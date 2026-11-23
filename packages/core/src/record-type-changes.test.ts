// T-013a: record type edits and deletions list the records they strand (D-037, D-053).
import { describe, expect, it } from "vitest";
import {
  RECORD_TYPE_CHANGE_CODES,
  newOrganizationId,
  recordTypeChanges,
  recordTypeDeletion,
  type RecordType,
  type RecordTypeChanges,
  type Validated,
} from "./index.js";

// Invented sample data.
const ORG = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const C = "5b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

const ORAL: RecordType = {
  key: "oral-history",
  organizationId: ORG,
  label: "Oral history",
  kind: "digital_asset",
  defaultTemplateKey: "oral-history",
};
const PHOTO: RecordType = {
  key: "photograph",
  organizationId: ORG,
  label: "Photograph",
  kind: "object",
  defaultTemplateKey: "objects",
};

function record(
  id: string,
  kind: string,
  recordTypeKey?: string,
  org: string = ORG,
): Record<string, unknown> {
  return {
    kind,
    organizationId: org,
    id,
    title: "Interview",
    createdAt: T,
    updatedAt: T,
    templateKey: "oral-history",
    ...(kind === "digital_asset" ? { mediaType: "audio/wav" } : {}),
    ...(recordTypeKey === undefined ? {} : { recordTypeKey }),
    fields: {},
  };
}

const RECORDS = [
  record(A, "digital_asset", "oral-history"),
  record(B, "object", "oral-history"),
  record(C, "object", "photograph"),
];

function use(records: unknown = RECORDS, recordTypes: unknown = [ORAL, PHOTO]): unknown {
  return { recordTypes, records };
}

