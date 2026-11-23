// Shared test fixtures for public-output tests (not exported from the package).
import { publicViewOrigin } from "./effective-brand.js";
import {
  effectiveRecord,
  indexAccessions,
  isEffectiveRecord,
  makeIdentifierChecker,
  makeRecordLinkChecker,
  newOrganizationId,
  newRecordId,
  publicView,
  type ArchivalLevel,
  type CatalogRecord,
  type EffectiveRecord,
  type FieldDefinition,
  type FieldTemplate,
  type FieldValue,
  type FieldValueChecker,
  type PublicRecord,
  type RecordId,
  type RecordIdentifiers,
  type RecordKind,
  type AccessionRegister,
  type OrganizationId,
} from "./index.js";

export const T = "2026-11-20T16:05:00.000Z";
/** The one organization every fixture belongs to. */
export const ORG = newOrganizationId();
export const CNE = "http://rightsstatements.org/vocab/CNE/1.0/";
export const BASE = "https://archive.example.org/items/";
export const LCSH = "http://id.loc.gov/authorities/subjects/sh85111283";

type Def = Partial<FieldDefinition> & Pick<FieldDefinition, "key">;

export function field(def: Def): FieldDefinition {
  return {
    label: def.key.replace(/_/g, " "),
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...def,
  };
}

/** One field of every kind, plus staff fields that must never be output. */
export const FIELDS: readonly FieldDefinition[] = [
  field({ key: "rights", label: "Rights", kind: "rights", inherited: true }),
  field({ key: "description", label: "Description", kind: "long_text" }),
  field({ key: "date", label: "Date", kind: "date" }),
  field({
    key: "access",
    label: "Access",
    kind: "list",
    options: [
      { value: "open_code", label: "Open to all" },
      { value: "by_request", label: "By request" },
    ],
  }),
  field({ key: "subjects", label: "Subjects", kind: "controlled_term", repeatable: true }),
  field({ key: "number", label: "Number", kind: "identifier" }),
  field({ key: "website", label: "Website", kind: "link" }),
  field({ key: "places", label: "Places", kind: "place", repeatable: true }),
  field({ key: "creator", label: "Creator", inherited: true }),
  field({ key: "extent", label: "Extent" }),
  field({ key: "holder", label: "Rights holder" }),
  field({ key: "donor_note", label: "Donor note", visibility: "staff" }),
  field({ key: "family_secret", label: "Family", visibility: "staff", inherited: true }),
];

export function template(fields: readonly FieldDefinition[] = FIELDS, key = "out"): FieldTemplate {
  return {
    key,
    label: key,
    organizationId: ORG,
    appliesTo: ["object", "archival_unit", "digital_asset", "agent", "place", "event"],
    fields,
  };
}

export const TPL = template();

export const MAPPING = {
  organizationId: ORG,
  template: "out",
  entries: [
    { field: "rights", term: "rights" },
    { field: "description", term: "description" },
    { field: "date", term: "created" },
    { field: "access", term: "accessRights" },
    { field: "subjects", term: "subject" },
    { field: "number", term: "identifier" },
    { field: "website", term: "relation" },
    { field: "places", term: "spatial" },
    { field: "creator", term: "creator" },
    { field: "holder", term: "rightsHolder" },
  ],
};

export function record(
  kind: RecordKind,
  title: string,
  fields: Readonly<Record<string, FieldValue>>,
  extra: Readonly<Record<string, unknown>> = {},
  id: RecordId = newRecordId(),
): CatalogRecord {
  const base = { id, title, organizationId: ORG, createdAt: T, updatedAt: T, fields };
  const byKind: Record<RecordKind, Record<string, unknown>> = {
    object: {},
    archival_unit: { level: "item" satisfies ArchivalLevel },
    digital_asset: { mediaType: "image/tiff" },
    agent: { agentType: "organization" },
    place: {},
    event: {},
  };
  return { kind, ...base, ...byKind[kind], ...extra } as CatalogRecord;
}

// Both types are public, so their values may be published; the type key
// itself must still never appear in output. `donor_file_number` is staff
// only (the default), so its values must never be published (D-022).
const identifierChecker = makeIdentifierChecker([
  {
    key: "accession_number",
    label: "Accession number",
    organizationId: ORG,
    uniqueness: "none",
    public: true,
  },
  {
    key: "secret_type_code",
    label: "Secret type",
    organizationId: ORG,
    uniqueness: "none",
    public: true,
  },
  { key: "donor_file_number", label: "Donor file number", organizationId: ORG, uniqueness: "none" },
]);
if (!identifierChecker.ok) throw new Error("identifier types");
/** The checkers publicOutput needs for the fixtures' identifier field. */
export const CHECKERS = Object.freeze({ identifier: identifierChecker.value });

