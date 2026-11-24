/**
 * Templates and identifier types through the service (T-042, D-076, D-079).
 *
 * - **Reading** (`listTemplates`, `readTemplate`, `listIdentifierTypes`):
 *   anyone holding a role in the organization that lets them see records
 *   (`records.view` anywhere) or change definitions (`catalog.definitions`),
 *   and system managers. Definitions hold field names, labels and rules,
 *   never record data.
 * - **Saving** a new version of a template (`saveTemplate`) or a new or
 *   changed identifier type (`saveIdentifierType`) needs
 *   `catalog.definitions` (a whole-catalog grant on any site, D-072, or a
 *   system manager). Each save is one transaction:
 *   1. the definition is locked: a template's `definition_lock`
 *      exclusively (record saves and publishing take it shared), an
 *      identifier type's row `FOR UPDATE` (record, identifier and publish
 *      checks lock the types `FOR SHARE`), so what is checked stays true
 *      until COMMIT;
 *   2. the version the person started from is compared with the stored
 *      one (`expectedVersion` for templates, 0 for a new key; the type's
 *      `tag` for identifier types, `null` for a new key): a mismatch is
 *      `version_conflict` and nothing is saved;
 *   3. core's change check (`templateChanges` over every record using the
 *      template, `identifierTypeChanges`) lists what needs a person's
 *      confirmation; the save is refused (`needs_confirmation`, one issue
 *      per change, its path `["confirm", code, key]`) until `confirm`
 *      lists exactly those changes;
 *   4. **D-076:** when the change makes a field or number public, the
 *      published records that would show it at once are found in the
 *      database (`publishedAmong`, `publishedHoldingType`), and the person
 *      must hold `records.publish` on every one of them (else
 *      `not_permitted`, with no count) and confirm them explicitly
 *      (`confirmPublished: true`); until then the save is refused with
 *      `publishes_records` and one `published_record_affected` issue per
 *      record (its path `["publishedRecords", id]`, every one a record the
 *      person may publish and so see);
 *   5. the new version is stored.
 *
 * Accepted signals (D-079): a change's message counts every record of the
 * organization it affects, on every site, because a template or identifier
 * type belongs to the whole organization (D-072 keeps `catalog.definitions`
 * organization-wide until John answers whether a site manager of one site
 * controls it). No ID of a record the person can't see is ever returned.
 */
import { createHash } from "node:crypto";
import {
  IssueList,
  MAX_RECORD_SET,
  holdsAnywhere,
  identifierTypeChanges,
  isPlainObject,
  isTemplateKey,
  issue,
  permits,
  readPlainData,
  templateChanges,
  validateIdentifierType,
  validateNewIdentifierType,
  validateTemplate,
  type Access,
  type FieldTemplate,
  type IdentifierType,
  type Issue,
  type JsonValue,
  type OrganizationId,
  type RecordId,
} from "@oculus/core";
import {
  identifierKeyInUse,
  insertIdentifierType,
  insertTemplateVersion,
  listTemplates as listStoredTemplates,
  lockDefinition,
  lockIdentifierType,
  publishedAmong,
  publishedHoldingType,
  readIdentifierTypes,
  readRecordPlace,
  readRecordsUsingTemplate,
  readTemplate as readStoredTemplate,
  updateIdentifierType,
  type Queryable,
  type TemplateSummary,
} from "@oculus/db";
import { RecordAccess, notPermitted, readAccess } from "./access.js";
import type { Runner } from "./admin.js";
import type { ServiceContext, ServiceResult } from "./service.js";

/** The most records one template save compares (core's own limit is higher). */
export const MAX_TEMPLATE_RECORDS = 50_000;

/** A template as read: its current or asked-for version. */
export interface TemplateVersion {
  readonly key: string;
  readonly version: number;
  readonly template: FieldTemplate;
}

