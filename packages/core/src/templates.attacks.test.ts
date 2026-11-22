// Attacks on templates: a template is edited by admins in the browser, so it
// is untrusted input. Each test tries one; validateTemplate and
// checkRecordAgainstTemplate must refuse it and never throw.
import { describe, expect, it } from "vitest";
import {
  checkRecordAgainstTemplate,
  indexTemplates,
  isTemplateRegistry,
  validateRecord,
  validateTemplate,
  webUrlProblem,
  type CatalogRecord,
  type FieldTemplate,
  type Validated,
  newOrganizationId,
} from "./index.js";

const ORG = newOrganizationId();

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
      organizationId: ORG,
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
    // Refused by validating the record first (T-012 review), before any field is read.
    expect(checkRecordAgainstTemplate(fake, tpl).map((i) => i.code)).toEqual(["invalid_record"]);
  });
});

// Findings of the independent review of T-005. Each test fails without its fix.
describe("review fixes", () => {
  function rec(fields: Record<string, unknown>): CatalogRecord {
    const r = validateRecord({
      kind: "object",
      id: ID,
      title: "X",
      organizationId: ORG,
      createdAt: T,
      updatedAt: T,
      fields,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }
  function t(fields: unknown[]): FieldTemplate {
    const r = validateTemplate(base(fields));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }
  function listField(i: number): Record<string, unknown> {
    return field({
      key: `list_${String(i)}`,
      kind: "list",
      options: Array.from({ length: 500 }, (_, j) => ({ value: `v${String(j)}`, label: "Label" })),
    });
  }

  it("1. accepts 20 list fields of 500 options, and names the field that goes over the total", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => listField(i));
    expect(validateTemplate(base(twenty)).ok).toBe(true);
    const r = validateTemplate(base([...twenty, listField(20)]));
    expect(codes(r)).toEqual(["too_many_options"]);
    expect(r.ok ? [] : r.issues.map((i) => i.path.join("."))).toEqual(["fields.20.options"]);
  });

  it("2. fails closed on a template that never went through validateTemplate", () => {
    const unknownKind = {
      ...base(),
      fields: [field({ kind: "number" })],
    } as unknown as FieldTemplate;
    expect(
      checkRecordAgainstTemplate(rec({ note: "anything" }), unknownKind).map((i) => i.code),
    ).toEqual(["invalid_template"]);
    const noVisibility = base([{ ...field(), visibility: undefined }]) as unknown as FieldTemplate;
    expect(checkRecordAgainstTemplate(rec({}), noVisibility).map((i) => i.code)).toEqual([
      "invalid_template",
    ]);
  });

  it("3. ignores optional settings inherited from a polluted Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    const tpl = t([
      field(),
      field({ key: "term", kind: "controlled_term" }),
      field({ key: "date", kind: "date", required: true, inherited: true }),
    ]);
    const called: string[] = [];
    proto.maxLength = 1e9;
    proto.vocabularies = ["nothing"];
    proto.allowMissingInherited = true;
    proto.text = () => {
      called.push("text");
      return [];
    };
    try {
      const issues = checkRecordAgainstTemplate(
        rec({ note: "x".repeat(5000), term: { label: "Depots", vocabulary: "lcsh" } }),
        tpl,
        { checkers: {} },
      );
      expect(issues.map((i) => i.code).sort()).toEqual(["invalid_text", "required"]);
      expect(called).toEqual([]);
    } finally {
      delete proto.maxLength;
      delete proto.vocabularies;
      delete proto.allowMissingInherited;
      delete proto.text;
    }
  });

  it("4. fails closed when a checker's path has parts that aren't text or whole numbers", () => {
    const tpl = t([field()]);
    for (const path of [[{}], ["uri", null], [1.5], [Number.NaN]]) {
      const issues = checkRecordAgainstTemplate(rec({ note: "x" }), tpl, {
        checkers: { text: () => [{ code: "bad", message: "Bad.", path: path as string[] }] },
      });
      expect(issues.map((i) => i.code)).toEqual(["check_failed"]);
    }
  });

  it("5. refuses prototype keys as template keys and codes", () => {
    expect(codes(validateTemplate({ ...base(), key: "constructor" }))).toEqual(["invalid_key"]);
    expect(codes(validateTemplate({ ...base(), key: "prototype" }))).toEqual(["invalid_key"]);
    expect(
      codes(
        validateTemplate(base([field({ kind: "controlled_term", vocabularies: ["constructor"] })])),
      ),
    ).toEqual(["invalid_code"]);
    expect(
      codes(
        validateTemplate(base([field({ kind: "identifier", identifierTypes: ["prototype"] })])),
      ),
    ).toEqual(["invalid_code"]);
    expect(
      codes(
        validateTemplate(base([field({ standards: [{ standard: "constructor", element: "x" }] })])),
      ),
    ).toEqual(["invalid_code"]);
    const tpl = t([field({ key: "term", kind: "controlled_term" })]);
    const issues = checkRecordAgainstTemplate(
      rec({ term: { label: "x", vocabulary: "constructor" } }),
      tpl,
    );
    expect(issues.map((i) => i.code)).toEqual(["invalid_code"]);
  });

  it("6. refuses backslashes in web addresses", () => {
    for (const url of [
      "https://\\evil.example/",
      "https://example.org\\@evil.example/",
      "https://example.org/a\\b",
    ]) {
      expect(webUrlProblem(url), url).toBeDefined();
    }
  });
});

