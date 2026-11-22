import { describe, expect, it } from "vitest";
import {
  VOCABULARIES,
  VOCABULARY_CODES,
  checkRecordAgainstTemplate,
  controlledTermChecker,
  isLocalTerm,
  normalizeTermUri,
  termUriKey,
  validateControlledTerm,
  validateRecord,
  validateTemplate,
  vocabulary,
  type CatalogRecord,
  type FieldTemplate,
  type Issue,
  type Validated,
  newOrganizationId,
} from "./index.js";

const ORG = newOrganizationId();

// Real id.loc.gov URIs and labels, checked against id.loc.gov on 2026-11-20.
const RAILROAD_STATIONS = "http://id.loc.gov/authorities/subjects/sh85111042";
const HURRICANES = "http://id.loc.gov/authorities/subjects/sh85063195";
const GHH = "http://id.loc.gov/authorities/names/no2008041321";
const TWAIN = "http://id.loc.gov/authorities/names/n79021164";
const ORAL_HISTORIES = "http://id.loc.gov/authorities/genreForms/gf2011026431";

function codes(result: Validated<unknown> | readonly Issue[]): string[] {
  if (Array.isArray(result)) return (result as readonly Issue[]).map((i) => i.code);
  const r = result as Validated<unknown>;
  return r.ok ? [] : r.issues.map((i) => i.code);
}

function code(input: unknown): string | undefined {
  return codes(validateControlledTerm(input))[0];
}

function message(input: unknown): string {
  const r = validateControlledTerm(input);
  return r.ok ? "" : (r.issues[0]?.message ?? "");
}

describe("the vocabulary list", () => {
  it("has the six vocabularies, each frozen and found by its code", () => {
    expect(VOCABULARIES.map((v) => v.code)).toEqual([...VOCABULARY_CODES]);
    expect(VOCABULARY_CODES).toEqual(["lcsh", "lcnaf", "lcgft", "nomenclature", "gnis", "local"]);
    expect(Object.isFrozen(VOCABULARIES)).toBe(true);
    for (const v of VOCABULARIES) {
      expect(Object.isFrozen(v)).toBe(true);
      expect(vocabulary(v.code)).toBe(v);
    }
  });

  it("says what is checked about each vocabulary's URIs", () => {
    expect(VOCABULARIES.map((v) => [v.code, v.uriCheck])).toEqual([
      ["lcsh", "lc_authority"],
      ["lcnaf", "lc_authority"],
      ["lcgft", "lc_authority"],
      ["nomenclature", "site"],
      ["gnis", "web_address"],
      ["local", "none"],
    ]);
    expect(vocabulary("lcsh")?.uriForm).toBe("http://id.loc.gov/authorities/subjects/{LCCN}");
    expect(vocabulary("lcgft")?.uriForm).toBe("http://id.loc.gov/authorities/genreForms/{LCCN}");
  });

  it("finds nothing for unknown codes, built-in names or non-text", () => {
    for (const c of ["LCSH", "aat", "constructor", "__proto__", "toString", "", 1, null]) {
      expect(vocabulary(c)).toBeUndefined();
    }
  });

  it("treats a term with no vocabulary, or local, as local", () => {
    expect(isLocalTerm({})).toBe(true);
    expect(isLocalTerm({ vocabulary: "local" })).toBe(true);
    expect(isLocalTerm({ vocabulary: "lcsh" })).toBe(false);
  });
});

