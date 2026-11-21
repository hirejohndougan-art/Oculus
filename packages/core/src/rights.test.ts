import { describe, expect, it } from "vitest";
import {
  CREATIVE_COMMONS,
  RIGHTS_FIELD_KEY,
  RIGHTS_STATEMENTS,
  RIGHTS_TERMS,
  canPublishRights,
  isRightsUri,
  normalizeRightsUri,
  rightsPublishIssues,
  rightsTerm,
  validateRightsUri,
  type NormalizedRights,
} from "./rights.js";
import { createRecord } from "./records.js";
import type { Validated } from "./issues.js";

function normal(text: string): NormalizedRights {
  const r = normalizeRightsUri(text);
  if (!r.ok) throw new Error(`${text}: ${JSON.stringify(r.issues)}`);
  return r.value;
}

function code(result: Validated<unknown>): string | undefined {
  return result.ok ? undefined : result.issues[0]?.code;
}

const changes = (text: string): string[] => normal(text).changes.map((c) => c.code);

describe("the rightsstatements.org vocabulary", () => {
  // Copied from https://rightsstatements.org/page/1.0/ on 2026-11-20.
  it("has the 12 version 1.0 statements with their published URIs and labels", () => {
    expect(RIGHTS_STATEMENTS.map((t) => [t.uri, t.label])).toEqual([
      ["http://rightsstatements.org/vocab/InC/1.0/", "In Copyright"],
      ["http://rightsstatements.org/vocab/InC-OW-EU/1.0/", "In Copyright - EU Orphan Work"],
      [
        "http://rightsstatements.org/vocab/InC-EDU/1.0/",
        "In Copyright - Educational Use Permitted",
      ],
      [
        "http://rightsstatements.org/vocab/InC-NC/1.0/",
        "In Copyright - Non-Commercial Use Permitted",
      ],
      [
        "http://rightsstatements.org/vocab/InC-RUU/1.0/",
        "In Copyright - Rights-holder(s) Unlocatable or Unidentifiable",
      ],
      ["http://rightsstatements.org/vocab/NoC-CR/1.0/", "No Copyright - Contractual Restrictions"],
      ["http://rightsstatements.org/vocab/NoC-NC/1.0/", "No Copyright - Non-Commercial Use Only"],
      [
        "http://rightsstatements.org/vocab/NoC-OKLR/1.0/",
        "No Copyright - Other Known Legal Restrictions",
      ],
      ["http://rightsstatements.org/vocab/NoC-US/1.0/", "No Copyright - United States"],
      ["http://rightsstatements.org/vocab/CNE/1.0/", "Copyright Not Evaluated"],
      ["http://rightsstatements.org/vocab/UND/1.0/", "Copyright Undetermined"],
      ["http://rightsstatements.org/vocab/NKC/1.0/", "No Known Copyright"],
    ]);
  });

  it("groups them as the vocabulary does", () => {
    const groups = (c: string): string[] =>
      RIGHTS_STATEMENTS.filter((t) => t.category === c).map((t) => t.code);
    expect(groups("in_copyright")).toEqual(["InC", "InC-OW-EU", "InC-EDU", "InC-NC", "InC-RUU"]);
    expect(groups("no_copyright")).toEqual(["NoC-CR", "NoC-NC", "NoC-OKLR", "NoC-US"]);
    expect(groups("other")).toEqual(["CNE", "UND", "NKC"]);
    for (const t of RIGHTS_STATEMENTS) {
      expect(t.source).toBe("rightsstatements.org");
      expect(t.shortLabel).toBe(t.code);
    }
  });
});

