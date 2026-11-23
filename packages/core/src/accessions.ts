/**
 * Accessions and deeds of gift (Spectrum "Acquisition and accessioning";
 * roadmap T-016, decision D-043).
 *
 * An **accession** is one arrival taken into the collection: a box of
 * donated papers, a bequest, a transfer from the city. It is logged before
 * the items inside are cataloged and keeps the chain of custody from the
 * donor to the shelf (mockup Accessions, Log an accession). It holds:
 *
 * - its **number**, `{ type, value }`, of one of the organization's
 *   identifier types (D-009), e.g. `accession_number` `2026.015`. Numbers
 *   are unique among the organization's accessions (compared by
 *   `identifierKey`), must fit the type's format, and `nextAccessionNumber`
 *   gives the next one by the type's auto-numbering;
 * - its **source**: the agent record (Authorities) of the donor, vendor or
 *   transferring body, as a record link `{ recordId, label }` (D-039);
 * - the day it was **received** (an EDTF day, `YYYY-MM-DD`, D-008), the
 *   acquisition **method**, a description of the **materials**, any
 *   **restrictions** the source asked for, in their words, and a staff note;
 * - an optional structured **access restriction** (T-016a, D-056, mockup
 *   Log an accession): `{ kind: "closed_until", until }` (nothing from it is
 *   published before the day `until`) or `{ kind: "staff_and_researchers" }`
 *   (never on the public site). The free-text `restrictions` stay notes and
 *   hold nothing back; "Other condition" in the mockup is notes only;
 * - the **deed of gift**: `missing`, `sent` (out for signature), `signed`
 *   (with the day, if known) or `not_needed` (a transfer, a purchase with a
 *   bill of sale, a find in the collection). A gift always needs one, so
 *   `not_needed` is refused for a gift;
 * - the **records it produced**: the objects, archival units and digital
 *   assets cataloged from it, as record links.
 *
 * A **donor contact** holds the email, phone and address of a source agent.
 *
 * **Everything here is staff-only** (mockup Donors: "Contact details are
 * visible to staff with the Donor relations role only", D-036). None of it
 * is a record or a record field, so none of it can reach `publicView` or
 * public output. `effective.ts` and `public-output.ts` never import this
 * module: from a register they can see only its organization and the IDs of
 * the records it holds back (`accession-holds.ts`), never an accession,
 * a donor, a number, materials or restrictions.
 *
 * **The deed check.** A record is held back from publishing when an
 * accession that holds produced it, produced a unit it is filed below, or
 * produced the record a digital asset `represents`. An accession holds when
 * its deed is needed but not signed (`missing` or `sent`), or when its access
 * restriction is in force on the register's day (`today`, given by the
 * caller: core never reads the clock). A `closed_until` restriction is in
 * force while `today` is before `until`, so from `until` on it holds nothing;
 * `staff_and_researchers` is always in force. `effectivePublishIssues` and `publicOutput`
 * take the register as `accessions` and refuse without it: for an object,
 * archival unit or digital asset, publishing without it is refused
 * (`accessions_unknown`), as is another organization's register
 * (`mixed_organizations`) or anything not made by `indexAccessions`
 * (`invalid_accessions`). Held back: `deed_not_signed` or
 * `access_restricted`, whose messages name no donor, number, accession,
 * restriction or date. The record, every record in its current
 * ancestry and, for a digital asset, the record it represents with that
 * record's current ancestry must all be ones the register knows
 * (`accessions_out_of_date`), and none may be held back.
 *
 * **One organization** (D-019, D-030). `indexAccessions` takes the
 * organization the register is for and refuses any accession, contact,
 * identifier type or record of another, so a register can be empty and
 * still say whose it is. Every lookup reads one register, so nothing of
 * another organization can be found through it. Like `indexRecords`, it
 * validates everything once into an opaque, frozen snapshot (recognised by a
 * WeakMap, never by shape): make it again after any accession, contact or
 * record changes. Caller lists are read once; Proxies, getters, holes and
 * prototype keys are refused. Nothing here throws on bad input.
 *
 * Messages never quote contact details, materials, restrictions (free text
 * or structured, nor a restriction's date) or notes.
 * Accession numbers are staff-only too: a public identifier type can't
 * number an accession (`public_type`).
 *
 * **No role check here.** `donorContact` and the other queries return what
 * the register holds to whoever calls them. Only staff with the Donor
 * relations permission (D-036) may see donors, contacts and accessions; the
 * service layer (T-032, roles in T-041) must check that before calling.
 *
 * **Only as fresh as the register.** The deed check reads the holds the
 * register worked out from the accessions and records it was made with, on
 * the day it was given. A register kept past that day still holds a
 * restriction that has since ended (it errs on the side of holding); one
 * given a day later than the real one would let a record out early, so
 * `today` must be the organization's own calendar day, worked out by the
 * caller in the organization's time zone.
 * Make the register at publish time, from the organization's records as
 * they are now, as T-034 will; a record the register doesn't know is
 * refused (`accessions_out_of_date`) rather than let through.
 */
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { markDeedHolds, type HoldReason } from "./accession-holds.js";
import { daysInMonth } from "./edtf.js";
import { recordsById } from "./effective.js";
import { identifierKey } from "./identifier-key.js";
import { matchesIdentifierPattern, parseIdentifierPattern } from "./identifier-pattern.js";
import {
  MAX_IDENTIFIER_LENGTH,
  MAX_IDENTIFIER_TYPES,
  nextIdentifier,
  validateIdentifierTypes,
  type IdentifierType,
  type RecordIdentifiers,
} from "./identifiers.js";
import { issue, isPlainObject, type Issue, type Validated } from "./issues.js";
import {
  isOrganizationId,
  mixedOrganizationsIssue,
  organizationIdOf,
  type OrganizationId,
} from "./organizations.js";
import { IssueList, readPlainData, textProblem, type JsonValue } from "./plain-data.js";
import { isRecordId, type RecordId } from "./record-id.js";
import { makeRecordLinkChecker } from "./record-links.js";
import type { CatalogRecord, RecordKind } from "./records.js";
import type { FieldDefinition, FieldValueChecker } from "./templates.js";

