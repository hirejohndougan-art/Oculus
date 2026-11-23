// Attack tests for accessions and deeds of gift (T-016, D-043): publishing a
// record whose deed is missing, using another organization's accessions,
// leaking donor details into output or messages, and hostile objects
// (getters, Proxies, prototype keys, forged registers).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  accessionById,
  accessionsOfRecord,
  deedHoldsOn,
  donorContact,
  effectivePublishIssues,
  indexAccessions,
  publicOutput,
  publicView,
  validateAccession,
  validateDonorContact,
  type Issue,
  type PublicRecord,
} from "./index.js";
import { deedHoldsOf } from "./accession-holds.js";
import {
  CNE,
  ORG,
  OTHER,
  RECORDS,
  SECRET,
  TYPES,
  ACCESSION_TYPE,
  accession,
  codes,
  contact,
  donor,
  effectiveOf,
  fonds,
  item,
  ok,
  registerOf,
  scan,
  vase,
} from "./accessions.fixtures.js";
import {
  BASE,
  CHECKERS,
  MAPPING,
  everything,
  identifiersFor,
  noAccessions,
  record,
} from "./public-output.fixtures.js";

const SECRETS = Object.values(SECRET);

function publish(view: PublicRecord | undefined, options: Record<string, unknown>) {
  if (view === undefined) throw new Error("no public view");
  return publicOutput(view, MAPPING, {
    baseUrl: BASE,
    published: [view.id],
    checkers: CHECKERS,
    identifiers: identifiersFor(RECORDS),
    ...options,
  });
}

function leaks(text: string): string[] {
  return SECRETS.filter((s) => text.includes(s));
}

function messages(found: Issue[] | readonly Issue[] | { ok: boolean; issues?: readonly Issue[] }) {
  const list = Array.isArray(found)
    ? (found as readonly Issue[])
    : ((found as { issues?: readonly Issue[] }).issues ?? []);
  return list.map((i) => i.message).join("\n");
}

function viewOrThrow(e: Parameters<typeof publicView>[0]): PublicRecord {
  const view = publicView(e);
  if (view === undefined) throw new Error("no public view");
  return view;
}

const held = () => registerOf([accession()]);