/** An identifier type as read, with the tag an edit starts from. */
export interface TaggedIdentifierType {
  readonly type: IdentifierType;
  /** Changes whenever the stored definition changes: what `saveIdentifierType` compares. */
  readonly tag: string;
}

/** A saved template version, with the published records it changed at once (D-076). */
export interface SavedTemplate extends TemplateVersion {
  readonly publishedRecords: readonly RecordId[];
}

/** A saved identifier type, with the published records it changed at once (D-076). */
export interface SavedIdentifierType extends TaggedIdentifierType {
  readonly publishedRecords: readonly RecordId[];
}

export interface DefinitionOperations {
  /** The organization's templates at their current versions. */
  listTemplates(context: ServiceContext): Promise<ServiceResult<readonly TemplateVersion[]>>;
  /** One template: its current version, or `version` if given. */
  readTemplate(
    context: ServiceContext,
    key: string,
    version?: number,
  ): Promise<ServiceResult<TemplateVersion>>;
  /**
   * Stores `template` as the next version of its key (`expectedVersion`:
   * the version the edit started from, 0 for a new key). See the module
   * header for `confirm` and `confirmPublished`.
   */
  saveTemplate(
    context: ServiceContext,
    template: unknown,
    options: unknown,
  ): Promise<ServiceResult<SavedTemplate>>;
  /** The organization's identifier types, each with its tag. */
  listIdentifierTypes(
    context: ServiceContext,
  ): Promise<ServiceResult<readonly TaggedIdentifierType[]>>;
  /**
   * Stores a new identifier type (`expectedTag: null`) or replaces one
   * (`expectedTag`: the tag the edit started from). See the module header.
   */
  saveIdentifierType(
    context: ServiceContext,
    type: unknown,
    options: unknown,
  ): Promise<ServiceResult<SavedIdentifierType>>;
}

interface Who {
  organizationId: OrganizationId;
  actor: string;
}

function refusal<T>(path: (string | number)[], code: string, message: string): ServiceResult<T> {
  return { ok: false, issues: [issue(path, code, message)] };
}

/** An own data property, never a getter's result or a proxy trap's. */
function own(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  try {
    const d = Object.getOwnPropertyDescriptor(input, key);
    return d !== undefined && "value" in d ? (d.value as unknown) : undefined;
  } catch {
    return undefined;
  }
}

const DEFINITION_LIMITS = {
  maxDepth: 16,
  maxValues: 200_000,
  maxStringLength: 100_000,
  maxKeyLength: 200,
  maxTotalChars: 2_000_000,
} as const;

/** A plain copy of an untrusted object, or the issues. */
function plainObject(
  input: unknown,
  what: string,
): ServiceResult<Readonly<Record<string, JsonValue>>> {
  const issues = new IssueList();
  let copy: JsonValue | undefined;
  try {
    copy = readPlainData(input, [], DEFINITION_LIMITS, issues);
  } catch {
    return refusal([], "unreadable", `The ${what} could not be read as plain data.`);
  }
  if (copy === undefined || !isPlainObject(copy)) {
    return issues.items.length > 0
      ? { ok: false, issues: issues.items }
      : refusal([], "not_an_object", `The ${what} must be a plain object.`);
  }
  return { ok: true, value: copy };
}

/** Options with only `allowed` keys. */
function readOptions(
  input: unknown,
  allowed: readonly string[],
): ServiceResult<Readonly<Record<string, JsonValue>>> {
  if (input === undefined) return { ok: true, value: {} };
  const copied = plainObject(input, "options");
  if (!copied.ok) return copied;
  for (const key of Object.keys(copied.value)) {
    if (!allowed.includes(key)) {
      return refusal(
        ["options", key],
        "unknown_property",
        `The options are ${allowed.join(", ")}.`,
      );
    }
  }
  return copied;
}

