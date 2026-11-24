// User and invitation helpers (accounts.ts, D-068). Addresses are invented
// (example.org and example.com are reserved for examples, RFC 2606).
import { describe, expect, it } from "vitest";
import {
  hashInvitationToken,
  isInvitationId,
  isInvitationToken,
  isUserId,
  newInvitationId,
  newInvitationToken,
  newUserId,
  normalizeEmail,
  validateDisplayName,
} from "./accounts.js";

describe("normalizeEmail", () => {
  it("lower-cases addresses Oculus accepts", () => {
    expect(normalizeEmail("Pat.Example@Example.ORG")).toBe("pat.example@example.org");
    expect(normalizeEmail("a+tag@mail.example.com")).toBe("a+tag@mail.example.com");
    expect(normalizeEmail("o'brien@example.org")).toBe("o'brien@example.org");
  });

  it("refuses what isn't an address it accepts", () => {
    for (const bad of [
      "",
      "plain",
      "@example.org",
      "pat@",
      "pat@example",
      "pat@@example.org",
      "pat@ex@ample.org",
      " pat@example.org",
      "pat@example.org ",
      "pat example@example.org",
      "pat@exa mple.org",
      '"pat"@example.org',
      "pat<@example.org",
      ".pat@example.org",
      "pat.@example.org",
      "pa..t@example.org",
      "pat@-example.org",
      "pat@example-.org",
      "pat@example..org",
      "pät@example.org",
      "pat@exämple.org",
      "pat@example.org\n",
      `${"a".repeat(65)}@example.org`,
      `pat@${"a".repeat(250)}.org`,
      undefined,
      42,
    ]) {
      expect(normalizeEmail(bad)).toBeUndefined();
    }
    expect(normalizeEmail(`${"a".repeat(64)}@example.org`)).toBe(`${"a".repeat(64)}@example.org`);
  });
});

describe("validateDisplayName", () => {
  it("accepts ordinary names unchanged and refuses tricks", () => {
    expect(validateDisplayName("Pat Example")).toBe("Pat Example");
    expect(validateDisplayName("Zoë O’Neill-Ávila")).toBe("Zoë O’Neill-Ávila");
    for (const bad of [
      "",
      " Pat",
      "Pat ",
      "Pat\nExample",
      "Pat Example",
      "Pat‮elpmaxE",
      "Pat\u0000",
      "x".repeat(201),
      undefined,
      7,
    ]) {
      expect(validateDisplayName(bad)).toBeUndefined();
    }
  });
});

describe("IDs and invitation tokens", () => {
  it("makes version 4 UUIDs", () => {
    expect(isUserId(newUserId())).toBe(true);
    expect(isInvitationId(newInvitationId())).toBe(true);
    expect(isUserId("3F1C2A9E-8B7D-4C6E-9A1B-2D3E4F5A6B7C")).toBe(false);
    expect(isUserId("not a uuid")).toBe(false);
  });

  it("makes 256-bit base64url tokens, all different", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newInvitationToken()));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isInvitationToken(t)).toBe(true);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
    }
  });

  it("accepts a token in one spelling only", () => {
    const t = newInvitationToken();
    // The last character holds 4 bits; flipping a low bit is another
    // spelling of different bytes or of none.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(t.slice(-1));
    const other = `${t.slice(0, -1)}${alphabet[last ^ 1] ?? "A"}`;
    expect(isInvitationToken(other)).toBe(false);
    expect(isInvitationToken(`${t}=`)).toBe(false);
    expect(isInvitationToken(t.slice(1))).toBe(false);
    expect(isInvitationToken(t.replace(/^./, "+"))).toBe(false);
    expect(isInvitationToken(42)).toBe(false);
  });

  it("stores a token as its SHA-256", () => {
    const t = newInvitationToken();
    const h = hashInvitationToken(t);
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h).toHaveLength(32);
    expect(Buffer.from(h).equals(Buffer.from(hashInvitationToken(t)))).toBe(true);
    expect(Buffer.from(h).equals(Buffer.from(hashInvitationToken(newInvitationToken())))).toBe(
      false,
    );
  });
});