describe("a record whose deed is missing can't be published", () => {
  it("not by leaving the register out, or passing undefined", () => {
    for (const r of [fonds, item, scan, vase]) {
      expect(codes(effectivePublishIssues(effectiveOf(r))), r.title).toEqual([
        "accessions_unknown",
      ]);
      expect(codes(effectivePublishIssues(effectiveOf(r), { accessions: undefined }))).toEqual([
        "accessions_unknown",
      ]);
      expect(codes(effectivePublishIssues(effectiveOf(r), {}))).toEqual(["accessions_unknown"]);
      expect(codes(publish(publicView(effectiveOf(r)), {}))).toEqual(["accessions_unknown"]);
    }
  });

  it("not with a forged, copied or wrapped register", () => {
    const real = held();
    const e = effectiveOf(item);
    for (const fake of [
      null,
      {},
      { organizationId: ORG, size: 0 },
      { ...real },
      Object.create(real) as object,
      [],
      "register",
    ]) {
      expect(codes(effectivePublishIssues(e, { accessions: fake })), JSON.stringify(fake)).toEqual([
        "invalid_accessions",
      ]);
      expect(codes(publish(publicView(e), { accessions: fake }))).toEqual(["invalid_accessions"]);
    }
    const wrapped = new Proxy(real, {});
    expect(codes(effectivePublishIssues(e, { accessions: wrapped }))).toEqual(["invalid_options"]);
    expect(codes(publish(publicView(e), { accessions: wrapped }))).toEqual(["invalid_options"]);
  });

  it("not with the register behind a getter, a Proxy of options, or on the prototype", () => {
    const e = effectiveOf(item);
    const getter = {};
    Object.defineProperty(getter, "accessions", { get: () => noAccessions(ORG), enumerable: true });
    expect(codes(effectivePublishIssues(e, getter))).toEqual(["invalid_options"]);
    expect(
      codes(effectivePublishIssues(e, new Proxy({ accessions: noAccessions(ORG) }, {}))),
    ).toEqual(["invalid_options"]);
    const options = {
      baseUrl: BASE,
      published: [item.id],
      checkers: CHECKERS,
      identifiers: identifiersFor(RECORDS),
    };
    Object.defineProperty(options, "accessions", {
      get: () => noAccessions(ORG),
      enumerable: true,
    });
    expect(codes(publicOutput(viewOrThrow(e), MAPPING, options))).toEqual(["invalid_options"]);
    const inherited = Object.create({ accessions: noAccessions(ORG) }) as object;
    expect(codes(effectivePublishIssues(e, inherited))).toEqual(["accessions_unknown"]);
  });

  describe("with Object.prototype polluted", () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>).accessions;
      delete (Object.prototype as Record<string, unknown>).deedStatus;
    });

    it("a register on Object.prototype isn't taken as the option", () => {
      (Object.prototype as Record<string, unknown>).accessions = noAccessions(ORG);
      expect(codes(effectivePublishIssues(effectiveOf(item), {}))).toEqual(["accessions_unknown"]);
    });

    it("a deed status on Object.prototype doesn't sign a deed left out", () => {
      (Object.prototype as Record<string, unknown>).deedStatus = "signed";
      const noDeed: Record<string, unknown> = { ...accession() };
      delete noDeed.deedStatus;
      expect(codes(validateAccession(noDeed))).toEqual(["invalid_deed_status"]);
    });
  });

  it("not from a kept view: the register as it is now decides", () => {
    const view = publicView(effectiveOf(item));
    expect(ok(publish(view, { accessions: noAccessions(ORG) })).id).toBe(BASE + item.id);
    expect(codes(publish(view, { accessions: held() }))).toEqual(["deed_not_signed"]);
  });

  it("not by changing the caller's objects after the register was made", () => {
    const a = accession() as { deedStatus: string };
    const list = [a];
    const records = [...RECORDS];
    const register = ok(
      indexAccessions(ORG, { accessions: list as never, records, identifierTypes: TYPES }),
    );
    a.deedStatus = "signed";
    list.length = 0;
    records.length = 0;
    expect(codes(effectivePublishIssues(effectiveOf(item), { accessions: register }))).toEqual([
      "deed_not_signed",
    ]);
    expect(Object.isFrozen(accessionById(register, (a as never as { id: string }).id))).toBe(true);
  });

  it("not by listing a record of a kind the deed check skips", () => {
    expect(
      codes(
        indexAccessions(ORG, {
          accessions: [accession({ records: [{ recordId: donor.id, label: "Donor" }] })],
          records: RECORDS,
          identifierTypes: TYPES,
        }),
      ),
    ).toEqual(["wrong_record_kind"]);
  });
});