describe("validateControlledTerm: accepted terms", () => {
  it("accepts canonical Library of Congress URIs with their vocabulary", () => {
    for (const [uri, vocab, label] of [
      [RAILROAD_STATIONS, "lcsh", "Railroad stations"],
      [HURRICANES, "lcsh", "Hurricanes"],
      ["http://id.loc.gov/authorities/subjects/sh2009119550", "lcsh", "A newer heading"],
      [GHH, "lcnaf", "Galveston, Houston and Henderson Railroad Company"],
      [TWAIN, "lcnaf", "Twain, Mark, 1835-1910"],
      ["http://id.loc.gov/authorities/names/nr00009591", "lcnaf", "J.B. Smith & Co."],
      ["http://id.loc.gov/authorities/names/nb2023015377", "lcnaf", "A society"],
      ["http://id.loc.gov/authorities/names/n2010201221", "lcnaf", "A church"],
      [ORAL_HISTORIES, "lcgft", "Oral histories"],
    ] as const) {
      const r = validateControlledTerm({ label, uri, vocabulary: vocab });
      expect(r).toEqual({ ok: true, value: { label, uri, vocabulary: vocab } });
    }
  });

  it("accepts local terms with no URI, with or without the local code", () => {
    expect(validateControlledTerm({ label: "Depot Park" })).toEqual({
      ok: true,
      value: { label: "Depot Park" },
    });
    expect(validateControlledTerm({ label: "Depot Park", vocabulary: "local" }).ok).toBe(true);
  });

  it("accepts outside vocabulary terms with no URI (headings built with subdivisions)", () => {
    expect(
      validateControlledTerm({ label: "Dickinson (Tex.)--History", vocabulary: "lcsh" }).ok,
    ).toBe(true);
    expect(validateControlledTerm({ label: "Dickinson", vocabulary: "gnis" }).ok).toBe(true);
  });

  it("accepts a Nomenclature URI on nomenclature.info", () => {
    for (const uri of ["https://nomenclature.info/nom/1234", "https://www.nomenclature.info/x"]) {
      expect(validateControlledTerm({ label: "Lantern", uri, vocabulary: "nomenclature" }).ok).toBe(
        true,
      );
    }
  });

  it("accepts any web address for GNIS, whose URI form isn't confirmed", () => {
    expect(
      validateControlledTerm({
        label: "Dickinson",
        uri: "https://example.org/gnis/1",
        vocabulary: "gnis",
      }).ok,
    ).toBe(true);
  });

  it("returns a frozen copy, not the input", () => {
    const input = { label: "Hurricanes", uri: HURRICANES, vocabulary: "lcsh" };
    const r = validateControlledTerm(input);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value).not.toBe(input);
    expect(Object.isFrozen(r.value)).toBe(true);
  });
});

