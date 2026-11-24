// Session tokens, CSRF tokens, time limits and client labels (T-037, D-069).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_POLICY,
  MAX_CLIENT_LABEL_LENGTH,
  SECOND_STEP_SECONDS,
  SESSION_POLICY_BOUNDS,
  checkCsrfToken,
  clientLabel,
  csrfTokenFor,
  hashSessionToken,
  isRecentAuthenticationWindow,
  isSessionId,
  isSessionToken,
  newSessionId,
  newSessionToken,
  validateSessionPolicy,
} from "./sessions.js";

/** The other spellings base64url decoders accept for the same 32 bytes, or near it. */
function variants(token: string): string[] {
  const last = token.at(-1) ?? "A";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = alphabet.indexOf(last);
  // The last character carries 4 bits; the 2 low bits must be zero. Any of
  // the 3 neighbours decodes to the same bytes in Node.
  const sameBytes = [1, 2, 3].map((d) => token.slice(0, -1) + (alphabet[index + d] ?? "A"));
  const standard = Buffer.from(token, "base64url").toString("base64");
  return [
    ...sameBytes,
    `${token}=`,
    standard,
    standard.replace(/=+$/, ""),
    ` ${token}`,
    `${token} `,
    `${token}\n`,
    token.slice(0, -1),
    `${token}A`,
    token.replace(/^./, "%41"),
  ];
}

describe("session tokens", () => {
  it("are 256 random bits in one spelling, stored as SHA-256", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = newSessionToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(isSessionToken(token)).toBe(true);
      seen.add(token);
      const hash = hashSessionToken(token);
      expect(hash).toHaveLength(32);
      expect(Buffer.from(hash).toString("hex")).toBe(
        createHash("sha256").update(token).digest("hex"),
      );
    }
    expect(seen.size).toBe(200);
  });

  it("refuses every other spelling, including ones that decode to the same bytes", () => {
    for (let i = 0; i < 20; i++) {
      const token = newSessionToken();
      for (const v of variants(token)) {
        if (v === token) continue;
        expect({ v, ok: isSessionToken(v) }).toEqual({ v, ok: false });
      }
    }
    // A token whose last character has stray low bits decodes like the
    // canonical one, but is still refused.
    const canonical = "A".repeat(42) + "A";
    expect(isSessionToken(canonical)).toBe(true);
    expect(isSessionToken("A".repeat(42) + "B")).toBe(false);
    expect(Buffer.from("A".repeat(42) + "B", "base64url")).toEqual(
      Buffer.from(canonical, "base64url"),
    );
  });

  it("refuses anything that isn't a string", () => {
    const token = newSessionToken();
    // eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
    const boxed: String = new String(token);
    for (const v of [undefined, null, 1, {}, [token], boxed, { toString: () => token }]) {
      expect(isSessionToken(v)).toBe(false);
      expect(csrfTokenFor(v)).toBeUndefined();
    }
  });
});

describe("session IDs", () => {
  it("are version 4 UUIDs in lower case", () => {
    const id = newSessionId();
    expect(isSessionId(id)).toBe(true);
    expect(isSessionId(id.toUpperCase())).toBe(false);
    expect(isSessionId(newSessionToken())).toBe(false);
  });
});

describe("CSRF tokens", () => {
  it("follow the session token, change with it and can't be guessed from another", () => {
    const a = newSessionToken();
    const b = newSessionToken();
    const csrfA = csrfTokenFor(a);
    expect(csrfA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfTokenFor(a)).toBe(csrfA);
    expect(csrfTokenFor(b)).not.toBe(csrfA);
    expect(csrfA).not.toBe(a);
    expect(checkCsrfToken(a, csrfA)).toBe(true);
    expect(checkCsrfToken(b, csrfA)).toBe(false);
    // The session token itself is not its CSRF token.
    expect(checkCsrfToken(a, a)).toBe(false);
  });

  it("refuses malformed, missing or other spellings", () => {
    const a = newSessionToken();
    const csrf = csrfTokenFor(a) ?? "";
    for (const v of [...variants(csrf), undefined, "", 7, { toString: () => csrf }]) {
      expect(checkCsrfToken(a, v)).toBe(false);
    }
    expect(checkCsrfToken(`${a}=`, csrf)).toBe(false);
    expect(checkCsrfToken(undefined, csrf)).toBe(false);
  });
});

