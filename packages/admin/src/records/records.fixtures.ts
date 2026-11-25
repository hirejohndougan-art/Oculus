/**
 * Invented data for the item screens' tests (T-046): a site, a template,
 * records and the replies the staff API gives for them.
 */
import { ORG_A, SITE_1 } from "../testing.fixtures";
import type {
  FieldTemplate,
  ReadRecordReply,
  RecordAbilities,
  StoredRecord,
  WorkflowState,
} from "./model";

export const A1 = {
  siteId: SITE_1,
  organizationId: ORG_A,
  siteName: "Invented archive site",
  organizationName: "Invented Archive",
};

export const RECORD_ID = "11111111-1111-4111-8111-111111111111";
export const PARENT_ID = "22222222-2222-4222-8222-222222222222";

export const TEMPLATE: FieldTemplate = {
  key: "t-object",
  label: "Invented object",
  appliesTo: ["object"],
  fields: [
    {
      key: "note",
      label: "Note",
      kind: "text",
      required: true,
      repeatable: false,
      visibility: "public",
      inherited: false,
      help: "What it is.",
    },
    {
      key: "provenance",
      label: "Provenance",
      kind: "long_text",
      required: false,
      repeatable: false,
      visibility: "public",
      inherited: true,
    },
    {
      key: "shelf",
      label: "Shelf",
      kind: "text",
      required: false,
      repeatable: false,
      visibility: "staff",
      inherited: false,
    },
    {
      key: "condition",
      label: "Condition",
      kind: "list",
      required: false,
      repeatable: false,
      visibility: "public",
      inherited: false,
      options: [
        { value: "good", label: "Good" },
        { value: "poor", label: "Poor" },
      ],
    },
    {
      key: "links",
      label: "Web link",
      kind: "link",
      required: false,
      repeatable: true,
      visibility: "public",
      inherited: false,
    },
  ],
};

export const TEMPLATES_REPLY = { templates: [{ key: "t-object", version: 1, template: TEMPLATE }] };
export const TYPES_REPLY = {
  recordTypes: [
    { key: "lantern", label: "Lantern", kind: "object", defaultTemplateKey: "t-object" },
  ],
};

export const STORED: StoredRecord = {
  id: RECORD_ID,
  organizationId: ORG_A,
  siteId: SITE_1,
  kind: "object",
  title: "An invented lantern",
  templateKey: "t-object",
  createdAt: "2026-11-24T10:00:00.000Z",
  updatedAt: "2026-11-24T11:00:00.000Z",
  fields: { note: "Tin.", links: [{ url: "javascript:alert(1)", label: "Bad link" }] },
};

export const ALL: RecordAbilities = { edit: true, history: true, publish: true, delete: true };
export const CATALOGER: RecordAbilities = {
  edit: true,
  history: true,
  publish: false,
  delete: false,
};
export const READER: RecordAbilities = {
  edit: false,
  history: false,
  publish: false,
  delete: false,
};

export function recordReply(
  change: {
    state?: WorkflowState;
    can?: RecordAbilities;
    version?: number;
    record?: Partial<StoredRecord>;
    inherited?: ReadRecordReply["inherited"];
  } = {},
): ReadRecordReply {
  return {
    record: { ...STORED, ...change.record },
    version: change.version ?? 3,
    state: change.state ?? "draft",
    can: change.can ?? CATALOGER,
    inherited: change.inherited ?? [],
  };
}

export const VERSIONS_REPLY = {
  versions: [
    {
      version: 1,
      actor: "user:00000000-0000-4000-8000-0000000000ff",
      recordedAt: "2026-11-24T10:00:00.000Z",
      changedFields: ["title", "fields.note"],
      action: "save",
      workflowState: "draft",
    },
    {
      version: 2,
      actor: "user:00000000-0000-4000-8000-0000000000ee",
      recordedAt: "2026-11-24T10:30:00.000Z",
      changedFields: ["fields.note"],
      action: "save",
      workflowState: "draft",
    },
    {
      version: 3,
      actor: "user:00000000-0000-4000-8000-0000000000ee",
      recordedAt: "2026-11-24T11:00:00.000Z",
      changedFields: ["workflowState"],
      action: "submit_for_review",
      workflowState: "ready_for_review",
    },
  ],
  next: null,
};
