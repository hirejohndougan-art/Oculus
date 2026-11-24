// Organizations on stored terms and on the Data Cleaning term lists
// (T-019b2, D-019, D-030, D-071): every set function refuses entries of
// another organization, or entries that don't say, before reading any term,
// and its refusal names no term. Also the condition log's organization
// checks, which had no cross-organization test.
import { describe, expect, it } from "vitest";
import {
  MAX_DUPLICATE_TERMS,
  MAX_STORED_TERMS,
  createConditionCheck,
  findLcTermsWithoutUri,
  findNearDuplicateTerms,
  indexConditionChecks,
  isStoredTermId,
  newOrganizationId,
  newRecordId,
  termIdentity,
  validateStoredTerm,
  validateStoredTerms,
  withConditionCheck,
  type OrganizationId,
  type Validated,
} from "./index.js";

const ARCHIVES = newOrganizationId();
const LIBRARY = newOrganizationId();

// Invented terms. The library's labels are what must never appear in an
// answer to the archives.
const DEPOT = { label: "Invented Street depot" };
const DEPOTS = { label: "invented street depots" };
const SECRET = { label: "Library staff only heading", vocabulary: "lcsh" };
const SECRET_TOO = { label: "library staff only headings", vocabulary: "lcsh" };

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

function stored(organizationId: OrganizationId, term: unknown, id: string = crypto.randomUUID()) {
  return { organizationId, id, term };
}

function entry(organizationId: unknown, term: unknown) {
  return { organizationId, term };
}

/** Nothing in a refusal names the library's labels. */
function expectNoLibraryText(result: Validated<unknown>): void {
  const text = JSON.stringify(result);
  expect(text).not.toMatch(/staff only/i);
}

/** Lists that hold something other than the archives' own entries, at each position. */
function strays(): [string, unknown][] {
  const getterOrg = Object.defineProperty({ term: DEPOT }, "organizationId", {
    get: () => ARCHIVES,
    enumerable: true,
  });
  return [
    ["the library's entry", entry(LIBRARY, SECRET)],
    ["an entry with no organization", { term: SECRET }],
    ["an entry with a bad organization", entry("not-an-org", SECRET)],
    ["an upper-case organization", entry(ARCHIVES.toUpperCase(), SECRET)],
    ["an organization behind a getter", getterOrg],
    ["a Proxy entry", new Proxy(entry(ARCHIVES, DEPOT), {})],
    ["a bare term", SECRET],
    ["a string", "Library staff only heading"],
    ["null", null],
  ];
}

describe("validateStoredTerm", () => {
  it("accepts a stored term and returns a frozen copy", () => {
    const id = crypto.randomUUID();
    const value = ok(validateStoredTerm(stored(ARCHIVES, DEPOT, id)));
    expect(value).toEqual({ organizationId: ARCHIVES, id, term: DEPOT });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.term)).toBe(true);
    expect(isStoredTermId(id)).toBe(true);
    expect(isStoredTermId(id.toUpperCase())).toBe(false);
  });

  it("requires an organization, an ID and a valid term, and nothing else", () => {
    expect(codes(validateStoredTerm({ id: crypto.randomUUID(), term: DEPOT }))).toEqual([
      "invalid_organization",
    ]);
    expect(codes(validateStoredTerm(stored("x" as OrganizationId, DEPOT)))).toEqual([
      "invalid_organization",
    ]);
    expect(codes(validateStoredTerm(stored(ARCHIVES, DEPOT, "1")))).toEqual(["invalid_id"]);
    const bad = validateStoredTerm(stored(ARCHIVES, { label: "" }));
    expect(bad.ok ? [] : bad.issues.map((i) => i.path)).toEqual([["term", "label"]]);
    expect(codes(validateStoredTerm({ ...stored(ARCHIVES, DEPOT), termKey: "x" }))).toEqual([
      "unknown_property",
    ]);
    for (const input of [null, "x", [], new Proxy(stored(ARCHIVES, DEPOT), {})]) {
      expect(codes(validateStoredTerm(input))).toEqual(["not_an_object"]);
    }
  });

  it("never runs a getter", () => {
    let ran = false;
    const input = Object.defineProperty(stored(ARCHIVES, DEPOT), "term", {
      get() {
        ran = true;
        return DEPOT;
      },
      enumerable: true,
    });
    expect(codes(validateStoredTerm(input))).toContain("not_plain_data");
    expect(ran).toBe(false);
  });
});

