// Attack tests for public output: staff values trying to get out, forged
// public views, hostile mappings and options, injection, and huge inputs.
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_CHARS,
  MAX_RECORD_SET,
  effectiveRecord,
  newRecordId,
  publicOutput,
  publicView,
  validateRecord,
  type PublicOutput,
  type PublicRecord,
  type Validated,
} from "./index.js";
import {
  BASE,
  CNE,
  MAPPING,
  TPL,
  effectiveOf,
  everything,
  field,
  record,
  template,
  viewOf,
  CHECKERS,
  RIGHTS_ENTRY,
} from "./public-output.fixtures.js";

function ok(result: Validated<PublicOutput>): PublicOutput {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const ch = (code: number): string => String.fromCharCode(code);

function out(view: PublicRecord, mapping: unknown = MAPPING, id = view.id) {
  return publicOutput(view, mapping, { baseUrl: BASE, published: [id], checkers: CHECKERS });
}

describe("staff values never reach any output form", () => {
  it("leaves out own, inherited and left-over staff values, and staff templates along the way", () => {
    // The fonds's template marks `creator` staff, so the strictest visibility
    // keeps it staff on the item, whose template marks it public.
    const fondsTemplate = template(
      TPL.fields.map((f) => (f.key === "creator" ? { ...f, visibility: "staff" as const } : f)),
      "fonds",
    );
    const fonds = record(
      "archival_unit",
      "SECRET-fonds-title",
      {
        rights: { uri: CNE },
        creator: "SECRET-inherited-through-staff",
        family_secret: "SECRET-inherited-staff",
      },
      { level: "fonds" },
    );
    const item = record(
      "archival_unit",
      "Item",
      {
        donor_note: "SECRET-own-staff",
        left_over: "SECRET-left-over",
        description: "Public text",
      },
      { level: "item", parentId: fonds.id },
    );
    const result = effectiveRecord(item.id, [item, fonds], (r) =>
      r.id === fonds.id ? fondsTemplate : TPL,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    // The staff values really are in the effective record.
    const keys = result.value.entries.map((e) => e.key);
    expect(keys).toEqual(
      expect.arrayContaining(["creator", "family_secret", "donor_note", "left_over"]),
    );
    const view = publicView(result.value);
    if (view === undefined) throw new Error("no view");
    // Even a mapping that maps every public field can't reach them.
    const mapAll = {
      template: "out",
      entries: [
        RIGHTS_ENTRY,
        ...TPL.fields
          .filter((f) => f.visibility === "public")
          .map((f) => ({ field: f.key, term: "description" })),
      ],
    };
    for (const mapping of [MAPPING, mapAll]) {
      const all = everything(ok(out(view, mapping)));
      expect(all).toContain("Public text");
      expect(all).not.toContain("SECRET");
      expect(all).not.toContain(fonds.id);
    }
  });

  it("refuses a mapping entry naming a staff field or a left-over key", () => {
    const item = record("object", "I", {
      rights: { uri: CNE },
      donor_note: "SECRET",
      left_over: "SECRET",
    });
    const view = viewOf([item], item.id);
    expect(
      codes(
        out(view, {
          template: "out",
          entries: [RIGHTS_ENTRY, { field: "donor_note", term: "description" }],
        }),
      ),
    ).toEqual(["staff_field"]);
    expect(
      codes(
        out(view, {
          template: "out",
          entries: [RIGHTS_ENTRY, { field: "left_over", term: "description" }],
        }),
      ),
    ).toEqual(["unknown_field"]);
  });

  it("refuses a mapping for a different template, even one that would map the same keys", () => {
    const item = record("object", "I", { rights: { uri: CNE } });
    const view = viewOf([item], item.id);
    expect(codes(out(view, { ...MAPPING, template: "spectrum-object" }))).toEqual([
      "wrong_template",
    ]);
  });

  it("checks the mapping against the template the view was built with, not a later edit", () => {
    // The caller's template object is changed after the view is made: the
    // view's own validated copy still decides.
    const fields = TPL.fields.map((f) => ({ ...f }));
    const tpl = { ...TPL, fields };
    const item = record("object", "I", { rights: { uri: CNE }, donor_note: "SECRET" });
    const view = viewOf([item], item.id, tpl);
    const donor = fields.find((f) => f.key === "donor_note");
    if (donor === undefined) throw new Error("no field");
    (donor as { visibility: string }).visibility = "public";
    const result = out(view, {
      template: "out",
      entries: [{ field: "donor_note", term: "description" }],
    });
    expect(codes(result)).toEqual(["staff_field"]);
  });

  it("never outputs an identifier's type, wherever it is mapped", () => {
    const item = record("object", "I", {
      rights: { uri: CNE },
      number: { type: "secret_type_code", value: "2026.015" },
    });
    const view = viewOf([item], item.id);
    for (const term of ["identifier", "title", "description", "subject", "relation"]) {
      const all = everything(
        ok(out(view, { template: "out", entries: [RIGHTS_ENTRY, { field: "number", term }] })),
      );
      expect(all).toContain("2026.015");
      expect(all).not.toContain("secret_type_code");
    }
  });
});

describe("forged and copied public views are refused", () => {
  const item = record("object", "I", { rights: { uri: CNE }, description: "x" });
  const effective = effectiveOf([item], item.id);
  const maybe = publicView(effective);
  if (maybe === undefined) throw new Error("no view");
  const view: PublicRecord = maybe;

  it("accepts the real view", () => {
    expect(out(view).ok).toBe(true);
  });

  it("refuses copies, clones, Proxies, objects inheriting from it and the effective record", () => {
    const forgeries: unknown[] = [
      { ...view },
      structuredClone(view),
      JSON.parse(JSON.stringify(view)) as unknown,
      Object.create(view) as unknown,
      new Proxy(view, {}),
      effective,
      { id: item.id, kind: "object", title: "I", fields: {}, entries: [] },
      null,
      undefined,
      "view",
    ];
    for (const forged of forgeries) {
      expect(codes(out(forged as PublicRecord, MAPPING, item.id))).toEqual(["not_public_view"]);
    }
  });

  it("does not read a forged view at all", () => {
    let reads = 0;
    const spy = new Proxy(view, {
      get(target, key, receiver) {
        reads++;
        return Reflect.get(target, key, receiver) as unknown;
      },
      getOwnPropertyDescriptor(target, key) {
        reads++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(codes(out(spy, MAPPING, item.id))).toEqual(["not_public_view"]);
    expect(reads).toBe(0);
  });

  it("keeps the marks that recognise a view out of the package's exports", async () => {
    const api = (await import("./index.js")) as Record<string, unknown>;
    expect(api.publicViewOrigin).toBeUndefined();
    expect(api.markPublicView).toBeUndefined();
  });

  it("can't be changed after it is made", () => {
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.entries)).toBe(true);
  });
});

describe("hostile options", () => {
  const item = record("object", "I", { rights: { uri: CNE } });
  const view = viewOf([item], item.id);
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).baseUrl;
    delete (Object.prototype as Record<string, unknown>).published;
  });

  function run(options: unknown) {
    return codes(publicOutput(view, MAPPING, options as never));
  }

  it("refuses a Proxy without reading it", () => {
    let reads = 0;
    const proxy = new Proxy(
      { baseUrl: BASE, published: [view.id] },
      {
        get(t, k, r) {
          reads++;
          return Reflect.get(t, k, r) as unknown;
        },
        ownKeys(t) {
          reads++;
          return Reflect.ownKeys(t);
        },
      },
    );
    expect(run(proxy)).toEqual(["invalid_options"]);
    expect(reads).toBe(0);
  });

  it("refuses getters, hidden properties, unknown options and class instances", () => {
    const getter = { published: [view.id] };
    let calls = 0;
    Object.defineProperty(getter, "baseUrl", {
      enumerable: true,
      get() {
        calls++;
        return BASE;
      },
    });
    expect(run(getter)).toEqual(["invalid_options"]);
    expect(calls).toBe(0);
    const hidden = { published: [view.id] };
    Object.defineProperty(hidden, "baseUrl", { value: BASE, enumerable: false });
    expect(run(hidden)).toEqual(["invalid_options"]);
    expect(run({ baseUrl: BASE, published: [view.id], force: true })).toEqual(["invalid_options"]);
    expect(run({ baseUrl: BASE, published: [view.id], [Symbol("x")]: 1 })).toEqual([
      "invalid_options",
    ]);
    expect(
      run(
        new (class {
          baseUrl = BASE;
          published = [view.id];
        })(),
      ),
    ).toEqual(["invalid_options"]);
    expect(run(null)).toEqual(["invalid_options"]);
  });

  it("refuses a Proxy or a getter inside the published list", () => {
    expect(run({ baseUrl: BASE, published: new Proxy([view.id], {}) })).toEqual([
      "invalid_options",
    ]);
    const list: unknown[] = [];
    let calls = 0;
    Object.defineProperty(list, 0, {
      enumerable: true,
      get() {
        calls++;
        return view.id;
      },
    });
    expect(run({ baseUrl: BASE, published: list })).toEqual(["invalid_published"]);
    expect(calls).toBe(0);
    // A hole is not an ID.
    const holey: unknown[] = [];
    holey[1] = view.id;
    expect(run({ baseUrl: BASE, published: holey })).toEqual(["invalid_published"]);
  });

  it("does not read options from Object.prototype", () => {
    (Object.prototype as Record<string, unknown>).baseUrl = BASE;
    (Object.prototype as Record<string, unknown>).published = [view.id];
    expect(run({})).toEqual(["invalid_base_url"]);
    expect(run({ baseUrl: BASE })).toEqual(["invalid_published"]);
  });

  it("refuses a published list over the limit without reading it", () => {
    const huge: unknown[] = [];
    huge.length = MAX_RECORD_SET + 1;
    expect(run({ baseUrl: BASE, published: huge })).toEqual(["invalid_published"]);
  });

  it("refuses a hostile mapping", () => {
    const proxy = new Proxy(MAPPING, {});
    expect(codes(out(view, proxy))).toEqual(["not_an_object"]);
    const getter = { template: "out" };
    Object.defineProperty(getter, "entries", { enumerable: true, get: () => MAPPING.entries });
    expect(out(view, getter).ok).toBe(false);
  });
});