describe("validateControlledTerm: refused terms", () => {
  it("refuses a URI on a term with no vocabulary, naming the vocabulary it looks like", () => {
    expect(code({ label: "Hurricanes", uri: HURRICANES })).toBe("vocabulary_missing");
    expect(message({ label: "Hurricanes", uri: HURRICANES })).toContain('"lcsh"');
    expect(code({ label: "X", uri: "https://example.org/x" })).toBe("vocabulary_missing");
  });

  it("refuses a URI on a local term", () => {
    expect(code({ label: "Depot", uri: "https://example.org/depot", vocabulary: "local" })).toBe(
      "local_uri",
    );
  });

  it("refuses an LC URI from another vocabulary", () => {
    expect(code({ label: "Hurricanes", uri: HURRICANES, vocabulary: "lcnaf" })).toBe(
      "wrong_vocabulary",
    );
    expect(code({ label: "Oral histories", uri: ORAL_HISTORIES, vocabulary: "lcsh" })).toBe(
      "wrong_vocabulary",
    );
    expect(code({ label: "Twain", uri: TWAIN, vocabulary: "gnis" })).toBe("wrong_vocabulary");
    expect(code({ label: "Twain", uri: TWAIN, vocabulary: "nomenclature" })).toBe(
      "wrong_vocabulary",
    );
  });

  it("refuses id.loc.gov or Nomenclature addresses given as GNIS", () => {
    expect(
      code({ label: "X", uri: "http://id.loc.gov/vocabulary/countries/xxu", vocabulary: "gnis" }),
    ).toBe("wrong_vocabulary");
    expect(code({ label: "X", uri: "https://nomenclature.info/nom/1", vocabulary: "gnis" })).toBe(
      "wrong_vocabulary",
    );
  });

  it("refuses LC and Nomenclature hosts for GNIS however the host is written", () => {
    for (const uri of [
      "http://id.loc.gov:80/authorities/subjects/sh85063195",
      "http://id.loc.gov./authorities/subjects/sh85063195",
      "https://ID.LOC.GOV:8443/authorities/names/n79021164",
      "http://www.id.loc.gov/authorities/subjects/sh85063195",
      "https://nomenclature.info.:443/nom/1",
      "https://WWW.NOMENCLATURE.INFO/nom/1",
    ]) {
      expect(code({ label: "X", uri, vocabulary: "gnis" }), uri).toBe("wrong_vocabulary");
    }
  });

  it("refuses LC URI variants as not canonical, naming the canonical form", () => {
    for (const uri of [
      "https://id.loc.gov/authorities/subjects/sh85063195",
      "http://id.loc.gov/authorities/subjects/sh85063195/",
      "http://id.loc.gov/authorities/subjects/sh85063195.html",
      "http://id.loc.gov/authorities/subjects/SH85063195",
      "http://www.id.loc.gov/authorities/subjects/sh85063195",
      "http://ID.LOC.GOV/authorities/subjects/sh85063195",
      "http://id.loc.gov/authorities/subjects/sh85063195#concept",
    ]) {
      expect(code({ label: "Hurricanes", uri, vocabulary: "lcsh" })).toBe("not_canonical");
      expect(message({ label: "Hurricanes", uri, vocabulary: "lcsh" })).toContain(HURRICANES);
    }
  });

  it("refuses id.loc.gov addresses that aren't authority URIs", () => {
    expect(
      code({ label: "X", uri: "http://id.loc.gov/vocabulary/countries/xxu", vocabulary: "lcsh" }),
    ).toBe("unknown_lc_path");
    expect(
      code({ label: "X", uri: "http://id.loc.gov/authorities/subjects", vocabulary: "lcsh" }),
    ).toBe("unknown_lc_path");
    expect(
      code({
        label: "X",
        uri: "http://id.loc.gov/authorities/genreforms/gf2011026431",
        vocabulary: "lcgft",
      }),
    ).toBe("unknown_lc_path");
  });

  it("refuses a URI from somewhere else for an LC vocabulary", () => {
    expect(code({ label: "X", uri: "https://example.org/sh85063195", vocabulary: "lcsh" })).toBe(
      "not_lc_uri",
    );
  });

  it("refuses bad control numbers and the wrong prefix", () => {
    const lcsh = (id: string): string | undefined =>
      code({ label: "X", uri: `http://id.loc.gov/authorities/subjects/${id}`, vocabulary: "lcsh" });
    expect(lcsh("sh8506319")).toBe("invalid_lccn"); // 7 digits
    expect(lcsh("sh850631955555")).toBe("invalid_lccn"); // too long
    expect(lcsh("s85063195x")).toBe("invalid_lccn");
    expect(lcsh("abcd85063195")).toBe("invalid_lccn");
    expect(lcsh("sh-85063195")).toBe("invalid_lccn");
    expect(lcsh("shx2008063195")).toBe("invalid_lccn"); // 13 characters
    expect(lcsh("n85063195")).toBe("wrong_prefix");
    expect(lcsh("85063195")).toBe("wrong_prefix");
    expect(
      code({
        label: "X",
        uri: "http://id.loc.gov/authorities/names/sh85063195",
        vocabulary: "lcnaf",
      }),
    ).toBe("wrong_prefix");
    expect(
      code({
        label: "X",
        uri: "http://id.loc.gov/authorities/names/nbc8506319",
        vocabulary: "lcnaf",
      }),
    ).toBe("invalid_lccn");
  });

  it("refuses the bare Nomenclature site and addresses with their own port", () => {
    const nom = (uri: string): string | undefined =>
      code({ label: "Lantern", uri, vocabulary: "nomenclature" });
    expect(nom("https://nomenclature.info/")).toBe("not_a_term");
    expect(nom("https://www.nomenclature.info")).toBe("not_a_term");
    expect(nom("https://nomenclature.info:8443/nom/1")).toBe("wrong_site");
    expect(nom("http://nomenclature.info:443/nom/1")).toBe("wrong_site");
    expect(nom("https://nomenclature.info:443/nom/1")).toBeUndefined(); // the default port
  });

  it("refuses a Nomenclature URI on another site", () => {
    expect(
      code({ label: "Lantern", uri: "https://example.org/nom/1", vocabulary: "nomenclature" }),
    ).toBe("wrong_site");
    expect(
      code({
        label: "Lantern",
        uri: "https://nomenclature.info.example.org/nom/1",
        vocabulary: "nomenclature",
      }),
    ).toBe("wrong_site");
  });

  it("refuses an unknown vocabulary, a bad label, a bad URI and extra properties", () => {
    expect(code({ label: "X", vocabulary: "aat" })).toBe("unknown_vocabulary");
    expect(code({ label: "X", vocabulary: 3 })).toBe("unknown_vocabulary");
    expect(code({ label: " X" })).toBe("invalid_text");
    expect(code({ label: "" })).toBe("invalid_text");
    expect(code({ label: "a\nb" })).toBe("invalid_text");
    expect(code({ label: "x".repeat(501) })).toBe("invalid_text");
    expect(code({})).toBe("invalid_text");
    expect(code({ label: "X", uri: "ftp://example.org", vocabulary: "gnis" })).toBe("invalid_url");
    expect(code({ label: "X", uri: 5, vocabulary: "gnis" })).toBe("invalid_url");
    expect(code({ label: "X", note: "y" })).toBe("unknown_property");
    expect(code("Hurricanes")).toBe("not_an_object");
    expect(code(null)).toBe("not_an_object");
  });
});