describe("Creative Commons", () => {
  // From each deed's page on creativecommons.org, 2026-11-20.
  it("has the six 4.0 licenses, CC0 and the Public Domain Mark", () => {
    expect(CREATIVE_COMMONS.map((t) => [t.uri, t.label, t.shortLabel, t.category])).toEqual([
      [
        "https://creativecommons.org/licenses/by/4.0/",
        "Attribution 4.0 International",
        "CC BY 4.0",
        "cc_license",
      ],
      [
        "https://creativecommons.org/licenses/by-sa/4.0/",
        "Attribution-ShareAlike 4.0 International",
        "CC BY-SA 4.0",
        "cc_license",
      ],
      [
        "https://creativecommons.org/licenses/by-nd/4.0/",
        "Attribution-NoDerivatives 4.0 International",
        "CC BY-ND 4.0",
        "cc_license",
      ],
      [
        "https://creativecommons.org/licenses/by-nc/4.0/",
        "Attribution-NonCommercial 4.0 International",
        "CC BY-NC 4.0",
        "cc_license",
      ],
      [
        "https://creativecommons.org/licenses/by-nc-sa/4.0/",
        "Attribution-NonCommercial-ShareAlike 4.0 International",
        "CC BY-NC-SA 4.0",
        "cc_license",
      ],
      [
        "https://creativecommons.org/licenses/by-nc-nd/4.0/",
        "Attribution-NonCommercial-NoDerivatives 4.0 International",
        "CC BY-NC-ND 4.0",
        "cc_license",
      ],
      [
        "https://creativecommons.org/publicdomain/zero/1.0/",
        "CC0 1.0 Universal",
        "CC0 1.0",
        "cc_public_domain",
      ],
      [
        "https://creativecommons.org/publicdomain/mark/1.0/",
        "Public Domain Mark 1.0 Universal",
        "PDM 1.0",
        "cc_public_domain",
      ],
    ]);
  });

  it("RIGHTS_TERMS is all 20, with no URI twice, and everything is frozen", () => {
    expect(RIGHTS_TERMS).toHaveLength(20);
    expect(new Set(RIGHTS_TERMS.map((t) => t.uri)).size).toBe(20);
    expect(Object.isFrozen(RIGHTS_TERMS)).toBe(true);
    expect(Object.isFrozen(RIGHTS_STATEMENTS)).toBe(true);
    expect(Object.isFrozen(CREATIVE_COMMONS)).toBe(true);
    for (const t of RIGHTS_TERMS) expect(Object.isFrozen(t)).toBe(true);
  });
});

describe("lookup and validation of stored values", () => {
  it("finds every term by its exact URI", () => {
    for (const t of RIGHTS_TERMS) {
      expect(rightsTerm(t.uri)).toBe(t);
      expect(isRightsUri(t.uri)).toBe(true);
      const r = validateRightsUri(t.uri);
      expect(r.ok && r.value).toBe(t);
    }
  });

  it.each([
    "https://rightsstatements.org/vocab/InC/1.0/",
    "http://rightsstatements.org/vocab/InC/1.0",
    "http://rightsstatements.org/page/InC/1.0/",
    "http://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by/4.0/deed.en",
  ])("refuses the variant %s as not canonical, naming the canonical form", (text) => {
    expect(isRightsUri(text)).toBe(false);
    const r = validateRightsUri(text);
    expect(code(r)).toBe("not_canonical");
    expect(r.ok ? "" : r.issues[0]?.message).toMatch(
      /should be stored as http(s)?:\/\/(rightsstatements|creativecommons)\.org\//,
    );
  });

  it.each([
    [undefined, "rights_missing"],
    [null, "rights_missing"],
    ["", "rights_missing"],
    ["   ", "rights_missing"],
    [42, "not_text"],
    [["http://rightsstatements.org/vocab/InC/1.0/"], "not_text"],
    ["All rights reserved", "unknown_rights"],
    ["http://rightsstatements.org/vocab/XYZ/1.0/", "unknown_rights"],
    ["http://rightsstatements.org/vocab/InC/2.0/", "unsupported_version"],
    ["https://creativecommons.org/licenses/by/3.0/", "unsupported_version"],
    ["https://example.org/vocab/InC/1.0/", "unknown_rights"],
  ])("%j → %s", (value, expected) => {
    expect(code(validateRightsUri(value))).toBe(expected);
    expect(isRightsUri(value)).toBe(false);
  });

  it("is case-sensitive in the statement code", () => {
    expect(isRightsUri("http://rightsstatements.org/vocab/inc/1.0/")).toBe(false);
    expect(code(normalizeRightsUri("http://rightsstatements.org/vocab/inc/1.0/"))).toBe(
      "unknown_rights",
    );
  });
});

