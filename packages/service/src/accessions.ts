/**
 * Accessions and donor contacts through the service (T-018c, D-114; core:
 * accessions.ts, D-043 and D-056).
 *
 * **Who.** Reading takes `donors.view`, changing `donors.edit` (D-036: the
 * Donor relations role, and managers), from a grant on the whole catalog
 * of any of the organization's sites: accessions belong to the
 * organization, not to a site. Anyone else, and anything of another
 * organization, answers `not_permitted` or exactly like a missing
 * accession (`unknown_accession`).
 *
 * **Saving.** An accession is given without `id` and `organizationId` (the
 * service sets both); core checks it whole (`indexAccessions`) against the
 * records it names, read now (the source must be one of the
 * organization's agents, the produced records its objects, archival units
 * or digital assets) and the organization's identifier types. A number
 * already used by another accession is `duplicate_number`; an edit names
 * the version it was made from (`expectedVersion`), or is
 * `version_conflict`. The reply says which published records the accession
 * now holds back from the public (`nowHeld`), so staff can withdraw them:
 * from the next publish check on, and in the public output at once, they
 * are refused (D-114).
 *
 * **Donor contacts** (an agent's email, phone, address) are read and saved
 * the same way, one per agent; deleting one forgets it.
 *
 * STAFF ONLY: nothing here is ever public, and messages never quote a
 * contact, materials, restrictions or notes.
 */
import {
  accessionHoldsOn,
  holdsForWholeCatalog,
  identifierKey,
  indexAccessions,
  isRecordId,
  issue,
  newAccessionId,
  validateAccession,
  validateDonorContact,
  grantPermissions,
  type Access,
  type Accession,
  type DonorContact,
  type RecordId,
  type RolePermission,
  type SiteId,
} from "@oculus/core";
import {
  MAX_ACCESSION_PAGE,
  deleteDonorContact,
  insertAccession,
  lockAccessionHolds,
  sitesBelow,
  listAccessions,
  numberUsedBefore,
  publishedBelow,
  readAccession,
  readAccessionRecords,
  readDonorContact,
  readIdentifierTypes,
  readRecordPlace,
  saveDonorContact,
  sql,
  updateAccession,
  type Queryable,
  type StoredAccession,
  type StoredDonorContact,
} from "@oculus/db";
import { NOT_PERMITTED_MESSAGE, readAccess } from "./access.js";
import { hasOnly, own, type Runner } from "./admin.js";
import type { ServiceRefusal, ServiceResult } from "./service.js";