declare const accessionIdBrand: unique symbol;

/** A lowercase version 4 UUID that identifies one accession forever. */
export type AccessionId = string & { readonly [accessionIdBrand]: true };

/** How the accession was acquired (Spectrum: acquisition method). */
export const ACQUISITION_METHODS = [
  "gift",
  "purchase",
  "bequest",
  "transfer",
  "field_collection",
  "found_in_collection",
  "other",
] as const;
export type AcquisitionMethod = (typeof ACQUISITION_METHODS)[number];

/** Where the deed of gift (the signed transfer of title) stands. */
export const DEED_STATUSES = ["missing", "sent", "signed", "not_needed"] as const;
export type DeedStatus = (typeof DEED_STATUSES)[number];

/** Deed statuses that hold the accession's records back from publishing. */
export const DEED_HOLD_STATUSES: readonly DeedStatus[] = Object.freeze(["missing", "sent"]);

/** The kinds of structured access restriction (mockup Log an accession). */
export const ACCESS_RESTRICTION_KINDS = ["closed_until", "staff_and_researchers"] as const;
export type AccessRestrictionKind = (typeof ACCESS_RESTRICTION_KINDS)[number];

/**
 * A structured access restriction, which holds the accession's records back
 * from publishing while it is in force. Staff-only, like the accession.
 */
export type AccessRestriction =
  | {
      /** Closed until a day: nothing is published before `until`. */
      readonly kind: "closed_until";
      /** The first day the records may be published, `YYYY-MM-DD`. */
      readonly until: string;
    }
  | {
      /** Staff and researchers only: never on the public site. */
      readonly kind: "staff_and_researchers";
    };

/** The record kinds an accession can produce. Agents, places and events aren't accessioned. */
export const ACCESSIONED_KINDS: readonly RecordKind[] = Object.freeze([
  "object",
  "archival_unit",
  "digital_asset",
]);

/** A link from an accession to a record of its organization (D-039's value shape). */
export interface AccessionLink {
  readonly recordId: RecordId;
  /** Staff text for the link, e.g. the donor's name or the record's title. */
  readonly label: string;
}

/** The accession number: one of the organization's identifier types, and the number. */
export interface AccessionNumber {
  /** An identifier type key, e.g. `accession_number`. */
  readonly type: string;
  /** Exactly as typed, e.g. `2026.015`. */
  readonly value: string;
}

export interface Accession {
  readonly id: AccessionId;
  readonly organizationId: OrganizationId;
  readonly number: AccessionNumber;
  /** The donor, vendor or transferring body: an agent record. */
  readonly sourceAgent: AccessionLink;
  /** The day it arrived, `YYYY-MM-DD` (an EDTF day). */
  readonly receivedOn: string;
  readonly method: AcquisitionMethod;
  /** What arrived, described as a whole. */
  readonly materials: string;
  /** What the source asked for, in their words. Notes only: holds nothing back. */
  readonly restrictions?: string;
  /** A structured restriction that holds the records back while in force. */
  readonly accessRestriction?: AccessRestriction;
  readonly deedStatus: DeedStatus;
  /** For a signed deed: the day it was signed, `YYYY-MM-DD`, if known. */
  readonly deedSignedOn?: string;
  /** The objects, archival units and digital assets cataloged from it. */
  readonly records: readonly AccessionLink[];
  readonly note?: string;
}

/** How to reach a source agent. At least one of email, phone and address. */
export interface DonorContact {
  /** The agent record this is the contact for. */
  readonly agentId: RecordId;
  readonly organizationId: OrganizationId;
  readonly email?: string;
  readonly phone?: string;
  readonly address?: string;
  readonly note?: string;
}

/** A validated, frozen snapshot of one organization's accessions. Opaque. */
export interface AccessionRegister {
  readonly organizationId: OrganizationId;
  /** How many accessions. */
  readonly size: number;
  /** The day (`YYYY-MM-DD`) restrictions were judged on: the `today` given. */
  readonly heldAsOf: string;
}

/** What `indexAccessions` reads. */
export interface AccessionRegisterInput {
  readonly accessions: readonly Accession[];
  /** Donor contacts; left out, none. */
  readonly contacts?: readonly DonorContact[];
  /** The organization's records: a list, or a lookup from `indexRecords`. */
  readonly records: unknown;
  /** The organization's identifier types. */
  readonly identifierTypes: readonly IdentifierType[];
  /**
   * The organization's calendar day now, `YYYY-MM-DD`, in its own time zone:
   * which restrictions are in force is judged on it. Required.
   */
  readonly today: string;
}

export const MAX_ACCESSIONS = 100_000;
export const MAX_ACCESSION_RECORDS = 5_000;
export const MAX_DONOR_CONTACTS = 100_000;
export const MAX_MATERIALS_LENGTH = 4000;
export const MAX_RESTRICTIONS_LENGTH = 4000;
export const MAX_ACCESSION_NOTE_LENGTH = 4000;
export const MAX_LINK_LABEL_LENGTH = 500;
export const MAX_CONTACT_LINE_LENGTH = 320;
export const MAX_ADDRESS_LENGTH = 1000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LINE_BREAKS = /[\t\n\r\u2028\u2029]/;

const ACCESSION_LIMITS = {
  maxDepth: 3,
  maxValues: 45 + 3 * MAX_ACCESSION_RECORDS,
  maxStringLength: MAX_MATERIALS_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 20_000 + MAX_ACCESSION_RECORDS * (MAX_LINK_LABEL_LENGTH + 64),
} as const;
const CONTACT_LIMITS = {
  maxDepth: 1,
  maxValues: 20,
  maxStringLength: MAX_ACCESSION_NOTE_LENGTH,
  maxKeyLength: 64,
  maxTotalChars: 8000,
} as const;

