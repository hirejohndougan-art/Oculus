// T-013 attacks: record types are untrusted data owned by one organization
// (D-030, D-037). Getters, Proxies, prototype keys and mixed organizations
// are refused, nothing throws, and no message quotes another organization's
// keys or values.
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRecordType,
  indexRecordTypes,
  indexTemplates,
  newOrganizationId,
  createRecord,
  recordTypeDefaults,
  recordTypeTemplateIssues,
  validateRecord,
  validateRecordType,
  type CatalogRecord,
  type FieldTemplate,
  type Issue,
  type RecordType,
  type RecordTypeRegistry,
  type TemplateRegistry,
  type Validated,
} from "./index.js";

const ORG = newOrganizationId();
const OTHER = newOrganizationId();
const T = "2026-11-20T16:05:00.000Z";
const A = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
const SECRET = "secret-other-org-key";

function codes(result: Validated<unknown> | readonly Issue[]): string[] {
  if (Array.isArray(result)) return (result as readonly Issue[]).map((i) => i.code);
  const v = result as Validated<unknown>;
  return v.ok ? [] : v.issues.map((i) => i.code);
}

function messages(result: Validated<unknown> | readonly Issue[]): string {
  const list = Array.isArray(result)
    ? (result as readonly Issue[])
    : (result as Validated<unknown>).ok
      ? []
      : (result as { issues: readonly Issue[] }).issues;
  return JSON.stringify(list);
}

function template(organizationId: string, key = "oral-history", kinds = ["digital_asset"]) {
  return {
    key,
    label: "Oral histories",
    organizationId,
    appliesTo: kinds,
    fields: [
      {
        key: "interviewer",
        label: "Interviewer",
        kind: "text",
        required: false,
        repeatable: false,
        visibility: "staff",
        inherited: false,
      },
    ],
  } as unknown as FieldTemplate;
}

function templates(org: string, ...keys: string[]): TemplateRegistry {
  const r = indexTemplates(
    (keys.length > 0 ? keys : ["oral-history"]).map((k) => template(org, k)),
  );
  if (!r.ok) throw new Error("bad fixture");
  return r.value;
}

function type(
  organizationId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: "oral-history",
    organizationId,
    label: "Oral history",
    kind: "digital_asset",
    defaultTemplateKey: "oral-history",
    ...extra,
  };
}

function registry(org: string, list: unknown[] = [type(org)]): RecordTypeRegistry {
  const r = indexRecordTypes(list, templates(org));
  if (!r.ok) throw new Error("bad fixture");
  return r.value;
}

function record(org = ORG, extra: Record<string, unknown> = {}): CatalogRecord {
  const r = validateRecord({
    kind: "digital_asset",
    id: A,
    title: "Interview",
    organizationId: org,
    templateKey: "oral-history",
    recordTypeKey: "oral-history",
    mediaType: "audio/wav",
    createdAt: T,
    updatedAt: T,
    fields: {},
    ...extra,
  });
  if (!r.ok) throw new Error("bad fixture");
  return r.value;
}

