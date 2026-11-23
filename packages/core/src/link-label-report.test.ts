// Link labels that no longer match the linked record's title, for Data
// Cleaning (T-015a, D-055), and attacks on the report: other organizations'
// records and templates, Proxies and getters, oversized lists.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_LINK_LABELS,
  MAX_STALE_LINK_LABELS,
  findStaleLinkLabels,
  indexRecords,
  indexTemplates,
  newOrganizationId,
  newRecordId,
  type CatalogRecord,
  type FieldTemplate,
  type Validated,
} from "./index.js";
import { ORG, field, record, template } from "./public-output.fixtures.js";

function ok<T>(result: Validated<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function codes(result: Validated<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const TPL = template(
  [
    field({ key: "creator", kind: "record_link" }),
    field({ key: "related", kind: "record_link", repeatable: true }),
    field({ key: "where", kind: "place" }),
    field({ key: "note", kind: "text" }),
  ],
  "links",
);
const REGISTRY = ok(indexTemplates([TPL]));

const withKey = (r: CatalogRecord): CatalogRecord => ({ ...r, templateKey: "links" });

function sample() {
  const agent = withKey(record("agent", "Dickinson, John Sr.", {}));
  const event = withKey(record("event", "Storm of 1900", {}));
  const place = withKey(record("place", "Dickinson (Tex.)", {}));
  const item = withKey(
    record("object", "Letter", {
      creator: { recordId: agent.id, label: "Dickinson, John" },
      related: [
        { recordId: event.id, label: "Storm  of 1900 " },
        { recordId: agent.id, label: "Dickinson, john sr." },
      ],
      where: { label: "Dickinson", recordId: place.id },
      note: "Dickinson, John",
    }),
  );
  return { agent, event, place, item, all: [agent, event, place, item] };
}

describe("findStaleLinkLabels", () => {
  it("lists links whose label differs from the linked record's title", () => {
    const s = sample();
    const result = ok(findStaleLinkLabels(ORG, s.all, REGISTRY));
    expect(result.entries).toEqual([
      {
        recordId: s.item.id,
        key: "creator",
        fieldKind: "record_link",
        linkedRecordId: s.agent.id,
        label: "Dickinson, John",
        title: "Dickinson, John Sr.",
      },
      {
        recordId: s.item.id,
        key: "related",
        fieldKind: "record_link",
        index: 1,
        linkedRecordId: s.agent.id,
        label: "Dickinson, john sr.",
        title: "Dickinson, John Sr.",
      },
      {
        recordId: s.item.id,
        key: "where",
        fieldKind: "place",
        linkedRecordId: s.place.id,
        label: "Dickinson",
        title: "Dickinson (Tex.)",
      },
    ]);
    expect(result.count).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.unknownTargets).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(Object.isFrozen(result.entries)).toBe(true);
  });

  it("treats white space and Unicode forms as equal, but not case", () => {
    const agent = withKey(record("agent", "Café Society", {}));
    const item = withKey(
      record("object", "Menu", {
        related: [
          { recordId: agent.id, label: "Café   Society" },
          { recordId: agent.id, label: "café society" },
        ],
      }),
    );
    const result = ok(findStaleLinkLabels(ORG, [agent, item], REGISTRY));
    expect(result.entries.map((e) => e.label)).toEqual(["café society"]);
  });

  it("accepts an indexRecords lookup and a lookup function", () => {
    const s = sample();
    const lookup = ok(indexRecords(s.all));
    expect(ok(findStaleLinkLabels(ORG, lookup, () => TPL)).count).toBe(3);
  });

  it("counts links to records not in the set without quoting them", () => {
    const missing = newRecordId();
    const item = withKey(
      record("object", "Orphan", { creator: { recordId: missing, label: "Gone" } }),
    );
    const result = ok(findStaleLinkLabels(ORG, [item], REGISTRY));
    expect(result.entries).toEqual([]);
    expect(result.unknownTargets).toBe(1);
  });

  it("ignores self links, place values with no record and other fields", () => {
    const id = newRecordId();
    const self = withKey(
      record(
        "object",
        "Self",
        { creator: { recordId: id, label: "Other" }, where: { label: "Somewhere" } },
        {},
        id,
      ),
    );
    const result = ok(findStaleLinkLabels(ORG, [self], REGISTRY));
    expect(result.count).toBe(0);
    expect(result.unknownTargets).toBe(0);
  });

  it("skips records without a usable template, naming only their ID and a code", () => {
    const s = sample();
    const legacy = record("object", "Old", {
      creator: { recordId: s.agent.id, label: "x" },
    });
    const result = ok(findStaleLinkLabels(ORG, [...s.all, legacy], REGISTRY));
    expect(result.skipped).toEqual([{ recordId: legacy.id, code: "no_template_key" }]);
    expect(result.skippedCount).toBe(1);
    expect(result.count).toBe(3);
  });

  it("caps the entries at maxEntries and counts them all", () => {
    const s = sample();
    const result = ok(findStaleLinkLabels(ORG, s.all, REGISTRY, { maxEntries: 2 }));
    expect(result.entries).toHaveLength(2);
    expect(result.count).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("is empty for no records", () => {
    expect(ok(findStaleLinkLabels(ORG, [], REGISTRY)).entries).toEqual([]);
  });
});

describe("findStaleLinkLabels attacks", () => {
  const OTHER = newOrganizationId();
  const SECRET = "Roe, Jane (anonymous donor)";

  function foreign(): CatalogRecord[] {
    const donor = withKey(record("agent", SECRET, {}, { organizationId: OTHER }));
    const item = withKey(
      record(
        "object",
        "Gift",
        { creator: { recordId: donor.id, label: "Donor" } },
        { organizationId: OTHER },
      ),
    );
    return [donor, item];
  }

  it("refuses another organization's records, naming nothing", () => {
    const records = foreign();
    const otherTpl = ok(indexTemplates([{ ...TPL, organizationId: OTHER } as FieldTemplate]));
    for (const result of [
      findStaleLinkLabels(ORG, records, otherTpl),
      findStaleLinkLabels(ORG, records, REGISTRY),
      findStaleLinkLabels(ORG, ok(indexRecords(records)), () => TPL),
    ]) {
      expect(result.ok).toBe(false);
      const text = JSON.stringify(result);
      for (const leak of [SECRET, OTHER, "Donor", "Gift", records[0]?.id ?? "?"]) {
        expect(text).not.toContain(leak);
      }
    }
    expect(codes(findStaleLinkLabels(ORG, records, () => TPL))).toEqual(["wrong_organization"]);
  });

  it("refuses another organization's template registry before reading records", () => {
    const s = sample();
    const otherTpl = ok(indexTemplates([{ ...TPL, organizationId: OTHER } as FieldTemplate]));
    let read = false;
    const records = [...s.all];
    Object.defineProperty(records, 0, {
      get() {
        read = true;
        return s.agent;
      },
    });
    expect(codes(findStaleLinkLabels(ORG, records, otherTpl))).toEqual(["wrong_organization"]);
    expect(read).toBe(false);
  });

  it("refuses a set mixing organizations", () => {
    const s = sample();
    const result = findStaleLinkLabels(ORG, [...s.all, ...foreign()], REGISTRY);
    expect(codes(result)).toEqual(["mixed_organizations"]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("never quotes a title through a link to another organization's record", () => {
    const s = sample();
    const [donor] = foreign();
    const item = withKey(
      record("object", "Letter", { creator: { recordId: donor?.id ?? "", label: "Donor" } }),
    );
    const result = ok(findStaleLinkLabels(ORG, [...s.all, item], REGISTRY));
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.unknownTargets).toBe(1);
  });

  it("skips a record whose lookup returns another organization's template", () => {
    const s = sample();
    const otherTpl = { ...TPL, organizationId: OTHER } as FieldTemplate;
    const result = ok(findStaleLinkLabels(ORG, s.all, () => otherTpl));
    expect(result.count).toBe(0);
    expect(result.skippedCount).toBe(4);
    expect(new Set(result.skipped.map((x) => x.code))).toEqual(new Set(["wrong_organization"]));
  });

  it("survives a template lookup that throws", () => {
    const s = sample();
    const result = ok(
      findStaleLinkLabels(ORG, s.all, () => {
        throw new Error(SECRET);
      }),
    );
    expect(result.skippedCount).toBe(4);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("refuses Proxies and getters without running them", () => {
    const s = sample();
    let ran = false;
    const trap = {
      get() {
        ran = true;
        return undefined;
      },
      getPrototypeOf(): object {
        ran = true;
        return Array.prototype as object;
      },
    };
    expect(findStaleLinkLabels(ORG, new Proxy(s.all, trap), REGISTRY).ok).toBe(false);
    expect(findStaleLinkLabels(ORG, s.all, new Proxy(() => TPL, trap)).ok).toBe(false);
    expect(findStaleLinkLabels(ORG, s.all, REGISTRY, new Proxy({}, trap)).ok).toBe(false);
    const getterOptions = Object.defineProperty({}, "maxEntries", {
      get() {
        ran = true;
        return 5;
      },
    });
    expect(codes(findStaleLinkLabels(ORG, s.all, REGISTRY, getterOptions))).toEqual([
      "invalid_option",
    ]);
    // A record whose label is a getter is not valid data.
    const sneaky = withKey(record("object", "Sneaky", {}));
    Object.defineProperty(sneaky.fields, "creator", {
      enumerable: true,
      get() {
        ran = true;
        return { recordId: s.agent.id, label: "x" };
      },
    });
    const result = ok(findStaleLinkLabels(ORG, [...s.all, sneaky], REGISTRY));
    expect(result.skipped).toEqual([{ recordId: sneaky.id, code: "invalid_record" }]);
    expect(ran).toBe(false);
  });

  it("refuses bad organization IDs, templates and options", () => {
    const s = sample();
    expect(codes(findStaleLinkLabels("nope", s.all, REGISTRY))).toEqual(["invalid_organization"]);
    expect(codes(findStaleLinkLabels(ORG, s.all, [TPL]))).toEqual(["invalid_templates"]);
    for (const maxEntries of [0, -1, 1.5, MAX_STALE_LINK_LABELS + 1, "5", Number.NaN]) {
      expect(
        codes(
          findStaleLinkLabels(ORG, s.all, REGISTRY, { maxEntries } as unknown as {
            maxEntries: number;
          }),
        ),
      ).toEqual(["invalid_option"]);
    }
    expect(codes(findStaleLinkLabels(ORG, { length: 1 }, REGISTRY))).toEqual(["not_a_list"]);
  });

  it("lists at most the default number of entries for a large set", () => {
    const agent = withKey(record("agent", "Smith, Ann", {}));
    const many: CatalogRecord[] = [agent];
    const links = Array.from({ length: 50 }, () => ({ recordId: agent.id, label: "Smith" }));
    for (let i = 0; i < 300; i += 1) {
      many.push(withKey(record("object", "Item", { related: links })));
    }
    const result = ok(findStaleLinkLabels(ORG, many, REGISTRY));
    expect(result.count).toBe(15_000);
    expect(result.entries).toHaveLength(DEFAULT_STALE_LINK_LABELS);
    expect(result.truncated).toBe(true);
  });
});
