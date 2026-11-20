import { describe, expect, it } from "vitest";
import { isRecordId, newRecordId, parseRecordId } from "./index.js";

describe("newRecordId", () => {
  it("makes a valid version 4 UUID", () => {
    const id = newRecordId();
    expect(isRecordId(id)).toBe(true);
    expect(id[14]).toBe("4");
  });

  it("makes a different ID every time", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newRecordId()));
    expect(ids.size).toBe(1000);
  });
});

describe("isRecordId", () => {
  it("accepts a lowercase v4 UUID", () => {
    expect(isRecordId("3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c")).toBe(true);
  });

  it.each([
    ["upper case", "3F1C2A9E-8B7D-4C6E-9A1B-2D3E4F5A6B7C"],
    ["version 1", "3f1c2a9e-8b7d-1c6e-9a1b-2d3e4f5a6b7c"],
    ["bad variant", "3f1c2a9e-8b7d-4c6e-7a1b-2d3e4f5a6b7c"],
    ["no dashes", "3f1c2a9e8b7d4c6e9a1b2d3e4f5a6b7c"],
    ["trailing text", "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c\n"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(isRecordId(value)).toBe(false);
  });

  it.each([undefined, null, 42, {}, ["3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c"]])(
    "rejects non-string %j",
    (value) => {
      expect(isRecordId(value)).toBe(false);
    },
  );
});

describe("parseRecordId", () => {
  it("trims and lowercases a hand-copied ID", () => {
    expect(parseRecordId("  3F1C2A9E-8B7D-4C6E-9A1B-2D3E4F5A6B7C ")).toBe(
      "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c",
    );
  });

  it("returns undefined for anything that is not an ID", () => {
    expect(parseRecordId("DHS-0001")).toBeUndefined();
    expect(parseRecordId("../3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c")).toBeUndefined();
    expect(parseRecordId(7)).toBeUndefined();
  });
});