function ok(result: Validated<RecordTypeChanges>): RecordTypeChanges {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

describe("recordTypeChanges", () => {
  it("fixtures are valid records", () => {
    const r = ok(recordTypeDeletion(ORAL, use()));
    expect(r.recordsChecked).toBe(true);
  });

  it("reports nothing for a label, description or default template edit", () => {
    const r = ok(
      recordTypeChanges(
        ORAL,
        {
          ...ORAL,
          label: "Oral histories",
          description: "Recorded interviews.",
          defaultTemplateKey: "audio",
        },
        use(),
      ),
    );
    expect(r.changes).toEqual([]);
    expect(r.needsConfirmation).toBe(false);
    expect(r.recordsChecked).toBe(true);
  });

  it("lists the records naming a renamed key", () => {
    const r = ok(recordTypeChanges(ORAL, { ...ORAL, key: "interview" }, use()));
    expect(r.changes.map((c) => c.code)).toEqual(["key_changed"]);
    const c = r.changes[0];
    expect(c?.type).toBe("oral-history");
    expect(c?.recordIds).toEqual([A, B]);
    expect(c?.recordCount).toBe(2);
    expect(c?.needsConfirmation).toBe(true);
    expect(c?.message).toContain('"interview"');
    expect(c?.message).toContain("2 records name the old key");
    expect(r.needsConfirmation).toBe(true);
  });

  it("a rename no record uses is informational", () => {
    const r = ok(recordTypeChanges(ORAL, { ...ORAL, key: "interview" }, use([RECORDS[2]])));
    expect(r.changes[0]?.needsConfirmation).toBe(false);
    expect(r.changes[0]?.message).toContain("No record is affected.");
    expect(r.needsConfirmation).toBe(false);
  });

  it("refuses a new key another type has", () => {
    const r = recordTypeChanges(ORAL, { ...ORAL, key: "photograph" }, use());
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(["key_taken"]);
  });

  it("reports records already naming the new key, left from a deleted type", () => {
    const left = [
      ...RECORDS,
      record("6c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f", "digital_asset", "interview"),
    ];
    const r = ok(recordTypeChanges(ORAL, { ...ORAL, key: "interview" }, use(left)));
    expect(r.changes.map((c) => c.code)).toEqual(["key_changed", "key_adopts_records"]);
    const adopt = r.changes[1];
    expect(adopt?.type).toBe("interview");
    expect(adopt?.recordCount).toBe(1);
    expect(adopt?.mismatchRecordIds).toEqual([]);
    expect(adopt?.mismatchCount).toBe(0);
    expect(adopt?.needsConfirmation).toBe(true);
    expect(adopt?.message).toMatch(/^1 record already names the key "interview"/);
  });

  it("adopted records of another kind are listed as mismatched", () => {
    const left = [
      ...RECORDS,
      record("6c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f", "object", "interview"),
    ];
    const r = ok(recordTypeChanges(ORAL, { ...ORAL, key: "interview" }, use(left)));
    const adopt = r.changes.find((c) => c.code === "key_adopts_records");
    expect(adopt?.mismatchRecordIds).toEqual(["6c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f"]);
    expect(adopt?.mismatchCount).toBe(1);
    expect(adopt?.message).toContain("1 record is of another kind");
  });

  it("lists the type's records of another kind after a kind change", () => {
    const r = ok(recordTypeChanges(ORAL, { ...ORAL, kind: "object" }, use()));
    expect(r.changes.map((c) => c.code)).toEqual(["kind_changed"]);
    expect(r.changes[0]?.recordIds).toEqual([A]);
    expect(r.changes[0]?.needsConfirmation).toBe(true);
    expect(r.changes[0]?.message).toContain("kind object");
    expect(r.changes[0]?.message).toContain("1 record of this type is of another kind");
  });

  it("a kind change matching every record is informational", () => {
    const r = ok(
      recordTypeChanges(ORAL, { ...ORAL, kind: "object" }, use([RECORDS[1], RECORDS[2]])),
    );
    expect(r.changes[0]?.recordCount).toBe(0);
    expect(r.needsConfirmation).toBe(false);
  });

  it("reports a rename and a kind change together, in code order", () => {
    const r = ok(recordTypeChanges(ORAL, { ...ORAL, key: "interview", kind: "object" }, use()));
    expect(r.changes.map((c) => c.code)).toEqual(["key_changed", "kind_changed"]);
    expect(r.changes[1]?.recordIds).toEqual([A]);
    const order = r.changes.map((c) => RECORD_TYPE_CHANGE_CODES.indexOf(c.code));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("without existing, every change needs confirmation and adoption is possible", () => {
    const r = ok(recordTypeChanges(ORAL, { ...ORAL, key: "interview", kind: "object" }));
    expect(r.recordsChecked).toBe(false);
    expect(r.changes.map((c) => c.code)).toEqual([
      "unverified",
      "key_changed",
      "key_adopts_records",
      "kind_changed",
    ]);
    expect(r.changes.every((c) => c.needsConfirmation)).toBe(true);
    expect(r.changes[1]?.message).toContain("Records weren't checked");
  });

  it("records without a type are ignored", () => {
    const r = ok(recordTypeDeletion(ORAL, use([record(A, "digital_asset")])));
    expect(r.changes[0]?.recordCount).toBe(0);
    expect(r.needsConfirmation).toBe(false);
  });

  it("results are frozen", () => {
    const r = ok(recordTypeChanges(ORAL, { ...ORAL, key: "interview" }, use()));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.changes)).toBe(true);
    expect(Object.isFrozen(r.changes[0])).toBe(true);
    expect(Object.isFrozen(r.changes[0]?.recordIds)).toBe(true);
  });
});

describe("recordTypeDeletion", () => {
  it("lists the records naming the type", () => {
    const r = ok(recordTypeDeletion(ORAL, use()));
    expect(r.changes.map((c) => c.code)).toEqual(["type_deleted"]);
    expect(r.changes[0]?.recordIds).toEqual([A, B]);
    expect(r.needsConfirmation).toBe(true);
    expect(r.changes[0]?.message).toContain(
      'The record type "oral-history" is deleted. 2 records name it.',
    );
  });

  it("deleting an unused type needs no confirmation", () => {
    const r = ok(recordTypeDeletion(PHOTO, use([RECORDS[0]])));
    expect(r.needsConfirmation).toBe(false);
  });

  it("without existing it needs confirmation", () => {
    const r = ok(recordTypeDeletion(ORAL));
    expect(r.recordsChecked).toBe(false);
    expect(r.needsConfirmation).toBe(true);
  });

  it("refuses a type that differs from the organization's list", () => {
    const r = recordTypeDeletion({ ...ORAL, label: "Changed" }, use());
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(["type_not_listed"]);
    const missing = recordTypeDeletion(ORAL, use(RECORDS, [PHOTO]));
    expect(missing.ok ? [] : missing.issues.map((i) => i.code)).toEqual(["type_not_listed"]);
  });

  it("an empty list of records means none", () => {
    const r = ok(recordTypeDeletion(ORAL, use([])));
    expect(r.recordsChecked).toBe(true);
    expect(r.changes[0]?.recordCount).toBe(0);
  });
});