describe("getters and Proxies", () => {
  it("validateRecordType refuses a Proxy without running its traps", () => {
    let trapped = 0;
    const p = new Proxy(type(ORG), {
      get(t, k, r) {
        trapped += 1;
        return Reflect.get(t, k, r) as unknown;
      },
      ownKeys(t) {
        trapped += 1;
        return Reflect.ownKeys(t);
      },
    });
    expect(codes(validateRecordType(p, templates(ORG)))).toEqual(["not_an_object"]);
    expect(trapped).toBe(0);
  });

  it("validateRecordType never runs a getter, and a throwing one doesn't throw", () => {
    let ran = 0;
    const input = type(ORG);
    Object.defineProperty(input, "kind", {
      enumerable: true,
      get() {
        ran += 1;
        throw new Error("boom");
      },
    });
    const r = validateRecordType(input, templates(ORG));
    expect(r.ok).toBe(false);
    expect(ran).toBe(0);
  });

  it("a getter that changes its answer can't pass one kind and store another", () => {
    let calls = 0;
    const input = type(ORG);
    Object.defineProperty(input, "organizationId", {
      enumerable: true,
      get() {
        calls += 1;
        return calls === 1 ? ORG : OTHER;
      },
    });
    expect(validateRecordType(input, templates(ORG)).ok).toBe(false);
    expect(indexRecordTypes([input], templates(ORG)).ok).toBe(false);
  });

  it("a Proxy template, template list or registry is refused", () => {
    const proxied = new Proxy(template(ORG), {});
    expect(codes(validateRecordType(type(ORG), proxied))).toEqual(["invalid_template"]);
    const reg = templates(ORG);
    expect(codes(validateRecordType(type(ORG), new Proxy(reg, {})))).toEqual(["invalid_template"]);
    expect(codes(indexRecordTypes([type(ORG)], new Proxy(reg, {})))).toEqual([
      "no_template_registry",
    ]);
    expect(codes(indexRecordTypes(new Proxy([type(ORG)], {}), reg))).toEqual(["not_a_list"]);
  });

  it("indexRecordTypes never runs a getter slot, and refuses holes", () => {
    let ran = 0;
    const list: unknown[] = [];
    Object.defineProperty(list, 0, {
      enumerable: true,
      get() {
        ran += 1;
        return type(ORG);
      },
    });
    expect(indexRecordTypes(list, templates(ORG)).ok).toBe(false);
    expect(ran).toBe(0);
    // eslint-disable-next-line no-sparse-arrays
    expect(indexRecordTypes([type(ORG), , type(ORG, { key: "b" })], templates(ORG)).ok).toBe(false);
  });

  it("a type entry that is a Proxy is refused", () => {
    const r = indexRecordTypes([new Proxy(type(ORG), {})], templates(ORG));
    expect(r.ok).toBe(false);
  });

  it("checkRecordType refuses a Proxy record or type, and a fake registry", () => {
    const rec = record();
    expect(codes(checkRecordType(new Proxy(rec, {}), registry(ORG)))).toEqual(["invalid_record"]);
    expect(codes(checkRecordType(rec, new Proxy(type(ORG), {}) as unknown as RecordType))).toEqual([
      "invalid_record_type",
    ]);
    expect(
      codes(checkRecordType(rec, new Proxy(registry(ORG), {}) as unknown as RecordType)),
    ).toEqual(["invalid_record_type"]);
  });

  it("checkRecordType refuses a record whose recordTypeKey is a getter", () => {
    let ran = 0;
    const rec = { ...record() } as Record<string, unknown>;
    Object.defineProperty(rec, "recordTypeKey", {
      enumerable: true,
      get() {
        ran += 1;
        return "oral-history";
      },
    });
    expect(codes(checkRecordType(rec as unknown as CatalogRecord, registry(ORG)))).toEqual([
      "invalid_record",
    ]);
    expect(ran).toBe(0);
  });

  it("recordTypeDefaults refuses a key that isn't a string, without converting it", () => {
    let ran = 0;
    const key = {
      toString() {
        ran += 1;
        return "oral-history";
      },
    };
    expect(codes(recordTypeDefaults(registry(ORG), key, ORG))).toEqual(["invalid_record_type_key"]);
    expect(ran).toBe(0);
  });
});

describe("prototype keys", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).description;
    delete (Object.prototype as Record<string, unknown>).recordTypeKey;
  });

  it("refuses __proto__, constructor and prototype as keys and properties", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(codes(validateRecordType(type(ORG, { key }), templates(ORG)))).toContain(
        "invalid_key",
      );
      expect(
        codes(validateRecordType(type(ORG, { defaultTemplateKey: key }), templates(ORG))),
      ).toContain("invalid_template_key");
      expect(codes(recordTypeDefaults(registry(ORG), key, ORG))).toEqual([
        "invalid_record_type_key",
      ]);
    }
    const input = JSON.parse(
      `{"key":"oral-history","organizationId":"${ORG}","label":"Oral history","kind":"digital_asset","defaultTemplateKey":"oral-history","__proto__":{"kind":"object"}}`,
    ) as unknown;
    expect(validateRecordType(input, templates(ORG)).ok).toBe(false);
  });

  it("an inherited property on Object.prototype is never read as the type's", () => {
    (Object.prototype as Record<string, unknown>).description = 42;
    const r = validateRecordType(type(ORG), templates(ORG));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.hasOwn(r.value, "description")).toBe(false);
  });

  it("a polluted recordTypeKey doesn't give a record a type", () => {
    const rec = validateRecord({
      kind: "digital_asset",
      id: A,
      title: "Scan",
      organizationId: ORG,
      templateKey: "oral-history",
      mediaType: "image/tiff",
      createdAt: T,
      updatedAt: T,
      fields: {},
    });
    if (!rec.ok) throw new Error("bad fixture");
    (Object.prototype as Record<string, unknown>).recordTypeKey = "oral-history";
    expect(codes(checkRecordType(rec.value, registry(ORG)))).toEqual(["no_record_type"]);
  });

  it("a type keyed like an Object method isn't found by inheritance", () => {
    expect(codes(recordTypeDefaults(registry(ORG), "tostring", ORG))).toEqual([
      "unknown_record_type",
    ]);
    expect(
      codes(checkRecordType(record(ORG, { recordTypeKey: "hasownproperty" }), registry(ORG))),
    ).toEqual(["unknown_record_type"]);
  });
});

