// Attack tests for S-007 (D-016 "Issues"): the issues `publicOutput` returns
// are for staff only, and even so their messages never quote a stored value,
// an identifier number or an identifier type key. Checker messages that do
// (`unknown_type`, `format_mismatch`, a bad date's text, a rights value) are
// replaced with fixed text; the code and path still say what and where.
import { describe, expect, it } from "vitest";
import {
  effectiveRecord,
  makeIdentifierChecker,
  publicOutput,
  publicView,
  type CatalogRecord,
  type FieldValue,
  type PublicOutput,
  type RecordIdentifiers,
  type Validated,
} from "./index.js";
import {
  accessionsFor,
  BASE,
  CNE,
  MAPPING,
  ORG,
  TPL,
  nowOf,
  record,
} from "./public-output.fixtures.js";

const NUMBER = "SECRETNUM-4471";
const TYPE_KEY = "secret_donor_ledger";

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const checker = makeIdentifierChecker([
  {
    key: "accession_number",
    label: "Accession number",
    organizationId: ORG,
    uniqueness: "none",
    pattern: "D-####",
    public: true,
  },
]);
if (!checker.ok) throw new Error("identifier types");
const CHECKERS = Object.freeze({ identifier: checker.value });

function identifiersOf(item: CatalogRecord, value: FieldValue): RecordIdentifiers[] {
  const v = value as { type: string; value: string };
  return [
    {
      recordId: item.id,
      organizationId: item.organizationId,
      current: [{ type: v.type, value: v.value, primary: true }],
      former: [],
    },
  ];
}

/**
 * A view of an object whose own `number` holds `value` (own values reach the
 * view unchecked, D-013), published with the identifier checker.
 */
function publishNumber(value: FieldValue): Validated<PublicOutput> {
  const item = record("object", "Item", { rights: { uri: CNE }, number: value });
  const identifiers = identifiersOf(item, value);
  const built = effectiveRecord(item.id, [item], () => TPL, { checkers: CHECKERS, identifiers });
  if (!built.ok) throw new Error(JSON.stringify(built.issues));
  const view = publicView(built.value);
  if (view === undefined) throw new Error("no view");
  return publicOutput(view, MAPPING, {
    ...nowOf(view),
    baseUrl: BASE,
    accessions: accessionsFor(view),
    published: [view.id],
    checkers: CHECKERS,
    identifiers,
  });
}

function quotesNothing(result: Validated<PublicOutput>, ...secrets: string[]): void {
  expect(result.ok).toBe(false);
  const text = JSON.stringify(result);
  for (const s of secrets) expect(text).not.toContain(s);
}

describe("publicOutput issue messages quote no values (S-007)", () => {
  it("an identifier of a type the organization doesn't have: no type key, no number", () => {
    const result = publishNumber({ type: TYPE_KEY, value: NUMBER });
    // effectiveRecord already holds it back as a staff type (D-022).
    expect(codes(result)).toEqual(["private_identifier_type"]);
    expect(result.ok ? [] : result.issues[0]?.path.slice(0, 2)).toEqual(["fields", "number"]);
    quotesNothing(result, TYPE_KEY, NUMBER);
  });

  it("an identifier that doesn't match its type's format: no number, no format", () => {
    const result = publishNumber({ type: "accession_number", value: NUMBER });
    expect(codes(result)).toContain("format_mismatch");
    quotesNothing(result, NUMBER, "SECRETNUM", "D-####");
  });

  it("a value that fails the built-in check: its text isn't quoted", () => {
    const item = record("object", "Item", { rights: { uri: CNE }, date: "SECRET-not-a-date" });
    const built = effectiveRecord(item.id, [item], () => TPL);
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    const result = publicOutput(view, MAPPING, {
      ...nowOf(view),
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [view.id],
      checkers: CHECKERS,
    });
    quotesNothing(result, "SECRET");
    expect(result.ok ? [] : result.issues[0]?.path.slice(0, 2)).toEqual(["fields", "date"]);
  });

  it("a rights value that isn't { uri }: its text isn't quoted", () => {
    const item = record("object", "Item", { rights: "SECRET rights text" });
    const built = effectiveRecord(item.id, [item], () => TPL);
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    const result = publicOutput(view, MAPPING, {
      ...nowOf(view),
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [view.id],
      checkers: CHECKERS,
    });
    quotesNothing(result, "SECRET");
  });

  it("a caller's checker that quotes the value: the message is replaced, code and path kept", () => {
    const item = record("object", "Item", {
      rights: { uri: CNE },
      description: "SECRET description",
    });
    const built = effectiveRecord(item.id, [item], () => TPL);
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const view = publicView(built.value);
    if (view === undefined) throw new Error("no view");
    const result = publicOutput(view, MAPPING, {
      ...nowOf(view),
      baseUrl: BASE,
      accessions: accessionsFor(view),
      published: [view.id],
      checkers: {
        ...CHECKERS,
        long_text: (v: FieldValue) => [
          { code: "no_thanks", message: `Refused ${JSON.stringify(v)}`, path: [] },
        ],
      },
    });
    expect(codes(result)).toEqual(["no_thanks"]);
    expect(result.ok ? [] : result.issues[0]?.path).toEqual(["fields", "description"]);
    quotesNothing(result, "SECRET");
  });
});
