// Shared test fixtures for public-output tests (not exported from the package).
import {
  effectiveRecord,
  newRecordId,
  publicView,
  type ArchivalLevel,
  type CatalogRecord,
  type EffectiveRecord,
  type FieldDefinition,
  type FieldTemplate,
  type FieldValue,
  type PublicRecord,
  type RecordId,
  type RecordKind,
} from "./index.js";

export const T = "2026-11-20T16:05:00.000Z";
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
    appliesTo: ["object", "archival_unit", "digital_asset", "agent", "place", "event"],
    fields,
  };
}

export const TPL = template();

export const MAPPING = {
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
  const base = { id, title, createdAt: T, updatedAt: T, fields };
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

export function effectiveOf(
  records: readonly CatalogRecord[],
  id: RecordId,
  tpl: FieldTemplate = TPL,
): EffectiveRecord {
  const result = effectiveRecord(id, records, () => tpl);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

export function viewOf(
  records: readonly CatalogRecord[],
  id: RecordId,
  tpl: FieldTemplate = TPL,
): PublicRecord {
  const view = publicView(effectiveOf(records, id, tpl));
  if (view === undefined) throw new Error("no public view");
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