const ACCESSION_KEYS: ReadonlySet<string> = new Set([
  "id",
  "organizationId",
  "number",
  "sourceAgent",
  "receivedOn",
  "method",
  "materials",
  "restrictions",
  "accessRestriction",
  "deedStatus",
  "deedSignedOn",
  "records",
  "note",
]);
const CONTACT_KEYS: ReadonlySet<string> = new Set([
  "agentId",
  "organizationId",
  "email",
  "phone",
  "address",
  "note",
]);
const INPUT_KEYS: ReadonlySet<string> = new Set([
  "accessions",
  "contacts",
  "records",
  "identifierTypes",
  "today",
]);

// ---------------------------------------------------------------------------
// IDs and days

/** Make a new random accession ID. */
export function newAccessionId(): AccessionId {
  return randomUUID() as AccessionId;
}

/** True if `value` is a well-formed accession ID (lowercase version 4 UUID). */
export function isAccessionId(value: unknown): value is AccessionId {
  return typeof value === "string" && UUID_V4.test(value);
}

/** A real calendar day written `YYYY-MM-DD`, years 1000 to 9999 (an EDTF day). */
function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DAY.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

// ---------------------------------------------------------------------------
// One accession, one contact

/**
 * Check one accession from untrusted input, on its own (its number's type,
 * its links and its number's uniqueness are checked by `indexAccessions`).
 * Returns a fresh, frozen copy, or every problem found. Never throws.
 */
export function validateAccession(input: unknown): Validated<Accession> {
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "An accession must be a plain object.", ACCESSION_LIMITS, issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    const d = view.data;
    unknownKeys(d, ACCESSION_KEYS, "an accession", issues);
    if (!isAccessionId(d.id)) {
      issues.add(["id"], "invalid_id", "The accession ID must be a lowercase version 4 UUID.");
    }
    checkOrganization(d.organizationId, "Every accession", issues);
    checkNumber(d.number, issues);
    checkLink(d.sourceAgent, ["sourceAgent"], "The source", issues);
    if (!isDay(d.receivedOn)) {
      issues.add(["receivedOn"], "invalid_date", "receivedOn must be a day written YYYY-MM-DD.");
    }
    const method = d.method;
    if (!(ACQUISITION_METHODS as readonly unknown[]).includes(method)) {
      issues.add(
        ["method"],
        "invalid_method",
        `The method must be one of: ${ACQUISITION_METHODS.join(", ")}.`,
      );
    }
    checkText(d.materials, ["materials"], "materials", MAX_MATERIALS_LENGTH, true, issues);
    checkText(
      d.restrictions,
      ["restrictions"],
      "restrictions",
      MAX_RESTRICTIONS_LENGTH,
      false,
      issues,
    );
    if (d.accessRestriction !== undefined) checkRestriction(d.accessRestriction, issues);
    checkText(d.note, ["note"], "note", MAX_ACCESSION_NOTE_LENGTH, false, issues);
    const deed = d.deedStatus;
    if (!(DEED_STATUSES as readonly unknown[]).includes(deed)) {
      issues.add(
        ["deedStatus"],
        "invalid_deed_status",
        `The deed status must be one of: ${DEED_STATUSES.join(", ")}.`,
      );
    } else if (deed === "not_needed" && method === "gift") {
      issues.add(
        ["deedStatus"],
        "deed_needed",
        "A gift passes ownership by a signed deed of gift, so its deed can't be marked not needed.",
      );
    }
    if (d.deedSignedOn !== undefined) {
      if (deed !== "signed") {
        issues.add(
          ["deedSignedOn"],
          "not_signed",
          "Only a signed deed has a signing date. Leave it out until the deed is signed.",
        );
      } else if (!isDay(d.deedSignedOn)) {
        issues.add(
          ["deedSignedOn"],
          "invalid_date",
          "deedSignedOn must be a day written YYYY-MM-DD.",
        );
      }
    }
    const records = d.records;
    if (!Array.isArray(records)) {
      issues.add(
        ["records"],
        "not_a_list",
        "records must be a list; leave it empty until items are cataloged.",
      );
    } else if (records.length > MAX_ACCESSION_RECORDS) {
      issues.add(
        ["records"],
        "too_many",
        `One accession can list at most ${String(MAX_ACCESSION_RECORDS)} records.`,
      );
    } else {
      const seen = new Set<string>();
      (records as readonly JsonValue[]).forEach((link, i) => {
        if (!checkLink(link, ["records", i], "Each record", issues)) return;
        const id = (link as { recordId: string }).recordId;
        if (seen.has(id)) {
          issues.add(
            ["records", i, "recordId"],
            "duplicate_record",
            "This record is listed twice.",
          );
        }
        seen.add(id);
      });
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as Accession };
  }, "This accession could not be read as plain data.");
}

/**
 * Check one donor contact from untrusted input, on its own (that its agent is
 * one of the organization's agent records is checked by `indexAccessions`).
 * Messages never quote the details. Never throws.
 */
