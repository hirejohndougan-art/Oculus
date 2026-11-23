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
  effectiveRecord,
  indexAccessions,
  publicOutput,
  publicView,
  validateAccession,
  validateDonorContact,
  type CatalogRecord,
  type Issue,
  type PublicRecord,
  type RecordId,
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
  series,
  vase,
} from "./accessions.fixtures.js";
import {
  BASE,
  CHECKERS,
  FIELDS,
  MAPPING,
  everything,
  field,
  identifiersFor,
  linkChecker,
  noAccessions,
  record,
  template,
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
    expect(ok(publish(view, { accessions: noAccessions(ORG, RECORDS) })).id).toBe(BASE + item.id);
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

describe("a scan can't publish what a deed holds back (T-016 review)", () => {
  const rights = { rights: { uri: CNE } };
  const free = record("archival_unit", "Free fonds", rights, { level: "fonds" });
  const unit = record("archival_unit", "Unit", rights, { level: "series", parentId: free.id });
  const shot = record("digital_asset", "Shot", rights, { represents: unit.id });
  const heldFonds = record("archival_unit", "Held fonds", rights, { level: "fonds" });
  const heldSeries = record("archival_unit", "Held series", rights, {
    level: "series",
    parentId: heldFonds.id,
  });
  const before = [free, unit, shot, heldFonds, heldSeries, donor];
  const holdsFonds = (records: readonly unknown[]) =>
    registerOf([accession({ records: [{ recordId: heldFonds.id, label: "Held" }] })], { records });

  it("not after the represented unit moved under a held series, with a register made before", () => {
    const register = holdsFonds(before);
    const moved = { ...unit, level: "file", parentId: heldSeries.id } as typeof unit;
    const now = [free, moved, shot, heldFonds, heldSeries, donor];
    const e = effectiveOf(shot, now);
    expect(codes(effectivePublishIssues(e, { accessions: register }))).toEqual(["deed_not_signed"]);
    expect(codes(publish(publicView(e), { accessions: register, records: now }))).toEqual([
      "deed_not_signed",
    ]);
  });

  it("not with a kept view, when publicOutput is given the records as they are now", () => {
    const register = holdsFonds(before);
    const view = publicView(effectiveOf(shot, before));
    expect(ok(publish(view, { accessions: register, records: before })).id).toBe(BASE + shot.id);
    const moved = { ...unit, level: "file", parentId: heldSeries.id } as typeof unit;
    const now = [free, moved, shot, heldFonds, heldSeries, donor];
    expect(codes(publish(view, { accessions: register, records: now }))).toEqual([
      "deed_not_signed",
    ]);
  });

  it("not with a register made without a record in between", () => {
    // The register was made without the series, so it can't see the unit is below the fonds.
    const register = holdsFonds([free, heldFonds, donor, shot, unit]);
    const below = { ...unit, level: "file", parentId: heldSeries.id } as typeof unit;
    const now = [free, below, shot, heldFonds, heldSeries, donor];
    expect(codes(effectivePublishIssues(effectiveOf(shot, now), { accessions: register }))).toEqual(
      ["accessions_out_of_date"],
    );
  });

  it("not with an empty register, for any accessioned kind", () => {
    const empty = registerOf([], { records: [] });
    for (const r of [fonds, item, scan, vase]) {
      expect(codes(effectivePublishIssues(effectiveOf(r), { accessions: empty })), r.title).toEqual(
        ["accessions_out_of_date"],
      );
    }
  });
});

describe("a link to a held record shows nothing, not even its label (T-016 review, D-045)", () => {
  it("even when the held record is in the published list", async () => {
    const { linkChecker, template, field, FIELDS } = await import("./public-output.fixtures.js");
    const tpl = template([
      ...FIELDS,
      field({ key: "related", kind: "record_link", repeatable: true }),
    ]);
    const map = {
      template: "out",
      entries: [
        { field: "rights", term: "rights" },
        { field: "related", term: "relation" },
      ],
    };
    const page = record("object", "Page", {
      rights: { uri: CNE },
      related: [
        { recordId: item.id, label: "Held item" },
        { recordId: vase.id, label: "Free vase" },
      ],
    });
    const records = [...RECORDS, page];
    const checkers = { ...CHECKERS, record_link: linkChecker(records) };
    const e = ok(
      (await import("./index.js")).effectiveRecord(page.id, records, () => tpl, {
        checkers,
        identifiers: identifiersFor(records),
      }),
    );
    const view = publicView(e);
    if (view === undefined) throw new Error("no public view");
    const run = (accessions: unknown) =>
      ok(
        publicOutput(view, map, {
          baseUrl: BASE,
          published: [page.id, item.id, vase.id],
          checkers,
          identifiers: identifiersFor(records),
          accessions,
          // Links to accessioned kinds are live only with the records (D-043).
          records,
        }),
      );
    const held = registerOf([accession({ records: [{ recordId: fonds.id, label: "F" }] })], {
      records,
    });
    const out = everything(run(held));
    expect(out).not.toContain(BASE + item.id);
    expect(out).not.toContain("Held item");
    expect(out).toContain("Free vase");
    expect(out).toContain(BASE + vase.id);
    // Once the deed is signed, both are links.
    const signed = registerOf(
      [accession({ deedStatus: "signed", records: [{ recordId: fonds.id, label: "F" }] })],
      { records },
    );
    expect(everything(run(signed))).toContain(BASE + item.id);
  });
});

describe("a link is deed-checked through its target's parents and what it shows (T-016 second review)", () => {
  const rights = { rights: { uri: CNE } };
  const LINKS_TPL = template([
    ...FIELDS,
    field({ key: "related", kind: "record_link", repeatable: true }),
  ]);
  const RIGHTS_MAP = { field: "rights", term: "rights" };
  const RELATED_MAP = { field: "related", term: "relation" };

  /** A page linking to `links`, among `others`, and a way to publish it. */
  function pageLinking(
    links: readonly { recordId: RecordId; label: string }[],
    others: readonly CatalogRecord[],
    kind: "object" | "agent" = "object",
  ) {
    const page =
      kind === "agent"
        ? record("agent", "Page", { related: links })
        : record("object", "Page", { ...rights, related: links });
    const records = [...others, page];
    const checkers = { ...CHECKERS, record_link: linkChecker(records) };
    const view = viewOrThrow(
      ok(
        effectiveRecord(page.id, records, () => LINKS_TPL, {
          checkers,
          identifiers: identifiersFor(records),
        }),
      ),
    );
    const map = {
      template: "out",
      entries: kind === "agent" ? [RELATED_MAP] : [RIGHTS_MAP, RELATED_MAP],
    };
    const publishWith = (accessions: unknown, now: readonly CatalogRecord[] | undefined) =>
      everything(
        ok(
          publicOutput(view, map, {
            baseUrl: BASE,
            published: records.map((r) => r.id),
            checkers,
            identifiers: identifiersFor(records),
            templateFor: () => LINKS_TPL,
            ...(accessions === undefined ? {} : { accessions }),
            ...(now === undefined ? {} : { records: now }),
          }),
        ),
      );
    return { records, publishWith };
  }

  const fondsDeed = (deedStatus: string) =>
    accession({ deedStatus, records: [{ recordId: fonds.id, label: "F" }] });

  it("not when the register was made without a record above the target", () => {
    const page = pageLinking(
      [
        { recordId: item.id, label: "Item label" },
        { recordId: scan.id, label: "Scan label" },
        { recordId: vase.id, label: "Vase label" },
      ],
      RECORDS,
    );
    // Every record but the series, so the register can't see the item is under the fonds.
    const register = registerOf([fondsDeed("missing")], {
      records: page.records.filter((r) => r.id !== series.id),
    });
    for (const now of [page.records, undefined]) {
      const out = page.publishWith(register, now);
      expect(out).not.toContain(BASE + item.id);
      expect(out).not.toContain(BASE + scan.id);
      expect(out).not.toContain("Item label");
      expect(out).not.toContain("Scan label");
      expect(leaks(out)).toEqual([]);
    }
    // A record outside the fonds is a live link, but only with the records.
    expect(page.publishWith(register, page.records)).toContain(BASE + vase.id);
    expect(page.publishWith(register, undefined)).not.toContain(BASE + vase.id);
  });

  it("not when the register was made without the record a digital asset shows", () => {
    const page = pageLinking([{ recordId: scan.id, label: "Scan label" }], RECORDS);
    // A signed deed, so only the item the register doesn't know keeps the scan out.
    const without = registerOf([fondsDeed("signed")], {
      records: page.records.filter((r) => r.id !== item.id),
    });
    expect(page.publishWith(without, page.records)).not.toContain(BASE + scan.id);
    const whole = registerOf([fondsDeed("signed")], { records: page.records });
    expect(page.publishWith(whole, page.records)).toContain(BASE + scan.id);
  });

  it("not after the target moved under a held fonds, with a register made before", () => {
    const free = record("archival_unit", "Free fonds", rights, { level: "fonds" });
    const unit = record("archival_unit", "Unit", rights, { level: "series", parentId: free.id });
    const heldFonds = record("archival_unit", "Held fonds", rights, { level: "fonds" });
    const page = pageLinking(
      [{ recordId: unit.id, label: "Unit label" }],
      [free, unit, heldFonds, donor],
    );
    const register = registerOf(
      [accession({ records: [{ recordId: heldFonds.id, label: "Held" }] })],
      { records: page.records },
    );
    expect(page.publishWith(register, page.records)).toContain(BASE + unit.id);
    const moved = { ...unit, parentId: heldFonds.id } as CatalogRecord;
    const now = page.records.map((r) => (r.id === unit.id ? moved : r));
    const out = page.publishWith(register, now);
    expect(out).not.toContain(BASE + unit.id);
    expect(out).not.toContain("Unit label");
    expect(leaks(out)).toEqual([]);
  });

  it("not from an agent's page published without a register", () => {
    const page = pageLinking(
      [
        { recordId: vase.id, label: "Vase label" },
        { recordId: donor.id, label: "Agent label" },
      ],
      RECORDS,
      "agent",
    );
    const out = page.publishWith(undefined, page.records);
    expect(out).not.toContain(BASE + vase.id);
    expect(out).not.toContain("Vase label");
    expect(out).toContain(BASE + donor.id);
    // With a register made now, the vase is a link.
    const now = registerOf([], { records: page.records });
    expect(page.publishWith(now, page.records)).toContain(BASE + vase.id);
  });
});

describe("accession numbers are staff-only", () => {
  it("refuses a public identifier type as an accession number type", () => {
    const r = indexAccessions(ORG, {
      accessions: [accession()],
      records: RECORDS,
      identifierTypes: [{ ...ACCESSION_TYPE, public: true }],
    });
    expect(codes(r)).toEqual(["public_type"]);
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
    // Lookups only: no set to read donor data from, or to change.
    expect(Object.keys(holds ?? {}).sort()).toEqual(["isHeld", "isKnown", "organizationId"]);
    expect(leaks(JSON.stringify(holds))).toEqual([]);
    expect(Object.isFrozen(holds)).toBe(true);
    expect(holds?.isHeld(item.id)).toBe(true);
    expect(holds?.isHeld(vase.id)).toBe(false);
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
