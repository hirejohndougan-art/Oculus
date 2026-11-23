// Direct tests for the helpers that keep organizations apart. Every module
// that takes several organizations' data relies on `oneOrganization`,
// `organizationIdOf` and `mixedOrganizationsIssue`, but until now they were
// only tested through those modules. `isIdentifierTypeKey` is a public guard
// that was likewise only tested indirectly.
import { describe, expect, it } from "vitest";
import { isIdentifierTypeKey, newOrganizationId, type OrganizationId } from "./index.js";
import { mixedOrganizationsIssue, oneOrganization, organizationIdOf } from "./organizations.js";

const A = newOrganizationId();
const B = newOrganizationId();

describe("organizationIdOf", () => {
  it("reads an own, valid organization ID", () => {
    expect(organizationIdOf({ organizationId: A })).toBe(A);
    expect(organizationIdOf({ organizationId: B, title: "x" })).toBe(B);
  });

  it("gives undefined for anything that doesn't name a valid organization", () => {
    for (const item of [
      undefined,
      null,
      A,
      42,
      [],
      {},
      { organizationId: undefined },
      { organizationId: "" },
      { organizationId: "not-an-id" },
      { organizationId: A.toUpperCase() },
      { organizationId: ` ${A}` },
      { organizationId: [A] },
      { organizationId: { id: A } },
    ]) {
      expect(organizationIdOf(item)).toBeUndefined();
    }
  });

  it("ignores an inherited organizationId", () => {
    expect(organizationIdOf(Object.create({ organizationId: A }))).toBeUndefined();
  });

  it("never runs a getter", () => {
    let ran = false;
    const item = {
      get organizationId() {
        ran = true;
        return A;
      },
    };
    expect(organizationIdOf(item)).toBeUndefined();
    expect(ran).toBe(false);
  });

  it("refuses a Proxy without touching its traps", () => {
    let trapped = false;
    const item = new Proxy(
      { organizationId: A },
      {
        getOwnPropertyDescriptor(target, key) {
          trapped = true;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(organizationIdOf(item)).toBeUndefined();
    expect(trapped).toBe(false);
  });
});

describe("oneOrganization", () => {
  it("gives undefined for no items", () => {
    expect(oneOrganization([])).toBeUndefined();
    expect(oneOrganization(new Set())).toBeUndefined();
  });

  it("gives the one organization every item names", () => {
    expect(oneOrganization([{ organizationId: A }])).toBe(A);
    expect(oneOrganization([{ organizationId: A }, { organizationId: A, x: 1 }])).toBe(A);
  });

  it("accepts any iterable and reads it once", () => {
    let reads = 0;
    function* items(): Generator<{ organizationId: OrganizationId }> {
      reads++;
      yield { organizationId: B };
      yield { organizationId: B };
    }
    expect(oneOrganization(items())).toBe(B);
    expect(reads).toBe(1);
  });

  it("gives mixed for two organizations", () => {
    expect(oneOrganization([{ organizationId: A }, { organizationId: B }])).toBe("mixed");
  });

  it("gives mixed when any item doesn't say which organization it belongs to, at any position", () => {
    const unowned = [{}, { organizationId: "nope" }, null, "text"];
    for (const bad of unowned) {
      expect(oneOrganization([bad])).toBe("mixed");
      expect(oneOrganization([bad, { organizationId: A }])).toBe("mixed");
      expect(oneOrganization([{ organizationId: A }, bad])).toBe("mixed");
      expect(oneOrganization([{ organizationId: A }, bad, { organizationId: A }])).toBe("mixed");
    }
  });

  it("gives mixed for an item whose organizationId is a getter", () => {
    const sneaky = {
      get organizationId() {
        return A;
      },
    };
    expect(oneOrganization([{ organizationId: A }, sneaky])).toBe("mixed");
  });

  it("gives mixed, without throwing, when the list can't be walked", () => {
    const broken: Iterable<unknown> = {
      [Symbol.iterator]() {
        throw new Error("no");
      },
    };
    expect(oneOrganization(broken)).toBe("mixed");
    function* failsHalfway(): Generator {
      yield { organizationId: A };
      throw new Error("no");
    }
    expect(oneOrganization(failsHalfway())).toBe("mixed");
  });
});

describe("mixedOrganizationsIssue", () => {
  it("names the path and the code, and says what was mixed", () => {
    const found = mixedOrganizationsIssue(["records", 2], "These records");
    expect(found.path).toEqual(["records", 2]);
    expect(found.code).toBe("mixed_organizations");
    expect(found.message.startsWith("These records belong to more than one organization")).toBe(
      true,
    );
  });

  it("never names an organization", () => {
    const found = mixedOrganizationsIssue([], "Templates");
    expect(found.message).not.toContain(A);
    expect(found.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe("isIdentifierTypeKey", () => {
  it("accepts 1 to 64 lower case letters, digits and underscores, starting with a letter", () => {
    for (const key of ["a", "accession_number", "loan2", "x_", "a".repeat(64)]) {
      expect(isIdentifierTypeKey(key)).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const key of [
      "",
      "a".repeat(65),
      "Accession",
      "1st",
      "_private",
      "accession-number",
      "accession number",
      "accession.number",
      "café",
      "a\n",
      " a",
      42,
      null,
      undefined,
      ["a"],
      { key: "a" },
    ]) {
      expect(isIdentifierTypeKey(key)).toBe(false);
    }
  });

  it("refuses the prototype keys", () => {
    for (const key of ["constructor", "prototype", "__proto__"]) {
      expect(isIdentifierTypeKey(key)).toBe(false);
    }
  });
});
