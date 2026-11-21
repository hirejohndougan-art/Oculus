// Attacks on templates: a template is edited by admins in the browser, so it
// is untrusted input. Each test tries one; validateTemplate and
// checkRecordAgainstTemplate must refuse it and never throw.
import { describe, expect, it } from "vitest";
import {
  checkRecordAgainstTemplate,
  validateRecord,
  validateTemplate,
  type CatalogRecord,
  type FieldTemplate,
  type Validated,
} from "./index.js";

const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const T = "2026-11-20T16:05:00.000Z";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function field(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "note",
    label: "Note",
    kind: "text",
    required: false,
    repeatable: false,
    visibility: "public",
    inherited: false,
    ...extra,
  };
}

function base(fields: unknown[] = [field()]): Record<string, unknown> {
  return { key: "t", label: "T", appliesTo: ["object"], fields };
}

describe("hostile templates", () => {
  it("refuses a Proxy", () => {
    expect(codes(validateTemplate(new Proxy(base(), {})))).toEqual(["not_an_object"]);
  });

  it("refuses a Proxy nested inside", () => {
    expect(codes(validateTemplate(base([new Proxy(field(), {})])))).toEqual(["not_plain_data"]);
  });

  it("refuses getters, and doesn't run them", () => {
    let ran = false;
    const f = field();
    Object.defineProperty(f, "visibility", {
      enumerable: true,
      get() {
        ran = true;
        return "public";
      },
    });
    expect(codes(validateTemplate(base([f])))).toEqual(["not_plain_data"]);
    expect(ran).toBe(false);
  });

  it("reports a Proxy whose traps throw instead of throwing", () => {
    const evil = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("boom");
        },
      },
    );
    expect(() => validateTemplate(evil)).not.toThrow();
    expect(validateTemplate(evil).ok).toBe(false);
  });

  it("refuses __proto__ and constructor as keys in the template", () => {
    const viaJson = JSON.parse(
      '{"key":"t","label":"T","appliesTo":["object"],"fields":[],"__proto__":{"x":1}}',
    ) as unknown;
    expect(codes(validateTemplate(viaJson))).toContain("forbidden_key");
    expect(codes(validateTemplate(base([field({ key: "constructor" })])))).toEqual([
      "invalid_field_key",
    ]);
  });

  it("can't make a field public by setting visibility through the prototype", () => {
    const f = Object.create({ visibility: "public" }) as Record<string, unknown>;
    Object.assign(f, field());
    delete f.visibility;
    expect(codes(validateTemplate(base([f])))).toEqual(["not_json"]);
  });

  it("isn't fooled by an inherited Object.prototype property", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.visibility = "public";
    try {
      const plain = field();
      delete plain.visibility;
      expect(codes(validateTemplate(base([plain])))).toEqual(["invalid_visibility"]);
    } finally {
      delete proto.visibility;
    }
  });

  it("refuses control and direction-changing characters in labels and options", () => {
    expect(codes(validateTemplate(base([field({ label: "Note‮" })])))).toEqual(["bad_characters"]);
    expect(
      codes(
        validateTemplate(
          base([field({ kind: "list", options: [{ value: "a\u0000", label: "A" }] })]),
        ),
      ),
    ).toEqual(["bad_characters"]);
  });

  it("escapes hostile text echoed in messages", () => {
    const r = validateTemplate(
      base([
        field({ kind: "controlled_term", vocabularies: ["lcsh", "lcsh"] }),
        field({ key: "note", label: "Other" }),
      ]),
    );
    expect(r.ok).toBe(false);
    const evil = validateTemplate({ ...base(), "‮evil": 1 });
    expect(evil.ok).toBe(false);
    if (!evil.ok) {
      for (const i of evil.issues) expect(i.message).not.toMatch(/‮/);
    }
  });

  it("stops after a bounded number of problems", () => {
    const fields = Array.from({ length: 200 }, (_, i) =>
      field({ key: `f${String(i)}`, kind: "nope", visibility: "x", required: 1 }),
    );
    const r = validateTemplate(base(fields));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBeLessThanOrEqual(201);
      expect(r.issues.at(-1)?.code).toBe("too_many_issues");
    }
  });

  it("refuses a template too large to read", () => {
    const options = Array.from({ length: 30_000 }, (_, i) => ({
      value: `v${String(i)}`,
      label: "L",
    }));
    const r = validateTemplate(base([field({ kind: "list", options })]));
    expect(codes(r)).toEqual(["too_many_values"]);
  });

  it("refuses help text longer than the limit before reading further", () => {
    expect(codes(validateTemplate(base([field({ help: "x".repeat(2001) })])))).toEqual([
      "too_long",
    ]);
  });
});

describe("hostile record values", () => {
  function t(fields: unknown[]): FieldTemplate {
    const r = validateTemplate(base(fields));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }
  function rec(fields: Record<string, unknown>): CatalogRecord {
    const r = validateRecord({
      kind: "object",
      id: ID,
      title: "X",
      createdAt: T,
      updatedAt: T,
      fields,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }

  it("refuses script and data URLs in links, rights and terms", () => {
    const tpl = t([
      field({ key: "link", kind: "link" }),
      field({ key: "rights", kind: "rights" }),
      field({ key: "term", kind: "controlled_term" }),
      field({ key: "place", kind: "place" }),
    ]);
    const issues = checkRecordAgainstTemplate(
      rec({
        link: { url: "javascript:alert(document.cookie)" },
        rights: { uri: "data:text/html,<script>alert(1)</script>" },
        term: { label: "x", uri: "vbscript:msgbox" },
        place: { label: "x", uri: " https://example.org/" },
      }),
      tpl,
    );
    expect(issues.map((i) => i.code)).toEqual([
      "invalid_url",
      "invalid_url",
      "invalid_url",
      "invalid_url",
    ]);
  });

  it("a template field key that matches an Object.prototype name doesn't read inherited values", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.note = "inherited";
    try {
      const issues = checkRecordAgainstTemplate(rec({}), t([field({ required: true })]));
      expect(issues.map((i) => i.code)).toEqual(["required"]);
    } finally {
      delete proto.note;
    }
  });

  it("escapes a hostile label echoed in record messages", () => {
    const tpl = t([field({ label: "Note <b>", required: true })]);
    const issues = checkRecordAgainstTemplate(rec({}), tpl);
    expect(issues[0]?.message).toContain('"Note <b>"');
  });

  it("stops after a bounded number of problems", () => {
    const tpl = t([field({ key: "notes", repeatable: true })]);
    const notes = Array.from({ length: 500 }, () => " bad");
    const issues = checkRecordAgainstTemplate(rec({ notes }), tpl);
    expect(issues.length).toBeLessThanOrEqual(201);
    expect(issues.at(-1)?.code).toBe("too_many_issues");
  });

  it("never throws, even when handed something that isn't a validated record", () => {
    const tpl = t([field()]);
    const fake = {
      kind: "object",
      get fields(): never {
        throw new Error("boom");
      },
    } as unknown as CatalogRecord;
    expect(checkRecordAgainstTemplate(fake, tpl).map((i) => i.code)).toEqual(["unreadable"]);
  });
});