export function validateDonorContact(input: unknown): Validated<DonorContact> {
  return guarded(() => {
    const issues = new IssueList();
    const view = readTop(input, "A donor contact must be a plain object.", CONTACT_LIMITS, issues);
    if (view === undefined) return { ok: false, issues: issues.items };
    const d = view.data;
    unknownKeys(d, CONTACT_KEYS, "a donor contact", issues);
    if (!isRecordId(d.agentId)) {
      issues.add(["agentId"], "invalid_id", "agentId must be the record ID of an agent.");
    }
    checkOrganization(d.organizationId, "Every donor contact", issues);
    checkLine(d.email, ["email"], "email", MAX_CONTACT_LINE_LENGTH, issues);
    checkLine(d.phone, ["phone"], "phone", MAX_CONTACT_LINE_LENGTH, issues);
    checkText(d.address, ["address"], "address", MAX_ADDRESS_LENGTH, false, issues);
    checkText(d.note, ["note"], "note", MAX_ACCESSION_NOTE_LENGTH, false, issues);
    if (d.email === undefined && d.phone === undefined && d.address === undefined) {
      issues.add([], "no_contact", "Give an email, a phone number or an address.");
    }
    if (issues.count > 0) return { ok: false, issues: issues.items };
    return { ok: true, value: view.copy as unknown as DonorContact };
  }, "This donor contact could not be read as plain data.");
}

// ---------------------------------------------------------------------------
// The register

interface RegisterData {
  readonly organizationId: OrganizationId;
  readonly byId: ReadonlyMap<AccessionId, Accession>;
  /** Accessions in register order. */
  readonly list: readonly Accession[];
  /** `type \0 identifierKey(value)` → accession. */
  readonly byNumber: ReadonlyMap<string, Accession>;
  /** Record → accessions that list it. */
  readonly byRecord: ReadonlyMap<RecordId, readonly Accession[]>;
  /** Record → accessions whose unsigned deed holds it back (directly, by an ancestor, or by what it represents). */
  readonly deeds: ReadonlyMap<RecordId, readonly AccessionId[]>;
  /** Record → accessions whose restriction, in force on the register's day, holds it back. */
  readonly restricted: ReadonlyMap<RecordId, readonly AccessionId[]>;
  readonly contacts: ReadonlyMap<RecordId, DonorContact>;
  readonly types: ReadonlyMap<string, IdentifierType>;
}

const REGISTERS = new WeakMap<object, RegisterData>();

const SOURCE_FIELD = linkField(["agent"]);
const RECORDS_FIELD = linkField(ACCESSIONED_KINDS);

/**
 * Validate one organization's accessions and donor contacts once, against
 * its records and identifier types, into a register for the queries below
 * and for the deed check (`effectivePublishIssues`, `publicOutput`).
 *
 * Refuses the whole input, with every problem found, when an accession or
 * contact is invalid; two accessions share an ID or a number (compared by
 * `identifierKey`, `duplicate_number`); a number's type isn't one of the
 * organization's identifier types (`unknown_type`) or the number doesn't fit
 * its format (`format_mismatch`); a source isn't one of the organization's
 * agent records, or a produced record isn't one of its objects, archival
 * units or digital assets (the record link checker's `unknown_record`,
 * `unusable_record`, `wrong_record_kind`, D-039); two contacts name one
 * agent (`duplicate_contact`); or anything belongs to another organization
 * than `organizationId` (`mixed_organizations`, naming nothing of it).
 * Never throws.
 */