/**
 * Each record's identifiers, holding as current exactly the `{ type, value }`
 * numbers its fields show (D-038: a field only points at a number the record
 * holds), the first one primary.
 */
export function identifiersFor(records: readonly CatalogRecord[]): RecordIdentifiers[] {
  return records.map((r) => {
    const current: { type: string; value: string; primary: boolean }[] = [];
    for (const value of Object.values(r.fields)) {
      const items: readonly unknown[] = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const { type, value: text, ...rest } = item as Record<string, unknown>;
        if (
          Object.keys(rest).length === 0 &&
          typeof type === "string" &&
          typeof text === "string" &&
          !current.some((c) => c.type === type && c.value === text)
        ) {
          current.push({ type, value: text, primary: current.length === 0 });
        }
      }
    }
    return { recordId: r.id, organizationId: r.organizationId, current, former: [] };
  });
}

/** A record link checker made from `records` (D-039). */
export function linkChecker(records: readonly CatalogRecord[]): FieldValueChecker {
  const made = makeRecordLinkChecker(records);
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  return made.value;
}

export function effectiveOf(
  records: readonly CatalogRecord[],
  id: RecordId,
  tpl: FieldTemplate = TPL,
): EffectiveRecord {
  // With the identifier checker, so public-type numbers reach the view
  // (D-022), and the records' identifiers, which hold them (D-038).
  const result = effectiveRecord(id, records, () => tpl, {
    checkers: CHECKERS,
    identifiers: identifiersFor(records),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

const VIEW_IDENTIFIERS = new WeakMap<object, RecordIdentifiers[]>();

/** The identifiers a view from `viewOf` was built with, to pass to publicOutput (D-038). */
export function idsOf(view: PublicRecord): RecordIdentifiers[] {
  return VIEW_IDENTIFIERS.get(view) ?? [];
}

export function viewOf(
  records: readonly CatalogRecord[],
  id: RecordId,
  tpl: FieldTemplate = TPL,
): PublicRecord {
  const view = publicView(effectiveOf(records, id, tpl));
  if (view === undefined) throw new Error("no public view");
  VIEW_IDENTIFIERS.set(view, identifiersFor(records));
  return view;
}

/** Every output form as one string, for "never appears" checks. */
export function everything(out: {
  readonly dublinCore: unknown;
  readonly jsonLd: unknown;
  readonly jsonLdText: string;
  readonly oaiDcXml: string;
  readonly id: string;
}): string {
  return [
    out.id,
    JSON.stringify(out.dublinCore),
    JSON.stringify(out.jsonLd),
    out.jsonLdText,
    out.oaiDcXml,
  ].join("\n");
}

/** The mapping entry kinds that need rights must have. */
export const RIGHTS_ENTRY = Object.freeze({ field: "rights", term: "rights" });

/**
 * An organization's accession register with no accessions, made from
 * `records` (D-043): it knows those records and holds none back.
 */
/** The organization's day the fixtures' registers are made on (invented). */
export const TODAY = "2026-11-23";

export function noAccessions(
  organizationId: OrganizationId,
  records: readonly CatalogRecord[] = [],
): AccessionRegister {
  const made = indexAccessions(organizationId, {
    accessions: [],
    records,
    identifierTypes: [],
    today: TODAY,
  });
  if (!made.ok) throw new Error(JSON.stringify(made.issues));
  return made.value;
}

/**
 * A register with no accessions that knows the records a public view (or
 * effective record) was made from, so publishing it needs no deed (D-043).
 * For anything else, an empty register of the fixtures' organization.
 */
export function accessionsFor(viewOrEffective: unknown): AccessionRegister {
  const view = isEffectiveRecord(viewOrEffective)
    ? publicView(viewOrEffective as EffectiveRecord)
    : viewOrEffective;
  const origin = publicViewOrigin(view);
  if (origin === undefined) return noAccessions(ORG);
  const records = origin.chain.map((step) => step.record);
  return noAccessions(records[0]?.organizationId ?? ORG, records);
}