describe("another organization's accessions are never used or read", () => {
  const theirs = record(
    "object",
    "Their object",
    { rights: { uri: CNE } },
    {
      organizationId: OTHER,
    },
  );
  const theirDonor = record("agent", "Their donor", {}, { organizationId: OTHER });

  it("their register can't clear, or hold, our records", () => {
    const e = effectiveOf(item);
    expect(codes(effectivePublishIssues(e, { accessions: noAccessions(OTHER) }))).toEqual([
      "mixed_organizations",
    ]);
    expect(
      codes(effectivePublishIssues(effectiveOf(donor), { accessions: noAccessions(OTHER) })),
    ).toEqual(["mixed_organizations"]);
    expect(codes(publish(publicView(e), { accessions: noAccessions(OTHER) }))).toEqual([
      "mixed_organizations",
    ]);
  });

  it("refuses their accessions, contacts, records and identifier types in our register", () => {
    const run = (input: Record<string, unknown>) =>
      indexAccessions(ORG, {
        accessions: [],
        records: RECORDS,
        identifierTypes: TYPES,
        ...input,
      });
    const cases = [
      { accessions: [accession({ organizationId: OTHER })] },
      { contacts: [contact({ organizationId: OTHER })] },
      { records: [...RECORDS, theirs] },
      { records: [theirs, theirDonor] },
      { identifierTypes: [{ ...ACCESSION_TYPE, organizationId: OTHER }] },
      { identifierTypes: [...TYPES, { ...ACCESSION_TYPE, key: "x", organizationId: OTHER }] },
    ];
    for (const c of cases) {
      const r = run(c);
      expect(codes(r), JSON.stringify(Object.keys(c))).toEqual(["mixed_organizations"]);
      expect(messages(r)).not.toContain(OTHER);
      expect(messages(r)).not.toContain("Their");
    }
  });

  it("can't link to their records, which are simply not found", () => {
    const r = indexAccessions(ORG, {
      accessions: [
        accession({
          sourceAgent: { recordId: theirDonor.id, label: "x" },
          records: [{ recordId: theirs.id, label: "y" }],
        }),
      ],
      records: RECORDS,
      identifierTypes: TYPES,
    });
    expect(codes(r)).toEqual(["unknown_record", "unknown_record"]);
    expect(messages(r)).not.toContain("Their");
  });

  it("finds nothing of theirs through our register", () => {
    const ours = registerOf([accession()], { contacts: [contact()] });
    expect(accessionsOfRecord(ours, theirs.id)).toEqual([]);
    expect(deedHoldsOn(ours, theirs.id)).toEqual([]);
    expect(donorContact(ours, theirDonor.id)).toBeUndefined();
    // And a register of theirs knows nothing of ours.
    const register = ok(
      indexAccessions(OTHER, {
        accessions: [],
        records: [theirs, theirDonor],
        identifierTypes: [],
      }),
    );
    expect(donorContact(register, donor.id)).toBeUndefined();
    expect(deedHoldsOn(register, item.id)).toEqual([]);
  });
});