export function indexAccessions(
  organizationId: OrganizationId,
  input: AccessionRegisterInput,
): Validated<AccessionRegister> {
  try {
    if (!isOrganizationId(organizationId)) {
      return refused(
        ["organizationId"],
        "invalid_organization",
        "A register belongs to one organization: give its organization ID.",
      );
    }
    const given: unknown = input;
    if (types.isProxy(given) || !isPlainObject(given)) {
      return refused([], "invalid_input", "Give { accessions, records, identifierTypes, today }.");
    }
    for (const key of Reflect.ownKeys(given)) {
      if (typeof key !== "string" || !INPUT_KEYS.has(key)) {
        return refused(
          [],
          "invalid_input",
          "The input has a property indexAccessions doesn't take.",
        );
      }
    }
    const parts = new Map<string, unknown>();
    for (const key of INPUT_KEYS) {
      const slot = Object.getOwnPropertyDescriptor(given, key);
      if (slot !== undefined && !("value" in slot)) {
        return refused([key], "invalid_input", `${key} can't be a getter.`);
      }
      parts.set(key, slot?.value);
    }
    // The day restrictions are judged on comes from the caller, never the clock.
    const today = parts.get("today");
    if (!isDay(today)) {
      return refused(
        ["today"],
        "invalid_today",
        "Give today's date in the organization's time zone, written YYYY-MM-DD, as today.",
      );
    }
    const mixed = (path: readonly (string | number)[]): Validated<AccessionRegister> => ({
      ok: false,
      issues: [
        mixedOrganizationsIssue(path, "These accessions, contacts, records and identifier types"),
      ],
    });

    // Identifier types: one validated copy, this organization's only. Each
    // entry's organization is checked first, read as a plain own data
    // property, so another organization's list, valid or not, gets no
    // message naming its keys (S-009a).
    const typesInput = parts.get("identifierTypes");
    if (
      !types.isProxy(typesInput) &&
      Array.isArray(typesInput) &&
      typesInput.length <= MAX_IDENTIFIER_TYPES
    ) {
      for (let i = 0; i < typesInput.length; i += 1) {
        const slot = Object.getOwnPropertyDescriptor(typesInput, i);
        const entry: unknown = slot !== undefined && "value" in slot ? slot.value : undefined;
        if (organizationIdOf(entry) !== organizationId) return mixed(["identifierTypes"]);
      }
    }
    const typesRead = validateIdentifierTypes(typesInput);
    if (!typesRead.ok) {
      if (typesRead.issues.some((i) => i.code === "mixed_organizations")) {
        return mixed(["identifierTypes"]);
      }
      return prefixed(["identifierTypes"], typesRead.issues);
    }
    if (typesRead.value.some((t) => t.organizationId !== organizationId)) {
      return mixed(["identifierTypes"]);
    }
    const typeByKey = new Map<string, IdentifierType>();
    for (const t of typesRead.value) if (!typeByKey.has(t.key)) typeByKey.set(t.key, t);

    // Records: one snapshot, read once, this organization's only.
    const found = recordsById(parts.get("records"));
    if (!found.ok) {
      if (found.issues.some((i) => i.code === "mixed_organizations")) return mixed(["records"]);
      return prefixed(["records"], found.issues);
    }
    const usable: CatalogRecord[] = [];
    for (const record of found.value.values()) {
      if (record === undefined) continue;
      if (record.organizationId !== organizationId) return mixed(["records"]);
      usable.push(record);
    }
    // Made from the frozen copies the snapshot holds, never from the caller's list again.
    const made = makeRecordLinkChecker(usable);
    if (!made.ok) return prefixed(["records"], made.issues);
    const checker = made.value;

    const accessionList = readList(parts.get("accessions"), MAX_ACCESSIONS, "accessions");
    if (!accessionList.ok) return prefixed(["accessions"], accessionList.issues);
    const contactInput = parts.get("contacts");
    const contactList =
      contactInput === undefined
        ? ({ ok: true, value: Object.freeze([]) } as const)
        : readList(contactInput, MAX_DONOR_CONTACTS, "contacts");
    if (!contactList.ok) return prefixed(["contacts"], contactList.issues);

    const issues = new IssueList();
    const accessions: Accession[] = [];
    accessionList.value.forEach((entry, i) => {
      if (issues.full) return;
      const checked = validateAccession(entry);
      if (!checked.ok) {
        for (const f of checked.issues) issues.add(["accessions", i, ...f.path], f.code, f.message);
      } else {
        accessions.push(checked.value);
      }
    });
    const contacts: DonorContact[] = [];
    contactList.value.forEach((entry, i) => {
      if (issues.full) return;
      const checked = validateDonorContact(entry);
      if (!checked.ok) {
        for (const f of checked.issues) issues.add(["contacts", i, ...f.path], f.code, f.message);
      } else {
        contacts.push(checked.value);
      }
    });
    if (issues.count > 0) return { ok: false, issues: issues.items };
    if (accessions.some((a) => a.organizationId !== organizationId)) return mixed(["accessions"]);
    if (contacts.some((c) => c.organizationId !== organizationId)) return mixed(["contacts"]);

    const byId = new Map<AccessionId, Accession>();
    const byNumber = new Map<string, Accession>();
    const byRecord = new Map<RecordId, Accession[]>();
    accessions.forEach((a, i) => {
      if (byId.has(a.id)) {
        issues.add(["accessions", i, "id"], "duplicate_id", "Two accessions have the same ID.");
        return;
      }
      byId.set(a.id, a);
      const type = typeByKey.get(a.number.type);
      if (type === undefined) {
        issues.add(
          ["accessions", i, "number", "type"],
          "unknown_type",
          "The accession number's type is not one of this organization's identifier types.",
        );
      } else if (type.public === true) {
        issues.add(
          ["accessions", i, "number", "type"],
          "public_type",
          "Accession numbers are staff-only, so their type can't be a public identifier type. Choose a staff type.",
        );
      } else if (type.pattern !== undefined) {
        const pattern = parseIdentifierPattern(type.pattern);
        if (pattern.ok && !matchesIdentifierPattern(pattern.value, a.number.value)) {
          issues.add(
            ["accessions", i, "number", "value"],
            "format_mismatch",
            `The accession number doesn't fit the format of ${type.label} numbers.`,
          );
        }
      }
      const key = `${a.number.type}\u0000${identifierKey(a.number.value)}`;
      if (byNumber.has(key)) {
        issues.add(
          ["accessions", i, "number", "value"],
          "duplicate_number",
          "Another accession already has this number.",
        );
      } else {
        byNumber.set(key, a);
      }
      // The accession stands in for the record the link checker expects:
      // only its ID (never a record's) and its organization are read.
      const self = Object.freeze({ id: a.id, organizationId: a.organizationId });
      linkProblems(
        checker,
        a.sourceAgent,
        SOURCE_FIELD,
        self,
        ["accessions", i, "sourceAgent"],
        issues,
      );
      a.records.forEach((link, j) => {
        linkProblems(checker, link, RECORDS_FIELD, self, ["accessions", i, "records", j], issues);
        const list = byRecord.get(link.recordId) ?? [];
        list.push(a);
        byRecord.set(link.recordId, list);
      });
    });
    const contactsByAgent = new Map<RecordId, DonorContact>();
    contacts.forEach((c, i) => {
      if (contactsByAgent.has(c.agentId)) {
        issues.add(
          ["contacts", i, "agentId"],
          "duplicate_contact",
          "Two contacts are given for the same agent. Keep one.",
        );
        return;
      }
      contactsByAgent.set(c.agentId, c);
      const self = Object.freeze({ id: newAccessionId(), organizationId: c.organizationId });
      linkProblems(
        checker,
        { recordId: c.agentId, label: "contact" },
        SOURCE_FIELD,
        self,
        ["contacts", i, "agentId"],
        issues,
      );
    });
    if (issues.count > 0) return { ok: false, issues: issues.items };

    const deeds = heldBy(
      accessions.filter((a) => DEED_HOLD_STATUSES.includes(a.deedStatus)),
      usable,
    );
    const restricted = heldBy(
      accessions.filter((a) => restrictionInForce(ownData(a, "accessRestriction"), today)),
      usable,
    );
    const frozenByRecord = new Map<RecordId, readonly Accession[]>();
    for (const [id, list] of byRecord) frozenByRecord.set(id, Object.freeze(list));
    const register: AccessionRegister = Object.freeze({
      organizationId,
      size: byId.size,
      heldAsOf: today,
    });
    REGISTERS.set(register, {
      organizationId,
      byId,
      list: Object.freeze(accessions),
      byNumber,
      byRecord: frozenByRecord,
      deeds,
      restricted,
      contacts: contactsByAgent,
      types: typeByKey,
    });
    // Shared as lookups only, so the sets themselves can't be changed.
    const known = new Set(usable.map((r) => r.id));
    const reasons = (id: RecordId): readonly HoldReason[] =>
      Object.freeze([
        ...(deeds.has(id) ? (["deed"] as const) : []),
        ...(restricted.has(id) ? (["restriction"] as const) : []),
      ]);
    markDeedHolds(register, {
      organizationId,
      isHeld: (id) => deeds.has(id) || restricted.has(id),
      holdReasons: reasons,
      isKnown: (id) => known.has(id),
    });
    return { ok: true, value: register };
  } catch {
    return refused([], "unreadable", "The accessions could not be read as plain data.");
  }
}