describe("termUriKey", () => {
  it("ignores scheme, host case, trailing dots and slashes, and ports 80 and 443", () => {
    const key = termUriKey("http://nomenclature.info/nom/1234");
    for (const uri of [
      "https://nomenclature.info/nom/1234",
      "https://NOMENCLATURE.INFO/nom/1234/",
      "http://nomenclature.info.:80/nom/1234",
      "https://nomenclature.info:443/nom/1234//",
    ]) {
      expect(termUriKey(uri), uri).toBe(key);
    }
  });

  it("keeps what can name a different term", () => {
    const key = termUriKey("https://nomenclature.info/nom/1234");
    for (const uri of [
      "https://nomenclature.info/nom/1235",
      "https://nomenclature.info/NOM/1234",
      "https://nomenclature.info:8080/nom/1234",
      "https://nomenclature.info/nom/1234?lang=fr",
      "https://www.nomenclature.info/nom/1234",
    ]) {
      expect(termUriKey(uri), uri).not.toBe(key);
    }
    // http on port 443 is not https.
    expect(termUriKey("http://nomenclature.info:443/nom/1234")).not.toBe(key);
    expect(termUriKey("not a url")).toBe("not a url");
    expect(termUriKey("ftp://example.org/x")).toBe("ftp://example.org/x");
  });
});

describe("normalizeTermUri", () => {
  it("leaves a canonical URI alone", () => {
    expect(normalizeTermUri(HURRICANES)).toEqual({
      ok: true,
      value: { uri: HURRICANES, vocabulary: "lcsh", changes: [] },
    });
  });

  it("turns variants into the canonical URI, listing every change", () => {
    const r = normalizeTermUri(
      "  HTTPS://www.ID.loc.gov/authorities/subjects/SH85063195.madsrdf.json?x=1#top ",
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.value.uri).toBe(HURRICANES);
    expect(r.value.vocabulary).toBe("lcsh");
    expect(r.value.changes.map((c) => c.code)).toEqual([
      "trimmed_spaces",
      "lowercased",
      "changed_scheme",
      "removed_www",
      "lowercased",
      "removed_file_ending",
      "removed_query",
      "removed_fragment",
    ]);
    expect(Object.isFrozen(r.value.changes)).toBe(true);
  });

  it("removes a trailing slash and recognizes each LC vocabulary", () => {
    const r = normalizeTermUri(`${ORAL_HISTORIES}/`);
    expect(r.ok && [r.value.uri, r.value.vocabulary, r.value.changes[0]?.code]).toEqual([
      ORAL_HISTORIES,
      "lcgft",
      "removed_trailing_slash",
    ]);
    const n = normalizeTermUri(`${GHH}.html`);
    expect(n.ok && [n.value.uri, n.value.vocabulary]).toEqual([GHH, "lcnaf"]);
  });

  it("turns a real-world-object address into the name authority", () => {
    const r = normalizeTermUri("http://id.loc.gov/rwo/agents/n79021164");
    expect(r.ok && [r.value.uri, r.value.changes.map((c) => c.code)]).toEqual([
      TWAIN,
      ["rwo_to_authority"],
    ]);
  });

  it("explains what isn't an LC authority URI", () => {
    expect(codes(normalizeTermUri("https://example.org/x"))).toEqual(["not_lc_uri"]);
    expect(codes(normalizeTermUri("http://id.loc.gov/vocabulary/countries/xxu"))).toEqual([
      "unknown_lc_path",
    ]);
    expect(codes(normalizeTermUri("http://id.loc.gov/authorities/subjects/xx1"))).toEqual([
      "invalid_lccn",
    ]);
    expect(codes(normalizeTermUri(42))).toEqual(["not_text"]);
    expect(codes(normalizeTermUri("x".repeat(501)))).toEqual(["too_long"]);
    expect(codes(normalizeTermUri("http://id.loc.gov/‮"))).toEqual(["bad_characters"]);
  });
});