describe("injection", () => {
  const hostile = `<script>alert("x")</script> ]]> & 'q' ${ch(13)}${ch(10)}end`;

  it("escapes hostile text in XML and keeps it exact in Dublin Core and JSON-LD", () => {
    const title = hostile.replace(/[\r\n]/g, "");
    const item = record("object", title, { rights: { uri: CNE }, description: hostile });
    const o = ok(out(viewOf([item], item.id)));
    const escaped =
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; ]]&gt; &amp; &apos;q&apos; &#13;" +
      ch(10) +
      "end";
    expect(o.oaiDcXml).toContain(`<dc:title>${escaped.replace(/&#13;|\n/g, "")}</dc:title>`);
    expect(o.oaiDcXml).toContain(`<dc:description>${escaped}</dc:description>`);
    expect(o.oaiDcXml).not.toContain("<script");
    expect(o.oaiDcXml).not.toContain("]]>");
    expect(o.oaiDcXml).not.toContain(ch(13));
    expect(o.dublinCore.description).toEqual([hostile]);
    expect(o.jsonLd["dcterms:description"]).toBe(hostile);
    // The JSON text can sit in a script element: no < > & as they are.
    expect(o.jsonLdText).not.toMatch(/[<>&]/);
    expect(JSON.parse(o.jsonLdText)).toEqual(o.jsonLd);
  });

  it("escapes line and paragraph separators in the JSON text", () => {
    const text = `a${ch(0x2028)}b${ch(0x2029)}c`;
    const item = record("object", "I", { rights: { uri: CNE }, description: text });
    const o = ok(out(viewOf([item], item.id)));
    expect(o.jsonLdText).not.toContain(ch(0x2028));
    expect(o.jsonLdText).not.toContain(ch(0x2029));
    expect(JSON.parse(o.jsonLdText)).toEqual(o.jsonLd);
  });

  it("keeps JSON-LD keywords in values as text, never as keys or nodes", () => {
    const sneaky = [
      "@context",
      "@id",
      '{"@id": "https://evil.example/"}',
      '", "@context": "https://evil.example/ctx", "x": "',
    ];
    const item = record("object", "@graph", {
      rights: { uri: CNE },
      description: sneaky.join(" "),
      subjects: sneaky.map((label) => ({ label })),
      creator: "@type",
    });
    const o = ok(out(viewOf([item], item.id)));
    const doc = JSON.parse(o.jsonLdText) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual([
      "@context",
      "@id",
      "@type",
      "dcterms:title",
      "dcterms:rights",
      "dcterms:description",
      "dcterms:subject",
      "dcterms:creator",
    ]);
    expect(doc["@id"]).toBe(BASE + item.id);
    expect(doc["@type"]).toBe("dcmitype:PhysicalObject");
    expect(doc["dcterms:title"]).toBe("@graph");
    expect(doc["dcterms:subject"]).toEqual(sneaky);
    // creator has a class range, so text goes in a label node, still as text.
    expect(doc["dcterms:creator"]).toEqual({ "rdfs:label": "@type" });
    expect(doc["@context"]).toEqual(o.jsonLd["@context"]);
  });

  it("refuses term, link and place URIs that aren't plain http(s)", () => {
    for (const fields of [
      { subjects: [{ label: "x", uri: 'http://e.example/"><script>' }] },
      { subjects: [{ label: "x", uri: "data:text/html,hi" }] },
      { website: { url: "http://e.example/<x>" } },
      { website: { url: "file:///etc/passwd" } },
      { places: [{ label: "x", uri: "http://e.example/{x}" }] },
      { places: [{ label: "x", uri: "vbscript:x" }] },
    ]) {
      const item = record("object", "I", { rights: { uri: CNE }, ...fields });
      const result = out(viewOf([item], item.id));
      expect(result.ok, JSON.stringify(fields)).toBe(false);
      expect(codes(result)).not.toContain("unreadable");
    }
  });

  it("never lets control characters, lone surrogates or non-characters reach a view", () => {
    // They are refused when the record is read, so no output can hold them;
    // the base URL is checked here too.
    for (const bad of [ch(1), ch(0x0b), ch(0xd800), ch(0xdc00), ch(0xfffe), ch(0xffff), ch(0x7f)]) {
      const item = record("object", `T${bad}`, { rights: { uri: CNE }, description: `x${bad}` });
      expect(validateRecord(item).ok).toBe(false);
      expect(effectiveRecord(item.id, [item], () => TPL).ok).toBe(false);
      const fine = record("object", "I", { rights: { uri: CNE } });
      const view = viewOf([fine], fine.id);
      expect(
        codes(publicOutput(view, MAPPING, { baseUrl: `${BASE}${bad}/`, published: [view.id] })),
      ).toEqual(["invalid_base_url"]);
    }
  });

  it("keeps characters XML allows, including astral ones, tab and line feed", () => {
    const text = `tab${ch(9)}nl${ch(10)}${ch(0xd83d)}${ch(0xde82)} ${ch(0xe000)}${ch(0xfffd)}`;
    const item = record("object", "I", { rights: { uri: CNE }, description: text });
    const o = ok(out(viewOf([item], item.id)));
    expect(o.oaiDcXml).toContain(`<dc:description>${text}</dc:description>`);
  });
});