describe("session time limits", () => {
  it("default to 4 hours idle and 12 hours absolute (D-052), 10 minutes for the second step", () => {
    expect(DEFAULT_SESSION_POLICY).toEqual({ idleSeconds: 14_400, absoluteSeconds: 43_200 });
    expect(Object.isFrozen(DEFAULT_SESSION_POLICY)).toBe(true);
    expect(SECOND_STEP_SECONDS).toBe(600);
    expect(validateSessionPolicy({ ...DEFAULT_SESSION_POLICY })).toEqual(DEFAULT_SESSION_POLICY);
  });

  it("accept only whole seconds within the bounds, idle no longer than absolute", () => {
    const b = SESSION_POLICY_BOUNDS;
    const good = [
      { idleSeconds: b.minIdleSeconds, absoluteSeconds: b.minAbsoluteSeconds },
      { idleSeconds: b.maxIdleSeconds, absoluteSeconds: b.maxAbsoluteSeconds },
      { idleSeconds: 3600, absoluteSeconds: 3600 },
    ];
    for (const p of good) expect(validateSessionPolicy(p)).toEqual(p);
    const bad: unknown[] = [
      { idleSeconds: b.minIdleSeconds - 1, absoluteSeconds: 3600 },
      { idleSeconds: b.maxIdleSeconds + 1, absoluteSeconds: b.maxAbsoluteSeconds },
      { idleSeconds: 600, absoluteSeconds: b.minAbsoluteSeconds - 1 },
      { idleSeconds: 600, absoluteSeconds: b.maxAbsoluteSeconds + 1 },
      { idleSeconds: 7200, absoluteSeconds: 3600 },
      { idleSeconds: 600.5, absoluteSeconds: 3600 },
      { idleSeconds: "600", absoluteSeconds: 3600 },
      { idleSeconds: 600 },
      { idleSeconds: 600, absoluteSeconds: 3600, extra: 1 },
      Object.defineProperty({ absoluteSeconds: 3600 }, "idleSeconds", {
        get: () => 600,
        enumerable: true,
      }),
      Object.assign(Object.create({ idleSeconds: 600 }) as object, { absoluteSeconds: 3600 }),
      [600, 3600],
      null,
      undefined,
    ];
    for (const p of bad) expect(validateSessionPolicy(p)).toBeUndefined();
  });

  it("allow a recent-authentication window of 1 minute to 1 hour", () => {
    expect(isRecentAuthenticationWindow(60)).toBe(true);
    expect(isRecentAuthenticationWindow(3600)).toBe(true);
    for (const v of [59, 3601, 600.5, "600", undefined]) {
      expect(isRecentAuthenticationWindow(v)).toBe(false);
    }
  });
});

describe("client labels", () => {
  it("are trimmed, cut to 200 characters and refused with control or direction characters", () => {
    expect(clientLabel("  Firefox on Linux  ")).toBe("Firefox on Linux");
    expect(clientLabel("é".repeat(500))).toBe("é".repeat(MAX_CLIENT_LABEL_LENGTH));
    expect(clientLabel("😀".repeat(300))).toBe("😀".repeat(MAX_CLIENT_LABEL_LENGTH));
    expect(clientLabel("x".repeat(10_000_000))).toHaveLength(MAX_CLIENT_LABEL_LENGTH);
    for (const v of ["", "   ", "a\nb", "a\u0000b", "a\u202eb", "a\u2028b", "a\ud800b", 5, null]) {
      expect(clientLabel(v)).toBeUndefined();
    }
  });
});