describe("normalizeRightsUri", () => {
  it("leaves a canonical URI alone and reports no changes", () => {
    for (const t of RIGHTS_TERMS) {
      const n = normal(t.uri);
      expect(n.uri).toBe(t.uri);
      expect(n.term).toBe(t);
      expect(n.changes).toEqual([]);
    }
  });

  it.each([
    ["https://rightsstatements.org/vocab/InC/1.0/", ["changed_scheme"]],
    ["http://rightsstatements.org/vocab/InC/1.0", ["added_trailing_slash"]],
    ["https://rightsstatements.org/page/InC/1.0/", ["changed_scheme", "page_to_vocab"]],
    [
      "https://rightsstatements.org/page/NoC-US/1.0/?language=en",
      ["changed_scheme", "page_to_vocab", "removed_query"],
    ],
    ["  http://rightsstatements.org/vocab/CNE/1.0/\n", ["trimmed_spaces"]],
    ["HTTP://RightsStatements.org/vocab/UND/1.0/", ["lowercased"]],
    ["http://www.rightsstatements.org/vocab/NKC/1.0/", ["removed_www"]],
  ])("rightsstatements.org: %s", (text, expected) => {
    expect(normal(text).uri.startsWith("http://rightsstatements.org/vocab/")).toBe(true);
    expect(changes(text)).toEqual(expected);
  });

  it.each([
    ["http://creativecommons.org/licenses/by/4.0/", ["changed_scheme"]],
    ["https://creativecommons.org/licenses/by-nc/4.0", ["added_trailing_slash"]],
    ["https://creativecommons.org/licenses/by-sa/4.0/deed.en", ["removed_page_suffix"]],
    ["https://creativecommons.org/licenses/by-nd/4.0/legalcode", ["removed_page_suffix"]],
    [
      "https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-hans",
      ["removed_page_suffix"],
    ],
    ["https://creativecommons.org/licenses/by-nc-nd/4.0/deed.pt_BR", ["removed_page_suffix"]],
    ["https://www.creativecommons.org/publicdomain/zero/1.0/", ["removed_www"]],
    [
      "https://creativecommons.org/publicdomain/mark/1.0/deed.en#ref",
      ["removed_page_suffix", "removed_fragment"],
    ],
    [
      "http://creativecommons.org/publicdomain/zero/1.0",
      ["changed_scheme", "added_trailing_slash"],
    ],
  ])("creativecommons.org: %s", (text, expected) => {
    expect(normal(text).uri.startsWith("https://creativecommons.org/")).toBe(true);
    expect(changes(text)).toEqual(expected);
  });

  it("says in plain words what each change was", () => {
    const n = normal("https://rightsstatements.org/page/InC/1.0/?language=en");
    expect(n.uri).toBe("http://rightsstatements.org/vocab/InC/1.0/");
    expect(n.changes.map((c) => c.message)).toEqual([
      "Changed https:// to http://, the form rightsstatements.org publishes.",
      "Changed /page/ (the web page) to /vocab/ (the statement's URI).",
      'Removed "?language=en" from the end.',
    ]);
  });

  it("returns frozen results", () => {
    const n = normal("https://rightsstatements.org/vocab/InC/1.0/");
    expect(Object.isFrozen(n)).toBe(true);
    expect(Object.isFrozen(n.changes)).toBe(true);
    expect(Object.isFrozen(n.changes[0])).toBe(true);
  });

  it.each([
    "https://creativecommons.org/licenses/by/3.0/",
    "https://creativecommons.org/licenses/by-nc-sa/3.0/us/",
    "https://creativecommons.org/licenses/by/2.5/",
    "https://creativecommons.org/licenses/by/2.1/jp/",
    "https://creativecommons.org/licenses/by-nd-nc/1.0/",
    "https://creativecommons.org/licenses/by/4.0/us/",
  ])("reports the older or national license %s as an unsupported version", (text) => {
    const r = normalizeRightsUri(text);
    expect(code(r)).toBe("unsupported_version");
  });

  it("explains rightsstatements.org versions other than 1.0", () => {
    const r = normalizeRightsUri("http://rightsstatements.org/vocab/InC/1.1/");
    expect(code(r)).toBe("unsupported_version");
    expect(r.ok ? "" : r.issues[0]?.message).toContain(
      "http://rightsstatements.org/vocab/InC/1.0/",
    );
  });

  it.each([
    "http://rightsstatements.org/vocab/1.0/",
    "http://rightsstatements.org/data/InC/1.0.json",
    "http://rightsstatements.org/vocab/InC/1.0/extra/",
    "http://rightsstatements.org/vocab//InC/1.0/",
    "http://rightsstatements.org/vocab/constructor/1.0/",
    "http://rightsstatements.org/vocab/__proto__/1.0/",
    "https://creativecommons.org/licenses/constructor/4.0/",
    "https://creativecommons.org/licenses/by/4.0/foo/bar/",
    "https://creativecommons.org/publicdomain/zero/2.0/",
    "https://creativecommons.org/publicdomain/certification/1.0/us/",
    "https://creativecommons.org/licenses/",
    "https://creativecommons.org",
    "ftp://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org.example.com/licenses/by/4.0/",
    "https://user@creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org:8080/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by/4.0/ deed",
    "InC",
    "CC BY 4.0",
  ])("does not recognize %s", (text) => {
    expect(code(normalizeRightsUri(text))).toBe("unknown_rights");
  });
});