describe("donor details never leak", () => {
  const register = registerOf([accession()], { contacts: [contact()] });

  it("not into public output: the view and output of a signed record hold none", () => {
    const signed = registerOf([accession({ deedStatus: "signed" })], { contacts: [contact()] });
    for (const r of [fonds, item, scan]) {
      const view = publicView(effectiveOf(r));
      expect(leaks(JSON.stringify(view)), r.title).toEqual([]);
      const out = ok(publish(view, { accessions: signed }));
      expect(leaks(everything(out)), r.title).toEqual([]);
    }
  });

  it("not into the messages of the deed check or of publishing", () => {
    for (const r of [fonds, item, scan]) {
      const e = effectiveOf(r);
      const found = effectivePublishIssues(e, { accessions: register });
      expect(codes(found)).toEqual(["deed_not_signed"]);
      expect(leaks(messages(found))).toEqual([]);
      expect(messages(found)).not.toContain(SECRET.number);
      expect(leaks(messages(publish(publicView(e), { accessions: register })))).toEqual([]);
    }
  });

  it("not into the messages of the register's own checks", () => {
    const long = "x".repeat(5000);
    const bad = [
      validateDonorContact(contact({ email: `${SECRET.email}\n${SECRET.phone}` })),
      validateDonorContact(contact({ phone: `${SECRET.phone}${long}` })),
      validateDonorContact(contact({ [SECRET.email]: SECRET.address })),
      validateAccession(accession({ materials: `${SECRET.materials}‮` })),
      validateAccession(accession({ restrictions: `${SECRET.restrictions}${long}` })),
      validateAccession(
        accession({ number: { type: "accession_number", value: `${SECRET.number}\n` } }),
      ),
      indexAccessions(ORG, {
        accessions: [accession({ number: { type: "accession_number", value: "2026-14" } })],
        records: RECORDS,
        identifierTypes: TYPES,
      }),
      indexAccessions(ORG, {
        accessions: [accession(), { ...accession(), number: accession().number }],
        records: RECORDS,
        identifierTypes: TYPES,
      }),
    ];
    for (const r of bad) {
      expect(r.ok).toBe(false);
      expect(leaks(messages(r))).toEqual([]);
    }
  });

  it("not through what the publish check can see of a register", () => {
    const holds = deedHoldsOf(register);
    expect(Object.keys(holds ?? {}).sort()).toEqual(["held", "known", "organizationId"]);
    expect(leaks(JSON.stringify([...(holds?.held ?? [])]))).toEqual([]);
    expect(Object.isFrozen(holds)).toBe(true);
  });

  it("not by any module but the package index importing accessions", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const mentions = /["'`](?:\.{1,2}\/)+(?:[^"'`]*\/)?accessions(?:\.[jt]s)?["'`]/;
    const importers = (readdirSync(here, { recursive: true }) as string[])
      .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.test\.ts$|\.fixtures\.ts$/.test(f))
      .filter((f) => f !== "accessions.ts")
      .filter((f) => mentions.test(readFileSync(join(here, f), "utf8")));
    expect(importers).toEqual(["index.ts"]);
    expect(mentions.test('from "./accessions.js"')).toBe(true);
    expect(mentions.test('from "./accession-holds.js"')).toBe(false);
  });
});

describe("hostile input to the register", () => {
  const base = { accessions: [], records: RECORDS, identifierTypes: TYPES };

  it("refuses a Proxy, getters, unknown keys and a bad organization", () => {
    expect(codes(indexAccessions(ORG, new Proxy(base, {}) as never))).toEqual(["invalid_input"]);
    const getter = { ...base };
    Object.defineProperty(getter, "accessions", { get: () => [], enumerable: true });
    expect(codes(indexAccessions(ORG, getter as never))).toEqual(["invalid_input"]);
    expect(codes(indexAccessions(ORG, { ...base, published: [] } as never))).toEqual([
      "invalid_input",
    ]);
    expect(codes(indexAccessions("nope" as never, base as never))).toEqual([
      "invalid_organization",
    ]);
    expect(codes(indexAccessions(ORG, { ...base, accessions: new Proxy([], {}) }))).toEqual([
      "not_a_list",
    ]);
  });

  it("refuses a list with a hole or a getter, and reads each entry once", () => {
    const holes: unknown[] = [];
    holes[1] = accession();
    expect(codes(indexAccessions(ORG, { ...base, accessions: holes } as never))).toEqual([
      "unreadable_entry",
    ]);
    const list: unknown[] = [];
    let reads = 0;
    Object.defineProperty(list, 0, {
      get: () => {
        reads += 1;
        return accession({ deedStatus: reads === 1 ? "missing" : "signed" });
      },
      enumerable: true,
    });
    expect(codes(indexAccessions(ORG, { ...base, accessions: list } as never))).toEqual([
      "unreadable_entry",
    ]);
  });

  it("refuses an accession that is a Proxy, has a getter or a prototype key", () => {
    expect(codes(validateAccession(new Proxy(accession(), {})))).toEqual(["not_an_object"]);
    const getter = { ...accession() } as Record<string, unknown>;
    Object.defineProperty(getter, "deedStatus", { get: () => "signed", enumerable: true });
    expect(validateAccession(getter).ok).toBe(false);
    const proto = JSON.parse(`{"__proto__": {"deedStatus": "signed"}}`) as Record<string, unknown>;
    expect(validateAccession({ ...accession(), ...proto }).ok).toBe(false);
    const constructorKey = { ...accession(), constructor: "x" };
    expect(validateAccession(constructorKey).ok).toBe(false);
    class Fancy {
      deedStatus = "signed";
    }
    expect(codes(validateAccession(new Fancy()))).toEqual(["not_an_object"]);
  });

  it("refuses an accession listing more records than allowed", () => {
    const many = Array.from({ length: 5001 }, () => ({ recordId: fonds.id, label: "x" }));
    expect(validateAccession(accession({ records: many })).ok).toBe(false);
  });
});
