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
 *   `catalog.definitions`, which only system managers hold (John,
 *   2026-11-24, D-072). Each save is one transaction:
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
 *   4. **D-076:** the published records whose public output the change
 *      may alter at once are found in the database: for a template whose
 *      public shape changes (its record kinds, a key added or removed, or
 *      anything in a field's definition but its label and help changed,
 *      `publicShapeChanged`),
 *      every published record using it or below one (`publishedAmong`
 *      with `below`; inherited fields carry values down, D-013); for an
 *      identifier type made public (or a new public one adopting left-over
 *      numbers), every published record holding a number of it or below
 *      one (`publishedHoldingType`, which for a new type also locks those
 *      records `FOR SHARE` so a publication in the meantime waits or is
 *      counted). A superset of the records whose output changes, never
 *      fewer. The person
 *      must hold `records.publish` on every one of them (else
 *      `not_permitted`, with no count) and confirm them explicitly
 *      (`confirmPublished: true`); until then the save is refused with
 *      `publishes_records` and one `published_record_affected` issue per
 *      record (its path `["publishedRecords", id]`, every one a record the
 *      person may publish and so see);
 *   5. the new version is stored.
 *
 * A change's message counts every record of the organization it affects,
 * on every site; only system managers, who see every record, save
 * definitions, so this tells nobody anything hidden. The `records.publish`
 * check of step 4 holds for system managers at once; it stays as a second
 * line should definitions ever be granted to a role again.
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
  RIGHTS_FIELD_KEY,
  RIGHTS_REQUIRED_KINDS,
  validateDublinCoreMapping,
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
  publishedUsingTemplate,
  readIdentifierTypes,
  readRecordPlace,
  readRecordsUsingTemplate,
  readDublinCoreMapping as readStoredMapping,
  readRecordsForChecks,
  readTemplate as readStoredTemplate,
  updateIdentifierType,
  writeDublinCoreMapping,
  type Queryable,
  type TemplateSummary,
} from "@oculus/db";
import { RecordAccess, actorUser, notPermitted, readAccess } from "./access.js";
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
  /**
   * Published records a new format took off the public sites (S-033,
   * D-091): their public number no longer fits it. Confirmed before saving.
   */
  readonly droppedFromPublic?: readonly RecordId[];
}

/** A template's Dublin Core mapping as read (T-050b, D-096): version 0 and `null` when none is stored. */
export interface DublinCoreMappingVersion {
  readonly key: string;
  readonly version: number;
  readonly mapping: unknown;
}

