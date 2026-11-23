// Attack tests for public output: staff values trying to get out, forged
// public views, hostile mappings and options, injection, and huge inputs.
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_CHARS,
  MAX_RECORD_SET,
  effectiveRecord,
  indexRecords,
  indexTemplates,
  makeIdentifierChecker,
  newOrganizationId,
  newRecordId,
  publicOutput,
  publicView,
  retireIdentifier,
  validateRecord,
  type FieldValue,
  type PublicOutput,
  type PublicRecord,
  type RecordId,
  type RecordIdentifiers,
  type Validated,
} from "./index.js";
import {
  accessionsFor,
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
  idsOf,
  CHECKERS,
  RIGHTS_ENTRY,
  ORG,
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
  return publicOutput(view, mapping, {
    baseUrl: BASE,
    accessions: accessionsFor(view),
    published: [id],
    checkers: CHECKERS,
    identifiers: idsOf(view),
  });
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
      organizationId: ORG,
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
          organizationId: ORG,
          template: "out",
          entries: [RIGHTS_ENTRY, { field: "donor_note", term: "description" }],
        }),
      ),
    ).toEqual(["staff_field"]);
    expect(
      codes(
        out(view, {
          organizationId: ORG,
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

  it("refuses another organization's mapping for a template with the same key (D-047)", () => {
    const item = record("object", "I", { rights: { uri: CNE } });
    const view = viewOf([item], item.id);
    const other = newOrganizationId();
    const theirs = { ...MAPPING, organizationId: other };
    const result = out(view, theirs);
    expect(codes(result)).toEqual(["wrong_organization"]);
    if (!result.ok) {
      for (const i of result.issues) {
        for (const leaked of ['"out"', other, ORG, ...MAPPING.entries.map((e) => e.field)]) {
          expect(i.message).not.toContain(leaked);
        }
      }
    }
    const unowned: Record<string, unknown> = { ...MAPPING };
    delete unowned.organizationId;
    expect(codes(out(view, unowned))).toEqual(["invalid_organization"]);
    expect(codes(out(view, { ...MAPPING, organizationId: "not-an-id" }))).toEqual([
      "invalid_organization",
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
      organizationId: ORG,
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
        ok(
          out(view, {
            organizationId: ORG,
            template: "out",
            entries: [RIGHTS_ENTRY, { field: "number", term }],
          }),
        ),
      );
      expect(all).toContain("2026.015");
      expect(all).not.toContain("secret_type_code");
    }
  });
});

describe("staff identifier types never reach any output form (D-022)", () => {
  // `donor_file_number` is staff only (the default) in the fixtures' types.
  const SECRET = "DF-SECRET-0042";
  const staffItem = () =>
    record("object", "I", {
      rights: { uri: CNE },
      number: { type: "donor_file_number", value: SECRET },
    });

  it("refuses a staff type's value in a public field, wherever it is mapped", () => {
    const item = staffItem();
    const view = viewOf([item], item.id);
    for (const term of ["identifier", "title", "description", "subject", "relation"]) {
      const result = out(view, {
        organizationId: ORG,
        template: "out",
        entries: [RIGHTS_ENTRY, { field: "number", term }],
      });
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(["private_identifier_type"]);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("refuses it in a repeatable field mixed with public numbers", () => {
    const fields = TPL.fields.map((f) => (f.key === "number" ? { ...f, repeatable: true } : f));
    const tpl = template(fields);
    const item = record("object", "I", {
      rights: { uri: CNE },
      number: [
        { type: "accession_number", value: "2026.015" },
        { type: "donor_file_number", value: SECRET },
      ],
    });
    const result = out(viewOf([item], item.id, tpl));
    expect(codes(result)).toEqual(["private_identifier_type"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("refuses it even with a lax identifier checker that accepts everything", () => {
    const item = staffItem();
    const view = viewOf([item], item.id);
    for (const identifier of [() => [], Object.assign(() => [], CHECKERS.identifier)]) {
      const result = publicOutput(view, MAPPING, {
        baseUrl: BASE,
        accessions: accessionsFor(view),
        published: [view.id],
        checkers: { identifier },
      });
      expect(result.ok).toBe(false);
      // The effective record already holds it back (D-022).
      expect(codes(result)).toEqual(["private_identifier_type"]);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("publishes nothing of an inherited list kept staff for one staff-type number (S-006a)", () => {
    // The child keeps the staff copy of the list (D-041), so the output must
    // hold neither the staff number nor the public one beside it, and the
    // fonds's title and ID must not appear either.
    const fields = TPL.fields.map((f) =>
      f.key === "number" ? { ...f, repeatable: true, inherited: true } : f,
    );
    const tpl = template(fields);
    const fonds = record(
      "archival_unit",
      "SECRET-fonds-title",
      {
        rights: { uri: CNE },
        number: [
          { type: "accession_number", value: "2026.015" },
          { type: "donor_file_number", value: SECRET },
        ],
      },
      { level: "fonds" },
    );
    const item = record(
      "archival_unit",
      "Item",
      { description: "Public text" },
      { level: "item", parentId: fonds.id },
    );
    const effective = effectiveOf([item, fonds], item.id, tpl);
    // Staff do see it, with the note that says why it stays staff.
    expect(effective.fields.number).toEqual([
      { type: "accession_number", value: "2026.015" },
      { type: "donor_file_number", value: SECRET },
    ]);
    expect(effective.notes.map((n) => n.code)).toContain("inherited_staff_identifier");
    const view = publicView(effective);
    if (view === undefined) throw new Error("no view");
    expect(Object.hasOwn(view.fields, "number")).toBe(false);
    const all = everything(
      ok(out(view, { organizationId: ORG, template: "out", entries: MAPPING.entries })),
    );
    expect(all).toContain("Public text");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("2026.015");
    expect(all).not.toContain("SECRET");
    expect(all).not.toContain(fonds.id);
  });

  it("refuses a lax checker for public types too: it can't say which types are public", () => {
    const item = record("object", "I", {
      rights: { uri: CNE },
      number: { type: "accession_number", value: "2026.015" },
    });
    const view = viewOf([item], item.id);
    const result = publicOutput(view, MAPPING, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [view.id],
      checkers: { identifier: () => [] },
    });
    expect(codes(result)).toEqual(["unchecked"]);
  });

  it("still publishes a public type's value in Dublin Core, JSON-LD and oai_dc", () => {
    const item = record("object", "I", {
      rights: { uri: CNE },
      number: { type: "accession_number", value: "2026.015" },
    });
    const o = ok(out(viewOf([item], item.id)));
    expect(o.dublinCore.identifier).toContain("2026.015");
    expect(o.jsonLdText).toContain("2026.015");
    expect(o.oaiDcXml).toContain("<dc:identifier>2026.015</dc:identifier>");
    expect(everything(o)).not.toContain("accession_number");
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
      { baseUrl: BASE, accessions: accessionsFor(view), published: [view.id] },
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
    expect(
      run({ baseUrl: BASE, accessions: accessionsFor(view), published: [view.id], force: true }),
    ).toEqual(["invalid_options"]);
    expect(
      run({
        baseUrl: BASE,
        accessions: accessionsFor(view),
        published: [view.id],
        [Symbol("x")]: 1,
      }),
    ).toEqual(["invalid_options"]);
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
    expect(
      run({ baseUrl: BASE, accessions: accessionsFor(view), published: new Proxy([view.id], {}) }),
    ).toEqual(["invalid_options"]);
    const list: unknown[] = [];
    let calls = 0;
    Object.defineProperty(list, 0, {
      enumerable: true,
      get() {
        calls++;
        return view.id;
      },
    });
    expect(run({ baseUrl: BASE, accessions: accessionsFor(view), published: list })).toEqual([
      "invalid_published",
    ]);
    expect(calls).toBe(0);
    // A hole is not an ID.
    const holey: unknown[] = [];
    holey[1] = view.id;
    expect(run({ baseUrl: BASE, accessions: accessionsFor(view), published: holey })).toEqual([
      "invalid_published",
    ]);
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
    expect(run({ baseUrl: BASE, accessions: accessionsFor(view), published: huge })).toEqual([
      "invalid_published",
    ]);
  });

  it("refuses a hostile mapping", () => {
    const proxy = new Proxy(MAPPING, {});
    expect(codes(out(view, proxy))).toEqual(["not_an_object"]);
    const getter = { organizationId: ORG, template: "out" };
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

  it("can't change the JSON text through Object.prototype.toJSON", () => {
    const item = record("object", "I", { rights: { uri: CNE }, creator: "someone" });
    const view = viewOf([item], item.id);
    // One entry: dublin-core.ts compares entries with JSON.stringify, so a
    // polluted toJSON makes it refuse longer mappings (it fails closed).
    const mapping = { organizationId: ORG, template: "out", entries: [RIGHTS_ENTRY] };
    const clean = ok(out(view, mapping));
    const proto = Object.prototype as Record<string, unknown>;
    proto.toJSON = () => "evil";
    let result: ReturnType<typeof out>;
    try {
      result = out(view, mapping);
    } finally {
      // Removed before anything else serializes (the test runner does too).
      delete proto.toJSON;
    }
    const polluted = ok(result);
    expect(polluted.jsonLdText).toBe(clean.jsonLdText);
    expect(polluted.jsonLdText).not.toContain("evil");
    expect(Object.getPrototypeOf(polluted.jsonLd)).toBeNull();
    expect(Object.getPrototypeOf(polluted.jsonLd["@context"])).toBeNull();
    expect(Object.getPrototypeOf(polluted.jsonLd["dcterms:rights"])).toBeNull();
    expect(Object.getPrototypeOf(polluted.dublinCore)).toBeNull();
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
      organizationId: ORG,
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
      organizationId: ORG,
      template: "out",
      entries: [RIGHTS_ENTRY, ...terms.map((term) => ({ field: "places", term }))],
    };
    expect(300 * uri.length * terms.length).toBeGreaterThan(MAX_OUTPUT_CHARS);
    expect(codes(out(view, mapping))).toEqual(["too_large"]);
    expect(
      out(view, {
        organizationId: ORG,
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
      organizationId: ORG,
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
    const o = ok(
      publicOutput(view, MAPPING, { baseUrl: BASE, accessions: accessionsFor(view), published }),
    );
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

describe("a parent's template changed after the view was made (security run 2026-11-21)", () => {
  const CREATOR_MAP = {
    organizationId: ORG,
    template: "out",
    entries: [RIGHTS_ENTRY, { field: "creator", term: "creator" }],
  };
  const staffCreator = (key: string) =>
    template(
      TPL.fields.map((f) => (f.key === "creator" ? { ...f, visibility: "staff" as const } : f)),
      key,
    );

  // The fonds's template marks `creator` public and inherited when the view is
  // made; then an admin makes it staff. The item's inherited value is staff now.
  function staleView() {
    let fondsTemplate = template(TPL.fields, "fonds");
    const fonds = record(
      "archival_unit",
      "Fonds",
      { rights: { uri: CNE }, creator: "SECRET-now-staff" },
      { level: "fonds" },
    );
    const item = record("archival_unit", "Item", {}, { level: "item", parentId: fonds.id });
    const lookup = (r: { id: string }) => (r.id === fonds.id ? fondsTemplate : TPL);
    const built = effectiveRecord(item.id, [item, fonds], lookup);
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    expect(view.fields.creator).toBe("SECRET-now-staff");
    fondsTemplate = staffCreator("fonds");
    return { view, item, lookup, fondsId: fonds.id };
  }

  it("refuses with templateFor, naming the parent", () => {
    const { view, item, lookup, fondsId } = staleView();
    const result = publicOutput(view, CREATOR_MAP, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: CHECKERS,
      templateFor: lookup,
    });
    expect(codes(result)).toEqual(["template_changed"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["templateFor", fondsId]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("refuses currentTemplate alone for a record with parents, which used to publish", () => {
    const { view, item } = staleView();
    const result = publicOutput(view, CREATOR_MAP, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: CHECKERS,
      currentTemplate: TPL,
    });
    expect(codes(result)).toEqual(["ancestor_templates_unchecked"]);
  });

  it("refuses when templateFor now finds no template, throws, or isn't a function", () => {
    const { view, item } = staleView();
    const run = (templateFor: unknown) =>
      publicOutput(view, CREATOR_MAP, {
        baseUrl: BASE,
        accessions: accessionsFor(view),
        published: [item.id],
        checkers: CHECKERS,
        templateFor: templateFor as () => undefined,
      });
    expect(codes(run(() => undefined))).toEqual(["template_changed"]);
    expect(
      codes(
        run(() => {
          throw new Error("boom");
        }),
      ),
    ).toEqual(["template_lookup_failed"]);
    expect(codes(run("TPL"))).toEqual(["invalid_options"]);
    expect(codes(run(new Proxy(() => TPL, {})))).toEqual(["invalid_options"]);
  });

  it("still publishes when no template along the way has changed", () => {
    const fondsTemplate = template(TPL.fields, "fonds");
    const fonds = record(
      "archival_unit",
      "Fonds",
      { rights: { uri: CNE }, creator: "Public creator" },
      { level: "fonds" },
    );
    const item = record("archival_unit", "Item", {}, { level: "item", parentId: fonds.id });
    // Fresh copies each call: compared as data, not by identity.
    const lookup = (r: { id: string }) =>
      r.id === fonds.id ? structuredClone(fondsTemplate) : structuredClone(TPL);
    const built = effectiveRecord(item.id, [item, fonds], lookup);
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    const result = ok(
      publicOutput(view, CREATOR_MAP, {
        baseUrl: BASE,
        accessions: accessionsFor(view),
        published: [item.id],
        checkers: CHECKERS,
        currentTemplate: TPL,
        templateFor: lookup,
      }),
    );
    expect(everything(result)).toContain("Public creator");
  });
});

describe("the records changed after the view was made (S-001a)", () => {
  const CREATOR_MAP = {
    organizationId: ORG,
    template: "out",
    entries: [RIGHTS_ENTRY, { field: "creator", term: "creator" }],
  };

  // A fonds, a series and an item inheriting `creator` from the fonds. The
  // view is built, then the catalog is edited; the view is kept and published.
  function keptView() {
    const fonds = record(
      "archival_unit",
      "Fonds",
      { rights: { uri: CNE }, creator: "SECRET-old-creator" },
      { level: "fonds" },
    );
    const other = record(
      "archival_unit",
      "Other fonds",
      { rights: { uri: CNE }, creator: "Other creator" },
      { level: "fonds" },
    );
    const item = record("archival_unit", "Item", {}, { level: "item", parentId: fonds.id });
    const lookup = () => TPL;
    const built = effectiveRecord(item.id, [item, fonds, other], lookup);
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    expect(view.fields.creator).toBe("SECRET-old-creator");
    return { view, item, fonds, other, lookup };
  }

  function run(view: PublicRecord, id: string, records: unknown, extra: object = {}) {
    return publicOutput(view, CREATOR_MAP, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [id as PublicRecord["id"]],
      checkers: CHECKERS,
      templateFor: () => TPL,
      records: records as readonly never[],
      ...extra,
    });
  }

  function refusedAt(result: Validated<PublicOutput>, id: string): void {
    expect(codes(result)).toEqual(["record_changed"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["records", id]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  }

  it("refuses when an ancestor's value has changed since, naming the ancestor", () => {
    const { view, item, fonds, other } = keptView();
    const edited = { ...fonds, fields: { ...fonds.fields, creator: "New creator" } };
    // templateFor alone can't see it: the templates are unchanged.
    expect(run(view, item.id, undefined).ok).toBe(true);
    refusedAt(run(view, item.id, [item, edited, other]), fonds.id);
    const indexed = indexRecords([item, edited, other]);
    if (!indexed.ok) throw new Error("bad fixture");
    refusedAt(run(view, item.id, indexed.value), fonds.id);
  });

  it("refuses when an ancestor's value has been made empty since", () => {
    const { view, item, fonds, other } = keptView();
    const emptied = { ...fonds, fields: { ...fonds.fields, creator: "" } };
    refusedAt(run(view, item.id, [item, emptied, other]), fonds.id);
  });

  it("refuses when the item has moved to a different parent since", () => {
    const { view, item, fonds, other } = keptView();
    const moved = { ...item, parentId: other.id };
    refusedAt(run(view, item.id, [moved, fonds, other]), item.id);
  });

  it("refuses when the item's level has changed since", () => {
    const { view, item, fonds, other } = keptView();
    const relevelled = { ...item, level: "file" };
    refusedAt(run(view, item.id, [relevelled, fonds, other]), item.id);
  });

  it("refuses when a parent has been removed from the set, or the record itself", () => {
    const { view, item, fonds, other } = keptView();
    refusedAt(run(view, item.id, [item, other]), item.id);
    refusedAt(run(view, item.id, [fonds, other]), item.id);
  });

  it("refuses a records option that isn't a list or an index", () => {
    const { view, item, fonds, other } = keptView();
    expect(codes(run(view, item.id, { item, fonds, other }))).toEqual(["invalid_options"]);
    expect(codes(run(view, item.id, new Proxy([item, fonds, other], {})))).toEqual([
      "invalid_options",
    ]);
    expect(codes(run(view, item.id, Object.freeze({ size: 3 })))).toEqual(["invalid_options"]);
  });

  it("asks templateFor with the records as they are now", () => {
    const { view, item, fonds, other } = keptView();
    const seen: unknown[] = [];
    const copies = structuredClone([item, fonds, other]);
    const result = run(view, item.id, copies, {
      templateFor: (r: unknown) => {
        seen.push(r);
        return TPL;
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(2);
    // Validated copies of the current set, not the records the view holds.
    expect(seen).toEqual([copies[0], copies[1]]);
  });

  it("still publishes from fresh copies of unchanged records", () => {
    const { view, item, fonds, other } = keptView();
    const result = ok(
      run(view, item.id, structuredClone([other, fonds, item]), {
        templateFor: () => structuredClone(TPL),
      }),
    );
    expect(everything(result)).toContain("SECRET-old-creator");
  });
});

// Records name their template (D-029). A record must never be published under
// a template other than the one it names, however the caller's lookup or a
// kept view would have it.
describe("records are published only under the template they name", () => {
  const HOLDER_MAP = {
    organizationId: ORG,
    template: "out",
    entries: [RIGHTS_ENTRY, { field: "holder", term: "rightsHolder" }],
  };
  // The same fields as TPL, but `holder` is staff: a donor's name.
  const STAFF_HOLDER = template(
    TPL.fields.map((f) => (f.key === "holder" ? { ...f, visibility: "staff" as const } : f)),
    "donor-records",
  );

  function registry(...templates: unknown[]) {
    const r = indexTemplates(templates);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }

  function keyedItem(templateKey: string) {
    return record(
      "object",
      "Chair",
      { rights: { uri: CNE }, holder: "SECRET-donor-name" },
      { templateKey },
    );
  }

  it("publishes with a registry as templateFor, finding the template by the record's key", () => {
    const item = keyedItem("out");
    const templates = registry(TPL, STAFF_HOLDER);
    const built = effectiveRecord(item.id, [item], templates, { checkers: CHECKERS });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    const out = ok(
      publicOutput(view, HOLDER_MAP, {
        baseUrl: BASE,
        accessions: accessionsFor(view),
        published: [item.id],
        checkers: CHECKERS,
        templateFor: templates,
        records: [item],
      }),
    );
    expect(everything(out)).toContain("SECRET-donor-name");
  });

  it("never builds a view under another template from a lookup that ignores the record's key", () => {
    const item = keyedItem("donor-records");
    const built = effectiveRecord(item.id, [item], () => TPL, { checkers: CHECKERS });
    expect(codes(built)).toEqual(["template_mismatch"]);
  });

  it("refuses a kept view when the lookup now gives the record another template", () => {
    const item = keyedItem("donor-records");
    const built = effectiveRecord(item.id, [item], registry(STAFF_HOLDER), { checkers: CHECKERS });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    const result = publicOutput(
      view,
      { organizationId: ORG, template: "donor-records", entries: [RIGHTS_ENTRY] },
      {
        baseUrl: BASE,
        accessions: accessionsFor(view),
        published: [item.id],
        checkers: CHECKERS,
        templateFor: () => TPL,
      },
    );
    expect(codes(result)).toEqual(["template_mismatch"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["templateFor"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("refuses a kept view once the record has been moved to a template that makes a value staff", () => {
    // Built while the record followed `out`, where `holder` is public; then
    // the record is moved to `donor-records`, where `holder` is staff.
    const item = keyedItem("out");
    const templates = registry(TPL, STAFF_HOLDER);
    const built = effectiveRecord(item.id, [item], templates, { checkers: CHECKERS });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    expect(view.fields.holder).toBe("SECRET-donor-name");
    const moved = { ...item, templateKey: "donor-records" };
    const result = publicOutput(view, HOLDER_MAP, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: CHECKERS,
      templateFor: templates,
      records: [moved],
    });
    expect(codes(result)).toEqual(["record_changed"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["records", item.id]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    // A view built now follows the template the record names: nothing to publish.
    const fresh = effectiveRecord(item.id, [moved], templates, { checkers: CHECKERS });
    if (!fresh.ok) throw new Error(JSON.stringify(fresh.issues));
    expect(publicView(fresh.value)?.fields.holder).toBeUndefined();
  });

  it("refuses a record with no templateKey when templateFor is a registry", () => {
    const item = record("object", "Chair", { rights: { uri: CNE } });
    const view = viewOf([item], item.id);
    const result = publicOutput(view, MAPPING, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: CHECKERS,
      templateFor: registry(TPL),
    });
    expect(codes(result)).toEqual(["no_template_key"]);
  });

  it("refuses a registry-shaped object as templateFor", () => {
    const item = record("object", "Chair", { rights: { uri: CNE } });
    const view = viewOf([item], item.id);
    const result = publicOutput(view, MAPPING, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: CHECKERS,
      templateFor: Object.freeze({ size: 1 }),
    });
    expect(codes(result)).toEqual(["invalid_options"]);
  });
});

describe("public output won't use another organization's records (D-019)", () => {
  const CREATOR_MAP = {
    organizationId: ORG,
    template: "out",
    entries: [RIGHTS_ENTRY, { field: "creator", term: "creator" }],
  };

  it("refuses a current set that mixes in another organization's records", () => {
    const fonds = record(
      "archival_unit",
      "Fonds",
      { rights: { uri: CNE }, creator: "Own creator" },
      { level: "fonds" },
    );
    const item = record("archival_unit", "Item", {}, { level: "item", parentId: fonds.id });
    const built = effectiveRecord(item.id, [item, fonds], () => TPL);
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    const stray = record(
      "archival_unit",
      "Other organization's fonds",
      { rights: { uri: CNE }, creator: "SECRET other creator" },
      { level: "fonds", organizationId: newOrganizationId() },
    );
    const options = {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: CHECKERS,
      templateFor: () => TPL,
    };
    expect(publicOutput(view, CREATOR_MAP, { ...options, records: [item, fonds] }).ok).toBe(true);
    const result = publicOutput(view, CREATOR_MAP, { ...options, records: [item, fonds, stray] });
    expect(codes(result)).toEqual(["mixed_organizations"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["records"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("another organization's identifier checker can't publish a staff number (D-019)", () => {
  // This organization's `accession_number` is staff only; another organization
  // has a public type with the same key.
  const OTHER_PUBLIC = makeIdentifierChecker([
    {
      key: "accession_number",
      label: "Accession number",
      organizationId: newOrganizationId(),
      uniqueness: "none",
      public: true,
    },
  ]);
  if (!OTHER_PUBLIC.ok) throw new Error("bad fixture");
  const other = { identifier: OTHER_PUBLIC.value };
  const MAP = {
    organizationId: ORG,
    template: "out",
    entries: [RIGHTS_ENTRY, { field: "number", term: "identifier" }],
  };

  it("leaves the number staff in the effective record, and publishing waits", () => {
    const item = record("object", "Item", {
      rights: { uri: CNE },
      number: { type: "accession_number", value: "SECRET-0001" },
    });
    const built = effectiveRecord(item.id, [item], () => TPL, { checkers: other });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    expect(built.value.entries.find((e) => e.key === "number")?.visibility).toBe("staff");
    expect(built.value.notes.map((n) => n.code)).toContain("wrong_organization_checker");
    const view = publicView(built.value);
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("refuses at the output boundary when the view was made with the right checker", () => {
    const item = record("object", "Item", {
      rights: { uri: CNE },
      number: { type: "accession_number", value: "SECRET-0001" },
    });
    const view = viewOf([item], item.id);
    const result = publicOutput(view, MAP, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: other,
    });
    expect(codes(result)).toEqual(["wrong_organization_checker"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("a set entry that doesn't say its organization refuses the set (second review of T-019)", () => {
  it.each([
    ["missing", (r: object) => ({ ...r, organizationId: undefined })],
    ["not an organization ID", (r: object) => ({ ...r, organizationId: "nope" })],
    [
      "behind a getter",
      (r: object) =>
        Object.defineProperty({ ...r }, "organizationId", { get: () => "x", enumerable: true }),
    ],
  ])("when its organizationId is %s", (_, spoil) => {
    const fonds = record("archival_unit", "Fonds", { rights: { uri: CNE } }, { level: "fonds" });
    const item = record("archival_unit", "Item", {}, { level: "item", parentId: fonds.id });
    const view = viewOf([item, fonds], item.id);
    const stray = spoil(record("object", "SECRET stray", {}));
    const index = indexRecords([item, fonds, stray]);
    expect(index.ok ? "" : index.issues[0]?.code).toBe("mixed_organizations");
    const out = publicOutput(view, MAPPING, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: CHECKERS,
      templateFor: () => TPL,
      records: [item, fonds, stray] as never,
    });
    expect(codes(out)).toEqual(["mixed_organizations"]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });
});

// D-038: numbers live in RecordIdentifiers. Each attack tries to get a
// staff-type number, or one the record no longer holds, into output.
describe("public output publishes only numbers the record holds (D-038)", () => {
  const MAP = {
    organizationId: ORG,
    template: "out",
    entries: [RIGHTS_ENTRY, { field: "number", term: "identifier" }],
  };
  const PUBLIC_NUMBER = { type: "accession_number", value: "2026.015" };
  interface IdSet {
    recordId: RecordId;
    organizationId: string;
    current: { type: string; value: string; primary: boolean }[];
    former: { type: string; value: string }[];
  }
  function itemWith(number: FieldValue) {
    return record("object", "Item", { rights: { uri: CNE }, number });
  }
  function publish(view: PublicRecord, id: RecordId, identifiers?: unknown) {
    return publicOutput(view, MAP, {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [id],
      checkers: CHECKERS,
      ...(identifiers === undefined ? {} : { identifiers: identifiers as never }),
    });
  }

  it("refuses a view made without the record's identifiers", () => {
    const item = itemWith(PUBLIC_NUMBER);
    const built = effectiveRecord(item.id, [item], () => TPL, { checkers: CHECKERS });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    const result = publish(view, item.id);
    expect(codes(result)).toEqual(["identifiers_unknown"]);
    expect(JSON.stringify(result)).not.toContain("2026.015");
  });

  it("refuses a staff-type primary number relabelled as a public type in the field", () => {
    const item = itemWith({ type: "accession_number", value: "SECRET-DF-1" });
    const identifiers: IdSet[] = [
      {
        recordId: item.id,
        organizationId: item.organizationId,
        current: [{ type: "donor_file_number", value: "SECRET-DF-1", primary: true }],
        former: [],
      },
    ];
    const built = effectiveRecord(item.id, [item], () => TPL, {
      checkers: CHECKERS,
      identifiers: identifiers as never,
    });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    expect(JSON.stringify(view)).not.toContain("SECRET");
    const result = publish(view, item.id, identifiers);
    expect(codes(result)).toEqual(["identifier_not_held"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("refuses a staff-type primary number the record holds, in a public field", () => {
    const item = itemWith({ type: "donor_file_number", value: "SECRET-DF-2" });
    const view = viewOf([item], item.id);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    const result = publish(view, item.id);
    expect(codes(result)).toEqual(["private_identifier_type"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("publishes a held public number, and checks it again against the identifiers as they are now", () => {
    const item = itemWith(PUBLIC_NUMBER);
    const view = viewOf([item], item.id);
    const now: IdSet = {
      recordId: item.id,
      organizationId: item.organizationId,
      current: [{ ...PUBLIC_NUMBER, primary: true }],
      former: [],
    };
    expect(ok(publish(view, item.id, [now])).dublinCore.identifier).toContain("2026.015");
    // Retired since the view was made: a kept view must not publish it.
    const retired: IdSet = {
      ...now,
      current: [{ type: "accession_number", value: "2026.016", primary: true }],
      former: [PUBLIC_NUMBER],
    };
    const result = publish(view, item.id, [retired]);
    expect(codes(result)).toEqual(["identifier_changed"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["fields", "number"]);
    expect(JSON.stringify(result)).not.toContain("2026.015");
    // Moved to another record of the organization: not this record's any more.
    const elsewhere: IdSet = { ...now, recordId: newRecordId() };
    expect(codes(publish(view, item.id, [elsewhere, { ...now, current: [] }]))).toEqual([
      "identifier_changed",
    ]);
    // Now held as a staff type with the same text.
    const restyled: IdSet = {
      ...now,
      current: [{ type: "donor_file_number", value: "2026.015", primary: true }],
    };
    expect(codes(publish(view, item.id, [restyled]))).toEqual(["identifier_changed"]);
  });

  it("refuses identifiers of another organization, duplicates and unreadable sets", () => {
    const item = itemWith(PUBLIC_NUMBER);
    const view = viewOf([item], item.id);
    const now: IdSet = {
      recordId: item.id,
      organizationId: item.organizationId,
      current: [{ ...PUBLIC_NUMBER, primary: true }],
      former: [],
    };
    expect(
      codes(publish(view, item.id, [{ ...now, organizationId: newOrganizationId() }])),
    ).toEqual(["mixed_organizations"]);
    expect(codes(publish(view, item.id, [now, now]))).toEqual(["duplicate_identifiers"]);
    expect(codes(publish(view, item.id, [{ ...now, current: "2026.015" }]))).toEqual([
      "invalid_identifiers",
    ]);
    expect(codes(publish(view, item.id, new Proxy([now], {})))).toEqual(["invalid_options"]);
    const getter = {
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [item.id],
      checkers: CHECKERS,
    };
    Object.defineProperty(getter, "identifiers", { get: () => [now], enumerable: true });
    expect(codes(publicOutput(view, MAP, getter))).toEqual(["invalid_options"]);
  });
});

// Review of T-014: a kept view must not publish a retired number, and
// identifier sets that break their own rules are refused.
describe("a kept view can't publish a retired number (T-014 review)", () => {
  const MAP = {
    organizationId: ORG,
    template: "out",
    entries: [RIGHTS_ENTRY, { field: "number", term: "identifier" }],
  };
  const NUMBER = { type: "accession_number", value: "2026.015" };
  const NEXT = { type: "accession_number", value: "2026.016" };

  function setup() {
    const item = record("object", "Item", { rights: { uri: CNE }, number: NUMBER });
    const before: RecordIdentifiers = {
      recordId: item.id,
      organizationId: item.organizationId,
      current: [
        { ...NUMBER, primary: true },
        { ...NEXT, primary: false },
      ],
      former: [],
    };
    const built = effectiveRecord(item.id, [item], () => TPL, {
      checkers: CHECKERS,
      identifiers: [before],
    });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    views.set(item.id, view);
    const retired = retireIdentifier(before, NUMBER, { newPrimary: NEXT });
    if (!retired.ok) throw new Error("retire");
    return { item, view, before, after: retired.value };
  }
  const views = new Map<RecordId, unknown>();
  const options = (id: RecordId, extra: object = {}) => ({
    baseUrl: BASE,
    accessions: accessionsFor(views.get(id)),
    published: [id],
    checkers: CHECKERS,
    ...extra,
  });

  it("refuses the view without identifiers, and with the identifiers as they are now", () => {
    const { item, view, before, after } = setup();
    expect(publicOutput(view, MAP, options(item.id, { identifiers: [before] })).ok).toBe(true);
    const without = publicOutput(view, MAP, options(item.id));
    expect(codes(without)).toEqual(["identifiers_unknown"]);
    expect(JSON.stringify(without)).not.toContain("2026.015");
    const now = publicOutput(view, MAP, options(item.id, { identifiers: [after] }));
    expect(codes(now)).toEqual(["identifier_changed"]);
    expect(JSON.stringify(now)).not.toContain("2026.015");
  });

  it("publishes a view with no identifier values without the option", () => {
    const item = record("object", "Item", { rights: { uri: CNE }, description: "A card" });
    const view = viewOf([item], item.id);
    views.set(item.id, view);
    const map = { organizationId: ORG, template: "out", entries: [RIGHTS_ENTRY] };
    expect(publicOutput(view, map, options(item.id)).ok).toBe(true);
  });

  it("refuses sets with two primaries, none, or the same current number twice", () => {
    const { item, view, before } = setup();
    const broken: RecordIdentifiers[] = [
      { ...before, current: before.current.map((c) => ({ ...c, primary: true })) },
      { ...before, current: before.current.map((c) => ({ ...c, primary: false })) },
      {
        ...before,
        current: [
          { ...NUMBER, primary: true },
          // The same number under the comparison key (spaces ignored).
          { type: NUMBER.type, value: "2026 .015", primary: false },
        ],
      },
    ];
    for (const set of broken) {
      const result = publicOutput(view, MAP, options(item.id, { identifiers: [set] }));
      expect(codes(result)).toEqual(["invalid_identifiers"]);
      expect(JSON.stringify(result)).not.toContain("2026.015");
      const fresh = effectiveRecord(item.id, [item], () => TPL, {
        checkers: CHECKERS,
        identifiers: [set],
      });
      expect(codes(fresh)).toEqual(["invalid_identifiers"]);
    }
  });

  it("allows a number both current and former: retired, then reinstated", () => {
    const { item, view, before } = setup();
    const reinstated: RecordIdentifiers = { ...before, former: [NUMBER] };
    expect(publicOutput(view, MAP, options(item.id, { identifiers: [reinstated] })).ok).toBe(true);
  });

  it("never publishes a held number whose type isn't one of the organization's", () => {
    const item = record("object", "Item", {
      rights: { uri: CNE },
      number: { type: "made_up_type", value: "SECRET-9" },
    });
    const set: RecordIdentifiers = {
      recordId: item.id,
      organizationId: item.organizationId,
      current: [{ type: "made_up_type", value: "SECRET-9", primary: true }],
      former: [],
    };
    const built = effectiveRecord(item.id, [item], () => TPL, {
      checkers: CHECKERS,
      identifiers: [set],
    });
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    expect(JSON.stringify(view)).not.toContain("SECRET");
    const result = publicOutput(view, MAP, options(item.id, { identifiers: [set] }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