describe("validateStoredTerms", () => {
  it("accepts one organization's list, frozen", () => {
    const list = [stored(ARCHIVES, DEPOT), stored(ARCHIVES, SECRET)];
    const value = ok(validateStoredTerms(list, ARCHIVES));
    expect(value).toHaveLength(2);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value[0])).toBe(true);
    expect(ok(validateStoredTerms([], ARCHIVES))).toEqual([]);
  });

  it("refuses another organization's entry, or one that doesn't say, at any position", () => {
    for (const [name, stray] of strays()) {
      for (const at of [0, 1, 2]) {
        const list: unknown[] = [stored(ARCHIVES, DEPOT), stored(ARCHIVES, DEPOTS)];
        list.splice(at, 0, stray);
        const r = validateStoredTerms(list, ARCHIVES);
        expect(codes(r), `${name} at ${String(at)}`).toEqual(["mixed_organizations"]);
        expectNoLibraryText(r);
      }
    }
  });

  it("refuses a list that is wholly another organization's, naming none of its terms", () => {
    const theirs = [stored(LIBRARY, SECRET), stored(LIBRARY, SECRET)];
    const r = validateStoredTerms(theirs, ARCHIVES);
    // Not duplicate_term: nothing about the library's list is read.
    expect(codes(r)).toEqual(["mixed_organizations"]);
    expectNoLibraryText(r);
  });

  it("refuses holes and getter slots as entries that don't say their organization", () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the attack
    const holed: unknown[] = [stored(ARCHIVES, DEPOT), , stored(ARCHIVES, DEPOTS)];
    expect(codes(validateStoredTerms(holed, ARCHIVES))).toEqual(["mixed_organizations"]);
    let ran = false;
    const list: unknown[] = [stored(ARCHIVES, DEPOT)];
    Object.defineProperty(list, 1, {
      get() {
        ran = true;
        return stored(ARCHIVES, DEPOTS);
      },
      enumerable: true,
    });
    expect(codes(validateStoredTerms(list, ARCHIVES))).toEqual(["mixed_organizations"]);
    expect(ran).toBe(false);
  });

  it("reads no term of a list it refuses, so a stray's getters never run", () => {
    let ran = false;
    const sneaky = Object.defineProperty(
      { organizationId: LIBRARY, id: crypto.randomUUID() },
      "term",
      {
        get() {
          ran = true;
          return SECRET;
        },
        enumerable: true,
      },
    );
    expect(codes(validateStoredTerms([stored(ARCHIVES, DEPOT), sneaky], ARCHIVES))).toEqual([
      "mixed_organizations",
    ]);
    expect(ran).toBe(false);
  });

  it("needs the organization the caller expects", () => {
    const list = [stored(ARCHIVES, DEPOT)];
    for (const bad of [undefined, "", "x", ARCHIVES.toUpperCase(), { id: ARCHIVES }]) {
      expect(codes(validateStoredTerms(list, bad as OrganizationId))).toEqual([
        "invalid_organization",
      ]);
    }
  });

  it("refuses two entries with one ID, or that are one term", () => {
    const id = crypto.randomUUID();
    expect(
      codes(
        validateStoredTerms([stored(ARCHIVES, DEPOT, id), stored(ARCHIVES, DEPOTS, id)], ARCHIVES),
      ),
    ).toEqual(["duplicate_id"]);
    // No vocabulary and `local` are one term; so are http and https copies of one address.
    const local = [stored(ARCHIVES, DEPOT), stored(ARCHIVES, { ...DEPOT, vocabulary: "local" })];
    expect(codes(validateStoredTerms(local, ARCHIVES))).toEqual(["duplicate_term"]);
    const lantern = (uri: string) => ({ label: "Lantern", vocabulary: "nomenclature", uri });
    const both = [
      stored(ARCHIVES, lantern("http://nomenclature.info/nom/1234")),
      stored(ARCHIVES, lantern("https://nomenclature.info/nom/1234/")),
    ];
    expect(codes(validateStoredTerms(both, ARCHIVES))).toEqual(["duplicate_term"]);
    // Two organizations may each store the same term.
    ok(validateStoredTerms([stored(ARCHIVES, DEPOT)], ARCHIVES));
    ok(validateStoredTerms([stored(LIBRARY, DEPOT)], LIBRARY));
  });

  it("refuses what isn't an ordinary list, and too many entries", () => {
    for (const input of ["x", { length: 0 }, new Proxy([], {}), new (class extends Array {})()]) {
      expect(codes(validateStoredTerms(input, ARCHIVES))).toEqual(["not_a_list"]);
    }
    expect(codes(validateStoredTerms(new Array(MAX_STORED_TERMS + 1), ARCHIVES))).toEqual([
      "too_many",
    ]);
  });
});