/** A saved mapping, with the published records it changed at once (D-076). */
export interface SavedDublinCoreMapping extends DublinCoreMappingVersion {
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
  /** A template's stored Dublin Core mapping (T-050b, D-096), for anyone who may read templates. */
  readDublinCoreMapping(
    context: ServiceContext,
    key: string,
  ): Promise<ServiceResult<DublinCoreMappingVersion>>;
  /**
   * Stores a template's Dublin Core mapping (those who may change
   * definitions, D-072), checked against the template's current version,
   * from `expectedVersion` (0 when none is stored). A change that shows
   * values at once on published records using the template needs
   * `confirmPublished` (D-076).
   */
  saveDublinCoreMapping(
    context: ServiceContext,
    key: string,
    mapping: unknown,
    options: unknown,
  ): Promise<ServiceResult<SavedDublinCoreMapping>>;
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
 * @internal Exported for its own test only (not from the package index):
 * today only system managers save definitions, so through the service this
 * check always passes; the test exercises its `records.publish` second line
 * directly with other people's access.
 *
 * D-076: the published records a change makes values public on. Every one
 * must be one the person may publish (`records.publish` where it is), else
 * `not_permitted` with no count; without `confirmPublished`, the refusal
 * lists them. `undefined` when the save may go on.
 */
export async function publishedGate(
  tx: Queryable,
  who: Who,
  checker: RecordAccess,
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
  if (!checker.access.systemManager) {
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

/**
 * Whether two versions of a template differ in anything that can decide
 * what the public sites show of a record using it or below one: the record
 * kinds it applies to, the set of keys, or anything in a field's definition
 * but its `label` and `help` (visibility, inheritance, kind, repeatability,
 * `maxLength`, list options with their labels, vocabularies, identifier
 * types, record kinds, standards, `required`). Public output drops an
 * inherited value that fails the child's field definition, so a field that
 * accepts more values can put a value that was never public on a published
 * child (review B5): every such change counts.
 */
export function publicShapeChanged(before: FieldTemplate, after: FieldTemplate): boolean {
  const shape = (t: FieldTemplate): string => {
    const fields: Record<string, string> = {};
    for (const f of t.fields) {
      const rest: Record<string, unknown> = { ...f };
      delete rest.label;
      delete rest.help;
      fields[f.key] = canonicalJson(rest);
    }
    return canonicalJson({ appliesTo: [...t.appliesTo].sort(), fields });
  };
  return shape(before) !== shape(after);
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
        // The arrangement lock first (for scoped grants), as record saves
        // take it before their definition locks (D-065, D-067), so the two
        // never wait for each other in opposite orders.
        const checker = new RecordAccess(tx, org, access.value);
        await checker.settle();
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
          // D-076: what the public sites show of a record depends on its own
          // template and, through inherited fields (D-013), on its ancestors'
          // templates: a key added or removed, or any change to a field's
          // definition but its label and help (public output drops an
          // inherited value the child's field refuses), can change the public
          // output of every record using this template and of every record
          // below one (a new inherited public key shows an ancestor's value
          // on a published child; a removed "stopper" key lets a
          // grandparent's value through). core's change list doesn't report
          // all of these (a new key no record holds is no change to it), so
          // the shapes are compared here, and every published record at or
          // below this template's records counts: a superset of those
          // whose output changes, never fewer.
          if (publicShapeChanged(current.value.template, template)) {
            const ids = records
              .map((r) => r.id)
              .filter((id): id is RecordId => typeof id === "string");
            affected = await publishedAmong(tx, org, ids, { below: true });
          }
        }
        const gate = await publishedGate(tx, who, checker, affected, confirmPublished.value);
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

    async readDublinCoreMapping(context, key) {
      return run("readDublinCoreMapping", context, async (tx, who) => {
        const access = await readerAccess(tx, who);
        if (!access.ok) return access;
        const unknown = refusal<DublinCoreMappingVersion>(
          ["key"],
          "unknown_template",
          "The organization has no such template.",
        );
        if (!isTemplateKey(key)) return unknown;
        const template = await readStoredTemplate(tx, who.organizationId, key);
        if (template === undefined) return unknown;
        const stored = await readStoredMapping(tx, who.organizationId, key);
        return {
          ok: true,
          value: Object.freeze({
            key,
            version: stored?.version ?? 0,
            mapping: stored?.mapping ?? null,
          }),
        };
      });
    },

    async saveDublinCoreMapping(context, key, mappingInput, saveOptions) {
      return run("saveDublinCoreMapping", context, async (tx, who) => {
        const org = who.organizationId;
        const access = await writerAccess(tx, who);
        if (!access.ok) return access;
        const changedBy = actorUser(who.actor);
        if (changedBy === undefined) return notPermitted();
        const opts = readOptions(saveOptions, ["expectedVersion", "confirmPublished"]);
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
            "Name the version the edit started from: 0 when the template has no mapping yet.",
          );
        }
        const confirmPublished = readConfirmPublished(opts.value);
        if (!confirmPublished.ok) return confirmPublished;
        const unknown = refusal<SavedDublinCoreMapping>(
          ["key"],
          "unknown_template",
          "The organization has no such template.",
        );
        if (!isTemplateKey(key)) return unknown;
        const copied = plainObject(mappingInput, "mapping");
        if (!copied.ok) return copied;
        const named = copied.value.organizationId;
        if (named !== undefined && named !== org) {
          return refusal(["organizationId"], "wrong_organization", WRONG_ORGANIZATION);
        }
        const namedTemplate = copied.value.template;
        if (namedTemplate !== undefined && namedTemplate !== key) {
          return refusal(["template"], "wrong_key", "The mapping's template is the address's.");
        }
        // The arrangement lock first (scoped grants), then the template's,
        // exclusively: the order record saves and template saves take them
        // in (D-065, D-067), so the template can't change under the check.
        const checker = new RecordAccess(tx, org, access.value);
        await checker.settle();
        await lockDefinition(tx, org, "template", key, true);
        const template = await readStoredTemplate(tx, org, key);
        if (template === undefined) return unknown;
        if (!template.ok) {
          return refusal(
            ["key"],
            "unreadable_template",
            "The stored template no longer reads as a template; it needs repair.",
          );
        }
        const valid = validateDublinCoreMapping(
          { ...copied.value, template: key, organizationId: org },
          template.value.template,
        );
        if (!valid.ok) return valid;
        // Public output refuses a mapping that leaves out the rights for the
        // kinds published only with them (core's `rights_not_mapped`), so
        // saving one would take every such published record off the public
        // sites at once: refused here with the same rule.
        const needsRights = template.value.template.appliesTo.some((k) =>
          (RIGHTS_REQUIRED_KINDS as readonly string[]).includes(k),
        );
        if (
          needsRights &&
          !valid.value.entries.some(
            (e) => e.field === RIGHTS_FIELD_KEY && (e.term === "rights" || e.term === "license"),
          )
        ) {
          return refusal(
            ["entries"],
            "rights_not_mapped",
            `The mapping must map the ${RIGHTS_FIELD_KEY} field to rights or license: this template's records can't be published without their rights.`,
          );
        }
        const stored = await readStoredMapping(tx, org, key, { lock: true });
        const storedVersion = stored?.version ?? 0;
        if (storedVersion !== expected) {
          return refusal(
            ["options", "expectedVersion"],
            "version_conflict",
            storedVersion === 0
              ? "This template has no mapping yet; save it as a new one (version 0)."
              : `The mapping was changed by someone else; it is now at version ${String(storedVersion)}. Read it again.`,
          );
        }
        // D-076: the mapping decides which public values go out as Dublin
        // Core (and in JSON-LD) for every published record using this
        // template, at once. Any change counts; an identical save doesn't.
        let affected: readonly RecordId[] | undefined = [];
        if (canonicalJson(stored?.mapping ?? null) !== canonicalJson(valid.value)) {
          // IDs only, under the lock (record saves and publishing wait).
          affected = await publishedUsingTemplate(tx, org, key);
        }
        const gate = await publishedGate(tx, who, checker, affected, confirmPublished.value);
        if (gate) return gate;
        const saved = await writeDublinCoreMapping(tx, valid.value, expected, changedBy);
        if (!saved.ok) return saved;
        return {
          ok: true,
          value: Object.freeze({
            key,
            version: saved.value.version,
            mapping: valid.value,
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
        const opts = readOptions(saveOptions, [
          "expectedTag",
          "confirm",
          "confirmPublished",
          "confirmDropped",
        ]);
        if (!opts.ok) return opts;
        const confirmDropped = opts.value.confirmDropped;
        if (
          confirmDropped !== undefined &&
          (!Array.isArray(confirmDropped) ||
            confirmDropped.length > 10_000 ||
            !confirmDropped.every((id) => typeof id === "string"))
        ) {
          return refusal(
            ["options", "confirmDropped"],
            "invalid_option",
            "confirmDropped lists the IDs of the published records the change takes off public sites.",
          );
        }
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
        // The arrangement lock first (scoped grants), then the type: the
        // order record saves take them in (D-067).
        const checker = new RecordAccess(tx, org, access.value);
        await checker.settle();
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
            type.public === true
              ? await publishedHoldingType(tx, org, type.key, { lock: true })
              : [];
          const gate = await publishedGate(tx, who, checker, affected, confirmPublished.value);
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
        // Called without `existing` on purpose: core then reports every
        // change that could affect records as needing confirmation, and the
        // D-076 list below is built from the database itself. With
        // `existing`, a format removed or a rule loosened on a public type
        // would list no records and slip through unconfirmed (third review).
        const compared = identifierTypeChanges(old, type);
        if (!compared.ok) return compared;
        // S-033 (D-091): a new format takes the published records whose
        // public number no longer fits it off the public sites. Which ones
        // is found from the published holders only (read under the type's
        // lock, which publishing waits on), and listed in the confirmation;
        // the confirmations themselves still come from the call above.
        let dropped: readonly RecordId[] = [];
        let formatSuffix = "";
        if (compared.value.changes.some((c) => c.code === "format_changed")) {
          const holders = await publishedHoldingType(tx, org, type.key);
          if (holders === undefined) {
            return refusal(
              [],
              "too_many_records",
              "Too many published records hold this type to check a new format here.",
            );
          }
          if (holders.length > 0) {
            // Which published records drop off is read from their public
            // fields' `{ type, value }` (core's publishedMisfits), so the
            // records and templates are all it needs; identifier sets would
            // only feed a count of misfits among these records, which isn't
            // asked (the message below keeps core's unchecked wording).
            const records = await readRecordsForChecks(tx, org, holders);
            const templates = (await listStoredTemplates(tx, org)).map((t) => t.template);
            const withUse = identifierTypeChanges(old, type, {
              identifierTypes: types.value,
              identifiers: [],
              records,
              templates,
              published: holders,
            });
            // Fails closed: a list that can't be made refuses the save.
            if (!withUse.ok) return withUse;
            const formatChange = withUse.value.changes.find((c) => c.code === "format_changed");
            dropped = formatChange?.publishedRecordIds ?? [];
          }
          if (dropped.length > 0) {
            const n = dropped.length;
            formatSuffix = ` ${n === 1 ? "1 published record" : `${String(n)} published records`} would show as not available on public sites until ${n === 1 ? "its number is" : "their numbers are"} fixed.`;
          }
        }
        const needed = compared.value.changes
          .filter((c) => c.needsConfirmation)
          .map((c) => ({
            code: c.code,
            key: c.type,
            message: c.code === "format_changed" ? `${c.message}${formatSuffix}` : c.message,
          }));
        const madePublic = compared.value.changes.some((c) => c.code === "made_public");
        const affected = madePublic ? await publishedHoldingType(tx, org, type.key) : [];
        // Listed with whichever confirmation is asked first, so the person
        // sees what the save takes off the public sites before any of it.
        const droppedIssues = dropped.map((id) =>
          issue(
            ["droppedFromPublic", id],
            "published_record_dropped",
            "This published record's number doesn't fit the new format; public sites would show it as not available.",
          ),
        );
        const gate = await publishedGate(tx, who, checker, affected, confirmPublished.value);
        if (gate) {
          return gate.ok || !gate.issues.some((i) => i.code === "publishes_records")
            ? gate
            : { ok: false, issues: [...gate.issues, ...droppedIssues] };
        }
        const notConfirmed = unconfirmed(needed, confirm.value);
        if (notConfirmed.length > 0) {
          return { ok: false, issues: [...notConfirmed, ...droppedIssues] };
        }
        // The confirmation is tied to the list: exactly these records,
        // as read now. A confirmation sent before seeing them, or before a
        // record was published meanwhile, asks again.
        const listed = new Set(Array.isArray(confirmDropped) ? (confirmDropped) : []);
        if (
          dropped.length > 0 &&
          (listed.size !== dropped.length || !dropped.every((id) => listed.has(id)))
        ) {
          return {
            ok: false,
            issues: [
              issue(
                ["confirmDropped"],
                "drops_published_records",
                `This change takes ${String(dropped.length)} published record(s) off the public sites. Check them, then confirm them (confirmDropped).`,
              ),
              ...droppedIssues,
            ],
          };
        }
        const saved = await updateIdentifierType(tx, type);
        if (!saved.ok) return saved;
        return {
          ok: true,
          value: Object.freeze({
            type: saved.value,
            tag: identifierTypeTag(saved.value),
            publishedRecords: Object.freeze([...(affected ?? [])]),
            droppedFromPublic: Object.freeze([...dropped]),
          }),
        };
      });
    },
  };
}
