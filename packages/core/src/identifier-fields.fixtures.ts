// Shared test fixtures for the identifier-fields tests (not exported from the package).
import {
  newOrganizationId,
  newRecordId,
  type CatalogRecord,
  type FieldTemplate,
  type FieldValue,
  type RecordIdentifiers,
} from "./index.js";

export const ORG = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";

export const TPL: FieldTemplate = {
  key: "objects",
  label: "Objects",
  organizationId: ORG,
  appliesTo: ["object"],
  fields: [
    {
      key: "object_number",
      label: "Object number",
      kind: "identifier",
      required: true,
      repeatable: false,
      visibility: "public",
      inherited: false,
    },
    {
      key: "other_numbers",
      label: "Other numbers",
      kind: "identifier",
      required: false,
      repeatable: true,
      visibility: "staff",
      inherited: false,
    },
    {
      key: "description",
      label: "Description",
      kind: "long_text",
      required: false,
      repeatable: false,
      visibility: "public",
      inherited: false,
    },
  ],
};

export function object(fields: Record<string, FieldValue>, organizationId = ORG): CatalogRecord {
  return {
    kind: "object",
    id: newRecordId(),
    title: "Postcard",
    organizationId,
    createdAt: T,
    updatedAt: T,
    fields,
  };
}

export function identifiersOf(
  record: CatalogRecord,
  current: { type: string; value: string; primary: boolean }[],
  former: { type: string; value: string }[] = [],
): RecordIdentifiers {
  return { recordId: record.id, organizationId: record.organizationId, current, former };
}