describe("mixed organizations", () => {
  it("refuses a default template of another organization, without comparing it", () => {
    // Given directly: another organization's template with the same key.
    const direct = validateRecordType(type(ORG), template(OTHER));
    expect(codes(direct)).toEqual(["wrong_organization"]);
    // Another organization's template of another key and kind: still only wrong_organization.
    const other = validateRecordType(type(ORG), template(OTHER, SECRET, ["place"]));
    expect(codes(other)).toEqual(["wrong_organization"]);
    expect(messages(other)).not.toContain(SECRET);
  });

  it("refuses another organization's template registry before looking up the key", () => {
    // Whether or not the other registry holds the key, the answer is the same.
    const holds = validateRecordType(type(ORG), templates(OTHER, "oral-history"));
    const lacks = validateRecordType(type(ORG), templates(OTHER, SECRET));
    expect(codes(holds)).toEqual(["wrong_organization"]);
    expect(codes(lacks)).toEqual(["wrong_organization"]);
    expect(messages(lacks)).not.toContain(SECRET);
    expect(codes(indexRecordTypes([type(ORG)], templates(OTHER)))).toEqual(["wrong_organization"]);
  });

  it("indexRecordTypes refuses a list of two organizations' types, quoting neither", () => {
    const r = indexRecordTypes(
      [type(ORG), type(OTHER, { key: SECRET, label: SECRET, defaultTemplateKey: SECRET })],
      templates(ORG),
    );
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expect(messages(r)).not.toContain(SECRET);
  });

  it("an entry with no organization, or a getter for one, counts as another organization's", () => {
    const missing = type(ORG, { key: "b" });
    delete missing.organizationId;
    expect(codes(indexRecordTypes([type(ORG), missing], templates(ORG)))).toEqual([
      "mixed_organizations",
    ]);
    const getter = type(ORG, { key: "b" });
    Object.defineProperty(getter, "organizationId", { enumerable: true, get: () => ORG });
    expect(codes(indexRecordTypes([type(ORG), getter], templates(ORG)))).toEqual([
      "mixed_organizations",
    ]);
    expect(codes(indexRecordTypes([missing], templates(ORG)))).toEqual(["mixed_organizations"]);
  });

  it("checkRecordType refuses another organization's registry before looking up the key", () => {
    const otherTypes = registry(OTHER, [type(OTHER)]);
    const known = checkRecordType(record(ORG), otherTypes);
    const unknown = checkRecordType(record(ORG, { recordTypeKey: "letters" }), otherTypes);
    expect(codes(known)).toEqual(["wrong_organization"]);
    expect(codes(unknown)).toEqual(["wrong_organization"]);
  });

  it("checkRecordType refuses another organization's type given directly, quoting none of it", () => {
    const theirs = type(OTHER, { label: SECRET, kind: "place", defaultTemplateKey: SECRET });
    const found = checkRecordType(record(ORG), theirs as unknown as RecordType);
    expect(codes(found)).toEqual(["wrong_organization"]);
    expect(messages(found)).not.toContain(SECRET);
    const keyed = type(OTHER, { key: SECRET });
    const mismatch = checkRecordType(record(ORG), keyed as unknown as RecordType);
    expect(codes(mismatch)).toEqual(["wrong_organization"]);
    expect(messages(mismatch)).not.toContain(SECRET);
  });

  it("recordTypeDefaults refuses another organization's registry before looking up the key", () => {
    const theirs = registry(OTHER, [type(OTHER)]);
    expect(codes(recordTypeDefaults(theirs, "oral-history", ORG))).toEqual(["wrong_organization"]);
    const unknown = recordTypeDefaults(theirs, SECRET, ORG);
    expect(codes(unknown)).toEqual(["wrong_organization"]);
    expect(messages(unknown)).not.toContain(SECRET);
    expect(recordTypeDefaults(theirs, "oral-history", OTHER).ok).toBe(true);
  });

  it("spreading the defaults can't move a new record into another organization", () => {
    // The review's attack: the caller's organization first, the defaults spread after.
    const theirs = registry(OTHER, [type(OTHER)]);
    expect(recordTypeDefaults(theirs, "oral-history", ORG).ok).toBe(false);
    // Even for the right registry, the defaults hold no organization to override with.
    const d = recordTypeDefaults(registry(ORG), "oral-history", ORG);
    if (!d.ok) throw new Error("bad fixture");
    expect(Object.hasOwn(d.value, "organizationId")).toBe(false);
    const made = createRecord(
      {
        organizationId: ORG,
        ...d.value,
        kind: "digital_asset",
        title: "Interview",
        mediaType: "audio/wav",
      },
      new Date(T),
    );
    expect(made.ok && made.value.organizationId).toBe(ORG);
  });

  it("recordTypeTemplateIssues refuses mixed lists and another organization's templates, quoting nothing", () => {
    const mixed = recordTypeTemplateIssues(
      [type(ORG), type(OTHER, { key: SECRET, defaultTemplateKey: SECRET })],
      templates(ORG),
    );
    expect(codes(mixed)).toEqual(["mixed_organizations"]);
    expect(messages(mixed)).not.toContain(SECRET);
    const wrong = recordTypeTemplateIssues([type(ORG)], templates(OTHER, SECRET));
    expect(codes(wrong)).toEqual(["wrong_organization"]);
    expect(messages(wrong)).not.toContain(SECRET);
  });
});