// A record names its template (D-029). The S-002 review's leak: a record
// moved to another template, with nothing in the record saying so, has its
// staff values checked (and published) under a key the other template makes
// public.
describe("a record is never checked against another template", () => {
  const staffTpl = base([field({ visibility: "staff" })]);
  staffTpl.key = "donor-files";
  const publicTpl = base([field({ visibility: "public" })]);
  publicTpl.key = "public-objects";

  function rec(extra: Record<string, unknown> = {}): CatalogRecord {
    const r = validateRecord({
      kind: "object",
      id: ID,
      title: "Chair",
      templateKey: "donor-files",
      organizationId: ORG,
      createdAt: T,
      updatedAt: T,
      fields: { note: "Donor's home address" },
      ...extra,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }

  it("refuses a template whose key isn't the record's templateKey", () => {
    const issues = checkRecordAgainstTemplate(rec(), publicTpl as unknown as FieldTemplate);
    expect(issues.map((i) => i.code)).toEqual(["template_mismatch"]);
    expect(issues[0]?.path).toEqual(["templateKey"]);
    expect(JSON.stringify(issues)).not.toContain("Donor");
  });

  it("refuses it through a registry too: the record's key decides, not the caller", () => {
    const registry = indexTemplates([publicTpl]);
    if (!registry.ok) throw new Error("registry");
    expect(checkRecordAgainstTemplate(rec(), registry.value).map((i) => i.code)).toEqual([
      "unknown_template",
    ]);
  });

  it("refuses a record with no templateKey through a registry", () => {
    const registry = indexTemplates([staffTpl, publicTpl]);
    if (!registry.ok) throw new Error("registry");
    const keyless = validateRecord({
      kind: "object",
      id: ID,
      title: "Chair",
      organizationId: ORG,
      createdAt: T,
      updatedAt: T,
      fields: {},
    });
    if (!keyless.ok) throw new Error("record");
    expect(checkRecordAgainstTemplate(keyless.value, registry.value).map((i) => i.code)).toEqual([
      "no_template_key",
    ]);
  });

  it("doesn't take a hand-made object of the registry's shape as a registry", () => {
    const fake = Object.freeze({ size: 1 });
    expect(isTemplateRegistry(fake)).toBe(false);
    expect(
      checkRecordAgainstTemplate(rec(), fake as unknown as FieldTemplate).map((i) => i.code),
    ).toEqual(["invalid_template"]);
  });
});

describe("hostile template registries", () => {
  it("refuses a Proxy or a non-list without reading it", () => {
    let read = false;
    const proxy = new Proxy([base()], {
      get: (t, k) => {
        read = true;
        return Reflect.get(t, k) as unknown;
      },
    });
    expect(codes(indexTemplates(proxy))).toEqual(["not_a_list"]);
    expect(read).toBe(false);
    for (const bad of [undefined, null, {}, "t", { 0: base(), length: 1 }]) {
      expect(codes(indexTemplates(bad))).toEqual(["not_a_list"]);
    }
  });

  it("refuses two templates with the same key, so neither can stand in for the other", () => {
    const staff = base([field({ visibility: "staff" })]);
    const pub = base([field({ visibility: "public" })]);
    const r = indexTemplates([staff, pub]);
    expect(codes(r)).toEqual(["duplicate_key"]);
    expect(r.ok ? [] : r.issues[0]?.path).toEqual([1, "key"]);
  });

  it("refuses the whole list for one invalid template, a hole or a getter", () => {
    expect(codes(indexTemplates([base(), { ...base(), key: "Bad" }]))).toEqual(["invalid_key"]);
    // eslint-disable-next-line no-sparse-arrays
    expect(indexTemplates([base(), ,]).ok).toBe(false);
    let ran = false;
    const list: unknown[] = [];
    Object.defineProperty(list, 0, {
      enumerable: true,
      get: () => {
        ran = true;
        return base();
      },
    });
    expect(indexTemplates(list).ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("refuses a template keyed constructor or __proto__", () => {
    for (const key of ["constructor", "prototype", "__proto__"]) {
      expect(indexTemplates([{ ...base(), key }]).ok).toBe(false);
    }
  });

  it("is a snapshot: later edits to the caller's template are not seen", () => {
    const tpl = base([field()]);
    const registry = indexTemplates([tpl]);
    if (!registry.ok) throw new Error("registry");
    (tpl.fields as unknown[]).push(field({ key: "extra" }));
    const r = validateRecord({
      kind: "object",
      id: ID,
      title: "Chair",
      templateKey: "t",
      organizationId: ORG,
      createdAt: T,
      updatedAt: T,
      fields: { extra: "x" },
    });
    if (!r.ok) throw new Error("record");
    expect(Object.isFrozen(registry.value)).toBe(true);
    expect(checkRecordAgainstTemplate(r.value, registry.value).map((i) => i.code)).toEqual([
      "unknown_field",
    ]);
  });
});

// Independent review of T-012: a record whose templateKey is there but not a
// plain key must never pass as an older record with no key, which any
// template would be accepted for.
describe("a templateKey that is there but unreadable is not 'no key'", () => {
  const staff = { ...base([field({ visibility: "staff" })]), key: "donor-files" };
  const pub = { ...base([field({ visibility: "public" })]), key: "public-objects" };
  function rec(): CatalogRecord {
    const r = validateRecord({
      kind: "object",
      id: ID,
      title: "Chair",
      templateKey: "donor-files",
      organizationId: ORG,
      createdAt: T,
      updatedAt: T,
      fields: { note: "Donor's home address" },
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }

  it("refuses an own templateKey that is undefined", () => {
    const spread = { ...rec(), templateKey: undefined } as unknown as CatalogRecord;
    expect(
      checkRecordAgainstTemplate(spread, pub as unknown as FieldTemplate).map((i) => i.code),
    ).toEqual(["invalid_record"]);
  });

  it("refuses a templateKey getter, without running it", () => {
    let ran = false;
    const r = { ...rec() } as Record<string, unknown>;
    delete r.templateKey;
    Object.defineProperty(r, "templateKey", {
      enumerable: true,
      get: () => {
        ran = true;
        return undefined;
      },
    });
    expect(
      checkRecordAgainstTemplate(
        r as unknown as CatalogRecord,
        pub as unknown as FieldTemplate,
      ).map((i) => i.code),
    ).toEqual(["invalid_record"]);
    expect(ran).toBe(false);
  });

  it("refuses them through a registry too", () => {
    const registry = indexTemplates([staff, pub]);
    if (!registry.ok) throw new Error("registry");
    const spread = { ...rec(), templateKey: undefined } as unknown as CatalogRecord;
    expect(checkRecordAgainstTemplate(spread, registry.value).map((i) => i.code)).toEqual([
      "invalid_record",
    ]);
  });
});
