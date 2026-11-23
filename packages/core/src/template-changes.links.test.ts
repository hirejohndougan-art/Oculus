// A record_link field's recordKinds narrowed by a template change (T-015a):
// the records whose links no longer fit, found through the organization's
// record link checker, and attacks on that checker option.
import { describe, expect, it } from "vitest";
import {
  MAX_LISTED_RECORDS,
  makeRecordLinkChecker,
  newOrganizationId,
  newRecordId,
  templateChanges,
  type CatalogRecord,
  type FieldDefinition,
  type FieldTemplate,
  type TemplateChange,
  type TemplateChanges,
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

function linkTemplate(creator: Partial<FieldDefinition>, key = "links"): FieldTemplate {
  return template(
    [
      field({ key: "creator", kind: "record_link", ...creator }),
      field({ key: "related", kind: "record_link", repeatable: true }),
      field({ key: "where", kind: "place" }),
    ],
    key,
  );
}

const ANY = linkTemplate({});
const AGENT_OR_EVENT = linkTemplate({ recordKinds: ["agent", "event"] });
const AGENT = linkTemplate({ recordKinds: ["agent"] });

const withKey = (r: CatalogRecord): CatalogRecord => ({ ...r, templateKey: "links" });

const SECRET_TITLE = "Jane Roe, anonymous donor";
const SECRET_LABEL = "Roe, Jane (donor)";

function sample() {
  const agent = record("agent", "Dickinson, John", {});
  const event = record("event", SECRET_TITLE, {});
  const place = record("place", "Dickinson (Tex.)", {});
  const byAgent = withKey(
    record("object", "Letter", { creator: { recordId: agent.id, label: "Dickinson, John" } }),
  );
  const byEvent = withKey(
    record("object", "Photograph", { creator: { recordId: event.id, label: SECRET_LABEL } }),
  );
  const none = withKey(record("object", "Map", {}));
  const users = [byAgent, byEvent, none];
  const checker = ok(makeRecordLinkChecker([agent, event, place, ...users]));
  return { agent, event, place, byAgent, byEvent, none, users, checker };
}

function only(result: Validated<TemplateChanges>, code: string): TemplateChange {
  const found = ok(result).changes.filter((c) => c.code === code);
  expect(found).toHaveLength(1);
  const [first] = found;
  if (first === undefined) throw new Error(`no ${code} change`);
  return first;
}

describe("record_kind_removed", () => {
  it("lists the records linking to a kind the field no longer allows", () => {
    const s = sample();
    const result = templateChanges(AGENT_OR_EVENT, AGENT, s.users, { linkChecker: s.checker });
    const change = only(result, "record_kind_removed");
    expect(change.key).toBe("creator");
    expect(change.removedCodes).toEqual(["event"]);
    expect(change.recordIds).toEqual([s.byEvent.id]);
    expect(change.recordCount).toBe(1);
    expect(change.needsConfirmation).toBe(true);
    expect(ok(result).needsConfirmation).toBe(true);
    expect(change.message).toContain("1 record link to a record of a kind");
  });

  it("names every kind dropped when the field allowed any", () => {
    const s = sample();
    const change = only(
      templateChanges(ANY, AGENT, s.users, { linkChecker: s.checker }),
      "record_kind_removed",
    );
    expect(change.removedCodes).toEqual([
      "object",
      "archival_unit",
      "digital_asset",
      "place",
      "event",
    ]);
    expect(change.recordIds).toEqual([s.byEvent.id]);
  });

  it("needs no confirmation when every link still fits", () => {
    const s = sample();
    const users = [s.byAgent, s.none];
    const result = templateChanges(AGENT_OR_EVENT, AGENT, users, { linkChecker: s.checker });
    const change = only(result, "record_kind_removed");
    expect(change.recordIds).toEqual([]);
    expect(change.needsConfirmation).toBe(false);
    expect(ok(result).needsConfirmation).toBe(false);
  });

  it("reports nothing when recordKinds widens or is dropped", () => {
    const s = sample();
    for (const [from, to] of [
      [AGENT, AGENT_OR_EVENT],
      [AGENT, ANY],
      [AGENT_OR_EVENT, linkTemplate({ recordKinds: ["event", "agent"] })],
    ] as const) {
      expect(ok(templateChanges(from, to, s.users, { linkChecker: s.checker })).changes).toEqual(
        [],
      );
    }
  });

  it("finds a misfit link inside a repeatable list", () => {
    const s = sample();
    const holder = withKey(
      record("object", "Album", {
        related: [
          { recordId: s.agent.id, label: "a" },
          { recordId: s.place.id, label: "b" },
        ],
      }),
    );
    const checker = ok(makeRecordLinkChecker([s.agent, s.place, holder]));
    const before = template(
      [field({ key: "related", kind: "record_link", repeatable: true })],
      "links",
    );
    const after = template(
      [field({ key: "related", kind: "record_link", repeatable: true, recordKinds: ["agent"] })],
      "links",
    );
    const change = only(
      templateChanges(before, after, [holder], { linkChecker: checker }),
      "record_kind_removed",
    );
    expect(change.recordIds).toEqual([holder.id]);
  });

  it("doesn't count a link to a record the checker doesn't hold", () => {
    const s = sample();
    const dangling = withKey(
      record("object", "Orphan", { creator: { recordId: newRecordId(), label: "gone" } }),
    );
    const result = templateChanges(AGENT_OR_EVENT, AGENT, [dangling], {
      linkChecker: s.checker,
    });
    expect(only(result, "record_kind_removed").recordCount).toBe(0);
  });

  it("without a checker lists every record holding a link, and needs confirmation", () => {
    const s = sample();
    const change = only(templateChanges(AGENT_OR_EVENT, AGENT, s.users), "record_kind_removed");
    expect([...change.recordIds].sort()).toEqual([s.byAgent.id, s.byEvent.id].sort());
    expect(change.needsConfirmation).toBe(true);
    expect(change.message).toContain("Linked records weren't checked");
    const empty = only(templateChanges(AGENT_OR_EVENT, AGENT, [s.none], {}), "record_kind_removed");
    expect(empty.needsConfirmation).toBe(false);
  });

  it("without records needs confirmation", () => {
    const s = sample();
    const result = templateChanges(AGENT_OR_EVENT, AGENT, undefined, { linkChecker: s.checker });
    const change = only(result, "record_kind_removed");
    expect(change.needsConfirmation).toBe(true);
    expect(ok(result).recordsChecked).toBe(false);
  });

  it("is not reported when the field changes kind (kind_changed covers it)", () => {
    const s = sample();
    const asPlace = template(
      [
        field({ key: "creator", kind: "place" }),
        field({ key: "related", kind: "record_link", repeatable: true }),
        field({ key: "where", kind: "place" }),
      ],
      "links",
    );
    const result = ok(templateChanges(AGENT, asPlace, s.users, { linkChecker: s.checker }));
    expect(result.changes.map((c) => c.code)).toEqual(["kind_changed"]);
  });
});

describe("record_kind_removed attacks", () => {
  it("refuses another organization's checker, naming nothing", () => {
    const s = sample();
    const other = newOrganizationId();
    const foreign = record("event", SECRET_TITLE, {}, { organizationId: other });
    const checker = ok(makeRecordLinkChecker([foreign]));
    const result = templateChanges(AGENT_OR_EVENT, AGENT, s.users, { linkChecker: checker });
    expect(codes(result)).toEqual(["wrong_organization_checker"]);
    const text = JSON.stringify(result);
    for (const leak of [other, ORG, foreign.id, SECRET_TITLE, "creator", "links"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("refuses another organization's checker even without records", () => {
    const foreign = record("agent", "X", {}, { organizationId: newOrganizationId() });
    const checker = ok(makeRecordLinkChecker([foreign]));
    expect(
      codes(templateChanges(AGENT_OR_EVENT, AGENT, undefined, { linkChecker: checker })),
    ).toEqual(["wrong_organization_checker"]);
  });

  it("refuses a hand-made checker or a Proxy of a real one", () => {
    const s = sample();
    const fake = () => [];
    const proxied = new Proxy(s.checker, {});
    for (const linkChecker of [fake, proxied, {}, "checker", null]) {
      expect(codes(templateChanges(AGENT_OR_EVENT, AGENT, s.users, { linkChecker }))).toEqual([
        "not_a_link_checker",
      ]);
    }
  });

  it("never runs a getter on the options, and refuses Proxy or odd options", () => {
    const s = sample();
    let ran = false;
    const getter = Object.defineProperty({}, "linkChecker", {
      enumerable: true,
      get() {
        ran = true;
        return s.checker;
      },
    });
    expect(codes(templateChanges(AGENT_OR_EVENT, AGENT, s.users, getter))).toEqual([
      "invalid_options",
    ]);
    expect(ran).toBe(false);
    const trap = new Proxy(
      { linkChecker: s.checker },
      {
        get() {
          ran = true;
          return s.checker;
        },
        getOwnPropertyDescriptor() {
          ran = true;
          return undefined;
        },
        getPrototypeOf() {
          ran = true;
          return Object.prototype;
        },
      },
    );
    expect(codes(templateChanges(AGENT_OR_EVENT, AGENT, s.users, trap))).toEqual([
      "invalid_options",
    ]);
    expect(ran).toBe(false);
    for (const odd of [[], "x", 1, new Map()]) {
      expect(
        codes(templateChanges(AGENT_OR_EVENT, AGENT, s.users, odd as unknown as object)),
      ).toEqual(["invalid_options"]);
    }
  });

  it("ignores an inherited linkChecker", () => {
    const s = sample();
    const inherited = Object.create({ linkChecker: () => [] }) as object;
    // Not a plain object (its prototype isn't Object.prototype), so refused.
    expect(codes(templateChanges(AGENT_OR_EVENT, AGENT, s.users, inherited))).toEqual([
      "invalid_options",
    ]);
  });

  it("never quotes a linked record's title or a link's label", () => {
    const s = sample();
    const text = JSON.stringify(
      templateChanges(AGENT_OR_EVENT, AGENT, s.users, { linkChecker: s.checker }),
    );
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain(SECRET_LABEL);
    expect(text).not.toContain(s.event.id);
  });

  it("lists at most MAX_LISTED_RECORDS records and counts them all", () => {
    const event = record("event", "Storm", {});
    const many: CatalogRecord[] = [];
    for (let i = 0; i <= MAX_LISTED_RECORDS; i += 1) {
      many.push(
        withKey(record("object", "Item", { creator: { recordId: event.id, label: "Storm" } })),
      );
    }
    const checker = ok(makeRecordLinkChecker([event, ...many]));
    const change = only(
      templateChanges(AGENT_OR_EVENT, AGENT, many, { linkChecker: checker }),
      "record_kind_removed",
    );
    expect(change.recordIds).toHaveLength(MAX_LISTED_RECORDS);
    expect(change.recordCount).toBe(MAX_LISTED_RECORDS + 1);
  });
});