describe("controlledTermChecker with checkRecordAgainstTemplate", () => {
  const ID = "3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c";
  const T = "2026-11-20T16:05:00.000Z";

  function template(): FieldTemplate {
    const r = validateTemplate({
      key: "sample-photo",
      label: "Photograph",
      organizationId: ORG,
      appliesTo: ["object"],
      fields: [
        {
          key: "subjects",
          label: "Subjects",
          kind: "controlled_term",
          required: false,
          repeatable: true,
          visibility: "public",
          inherited: false,
          vocabularies: ["lcsh", "local"],
        },
        {
          key: "genre",
          label: "Genre",
          kind: "controlled_term",
          required: false,
          repeatable: false,
          visibility: "public",
          inherited: false,
        },
      ],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }

  function record(fields: Record<string, unknown>): CatalogRecord {
    const r = validateRecord({
      kind: "object",
      id: ID,
      title: "Passengers at the depot",
      organizationId: ORG,
      createdAt: T,
      updatedAt: T,
      fields,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return r.value;
  }

  const check = (fields: Record<string, unknown>): Issue[] =>
    checkRecordAgainstTemplate(record(fields), template(), {
      checkers: { controlled_term: controlledTermChecker },
    });

  it("passes good terms", () => {
    expect(
      check({
        subjects: [
          { label: "Railroad stations", uri: RAILROAD_STATIONS, vocabulary: "lcsh" },
          { label: "Depot Park", vocabulary: "local" },
        ],
        genre: { label: "Oral histories", uri: ORAL_HISTORIES, vocabulary: "lcgft" },
      }),
    ).toEqual([]);
  });

  it("reports vocabulary problems at the value's path", () => {
    const r = check({
      subjects: [
        { label: "Railroad stations", uri: `${RAILROAD_STATIONS}/`, vocabulary: "lcsh" },
        { label: "Depot Park", uri: "https://example.org/depot", vocabulary: "local" },
      ],
      genre: { label: "Hurricanes", uri: HURRICANES, vocabulary: "lcgft" },
    });
    expect(r.map((i) => [i.path.join("."), i.code])).toEqual([
      ["fields.subjects.0.uri", "not_canonical"],
      ["fields.subjects.1.uri", "local_uri"],
      ["fields.genre.uri", "wrong_vocabulary"],
    ]);
  });

  it("is a plain function returning frozen problems for one value", () => {
    const field = template().fields[1];
    if (field === undefined) throw new Error("expected a field");
    const problems = controlledTermChecker({ label: "X", vocabulary: "aat" }, field, record({}));
    expect(problems.map((p) => [p.code, p.path])).toEqual([["unknown_vocabulary", ["vocabulary"]]]);
    expect(Object.isFrozen(problems)).toBe(true);
    expect(controlledTermChecker({ label: "X" }, field, record({}))).toEqual([]);
  });
});