describe("the publishing rule", () => {
  const record = (fields: Record<string, unknown>): unknown => ({
    kind: "object",
    title: "Invented chair",
    fields,
  });

  it("allows a record whose rights field holds a canonical URI", () => {
    for (const t of RIGHTS_TERMS) {
      expect(rightsPublishIssues(record({ [RIGHTS_FIELD_KEY]: t.uri }))).toEqual([]);
      expect(canPublishRights(record({ rights: t.uri }))).toBe(true);
    }
  });

  it("works on a real validated record", () => {
    const made = createRecord({
      kind: "object",
      title: "Invented plow",
      fields: { rights: "http://rightsstatements.org/vocab/NoC-US/1.0/" },
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(canPublishRights(made.value)).toBe(true);
  });

  it("blocks a record without a rights value, with a message for the person", () => {
    const issues = rightsPublishIssues(record({ title_note: "x" }));
    expect(issues).toEqual([
      {
        path: ["fields", "rights"],
        code: "rights_missing",
        message: "Choose a rights statement or license before this record can be published.",
      },
    ]);
    expect(Object.isFrozen(issues)).toBe(true);
    expect(canPublishRights(record({}))).toBe(false);
    expect(canPublishRights(record({ rights: null }))).toBe(false);
    expect(canPublishRights(record({ rights: "" }))).toBe(false);
  });

  it.each([
    ["All rights reserved", "unknown_rights"],
    ["https://rightsstatements.org/vocab/InC/1.0/", "not_canonical"],
    ["https://creativecommons.org/licenses/by/3.0/", "unsupported_version"],
    [{ uri: "http://rightsstatements.org/vocab/InC/1.0/" }, "not_text"],
  ])("blocks %j with %s", (value, expected) => {
    const issues = rightsPublishIssues(record({ rights: value }));
    expect(issues.map((i) => i.code)).toEqual([expected]);
    expect(issues[0]?.path).toEqual(["fields", "rights"]);
  });

  it("reports a record with no fields object", () => {
    expect(rightsPublishIssues({ kind: "object" }).map((i) => i.code)).toEqual(["not_an_object"]);
    expect(rightsPublishIssues(null).map((i) => i.code)).toEqual(["not_an_object"]);
    expect(rightsPublishIssues("record").map((i) => i.code)).toEqual(["not_an_object"]);
  });
});