/** True if `value` is a register made by `indexAccessions`. */
export function isAccessionRegister(value: unknown): value is AccessionRegister {
  return typeof value === "object" && value !== null && REGISTERS.has(value);
}

/** One accession by its ID, or undefined (also for anything not a register). */
export function accessionById(register: AccessionRegister, id: unknown): Accession | undefined {
  const data = dataOf(register);
  return data !== undefined && isAccessionId(id) ? data.byId.get(id) : undefined;
}

/**
 * The accessions whose number matches `query`, of any type (or only `type`),
 * compared by `identifierKey` (case, spaces and lookalikes ignored). Bad
 * queries find nothing.
 */
export function accessionsByNumber(
  register: AccessionRegister,
  query: unknown,
  type?: string,
): readonly Accession[] {
  const data = dataOf(register);
  if (data === undefined || typeof query !== "string" || query.length > MAX_IDENTIFIER_LENGTH) {
    return Object.freeze([]);
  }
  const key = identifierKey(query);
  if (key.length === 0) return Object.freeze([]);
  const found: Accession[] = [];
  for (const typeKey of data.types.keys()) {
    if (type !== undefined && typeKey !== type) continue;
    const a = data.byNumber.get(`${typeKey}\u0000${key}`);
    if (a !== undefined) found.push(a);
  }
  return Object.freeze(found);
}

/** The accessions that list `recordId` among the records they produced. */
export function accessionsOfRecord(
  register: AccessionRegister,
  recordId: unknown,
): readonly Accession[] {
  const data = dataOf(register);
  if (data === undefined || !isRecordId(recordId)) return Object.freeze([]);
  return data.byRecord.get(recordId) ?? Object.freeze([]);
}

/**
 * The accessions still waiting on a deed (`missing` or `sent`), oldest
 * arrival first (mockup Deeds).
 */
export function accessionsAwaitingDeeds(register: AccessionRegister): readonly Accession[] {
  const data = dataOf(register);
  if (data === undefined) return Object.freeze([]);
  return Object.freeze(
    data.list
      .filter((a) => DEED_HOLD_STATUSES.includes(a.deedStatus))
      .sort((a, b) => cmp(a.receivedOn, b.receivedOn) || cmp(a.number.value, b.number.value)),
  );
}

/**
 * The accessions holding `recordId` back from publishing by their deed:
 * those with a deed needed but not signed that produced it, a unit it is
 * filed below, or the record it represents, as the records were when the
 * register was made. Empty when no deed holds it back.
 */
export function deedHoldsOn(register: AccessionRegister, recordId: unknown): readonly Accession[] {
  return holdsIn(register, recordId, "deeds");
}

/**
 * The accessions holding `recordId` back by an access restriction in force
 * on the register's day (`heldAsOf`), found as `deedHoldsOn` finds them.
 * Empty when no restriction holds it back.
 */
export function restrictionHoldsOn(
  register: AccessionRegister,
  recordId: unknown,
): readonly Accession[] {
  return holdsIn(register, recordId, "restricted");
}

/**
 * Every record held back, by a deed or by a restriction in force on the
 * register's day, by ID, in no particular order.
 */
export function recordsHeldBack(register: AccessionRegister): readonly RecordId[] {
  const data = dataOf(register);
  if (data === undefined) return Object.freeze([]);
  return Object.freeze([...new Set([...data.deeds.keys(), ...data.restricted.keys()])]);
}

/** The contact details for one source agent, or undefined. Staff with Donor relations only. */
export function donorContact(
  register: AccessionRegister,
  agentId: unknown,
): DonorContact | undefined {
  const data = dataOf(register);
  return data !== undefined && isRecordId(agentId) ? data.contacts.get(agentId) : undefined;
}

/**
 * The next accession number for an identifier type with auto-numbering, one
 * more than the highest of the same form among the register's accessions
 * (as `nextIdentifier` does for records, D-009). Year-based numbering needs
 * the `year`. Fails rather than guessing (see `nextIdentifier`), and when
 * `typeKey` isn't one of the register's identifier types. Never throws.
 */
export function nextAccessionNumber(
  register: AccessionRegister,
  typeKey: unknown,
  options: { readonly year?: number } = {},
): Validated<string> {
  try {
    const data = dataOf(register);
    if (data === undefined) {
      return refused([], "not_a_register", "Give the register made by indexAccessions.");
    }
    const type = typeof typeKey === "string" ? data.types.get(typeKey) : undefined;
    if (type === undefined) {
      return refused(
        ["type"],
        "unknown_type",
        "This is not one of this organization's identifier types.",
      );
    }
    // Each accession as a set holding its number, so the counting is D-009's own.
    const sets: RecordIdentifiers[] = data.list.map((a) => ({
      recordId: a.id as unknown as RecordId,
      organizationId: a.organizationId,
      current: [{ type: a.number.type, value: a.number.value, primary: true }],
      former: [],
    }));
    const year = isPlainObject(options)
      ? Object.getOwnPropertyDescriptor(options, "year")
      : undefined;
    const y: unknown = year !== undefined && "value" in year ? year.value : undefined;
    return nextIdentifier(type, sets, typeof y === "number" ? { year: y } : {});
  } catch {
    return refused([], "unreadable", "The next accession number could not be worked out.");
  }
}