/** `confirm`: a list of `{ code, key }`, as a set of `code\0key`. */
function readConfirm(options: Readonly<Record<string, JsonValue>>): ServiceResult<Set<string>> {
  const list = options.confirm;
  if (list === undefined) return { ok: true, value: new Set() };
  const bad = refusal<Set<string>>(
    ["options", "confirm"],
    "invalid_option",
    "confirm lists the confirmed changes as { code, key }.",
  );
  if (!Array.isArray(list) || list.length > 10_000) return bad;
  const out = new Set<string>();
  for (const item of list as readonly JsonValue[]) {
    if (!isPlainObject(item)) return bad;
    const code = own(item, "code");
    const key = own(item, "key");
    if (typeof code !== "string" || typeof key !== "string") return bad;
    out.add(`${code}\u0000${key}`);
  }
  return { ok: true, value: out };
}

function readConfirmPublished(
  options: Readonly<Record<string, JsonValue>>,
): ServiceResult<boolean> {
  const value = options.confirmPublished;
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== "boolean") {
    return refusal(
      ["options", "confirmPublished"],
      "invalid_option",
      "confirmPublished is true or false.",
    );
  }
  return { ok: true, value };
}

/** The changes needing confirmation, unless `confirmed` names exactly those. */
function unconfirmed(
  needed: readonly { code: string; key: string; message: string }[],
  confirmed: ReadonlySet<string>,
): Issue[] {
  const keys = new Set(needed.map((c) => `${c.code}\u0000${c.key}`));
  if (keys.size === confirmed.size && [...keys].every((k) => confirmed.has(k))) return [];
  return needed.map((c) => issue(["confirm", c.code, c.key], "needs_confirmation", c.message));
}

/** Whether the person may read definitions at all. */
function mayRead(access: Access): boolean {
  return (
    holdsAnywhere(access, "records.view") ||
    permits(access, "catalog.definitions", { on: "organization" })
  );
}

function mayChangeDefinitions(access: Access): boolean {
  return permits(access, "catalog.definitions", { on: "organization" });
}

/** JSON with every object's keys sorted, so equal values give equal text whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * An identifier type's tag: a digest of its definition (keys sorted, so the
 * stored JSON's own key order doesn't matter). Any change gives a new tag.
 */
export function identifierTypeTag(type: IdentifierType): string {
  return createHash("sha256").update(canonicalJson(type)).digest("base64url").slice(0, 32);
}

const TAG = /^[A-Za-z0-9_-]{32}$/;

const WRONG_ORGANIZATION = "This names another organization than the one you are working in.";

/**
 * D-076: the published records a change makes values public on. Every one
 * must be one the person may publish (`records.publish` where it is), else
 * `not_permitted` with no count; without `confirmPublished`, the refusal
 * lists them. `undefined` when the save may go on.
 */
async function publishedGate(
  tx: Queryable,
  who: Who,
  access: Access,
  affected: readonly RecordId[] | undefined,
  confirmed: boolean,
): Promise<ServiceResult<never> | undefined> {
  if (affected === undefined) {
    return refusal(
      [],
      "too_many_records",
      "This change would show values on too many published records to list. Change it in smaller steps.",
    );
  }
  if (affected.length === 0) return undefined;
  if (!access.systemManager) {
    const checker = new RecordAccess(tx, who.organizationId, access);
    await checker.settle();
    for (const id of affected) {
      const place = await readRecordPlace(tx, who.organizationId, id);
      const denied =
        place === undefined
          ? notPermitted()
          : await checker.onRecord(
              {
                kind: place.kind,
                id,
                parentId: place.parentId,
                represents: place.represents,
                siteId: place.siteId,
              },
              ["records.publish"],
            );
      if (denied) {
        return refusal(
          [],
          "not_permitted",
          "This change would show values at once on published records you may not publish.",
        );
      }
    }
  }
  if (confirmed) return undefined;
  return {
    ok: false,
    issues: [
      issue(
        ["confirmPublished"],
        "publishes_records",
        `This change shows values at once on ${String(affected.length)} published record(s). Check them, then confirm (confirmPublished).`,
      ),
      ...affected.map((id) =>
        issue(
          ["publishedRecords", id],
          "published_record_affected",
          "This published record would show the change at once.",
        ),
      ),
    ],
  };
}