describe("termIdentity", () => {
  it("is one rule for one term: vocabulary and URI key, or vocabulary and exact label", () => {
    const id = (t: unknown) => ok(termIdentity(t));
    expect(id(DEPOT)).toBe(id({ ...DEPOT, vocabulary: "local" }));
    expect(id(DEPOT)).not.toBe(id(DEPOTS));
    const uri = "http://id.loc.gov/authorities/subjects/sh85110904";
    expect(id({ label: "Railroads", vocabulary: "lcsh", uri })).toBe(
      id({ label: "Old label", vocabulary: "lcsh", uri }),
    );
    // Composed and decomposed accents stay two terms (D-062).
    expect(id({ label: "Café" })).not.toBe(id({ label: "Café" }));
    expect(codes(termIdentity({ label: "" }))).toEqual(["invalid_text"]);
  });
});

describe("findNearDuplicateTerms and findLcTermsWithoutUri, one organization at a time", () => {
  const finders: [string, (input: unknown, org: OrganizationId) => Validated<unknown>][] = [
    ["findNearDuplicateTerms", (input, org) => findNearDuplicateTerms(input, org)],
    ["findLcTermsWithoutUri", (input, org) => findLcTermsWithoutUri(input, org)],
  ];

  it("take stored terms and term usages straight, ignoring their other properties", () => {
    const list = [
      stored(ARCHIVES, DEPOT),
      { organizationId: ARCHIVES, fieldKey: "subjects", termKey: "0".repeat(64), term: DEPOTS },
      entry(ARCHIVES, { label: "Parks", vocabulary: "lcsh" }),
    ];
    const pairs = ok(findNearDuplicateTerms(list, ARCHIVES));
    expect(pairs.candidates.map((c) => [c.first, c.second])).toEqual([[0, 1]]);
    const lc = ok(findLcTermsWithoutUri(list, ARCHIVES));
    expect(lc.terms).toEqual([{ vocabulary: "lcsh", label: "Parks", indexes: [2] }]);
  });

  it("refuse a list mixing in another organization's entry, or one that doesn't say, anywhere", () => {
    for (const [fn, find] of finders) {
      for (const [name, stray] of strays()) {
        for (const at of [0, 1, 2]) {
          const list: unknown[] = [entry(ARCHIVES, DEPOT), entry(ARCHIVES, SECRET_TOO)];
          list.splice(at, 0, stray);
          const r = find(list, ARCHIVES);
          expect(codes(r), `${fn}: ${name} at ${String(at)}`).toEqual(["mixed_organizations"]);
          expectNoLibraryText(r);
        }
      }
    }
  });

  it("never pair or name two organizations' labels, even when they'd match", () => {
    // Both organizations hold near-duplicates of each other's labels.
    const mixed = [entry(ARCHIVES, DEPOT), entry(LIBRARY, DEPOTS)];
    expect(codes(findNearDuplicateTerms(mixed, ARCHIVES))).toEqual(["mixed_organizations"]);
    expect(codes(findNearDuplicateTerms(mixed, LIBRARY))).toEqual(["mixed_organizations"]);
    // Each organization's own list is compared on its own.
    const mine = ok(
      findNearDuplicateTerms([entry(ARCHIVES, DEPOT), entry(ARCHIVES, DEPOTS)], ARCHIVES),
    );
    expect(mine.candidates).toHaveLength(1);
  });

  it("refuse a list wholly another organization's, naming none of its terms", () => {
    const theirs = [
      entry(LIBRARY, SECRET),
      entry(LIBRARY, SECRET_TOO),
      entry(LIBRARY, { label: "" }),
    ];
    for (const [fn, find] of finders) {
      const r = find(theirs, ARCHIVES);
      expect(codes(r), fn).toEqual(["mixed_organizations"]);
      expectNoLibraryText(r);
      // The library itself gets its report.
      expect(find(theirs, LIBRARY).ok, fn).toBe(true);
    }
  });

  it("read no term of a list they refuse, so a stray's getters never run", () => {
    for (const [fn, find] of finders) {
      let ran = false;
      const sneaky = Object.defineProperty({ organizationId: LIBRARY }, "term", {
        get() {
          ran = true;
          return SECRET;
        },
        enumerable: true,
      });
      expect(codes(find([entry(ARCHIVES, DEPOT), sneaky], ARCHIVES)), fn).toEqual([
        "mixed_organizations",
      ]);
      expect(ran, fn).toBe(false);
    }
  });

  it("refuse holes and getter slots, and skip an entry with no term or a getter term", () => {
    for (const [fn, find] of finders) {
      // eslint-disable-next-line no-sparse-arrays -- the hole is the attack
      const holed: unknown[] = [entry(ARCHIVES, DEPOT), , entry(ARCHIVES, DEPOTS)];
      expect(codes(find(holed, ARCHIVES)), fn).toEqual(["mixed_organizations"]);
      const slot: unknown[] = [entry(ARCHIVES, DEPOT)];
      Object.defineProperty(slot, 1, { get: () => entry(ARCHIVES, DEPOTS), enumerable: true });
      expect(codes(find(slot, ARCHIVES)), fn).toEqual(["mixed_organizations"]);
    }
    let ran = false;
    const getterTerm = Object.defineProperty({ organizationId: ARCHIVES }, "term", {
      get() {
        ran = true;
        return DEPOT;
      },
      enumerable: true,
    });
    const r = ok(findNearDuplicateTerms([{ organizationId: ARCHIVES }, getterTerm], ARCHIVES));
    expect(
      r.skipped.map((s) => [s.index, s.issues.map((i) => [i.path.join("."), i.code])]),
    ).toEqual([
      [0, [["0.term", "missing"]]],
      [1, [["1.term", "not_plain_data"]]],
    ]);
    expect(ran).toBe(false);
  });

  it("need the organization the caller expects, and still check the list and options", () => {
    for (const [fn, find] of finders) {
      for (const bad of [undefined, "", ARCHIVES.toUpperCase(), { organizationId: ARCHIVES }]) {
        expect(codes(find([entry(ARCHIVES, DEPOT)], bad as OrganizationId)), fn).toEqual([
          "invalid_organization",
        ]);
      }
      expect(codes(find("x", undefined as unknown as OrganizationId)), fn).toEqual([
        "invalid_organization",
        "not_a_list",
      ]);
      expect(codes(find(new Array(MAX_DUPLICATE_TERMS + 1), ARCHIVES)), fn).toEqual(["too_many"]);
      expect(ok(find([], ARCHIVES)), fn).toBeDefined();
    }
    expect(codes(findNearDuplicateTerms([], ARCHIVES, { maxCandidates: 0 }))).toEqual([
      "invalid_option",
    ]);
    expect(codes(findLcTermsWithoutUri([], ARCHIVES, { maxTerms: 0 }))).toEqual(["invalid_option"]);
  });
});

