import { describe, expect, it } from "vitest";
import { identifierFieldIssues, retireIdentifier } from "./index.js";
import { TPL, identifiersOf, object } from "./identifier-fields.fixtures.js";

const OBJ = { type: "object_number", value: "2026.015" };
const FIELD = { type: "field_number", value: "F-7" };

function codes(list: readonly { code: string }[]): string[] {
  return list.map((i) => i.code);
}

describe("identifierFieldIssues: a field shows one of the record's current identifiers", () => {
  it("accepts fields that point at current identifiers, primary or not", () => {
    const r = object({ object_number: OBJ, other_numbers: [FIELD], description: "A card" });
    const ids = identifiersOf(r, [
      { ...OBJ, primary: true },
      { ...FIELD, primary: false },
    ]);
    expect(identifierFieldIssues(r, TPL, ids)).toEqual([]);
  });

  it("accepts a record with no identifier values stored, and empty lists", () => {
    const r = object({ other_numbers: [] });
    expect(identifierFieldIssues(r, TPL, identifiersOf(r, []))).toEqual([]);
  });

  it("reports a number typed into a field and nowhere else, naming the field, never the value", () => {
    const r = object({ object_number: OBJ });
    const found = identifierFieldIssues(r, TPL, identifiersOf(r, []));
    expect(codes(found)).toEqual(["identifier_not_held"]);
    expect(found[0]?.path).toEqual(["fields", "object_number"]);
    expect(found[0]?.message).toContain("Object number");
    expect(found[0]?.message).not.toContain("2026.015");
  });

  it("reports each number of a list that isn't held, by its position", () => {
    const r = object({ other_numbers: [FIELD, { type: "field_number", value: "F-8" }] });
    const found = identifierFieldIssues(r, TPL, identifiersOf(r, [{ ...FIELD, primary: true }]));
    expect(found.map((i) => i.path)).toEqual([["fields", "other_numbers", 1]]);
  });

  it("reports a number once it is retired, until the field is changed", () => {
    const r = object({ object_number: OBJ });
    const ids = identifiersOf(r, [
      { ...OBJ, primary: true },
      { type: "object_number", value: "2026.016", primary: false },
    ]);
    expect(identifierFieldIssues(r, TPL, ids)).toEqual([]);
    const retired = retireIdentifier(ids, OBJ, {
      newPrimary: { type: "object_number", value: "2026.016" },
    });
    if (!retired.ok) throw new Error("retire");
    expect(codes(identifierFieldIssues(r, TPL, retired.value))).toEqual(["identifier_not_held"]);
    const moved = { ...r, fields: { object_number: { type: "object_number", value: "2026.016" } } };
    expect(identifierFieldIssues(moved, TPL, retired.value)).toEqual([]);
  });

  it("returns frozen results", () => {
    const r = object({ object_number: OBJ });
    const found = identifierFieldIssues(r, TPL, identifiersOf(r, []));
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found[0])).toBe(true);
  });
});
