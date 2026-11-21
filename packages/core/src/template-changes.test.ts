import { describe, expect, it } from "vitest";
import { templateChanges, type TemplateChange, type TemplateChanges } from "./index.js";

const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const B = "4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const C = "5b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

function field(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "note",
    label: "Note",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "staff",
    inherited: false,
    ...extra,
  };
}

function template(...fields: Record<string, unknown>[]): Record<string, unknown> {
  return { key: "t", label: "T", appliesTo: ["object"], fields };
}

function record(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { kind: "object", id, title: "Postcard", createdAt: T, updatedAt: T, fields };
}

function run(oldT: unknown, newT: unknown, records?: unknown): TemplateChanges {
  const result = templateChanges(oldT, newT, records);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function summary(changes: readonly TemplateChange[]): [string, string, boolean][] {
  return changes.map((c) => [c.code, c.key, c.needsConfirmation]);
}

const TITLE = field({ key: "summary", label: "Summary", visibility: "public" });

describe("templateChanges", () => {
  it("reports nothing for the same template", () => {
    const t = template(TITLE, field());
    const r = run(t, t, [record(A, { note: "x" })]);
    expect(r.changes).toEqual([]);
    expect(r.needsConfirmation).toBe(false);
    expect(r.recordsChecked).toBe(true);
  });

  it("reports staff to public, with the records holding a value", () => {
    const r = run(template(field()), template(field({ visibility: "public" })), [
      record(A, { note: "x" }),
      record(B, {}),
    ]);
    expect(summary(r.changes)).toEqual([["made_public", "note", true]]);
    expect(r.changes[0]?.recordIds).toEqual([A]);
    expect(r.changes[0]?.recordCount).toBe(1);
    expect(r.needsConfirmation).toBe(true);
  });

  it("needs confirmation to make a field public even when no record holds a value", () => {
    const r = run(template(field()), template(field({ visibility: "public" })), []);
    expect(summary(r.changes)).toEqual([["made_public", "note", true]]);
    expect(r.changes[0]?.recordIds).toEqual([]);
  });

  it("works without records, and says they weren't checked", () => {
    const r = run(template(TITLE, field()), template(TITLE));
    expect(r.recordsChecked).toBe(false);
    expect(summary(r.changes)).toEqual([["key_removed", "note", true]]);
    expect(r.changes[0]?.message).toContain("weren't checked");
  });

  it("reports a removed key, and needs confirmation only when records hold values", () => {
    const oldT = template(TITLE, field());
    expect(summary(run(oldT, template(TITLE), [record(A, { note: "x" })]).changes)).toEqual([
      ["key_removed", "note", true],
    ]);
    expect(summary(run(oldT, template(TITLE), [record(A, {})]).changes)).toEqual([
      ["key_removed", "note", false],
    ]);
  });

  it("reports a left-over key reused by a new staff field", () => {
    const r = run(template(TITLE), template(TITLE, field()), [record(A, { note: "x" })]);
    expect(summary(r.changes)).toEqual([["key_reused", "note", true]]);
    expect(r.changes[0]?.recordIds).toEqual([A]);
  });

  it("says nothing about a new field no record holds a value for", () => {
    expect(run(template(TITLE), template(TITLE, field()), [record(A, {})]).changes).toEqual([]);
  });

  it("reports a change of kind", () => {
    const r = run(template(field()), template(field({ kind: "long_text" })), [
      record(A, { note: "x" }),
    ]);
    expect(summary(r.changes)).toEqual([["kind_changed", "note", true]]);
  });

  it("reports a field that stops repeating, with the records holding several values", () => {
    const r = run(template(field({ repeatable: true })), template(field()), [
      record(A, { note: ["x"] }),
      record(B, { note: ["x", "y"] }),
      record(C, {}),
    ]);
    expect(summary(r.changes)).toEqual([["repeatable_changed", "note", true]]);
    expect(r.changes[0]?.recordIds).toEqual([A, B]);
    expect(r.changes[0]?.recordsWithSeveralValues).toEqual([B]);
    expect(r.changes[0]?.message).toContain("1 record hold more than one value");
  });

  it("reports a field that starts repeating", () => {
    const r = run(template(field()), template(field({ repeatable: true })), [
      record(A, { note: "x" }),
    ]);
    expect(summary(r.changes)).toEqual([["repeatable_changed", "note", true]]);
    expect(r.changes[0]?.recordsWithSeveralValues).toBeUndefined();
  });

  it("reports a removed list option with the records that use it", () => {
    const opt = (...values: string[]) => values.map((value) => ({ value, label: value }));
    const oldT = template(
      field({ key: "format", kind: "list", repeatable: true, options: opt("a", "b", "c") }),
    );
    const newT = template(
      field({ key: "format", kind: "list", repeatable: true, options: opt("a") }),
    );
    const r = run(oldT, newT, [
      record(A, { format: ["a", "b"] }),
      record(B, { format: ["c"] }),
      record(C, { format: ["a"] }),
    ]);
    expect(r.changes.map((c) => [c.code, c.option, c.recordIds])).toEqual([
      ["option_removed", "b", [A]],
      ["option_removed", "c", [B]],
    ]);
  });

  it("reports no longer inherited and public-to-staff changes as information only", () => {
    const r = run(template(field({ visibility: "public", inherited: true })), template(field()), [
      record(A, { note: "x" }),
    ]);
    expect(summary(r.changes)).toEqual([
      ["inherited_changed", "note", false],
      ["made_staff", "note", false],
    ]);
    expect(r.needsConfirmation).toBe(false);
  });

  it("reports an added record kind, needing confirmation only with a public field", () => {
    const pub = template(TITLE);
    const r = run(pub, { ...pub, appliesTo: ["object", "digital_asset"] }, [record(A, {})]);
    expect(summary(r.changes)).toEqual([["kind_added", "digital_asset", true]]);
    expect(r.changes[0]?.recordCount).toBe(0);
    const staff = template(field());
    expect(
      summary(run(staff, { ...staff, appliesTo: ["object", "event"] }, [record(A, {})]).changes),
    ).toEqual([["kind_added", "event", false]]);
  });

  it("needs confirmation when a field starts being inherited", () => {
    const r = run(template(field()), template(field({ inherited: true })), []);
    expect(summary(r.changes)).toEqual([["inherited_changed", "note", true]]);
  });

  it("needs confirmation to remove an inherited field even when no record holds a value", () => {
    const r = run(template(TITLE, field({ inherited: true })), template(TITLE), [record(A, {})]);
    expect(summary(r.changes)).toEqual([["key_removed", "note", true]]);
  });

  it("reports every added field when records weren't given", () => {
    const pub = field({ key: "extra", visibility: "public" });
    const r = run(template(TITLE), template(TITLE, field(), pub));
    expect(summary(r.changes)).toEqual([
      ["key_reused", "note", true],
      ["made_public", "extra", true],
      ["key_reused", "extra", true],
    ]);
    expect(r.changes[1]?.message).toContain("weren't checked");
  });

  it("reports a lower maxLength with the records holding longer values", () => {
    const r = run(template(field()), template(field({ maxLength: 3 })), [
      record(A, { note: "abcd" }),
      record(B, { note: "abc" }),
    ]);
    expect(summary(r.changes)).toEqual([["max_length_lowered", "note", true]]);
    expect(r.changes[0]?.recordIds).toEqual([A]);
    const none = run(template(field()), template(field({ maxLength: 3 })), [
      record(B, { note: "a" }),
    ]);
    expect(summary(none.changes)).toEqual([["max_length_lowered", "note", false]]);
    expect(summary(run(template(field({ maxLength: 3 })), template(field())).changes)).toEqual([]);
  });

  it("reports a dropped vocabulary with the records using it, local terms included", () => {
    const term = (extra: Record<string, unknown>) =>
      field({ key: "subject", kind: "controlled_term", repeatable: true, ...extra });
    const r = run(
      template(term({ vocabularies: ["lcsh", "local"] })),
      template(term({ vocabularies: ["lcsh"] })),
      [
        record(A, { subject: [{ label: "Ships", vocabulary: "lcsh" }] }),
        record(B, { subject: [{ label: "Ships" }] }),
      ],
    );
    expect(r.changes.map((c) => [c.code, c.removedCodes, c.recordIds])).toEqual([
      ["vocabulary_removed", ["local"], [B]],
    ]);
    const fromAny = run(template(term({})), template(term({ vocabularies: ["lcsh"] })), [
      record(B, { subject: [{ label: "Ships" }] }),
    ]);
    expect(fromAny.changes.map((c) => [c.code, c.removedCodes, c.recordIds])).toEqual([
      ["vocabulary_removed", [], [B]],
    ]);
  });

  it("reports a dropped identifier type with the records using it", () => {
    const id = (types?: string[]) =>
      field({ key: "ref", kind: "identifier", ...(types ? { identifierTypes: types } : {}) });
    const r = run(template(id(["accession", "call-number"])), template(id(["accession"])), [
      record(A, { ref: { type: "call-number", value: "1" } }),
      record(B, { ref: { type: "accession", value: "2" } }),
    ]);
    expect(r.changes.map((c) => [c.code, c.removedCodes, c.recordIds])).toEqual([
      ["identifier_type_removed", ["call-number"], [A]],
    ]);
  });

  it("reports a field made required with the records lacking it", () => {
    const r = run(template(field()), template(field({ required: true })), [
      record(A, { note: "x" }),
      record(B, {}),
    ]);
    expect(summary(r.changes)).toEqual([["made_required", "note", true]]);
    expect(r.changes[0]?.recordIds).toEqual([B]);
    const unknown = run(template(field()), template(field({ required: true })));
    expect(summary(unknown.changes)).toEqual([["made_required", "note", true]]);
  });

  it("refuses two different templates", () => {
    const result = templateChanges(template(field()), { ...template(field()), key: "other" });
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(["different_template"]);
  });

  it("refuses invalid templates, saying which", () => {
    const result = templateChanges(template(field()), template(field({ visibility: "maybe" })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path.slice(0, 1)).toEqual(["newTemplate"]);
  });

  it("returns frozen results", () => {
    const r = run(template(field()), template(field({ visibility: "public" })), [
      record(A, { note: "x" }),
    ]);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.changes)).toBe(true);
    expect(Object.isFrozen(r.changes[0])).toBe(true);
    expect(Object.isFrozen(r.changes[0]?.recordIds)).toBe(true);
  });
});