// ---------------------------------------------------------------------------
// Internals

/**
 * True when `restriction` holds records back on `today` (both days checked
 * `YYYY-MM-DD`, so compared as text): `closed_until` while `today` is before
 * `until`, `staff_and_researchers` always, no restriction never.
 */
function restrictionInForce(restriction: AccessRestriction | undefined, today: string): boolean {
  if (restriction === undefined) return false;
  // Validated, so both are own properties; read as such all the same, and
  // anything unexpected holds.
  const own = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(restriction, key)
      ? (restriction as unknown as Record<string, unknown>)[key]
      : undefined;
  const kind = own("kind");
  const until = own("until");
  if (kind === "closed_until" && isDay(until)) return today < until;
  return true;
}

/**
 * `key` of `value` as an own data property, never inherited or behind a
 * getter, so a polluted Object.prototype can't add one (D-056).
 */
function ownData<T extends object, K extends keyof T & string>(value: T, key: K): T[K] | undefined {
  const slot = Object.getOwnPropertyDescriptor(value, key);
  return slot !== undefined && "value" in slot ? (slot.value as T[K]) : undefined;
}

/** `key` of a plain JSON object as an own data property, or undefined. */
function ownJson(value: object, key: string): JsonValue | undefined {
  const slot = Object.getOwnPropertyDescriptor(value, key);
  return slot !== undefined && "value" in slot ? (slot.value as JsonValue) : undefined;
}

function holdsIn(
  register: AccessionRegister,
  recordId: unknown,
  which: "deeds" | "restricted",
): readonly Accession[] {
  const data = dataOf(register);
  if (data === undefined || !isRecordId(recordId)) return Object.freeze([]);
  const ids = data[which].get(recordId) ?? [];
  return Object.freeze(ids.flatMap((id) => data.byId.get(id) ?? []));
}

/**
 * Record → the given (holding) accessions, following each produced record
 * down the arrangement (`parentId`) and to the digital assets that represent
 * it.
 */
function heldBy(
  accessions: readonly Accession[],
  records: readonly CatalogRecord[],
): ReadonlyMap<RecordId, readonly AccessionId[]> {
  const below = new Map<RecordId, RecordId[]>();
  const add = (from: RecordId | undefined, to: RecordId): void => {
    if (from === undefined) return;
    const list = below.get(from) ?? [];
    list.push(to);
    below.set(from, list);
  };
  for (const r of records) {
    if (r.kind === "archival_unit") add(r.parentId, r.id);
    if (r.kind === "digital_asset") add(r.represents, r.id);
  }
  const holds = new Map<RecordId, AccessionId[]>();
  for (const a of accessions) {
    const seen = new Set<RecordId>();
    const queue: RecordId[] = a.records.map((l) => l.recordId);
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const list = holds.get(id) ?? [];
      list.push(a.id);
      holds.set(id, list);
      for (const next of below.get(id) ?? []) queue.push(next);
    }
  }
  const frozen = new Map<RecordId, readonly AccessionId[]>();
  for (const [id, list] of holds) frozen.set(id, Object.freeze(list));
  return frozen;
}

function linkField(kinds: readonly RecordKind[]): FieldDefinition {
  return Object.freeze({
    key: "accession_link",
    label: "Accession link",
    kind: "record_link",
    required: true,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    recordKinds: Object.freeze([...kinds]),
  });
}

function linkProblems(
  checker: FieldValueChecker,
  link: AccessionLink,
  field: FieldDefinition,
  self: object,
  path: readonly (string | number)[],
  issues: IssueList,
): void {
  const value = { recordId: link.recordId, label: link.label };
  for (const p of checker(value, field, self as CatalogRecord)) {
    issues.add([...path, ...(p.path ?? [])], p.code, p.message);
  }
}

function dataOf(register: unknown): RegisterData | undefined {
  return typeof register === "object" && register !== null ? REGISTERS.get(register) : undefined;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkNumber(value: JsonValue | undefined, issues: IssueList): void {
  if (!isPlainObject(value)) {
    issues.add(["number"], "required", "Every accession needs a number: { type, value }.");
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "type" && key !== "value") {
      issues.add(
        ["number", key],
        "unknown_property",
        "An accession number has only type and value.",
      );
    }
  }
  // Own data properties only: a `type` or `value` on Object.prototype must
  // never complete a number left without one (T-018a review follow-up).
  const type = ownJson(value, "type");
  if (typeof type !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(type)) {
    issues.add(["number", "type"], "invalid_type", "The type must be an identifier type key.");
  }
  checkLine(
    ownJson(value, "value"),
    ["number", "value"],
    "number",
    MAX_IDENTIFIER_LENGTH,
    issues,
    true,
  );
}

/** True when `value` is a usable link `{ recordId, label }`; otherwise adds the issues. */
function checkLink(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  what: string,
  issues: IssueList,
): boolean {
  if (!isPlainObject(value)) {
    issues.add(path, "not_a_link", `${what} must be a link { recordId, label }.`);
    return false;
  }
  const before = issues.count;
  for (const key of Object.keys(value)) {
    if (key !== "recordId" && key !== "label") {
      issues.add([...path, key], "unknown_property", "A link has only recordId and label.");
    }
  }
  if (!isRecordId(ownJson(value, "recordId"))) {
    issues.add([...path, "recordId"], "invalid_id", "recordId must be a record ID.");
  }
  checkLine(
    ownJson(value, "label"),
    [...path, "label"],
    "label",
    MAX_LINK_LABEL_LENGTH,
    issues,
    true,
  );
  return issues.count === before;
}