describe("condition logs (D-030), across organizations", () => {
  const record = newRecordId();
  const mine = () =>
    ok(
      createConditionCheck(
        {
          organizationId: ARCHIVES,
          recordId: record,
          checkedOn: "2026-11-01",
          checkedBy: "A. Volunteer",
          condition: "good",
          reason: "routine",
        },
        new Date("2026-11-23T18:00:00.000Z"),
      ),
    );
  const theirs = () => ({ ...mine(), organizationId: LIBRARY });
  const unowned = () => {
    const rest: Record<string, unknown> = { ...mine() };
    delete rest.organizationId;
    return rest;
  };

  it("indexConditionChecks refuses a log holding another organization's check", () => {
    expect(codes(indexConditionChecks(ARCHIVES, [mine(), theirs()]))).toEqual([
      "mixed_organizations",
    ]);
    expect(codes(indexConditionChecks(ARCHIVES, [theirs()]))).toEqual(["mixed_organizations"]);
    expect(codes(indexConditionChecks(ARCHIVES, [unowned()]))).toEqual(["invalid_organization"]);
    expect(codes(withConditionCheck(ok(indexConditionChecks(ARCHIVES, [])), unowned()))).toEqual([
      "invalid_organization",
    ]);
    expect(codes(indexConditionChecks("x", [mine()]))).toEqual(["invalid_organization"]);
  });

  it("withConditionCheck refuses adding another organization's check", () => {
    const log = ok(indexConditionChecks(ARCHIVES, [mine()]));
    expect(codes(withConditionCheck(log, theirs(), new Date("2026-11-23T18:00:00.000Z")))).toEqual([
      "mixed_organizations",
    ]);
    const empty = ok(indexConditionChecks(LIBRARY, []));
    expect(codes(withConditionCheck(empty, mine(), new Date("2026-11-23T18:00:00.000Z")))).toEqual([
      "mixed_organizations",
    ]);
  });
});
