// Hostile input for the rights module. Each test tries one attack; each must
// be refused or neutralized, and nothing may throw.
import { describe, expect, it } from "vitest";
import {
  MAX_RIGHTS_TEXT_LENGTH,
  canPublishRights,
  normalizeRightsUri,
  rightsPublishIssues,
  rightsTerm,
  validateRightsUri,
} from "./index.js";

const INC = "http://rightsstatements.org/vocab/InC/1.0/";

const codeOf = (r: { ok: boolean; issues?: readonly { code: string }[] }): string | undefined =>
  r.ok ? undefined : r.issues?.[0]?.code;

describe("the publishing rule can't be fooled", () => {
  it("ignores a rights value inherited from Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    proto.rights = INC;
    try {
      expect(canPublishRights({ fields: {} })).toBe(false);
      expect(rightsPublishIssues({ fields: {} })[0]?.code).toBe("rights_missing");
    } finally {
      delete proto.rights;
    }
  });

  it("ignores fields inherited from a prototype", () => {
    const record: unknown = Object.create({ fields: { rights: INC } });
    expect(canPublishRights(record)).toBe(false);
  });

  it("refuses a Proxy record or Proxy fields that would claim a valid value", () => {
    const fields = new Proxy({ rights: INC }, {});
    expect(rightsPublishIssues({ fields })[0]?.code).toBe("unreadable");
    expect(rightsPublishIssues(new Proxy({ fields: { rights: INC } }, {}))[0]?.code).toBe(
      "unreadable",
    );
  });

  it("does not run a getter, and reports it as unreadable", () => {
    let calls = 0;
    const fields = {};
    Object.defineProperty(fields, "rights", {
      enumerable: true,
      get() {
        calls += 1;
        return INC;
      },
    });
    expect(rightsPublishIssues({ fields })[0]?.code).toBe("unreadable");
    expect(calls).toBe(0);
  });

  it("refuses a hidden (non-enumerable) rights value that JSON output would drop", () => {
    const fields = {};
    Object.defineProperty(fields, "rights", { value: INC, enumerable: false });
    const record = { kind: "object", fields };
    expect(JSON.stringify(record)).not.toContain("rightsstatements");
    expect(rightsPublishIssues(record)[0]?.code).toBe("unreadable");
    expect(canPublishRights(record)).toBe(false);
  });

  it("refuses hidden fields, and a hidden or getter kind claiming an exempt kind", () => {
    const hiddenFields = { kind: "object" };
    Object.defineProperty(hiddenFields, "fields", { value: { rights: INC }, enumerable: false });
    expect(canPublishRights(hiddenFields)).toBe(false);

    const hiddenKind = { fields: {} };
    Object.defineProperty(hiddenKind, "kind", { value: "agent", enumerable: false });
    expect(canPublishRights(hiddenKind)).toBe(false);

    const getterKind = { fields: {} };
    Object.defineProperty(getterKind, "kind", { enumerable: true, get: () => "agent" });
    expect(canPublishRights(getterKind)).toBe(false);
  });

  it("ignores an exempt kind inherited from a prototype", () => {
    const record: unknown = Object.assign(Object.create({ kind: "agent" }) as object, {
      fields: {},
    });
    expect(canPublishRights(record)).toBe(false);
  });

  it("refuses a Proxy whose trap throws, without throwing", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    expect(() => rightsPublishIssues(hostile)).not.toThrow();
    expect(canPublishRights(hostile)).toBe(false);
  });

  it("refuses a String object that looks like a URI", () => {
    const boxed = new String(INC);
    expect(rightsTerm(boxed)).toBeUndefined();
    expect(canPublishRights({ fields: { rights: boxed } })).toBe(false);
  });

  it("does not treat prototype names as statement codes", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(rightsTerm(name)).toBeUndefined();
      expect(codeOf(normalizeRightsUri(`http://rightsstatements.org/vocab/${name}/1.0/`))).toBe(
        "unknown_rights",
      );
      expect(codeOf(normalizeRightsUri(`https://creativecommons.org/licenses/${name}/4.0/`))).toBe(
        "unknown_rights",
      );
    }
  });
});

describe("the normalizer refuses hostile text", () => {
  it("refuses text over the length limit before reading it", () => {
    const long = `${INC}?${"a".repeat(MAX_RIGHTS_TEXT_LENGTH)}`;
    expect(codeOf(normalizeRightsUri(long))).toBe("too_long");
    expect(codeOf(validateRightsUri(long))).toBe("too_long");
  });

  it("finishes quickly on worst-case text at the limit", () => {
    const inputs = [
      `http://${"a.".repeat(240)}`,
      `https://creativecommons.org/${"/".repeat(470)}`,
      `https://creativecommons.org/licenses/by/4.0/deed${".aa-bb".repeat(75)}`,
      `http://rightsstatements.org/vocab/InC/1.0/?${"#".repeat(450)}`,
    ];
    const start = performance.now();
    for (const text of inputs) {
      expect(text.length).toBeLessThanOrEqual(MAX_RIGHTS_TEXT_LENGTH);
      normalizeRightsUri(text);
    }
    expect(performance.now() - start).toBeLessThan(200);
  });

  it.each([
    ["a direction override", "http://rightsstatements.org/vocab/InC\u202e/1.0/"],
    ["a zero-width space", "http://rightsstatements.org/vocab/In\u200bC/1.0/"],
    ["a NUL", `${INC}\u0000`],
    ["a lone surrogate", `${INC}\ud800`],
  ])("refuses %s", (_name, text) => {
    expect(codeOf(normalizeRightsUri(text))).toBe("bad_characters");
  });

  it("refuses look-alike hosts and lookalike letters", () => {
    for (const text of [
      "http://rightsstatements.org.evil.example/vocab/InC/1.0/",
      "http://evil.example/rightsstatements.org/vocab/InC/1.0/",
      "http://rightsstatements.org@evil.example/vocab/InC/1.0/",
      "http://r\u0456ghtsstatements.org/vocab/InC/1.0/", // Cyrillic i
      "http://xn--rghtsstatements-xyz.org/vocab/InC/1.0/",
      "javascript://rightsstatements.org/vocab/InC/1.0/",
      "//rightsstatements.org/vocab/InC/1.0/",
      "http://rightsstatements.org/vocab/InC/1.0/../../InC/1.0/",
      "http://rightsstatements.org/vocab/InC/1.0/%2e%2e/",
      "http://rightsstatements.org/vocab/%49nC/1.0/",
    ]) {
      expect(codeOf(normalizeRightsUri(text)), text).toMatch(
        /^(unknown_rights|unsupported_version)$/,
      );
    }
  });

  it("escapes hostile text echoed in messages", () => {
    const r = normalizeRightsUri("<script>alert(1)</script>\u2028x");
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : (r.issues[0]?.message ?? "");
    expect(message).toContain("\\u2028");
    expect(message).not.toContain("\u2028");
  });

  it("shortens long text echoed in messages", () => {
    const r = normalizeRightsUri(`not a uri ${"x".repeat(400)}`);
    const message = r.ok ? "" : (r.issues[0]?.message ?? "");
    expect(message.length).toBeLessThan(200);
  });
});