describe("prototype pollution", () => {
  afterEach(() => {
    const proto = Object.prototype as Record<string, unknown>;
    delete proto.iri;
    delete proto.labelled;
    delete proto.level;
  });

  it("can't add an IRI, label or type to output values through Object.prototype", () => {
    const item = record("object", "I", {
      rights: { uri: CNE },
      description: "plain",
      creator: "someone",
      subjects: [{ label: "local" }],
    });
    const unit = record("archival_unit", "U", { rights: { uri: CNE } }, { level: "item" });
    const clean = ok(out(viewOf([item], item.id)));
    const cleanUnit = ok(out(viewOf([unit], unit.id)));
    Object.assign(Object.prototype, {
      iri: "https://evil.example/",
      labelled: true,
      level: "fonds",
    });
    const polluted = ok(out(viewOf([item], item.id)));
    expect(everything(polluted)).not.toContain("evil");
    expect(polluted).toEqual(clean);
    expect(ok(out(viewOf([unit], unit.id))).jsonLd["@type"]).toBeUndefined();
    expect(ok(out(viewOf([unit], unit.id)))).toEqual(cleanUnit);
  });
});

describe("huge inputs", () => {
  it("refuses output over the size limit, quickly", () => {
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const tpl = template([
      field({ key: "rights", kind: "rights" }),
      ...keys.map((key) => field({ key, kind: "long_text" })),
    ]);
    const fields: Record<string, string> = {};
    for (const key of keys) fields[key] = "x".repeat(99_000);
    const item = record("object", "Big", { rights: { uri: CNE }, ...fields });
    const view = viewOf([item], item.id, tpl);
    const terms = [
      "description",
      "abstract",
      "title",
      "subject",
      "coverage",
      "source",
      "relation",
    ] as const;
    const mapping = {
      template: "out",
      entries: [RIGHTS_ENTRY, ...keys.flatMap((f) => terms.map((term) => ({ field: f, term })))],
    };
    const started = performance.now();
    expect(codes(out(view, mapping))).toEqual(["too_large"]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(9 * 99_000 * terms.length).toBeGreaterThan(MAX_OUTPUT_CHARS);
  });

  it("counts URIs against the size limit too", () => {
    const uri = `https://e.example/${"u".repeat(1970)}`;
    const places = Array.from({ length: 300 }, (_, i) => ({ label: String(i), uri }));
    const item = record("object", "URIs", { rights: { uri: CNE }, places });
    const view = viewOf([item], item.id);
    const terms = [
      "subject",
      "relation",
      "coverage",
      "spatial",
      "source",
      "type",
      "format",
      "medium",
      "extent",
    ];
    const mapping = {
      template: "out",
      entries: [RIGHTS_ENTRY, ...terms.map((term) => ({ field: "places", term }))],
    };
    expect(300 * uri.length * terms.length).toBeGreaterThan(MAX_OUTPUT_CHARS);
    expect(codes(out(view, mapping))).toEqual(["too_large"]);
    expect(
      out(view, {
        template: "out",
        entries: [RIGHTS_ENTRY, { field: "places", term: "spatial" }],
      }).ok,
    ).toBe(true);
  });

  function escapingRecord(char: string) {
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const tpl = template([
      field({ key: "rights", kind: "rights" }),
      ...keys.map((key) => field({ key, kind: "long_text" })),
    ]);
    const fields: Record<string, string> = {};
    for (const key of keys) fields[key] = char.repeat(99_000);
    const item = record("object", "Big", { rights: { uri: CNE }, ...fields });
    const view = viewOf([item], item.id, tpl);
    const mapping = {
      template: "out",
      entries: [RIGHTS_ENTRY, ...keys.map((f) => ({ field: f, term: "description" }))],
    };
    return { view, mapping, values: 9 * 99_000 };
  }

  it("caps the JSON text as produced, escapes included", () => {
    // "<" is 1 character of value but 6 in jsonLdText (and 4 in XML).
    const { view, mapping, values } = escapingRecord("<");
    expect(values).toBeLessThan(MAX_OUTPUT_CHARS);
    const result = out(view, mapping);
    expect(codes(result)).toEqual(["too_large"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["jsonLdText"]);
  });

  it("caps the XML as produced, escapes included", () => {
    // "'" is 1 character in JSON but 6 in XML (&apos;).
    const { view, mapping } = escapingRecord("'");
    const result = out(view, mapping);
    expect(codes(result)).toEqual(["too_large"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["oaiDcXml"]);
  });

  it("handles a record near every limit in good time", () => {
    const subjects = Array.from({ length: 500 }, (_, i) => ({
      label: `${"<&>".repeat(150)}${String(i)}`,
    }));
    const item = record("object", "<".repeat(1000), {
      rights: { uri: CNE },
      description: "&".repeat(99_000),
      subjects,
    });
    const view = viewOf([item], item.id);
    const published = Array.from({ length: 100_000 }, () => newRecordId());
    published.push(view.id);
    const started = performance.now();
    const o = ok(publicOutput(view, MAPPING, { baseUrl: BASE, published }));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(o.dublinCore.subject).toHaveLength(500);
    const content = o.oaiDcXml.replace(
      /<\?xml[^>]*\?>|<\/?(?:oai_dc|dc):[A-Za-z]+(?: [^>]*)?>/g,
      "",
    );
    expect(content).not.toMatch(/[<>]/);
    expect(content).toContain("&amp;&amp;");
  });
});