describe("recordTypeTemplateIssues attacks", () => {
  it("never runs a getter slot or a getter key, and refuses Proxies", () => {
    let ran = 0;
    const list: unknown[] = [type(ORG)];
    Object.defineProperty(list, 1, {
      enumerable: true,
      get() {
        ran += 1;
        return type(ORG, { key: "b" });
      },
    });
    const r = recordTypeTemplateIssues(list, templates(ORG));
    // A getter slot reads as an entry with no organization.
    expect(codes(r)).toEqual(["mixed_organizations"]);
    const keyed = type(ORG, { defaultTemplateKey: "missing" });
    Object.defineProperty(keyed, "key", {
      enumerable: true,
      get() {
        ran += 1;
        return "oral-history";
      },
    });
    const k = recordTypeTemplateIssues([keyed], templates(ORG));
    expect(k.ok).toBe(true);
    if (k.ok) expect(Object.hasOwn(k.value[0] ?? {}, "key")).toBe(false);
    expect(ran).toBe(0);
    expect(codes(recordTypeTemplateIssues(new Proxy([type(ORG)], {}), templates(ORG)))).toEqual([
      "not_a_list",
    ]);
    const p = recordTypeTemplateIssues([new Proxy(type(ORG), {})], templates(ORG));
    expect(codes(p)).toEqual(["mixed_organizations"]);
  });

  it("never throws", () => {
    for (const h of [undefined, null, 1, "x", {}, [null], [7]]) {
      expect(() => recordTypeTemplateIssues(h, templates(ORG))).not.toThrow();
      expect(() => recordTypeTemplateIssues([type(ORG)], h as never)).not.toThrow();
    }
  });
});

describe("never throws", () => {
  it("on hostile or odd inputs", () => {
    const hostile = [
      undefined,
      null,
      7,
      "x",
      [],
      new Date(),
      Object.create({ key: "oral-history" }) as unknown,
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("boom");
          },
        },
      ),
    ];
    for (const h of hostile) {
      expect(() => validateRecordType(h, templates(ORG))).not.toThrow();
      expect(() => validateRecordType(type(ORG), h as never)).not.toThrow();
      expect(() => indexRecordTypes(h, templates(ORG))).not.toThrow();
      expect(() => indexRecordTypes([h], templates(ORG))).not.toThrow();
      expect(() => checkRecordType(h as never, registry(ORG))).not.toThrow();
      expect(() => checkRecordType(record(), h as never)).not.toThrow();
      expect(() => recordTypeDefaults(h as never, "oral-history", ORG)).not.toThrow();
      expect(() => recordTypeDefaults(registry(ORG), h, ORG)).not.toThrow();
    }
  });
});