/** An accession as the service gives it out. */
export interface AccessionView {
  readonly accession: Accession;
  /** Pass it as `expectedVersion` with the next edit. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A saved accession, and the published records it now holds back. */
export interface SavedAccession extends AccessionView {
  readonly nowHeld: readonly RecordId[];
}

export interface DonorContactView {
  readonly contact: DonorContact;
  readonly version: number;
  readonly updatedAt: string;
}

export interface AccessionPage {
  readonly accessions: readonly AccessionView[];
  /** The `before` for the next page, or null when this one wasn't full. */
  readonly next: string | null;
}

export interface AccessionOperations {
  listAccessions(context: unknown, page?: unknown): Promise<ServiceResult<AccessionPage>>;
  readAccession(context: unknown, id: unknown): Promise<ServiceResult<AccessionView>>;
  createAccession(context: unknown, input: unknown): Promise<ServiceResult<SavedAccession>>;
  updateAccession(
    context: unknown,
    id: unknown,
    input: unknown,
    options: { readonly expectedVersion: unknown },
  ): Promise<ServiceResult<SavedAccession>>;
  readDonorContact(context: unknown, agentId: unknown): Promise<ServiceResult<DonorContactView>>;
  saveDonorContact(
    context: unknown,
    agentId: unknown,
    input: unknown,
    options: { readonly expectedVersion: unknown },
  ): Promise<ServiceResult<DonorContactView>>;
  deleteDonorContact(
    context: unknown,
    agentId: unknown,
    options: { readonly expectedVersion: unknown },
  ): Promise<ServiceResult<{ readonly deleted: true }>>;
}

type Refusal = ServiceRefusal;

function refusal(path: (string | number)[], code: string, message: string): Refusal {
  return { ok: false, issues: [issue(path, code, message)] };
}

const NOT_PERMITTED = (): Refusal => refusal([], "not_permitted", NOT_PERMITTED_MESSAGE);
const UNKNOWN_ACCESSION = (): Refusal =>
  refusal(["accessionId"], "unknown_accession", "There is no such accession here.");
const UNKNOWN_CONTACT = (): Refusal =>
  refusal(["agentId"], "unknown_contact", "There are no contact details for that agent here.");

/** The keys an accession is given with (core's, without `id` and `organizationId`). */
const INPUT_KEYS = [
  "number",
  "sourceAgent",
  "receivedOn",
  "method",
  "materials",
  "restrictions",
  "note",
  "deedStatus",
  "deedSignedOn",
  "accessRestriction",
  "records",
];

const CONTACT_KEYS = ["email", "phone", "address", "note"];

/**
 * Whether `access` holds `permission` for the organization's accessions: a
 * system manager, or a whole-catalog grant (on one site or every site) of
 * a role that has it.
 */
function holdsDonorPermission(access: Access, permission: RolePermission): boolean {
  if (access.systemManager) return true;
  return access.grants.some((g) => g.scope === null && grantPermissions(g).includes(permission));
}

function view(row: StoredAccession, accession: Accession): AccessionView {
  return Object.freeze({
    accession,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function expectedOf(value: unknown, allowZero: boolean): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (value >= 1 || (allowZero && value === 0))
    ? value
    : undefined;
}

const BAD_VERSION = (): Refusal =>
  refusal(
    ["options", "expectedVersion"],
    "invalid_version",
    "Give the version you edited (a whole number) as expectedVersion.",
  );

export function accessionOperations(run: Runner): AccessionOperations {
  /** The person's access, if they hold `permission` for accessions. */
  async function allowed(
    tx: Queryable,
    who: { organizationId: Accession["organizationId"]; actor: string },
    permission: RolePermission,
  ): Promise<{ ok: true; userId: string; access: Access } | Refusal> {
    const access = await readAccess(tx, who.organizationId, who.actor);
    if (!access.ok) return access;
    if (!holdsDonorPermission(access.value, permission)) return NOT_PERMITTED();
    return { ok: true, userId: access.userId, access: access.value };
  }

  /**
   * Whether the person may name each of `ids` in an accession: the record's
   * home site is one where they hold `donors.edit` for the whole catalog
   * (a record on no site: system managers only, as for every catalog
   * permission). Accessions belong to the organization, but naming a record
   * holds it back from that site's public, so it takes a role there (D-114).
   */
  async function mayName(
    tx: Queryable,
    org: Accession["organizationId"],
    access: Access,
    ids: readonly RecordId[],
  ): Promise<Refusal | undefined> {
    if (access.systemManager) return undefined;
    // The named records and everything below them: what a hold would reach.
    for (const site of await sitesBelow(tx, org, ids)) {
      if (site === null || !holdsForWholeCatalog(access, "donors.edit", site as SiteId)) {
        return refusal(
          ["records"],
          "not_permitted",
          "An accession can name only records (and what is filed below them) of sites where you work with donors and accessions.",
        );
      }
    }
    return undefined;
  }

  /**
   * Of `ids`, those on sites where the person works with donors
   * (`donors.edit`, the same rule as naming them): the records below a
   * named one may be on another site.
   */
  async function visible(
    tx: Queryable,
    org: Accession["organizationId"],
    access: Access,
    ids: readonly RecordId[],
  ): Promise<readonly RecordId[]> {
    if (access.systemManager) return ids;
    const out: RecordId[] = [];
    for (const id of ids) {
      const place = await readRecordPlace(tx, org, id);
      if (place?.siteId != null && holdsForWholeCatalog(access, "donors.edit", place.siteId)) {
        out.push(id);
      }
    }
    return Object.freeze(out);
  }

  async function today(tx: Queryable, org: Accession["organizationId"]): Promise<string> {
    const [row] = await tx.rows<{ today: string | null }>(
      sql`SELECT public.organization_local_day(${org}::uuid) AS today`,
    );
    return row?.today ?? "";
  }

  /** Every record `candidate` names (and `before`, the stored version's), in ID order. */
  function namedIds(candidate: unknown, before?: unknown): readonly RecordId[] {
    const ids = new Set<string>();
    for (const value of [candidate, before]) {
      const source = own(own(value, "sourceAgent"), "recordId");
      if (isRecordId(source)) ids.add(source);
      const links = own(value, "records");
      if (Array.isArray(links)) {
        for (const link of links as unknown[]) {
          const id = own(link, "recordId");
          if (isRecordId(id)) ids.add(id);
        }
      }
    }
    return [...ids].sort() as RecordId[];
  }

  /** Core's whole check of one accession, against the records it names and the types, read now. */
  async function checkAccession(
    tx: Queryable,
    org: Accession["organizationId"],
    candidate: unknown,
  ): Promise<{ ok: true; value: Accession } | Refusal> {
    const ids: RecordId[] = [];
    const source = own(own(candidate, "sourceAgent"), "recordId");
    if (isRecordId(source)) ids.push(source);
    const links = own(candidate, "records");
    if (Array.isArray(links)) {
      for (const link of links as unknown[]) {
        const id = own(link, "recordId");
        if (isRecordId(id)) ids.push(id);
      }
    }
    const records = await readAccessionRecords(tx, org, ids);
    if (records === undefined) {
      return refusal(["records"], "too_many_records", "That is too many records to check at once.");
    }
    const types = await readIdentifierTypes(tx, org);
    if (!types.ok) {
      return refusal(["number"], "unreadable_types", "The identifier types can't be read now.");
    }
    const register = indexAccessions(org, {
      accessions: [candidate as Accession],
      records,
      identifierTypes: types.value,
      today: (await today(tx, org)) || "1970-01-01",
    });
    if (!register.ok) {
      return {
        ok: false,
        issues: register.issues.map((i) =>
          i.path[0] === "accessions" && i.path[1] === 0 ? { ...i, path: i.path.slice(2) } : i,
        ),
      };
    }
    // The one accession, as core validated it (a frozen copy of plain data).
    const valid = validateAccession(candidate);
    return valid.ok ? { ok: true, value: valid.value } : { ok: false, issues: valid.issues };
  }

  /** The accession input with the service's id and organization, or a refusal. */
  function candidateOf(
    input: unknown,
    id: string,
    org: Accession["organizationId"],
  ): { ok: true; value: Record<string, unknown> } | Refusal {
    if (!hasOnly(input, INPUT_KEYS)) {
      return refusal(
        ["accession"],
        "invalid_request",
        `An accession is given as ${INPUT_KEYS.join(", ")} (its ID and organization are set here).`,
      );
    }
    const out: Record<string, unknown> = { id, organizationId: org };
    for (const key of INPUT_KEYS) {
      const value = own(input, key);
      if (value !== undefined) out[key] = value;
    }
    return { ok: true, value: out };
  }

  async function saveAndReply(
    tx: Queryable,
    org: Accession["organizationId"],
    accession: Accession,
    access: Access,
    save: (numberKey: string) => ReturnType<typeof insertAccession>,
  ): Promise<ServiceResult<SavedAccession>> {
    const numberKey = `${accession.number.type}:${identifierKey(accession.number.value)}`;
    // A type numbering for all time never gives a number to a second accession.
    const types = await readIdentifierTypes(tx, org);
    const type = types.ok ? types.value.find((t) => t.key === accession.number.type) : undefined;
    if (
      type?.uniqueness === "all_time" &&
      (await numberUsedBefore(tx, org, numberKey, accession.id))
    ) {
      return refusal(
        ["number", "value"],
        "duplicate_number",
        "Another accession has had this number. Numbers of this type are never used twice.",
      );
    }
    const saved = await save(numberKey);
    if (!saved.ok) {
      if (saved.code === "duplicate_number") {
        return refusal(
          ["number", "value"],
          "duplicate_number",
          "Another accession already has this number.",
        );
      }
      if (saved.code === "missing_record") {
        return refusal(
          ["records"],
          "unknown_record",
          "A record it names was deleted meanwhile. Check the records and save again.",
        );
      }
      return refusal(
        ["options", "expectedVersion"],
        "version_conflict",
        "The accession was saved by someone else since you opened it. Read it again.",
      );
    }
    // An unknown day ("") holds every closed_until restriction: never a guess.
    const nowHeld = accessionHoldsOn(accession, await today(tx, org))
      ? await visible(
          tx,
          org,
          access,
          await publishedBelow(
            tx,
            org,
            accession.records.map((l) => l.recordId),
          ),
        )
      : [];
    return {
      ok: true,
      value: Object.freeze({ ...view(saved.value, accession), nowHeld }),
    };
  }

  function contactView(row: StoredDonorContact, contact: DonorContact): DonorContactView {
    return Object.freeze({ contact, version: row.version, updatedAt: row.updatedAt });
  }

  return {
    listAccessions(context, page) {
      return run("listAccessions", context, async (tx, who) => {
        const may = await allowed(tx, who, "donors.view");
        if (!may.ok) return may;
        if (page !== undefined && !hasOnly(page, ["before"])) {
          return refusal(["page"], "invalid_request", "A page is { before } (an accession ID).");
        }
        const before = own(page, "before");
        if (before !== undefined && !isRecordId(before)) {
          return refusal(["page", "before"], "invalid_id", "before is an accession ID.");
        }
        const rows = await listAccessions(tx, who.organizationId, {
          ...(before === undefined ? {} : { before }),
        });
        // As stored: core checked each one when it was saved.
        const out = rows.map((row) => view(row, row.definition as Accession));
        const last = rows.at(-1);
        return {
          ok: true,
          value: Object.freeze({
            accessions: Object.freeze(out),
            next:
              rows.length >= MAX_ACCESSION_PAGE && last !== undefined
                ? (last.definition as { id: string }).id
                : null,
          }),
        };
      });
    },

    readAccession(context, id) {
      return run("readAccession", context, async (tx, who) => {
        const may = await allowed(tx, who, "donors.view");
        if (!may.ok) return may;
        if (typeof id !== "string") return UNKNOWN_ACCESSION();
        const row = await readAccession(tx, who.organizationId, id);
        if (row === undefined) return UNKNOWN_ACCESSION();
        return { ok: true, value: view(row, row.definition as Accession) };
      });
    },

    createAccession(context, input) {
      return run("createAccession", context, async (tx, who) => {
        const may = await allowed(tx, who, "donors.edit");
        if (!may.ok) return may;
        const candidate = candidateOf(input, newAccessionId(), who.organizationId);
        if (!candidate.ok) return candidate;
        // Before anything is read: no publish check runs meanwhile (D-114).
        await lockAccessionHolds(tx, who.organizationId, "exclusive");
        const named = namedIds(candidate.value);
        const naming = await mayName(tx, who.organizationId, may.access, named);
        if (naming) return naming;
        const checked = await checkAccession(tx, who.organizationId, candidate.value);
        if (!checked.ok) return checked;
        return saveAndReply(tx, who.organizationId, checked.value, may.access, (key) =>
          insertAccession(tx, checked.value, key, may.userId),
        );
      });
    },

    updateAccession(context, id, input, options) {
      return run("updateAccession", context, async (tx, who) => {
        const may = await allowed(tx, who, "donors.edit");
        if (!may.ok) return may;
        const expected = expectedOf(own(options, "expectedVersion"), false);
        if (expected === undefined) return BAD_VERSION();
        if (typeof id !== "string") return UNKNOWN_ACCESSION();
        // Before anything is read: no publish check runs meanwhile (D-114).
        await lockAccessionHolds(tx, who.organizationId, "exclusive");
        const row = await readAccession(tx, who.organizationId, id, { lock: true });
        if (row === undefined) return UNKNOWN_ACCESSION();
        const candidate = candidateOf(input, id, who.organizationId);
        if (!candidate.ok) return candidate;
        const named = namedIds(candidate.value, row.definition);
        const naming = await mayName(tx, who.organizationId, may.access, named);
        if (naming) return naming;
        const checked = await checkAccession(tx, who.organizationId, candidate.value);
        if (!checked.ok) return checked;
        return saveAndReply(tx, who.organizationId, checked.value, may.access, (key) =>
          updateAccession(tx, checked.value, key, may.userId, expected),
        );
      });
    },

    readDonorContact(context, agentId) {
      return run("readDonorContact", context, async (tx, who) => {
        const may = await allowed(tx, who, "donors.view");
        if (!may.ok) return may;
        if (typeof agentId !== "string") return UNKNOWN_CONTACT();
        const row = await readDonorContact(tx, who.organizationId, agentId);
        if (row === undefined) return UNKNOWN_CONTACT();
        return { ok: true, value: contactView(row, row.definition as DonorContact) };
      });
    },

    saveDonorContact(context, agentId, input, options) {
      return run("saveDonorContact", context, async (tx, who) => {
        const may = await allowed(tx, who, "donors.edit");
        if (!may.ok) return may;
        const expected = expectedOf(own(options, "expectedVersion"), true);
        if (expected === undefined) return BAD_VERSION();
        if (!isRecordId(agentId)) {
          return refusal(["agentId"], "invalid_id", "The agent is a record ID.");
        }
        if (!hasOnly(input, CONTACT_KEYS)) {
          return refusal(
            ["contact"],
            "invalid_request",
            `Contact details are ${CONTACT_KEYS.join(", ")}.`,
          );
        }
        const candidate: Record<string, unknown> = {
          agentId,
          organizationId: who.organizationId,
        };
        for (const key of CONTACT_KEYS) {
          const value = own(input, key);
          if (value !== undefined) candidate[key] = value;
        }
        const checked = validateDonorContact(candidate);
        if (!checked.ok) return { ok: false, issues: checked.issues };
        const naming = await mayName(tx, who.organizationId, may.access, [agentId]);
        if (naming) return naming;
        // The agent must be one of the organization's agents (core's register check).
        const types = await readIdentifierTypes(tx, who.organizationId);
        const records = await readAccessionRecords(tx, who.organizationId, [agentId]);
        const register = indexAccessions(who.organizationId, {
          accessions: [],
          contacts: [checked.value],
          records: records ?? [],
          identifierTypes: types.ok ? types.value : [],
          today: (await today(tx, who.organizationId)) || "1970-01-01",
        });
        if (!register.ok) {
          return refusal(
            ["agentId"],
            "unknown_agent",
            "Contact details belong to an agent record.",
          );
        }
        const saved = await saveDonorContact(tx, checked.value, may.userId, expected);
        if (!saved.ok) {
          return saved.code === "missing_record"
            ? refusal(["agentId"], "unknown_agent", "Contact details belong to an agent record.")
            : refusal(
                ["options", "expectedVersion"],
                "version_conflict",
                expected === 0
                  ? "Contact details are already saved for this agent. Read them again."
                  : "The contact details were saved by someone else since you opened them. Read them again.",
              );
        }
        return { ok: true, value: contactView(saved.value, checked.value) };
      });
    },

    deleteDonorContact(context, agentId, options) {
      return run("deleteDonorContact", context, async (tx, who) => {
        const may = await allowed(tx, who, "donors.edit");
        if (!may.ok) return may;
        const expected = expectedOf(own(options, "expectedVersion"), false);
        if (expected === undefined) return BAD_VERSION();
        if (typeof agentId !== "string") return UNKNOWN_CONTACT();
        if (await deleteDonorContact(tx, who.organizationId, agentId, expected)) {
          return { ok: true, value: Object.freeze({ deleted: true as const }) };
        }
        return (await readDonorContact(tx, who.organizationId, agentId)) === undefined
          ? UNKNOWN_CONTACT()
          : refusal(
              ["options", "expectedVersion"],
              "version_conflict",
              "The contact details were changed since you opened them. Read them again.",
            );
      });
    },
  };
}