/** One line of text; required or optional. Never quotes the value. */
function checkLine(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  what: string,
  max: number,
  issues: IssueList,
  required = false,
): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(
      path,
      required ? "required" : "invalid_text",
      `The ${what} must be text; leave it out if there is none.`,
    );
    return;
  }
  if (value !== value.trim())
    issues.add(path, "untrimmed", `The ${what} starts or ends with spaces.`);
  if (value.length > max) {
    issues.add(path, "too_long", `The ${what} can be at most ${String(max)} characters.`);
  }
  if (LINE_BREAKS.test(value)) {
    issues.add(
      path,
      "control_characters",
      `The ${what} must be one line, with no tabs or line breaks.`,
    );
  }
  const problem = textProblem(value);
  if (problem !== undefined) issues.add(path, "bad_characters", `The ${what} ${problem}.`);
}

/** Text that may run over several lines; required or optional. Never quotes the value. */
function checkText(
  value: JsonValue | undefined,
  path: readonly (string | number)[],
  what: string,
  max: number,
  required: boolean,
  issues: IssueList,
): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.add(
      path,
      required ? "required" : "invalid_text",
      required
        ? `Describe the ${what}.`
        : `The ${what} must be text; leave it out if there is none.`,
    );
    return;
  }
  if (value.length > max) {
    issues.add(path, "too_long", `The ${what} can be at most ${String(max)} characters.`);
  }
  const problem = textProblem(value);
  if (problem !== undefined) issues.add(path, "bad_characters", `The ${what} ${problem}.`);
}

function checkRestriction(value: JsonValue, issues: IssueList): void {
  const path = ["accessRestriction"];
  if (!isPlainObject(value)) {
    issues.add(
      path,
      "invalid_restriction",
      `An access restriction must be { kind } with kind one of: ${ACCESS_RESTRICTION_KINDS.join(", ")}.`,
    );
    return;
  }
  // Own properties only: an `until` on Object.prototype must never complete
  // a restriction left without one.
  const own = (key: string): JsonValue | undefined =>
    Object.prototype.hasOwnProperty.call(value, key)
      ? (value as Readonly<Record<string, JsonValue>>)[key]
      : undefined;
  const v = value as Readonly<Record<string, JsonValue>>;
  const kind = own("kind");
  const allowed = kind === "closed_until" ? ["kind", "until"] : ["kind"];
  // Reported once, at the restriction itself: the path never carries the
  // unknown key's text (D-056: restrictions are never quoted).
  if (Object.keys(v).some((key) => !allowed.includes(key))) {
    issues.add(
      path,
      "unknown_property",
      kind === "closed_until"
        ? "A closed-until restriction has only kind and until."
        : "This access restriction has only kind.",
    );
  }
  if (!(ACCESS_RESTRICTION_KINDS as readonly unknown[]).includes(kind)) {
    issues.add(
      [...path, "kind"],
      "invalid_restriction",
      `The restriction kind must be one of: ${ACCESS_RESTRICTION_KINDS.join(", ")}. Write any other condition in restrictions.`,
    );
    return;
  }
  if (kind === "closed_until" && !isDay(own("until"))) {
    issues.add(
      [...path, "until"],
      "invalid_date",
      "until must be the first day the records may be published, written YYYY-MM-DD.",
    );
  }
}

function checkOrganization(value: JsonValue | undefined, what: string, issues: IssueList): void {
  if (!isOrganizationId(value)) {
    issues.add(
      ["organizationId"],
      "invalid_organization",
      `${what} belongs to one organization: organizationId must be an organization ID.`,
    );
  }
}

function unknownKeys(
  view: Readonly<Record<string, JsonValue | undefined>>,
  allowed: ReadonlySet<string>,
  what: string,
  issues: IssueList,
): void {
  for (const key of Object.keys(view)) {
    if (!allowed.has(key)) {
      issues.add([key], "unknown_property", `This is not a property of ${what}.`);
    }
  }
}

interface TopView {
  readonly copy: Readonly<Record<string, JsonValue>>;
  readonly data: Readonly<Record<string, JsonValue | undefined>>;
}

function readTop(
  input: unknown,
  notObject: string,
  limits: typeof ACCESSION_LIMITS | typeof CONTACT_LIMITS,
  issues: IssueList,
): TopView | undefined {
  if (types.isProxy(input) || !isPlainObject(input)) {
    issues.add([], "not_an_object", notObject);
    return undefined;
  }
  const copy = readPlainData(input, [], limits, issues);
  if (copy === undefined || !isPlainObject(copy)) return undefined;
  // Read only the copy's own properties, never anything inherited.
  const data = Object.create(null) as Record<string, JsonValue | undefined>;
  for (const key of Object.keys(copy)) data[key] = copy[key];
  return { copy, data };
}

/** A caller's list read once into a frozen shallow copy; Proxies, holes and getters refused. */
function readList(input: unknown, max: number, what: string): Validated<readonly unknown[]> {
  if (types.isProxy(input) || !Array.isArray(input)) {
    return refused([], "not_a_list", `The ${what} must be given as a list.`);
  }
  const length = input.length;
  if (length > max) return refused([], "too_many", `At most ${String(max)} ${what} are allowed.`);
  const copy: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(input, i);
    if (slot === undefined || !("value" in slot)) {
      return refused(
        [i],
        "unreadable_entry",
        `Entry ${String(i)} of the ${what} can't be read as plain data.`,
      );
    }
    copy.push(slot.value);
  }
  return { ok: true, value: Object.freeze(copy) };
}

function prefixed(
  path: readonly (string | number)[],
  found: readonly Issue[],
): { readonly ok: false; readonly issues: readonly Issue[] } {
  return { ok: false, issues: found.map((f) => issue([...path, ...f.path], f.code, f.message)) };
}

function refused(
  path: readonly (string | number)[],
  code: string,
  message: string,
): { readonly ok: false; readonly issues: readonly Issue[] } {
  return { ok: false, issues: [issue(path, code, message)] };
}

function guarded<T>(run: () => Validated<T>, message: string): Validated<T> {
  try {
    return run();
  } catch {
    return refused([], "unreadable", message);
  }
}