/** The codes of template changes that can put stored values on the public sites. */
const PUBLISHING_TEMPLATE_CHANGES: ReadonlySet<string> = new Set(["made_public", "key_reused"]);

function inheritedKeys(template: FieldTemplate): Set<string> {
  return new Set(template.fields.filter((f) => f.inherited).map((f) => f.key));
}

export function definitionOperations(run: Runner): DefinitionOperations {
  async function readerAccess(tx: Queryable, who: Who): Promise<ServiceResult<Access>> {
    const access = await readAccess(tx, who.organizationId, who.actor);
    if (!access.ok) return access;
    if (!mayRead(access.value)) return notPermitted();
    return { ok: true, value: access.value };
  }

  async function writerAccess(tx: Queryable, who: Who): Promise<ServiceResult<Access>> {
    const access = await readAccess(tx, who.organizationId, who.actor);
    if (!access.ok) return access;
    if (!mayChangeDefinitions(access.value)) return notPermitted();
    return { ok: true, value: access.value };
  }

  return {
    async listTemplates(context) {
      return run("listTemplates", context, async (tx, who) => {
        const access = await readerAccess(tx, who);
        if (!access.ok) return access;
        const list: readonly TemplateSummary[] = await listStoredTemplates(tx, who.organizationId);
        return { ok: true, value: list };
      });
    },

    async readTemplate(context, key, version) {
      return run("readTemplate", context, async (tx, who) => {
        const access = await readerAccess(tx, who);
        if (!access.ok) return access;
        const unknown = refusal<TemplateVersion>(
          ["key"],
          "unknown_template",
          "The organization has no such template.",
        );
        if (!isTemplateKey(key)) return unknown;
        if (
          version !== undefined &&
          (!Number.isInteger(version) || version < 1 || version >= 2 ** 31 - 1)
        ) {
          return unknown;
        }
        const stored = await readStoredTemplate(tx, who.organizationId, key, version);
        if (stored === undefined) return unknown;
        if (!stored.ok) {
          return refusal(
            ["key"],
            "unreadable_template",
            "The stored template no longer reads as a template; it needs repair.",
          );
        }
        return {
          ok: true,
          value: Object.freeze({
            key,
            version: stored.value.version,
            template: stored.value.template,
          }),
        };
      });
    },

    async saveTemplate(context, templateInput, saveOptions) {
      return run("saveTemplate", context, async (tx, who) => {
        const org = who.organizationId;
        const access = await writerAccess(tx, who);
        if (!access.ok) return access;
        const opts = readOptions(saveOptions, ["expectedVersion", "confirm", "confirmPublished"]);
        if (!opts.ok) return opts;
        const expected = opts.value.expectedVersion;
        if (
          typeof expected !== "number" ||
          !Number.isInteger(expected) ||
          expected < 0 ||
          expected >= 2 ** 31 - 1
        ) {
          return refusal(
            ["options", "expectedVersion"],
            "invalid_version",
            "Name the version the edit started from: 0 for a new template.",
          );
        }
        const confirm = readConfirm(opts.value);
        if (!confirm.ok) return confirm;
        const confirmPublished = readConfirmPublished(opts.value);
        if (!confirmPublished.ok) return confirmPublished;
        const copied = plainObject(templateInput, "template");
        if (!copied.ok) return copied;
        const named = copied.value.organizationId;
        if (named !== undefined && named !== org) {
          return refusal(["organizationId"], "wrong_organization", WRONG_ORGANIZATION);
        }
        const valid = validateTemplate({ ...copied.value, organizationId: org });
        if (!valid.ok) return valid;
        const template = valid.value;
        // Exclusive until COMMIT: record saves and publishing (shared) wait.
        await lockDefinition(tx, org, "template", template.key, true);
        const current = await readStoredTemplate(tx, org, template.key);
        if (current !== undefined && !current.ok) {
          return refusal(
            ["key"],
            "unreadable_template",
            "The stored template no longer reads as a template; it needs repair.",
          );
        }
        const storedVersion = current?.value.version ?? 0;
        if (storedVersion !== expected) {
          return refusal(
            ["options", "expectedVersion"],
            "version_conflict",
            storedVersion === 0
              ? "There is no such template yet; save it as a new one (version 0)."
              : `The template was saved by someone else; it is now at version ${String(storedVersion)}. Read it again.`,
          );
        }
        let affected: readonly RecordId[] | undefined = [];
        let needed: { code: string; key: string; message: string }[] = [];
        if (current !== undefined) {
          const records = await readRecordsUsingTemplate(
            tx,
            org,
            template.key,
            MAX_TEMPLATE_RECORDS,
          );
          if (records === undefined || records.length > MAX_RECORD_SET) {
            return refusal(
              [],
              "too_many_records",
              "Too many records use this template to check the change here.",
            );
          }
          const compared = templateChanges(current.value.template, template, records);
          if (!compared.ok) return compared;
          const changes = compared.value.changes;
          needed = changes
            .filter((c) => c.needsConfirmation)
            .map((c) => ({ code: c.code, key: c.key, message: c.message }));
          const publicNow = new Set(
            template.fields.filter((f) => f.visibility === "public").map((f) => f.key),
          );
          const inherited = new Set([
            ...inheritedKeys(current.value.template),
            ...inheritedKeys(template),
          ]);
          // Values reach published records below these through inheritance
          // (D-013), so a change to an inherited field counts for every
          // published record at or below the template's records.
          const touchesInherited = changes.some((c) => inherited.has(c.key));
          if (touchesInherited) {
            const ids = records
              .map((r) => r.id)
              .filter((id): id is RecordId => typeof id === "string");
            affected = await publishedAmong(tx, org, ids, { below: true });
          } else {
            const direct = new Set<RecordId>();
            for (const c of changes) {
              if (!PUBLISHING_TEMPLATE_CHANGES.has(c.code) || !publicNow.has(c.key)) continue;
              for (const id of c.recordIds) direct.add(id);
            }
            affected = await publishedAmong(tx, org, [...direct]);
          }
        }
        const gate = await publishedGate(tx, who, access.value, affected, confirmPublished.value);
        if (gate) return gate;
        const notConfirmed = unconfirmed(needed, confirm.value);
        if (notConfirmed.length > 0) return { ok: false, issues: notConfirmed };
        const saved = await insertTemplateVersion(tx, template);
        if (!saved.ok) return saved;
        return {
          ok: true,
          value: Object.freeze({
            key: template.key,
            version: saved.value.version,
            template: saved.value.template,
            publishedRecords: Object.freeze([...(affected ?? [])]),
          }),
        };
      });
    },

    async listIdentifierTypes(context) {
      return run("listIdentifierTypes", context, async (tx, who) => {
        const access = await readerAccess(tx, who);
        if (!access.ok) return access;
        const types = await readIdentifierTypes(tx, who.organizationId);
        if (!types.ok) {
          return refusal(
            [],
            "unreadable_types",
            "The stored identifier types no longer read as valid; they need repair.",
          );
        }
        return {
          ok: true,
          value: Object.freeze(
            types.value.map((type) => Object.freeze({ type, tag: identifierTypeTag(type) })),
          ),
        };
      });
    },

    async saveIdentifierType(context, typeInput, saveOptions) {
      return run("saveIdentifierType", context, async (tx, who) => {
        const org = who.organizationId;
        const access = await writerAccess(tx, who);
        if (!access.ok) return access;
        const opts = readOptions(saveOptions, ["expectedTag", "confirm", "confirmPublished"]);
        if (!opts.ok) return opts;
        const expectedTag = opts.value.expectedTag;
        if (expectedTag !== null && (typeof expectedTag !== "string" || !TAG.test(expectedTag))) {
          return refusal(
            ["options", "expectedTag"],
            "invalid_version",
            "Name the tag the edit started from, or null for a new identifier type.",
          );
        }
        const confirm = readConfirm(opts.value);
        if (!confirm.ok) return confirm;
        const confirmPublished = readConfirmPublished(opts.value);
        if (!confirmPublished.ok) return confirmPublished;
        const copied = plainObject(typeInput, "identifier type");
        if (!copied.ok) return copied;
        const named = copied.value.organizationId;
        if (named !== undefined && named !== org) {
          return refusal(["organizationId"], "wrong_organization", WRONG_ORGANIZATION);
        }
        const input = { ...copied.value, organizationId: org };
        if (expectedTag === null) {
          const valid = validateNewIdentifierType(input);
          if (!valid.ok) return valid;
          const type = valid.value;
          // Numbers left under its key are adopted (D-031): confirmed first.
          const adopts = await identifierKeyInUse(tx, org, type.key);
          const neededNew = adopts
            ? [
                {
                  code: "key_adopts_values",
                  key: type.key,
                  message:
                    "Records already hold numbers under this key (from an earlier type); this type takes them over.",
                },
              ]
            : [];
          // A public new type adopts former numbers left under its key
          // (D-031): published records holding them would show them.
          const affected =
            type.public === true ? await publishedHoldingType(tx, org, type.key) : [];
          const gate = await publishedGate(tx, who, access.value, affected, confirmPublished.value);
          if (gate) return gate;
          const notConfirmedNew = unconfirmed(neededNew, confirm.value);
          if (notConfirmedNew.length > 0) return { ok: false, issues: notConfirmedNew };
          const saved = await insertIdentifierType(tx, type);
          if (!saved.ok) return saved;
          return {
            ok: true,
            value: Object.freeze({
              type: saved.value,
              tag: identifierTypeTag(saved.value),
              publishedRecords: Object.freeze([...(affected ?? [])]),
            }),
          };
        }
        const valid = validateIdentifierType(input);
        if (!valid.ok) return valid;
        const type = valid.value;
        const conflict = refusal<SavedIdentifierType>(
          ["options", "expectedTag"],
          "version_conflict",
          "The identifier type was changed by someone else (or doesn't exist). Read it again.",
        );
        // Until COMMIT, nothing that locks the types FOR SHARE (record and
        // identifier saves, publishing) runs.
        if (!(await lockIdentifierType(tx, org, type.key))) return conflict;
        const types = await readIdentifierTypes(tx, org);
        if (!types.ok) {
          return refusal(
            [],
            "unreadable_types",
            "The stored identifier types no longer read as valid; they need repair.",
          );
        }
        const old = types.value.find((t) => t.key === type.key);
        if (old === undefined || identifierTypeTag(old) !== expectedTag) return conflict;
        const compared = identifierTypeChanges(old, type);
        if (!compared.ok) return compared;
        const needed = compared.value.changes
          .filter((c) => c.needsConfirmation)
          .map((c) => ({ code: c.code, key: c.type, message: c.message }));
        const madePublic = compared.value.changes.some((c) => c.code === "made_public");
        const affected = madePublic ? await publishedHoldingType(tx, org, type.key) : [];
        const gate = await publishedGate(tx, who, access.value, affected, confirmPublished.value);
        if (gate) return gate;
        const notConfirmed = unconfirmed(needed, confirm.value);
        if (notConfirmed.length > 0) return { ok: false, issues: notConfirmed };
        const saved = await updateIdentifierType(tx, type);
        if (!saved.ok) return saved;
        return {
          ok: true,
          value: Object.freeze({
            type: saved.value,
            tag: identifierTypeTag(saved.value),
            publishedRecords: Object.freeze([...(affected ?? [])]),
          }),
        };
      });
    },
  };
}
