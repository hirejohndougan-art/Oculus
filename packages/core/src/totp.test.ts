// TOTP and HOTP against the RFCs' own test vectors, the drift window and its
// edges, no replay, base32, the otpauth link and recovery codes (T-038,
// D-052, D-077). The secret "12345678901234567890" is RFC 4226's and RFC
// 6238's published test key, not a real one.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RECOVERY_CODE_COUNT,
  SECOND_STEP_THROTTLE,
  decodeBase32,
  encodeBase32,
  formatRecoveryCode,
  hashRecoveryCode,
  hotp,
  isCanonicalRecoveryCode,
  matchTotpStep,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  normalizeTotpCode,
  otpauthUri,
  totpAt,
  totpStep,
} from "./totp.js";
import { throttleAttempt, throttleDelaySeconds } from "./sign-in-throttle.js";

const RFC_KEY = new Uint8Array(Buffer.from("12345678901234567890", "ascii"));

describe("HOTP (RFC 4226 Appendix D)", () => {
  it("gives the published 6-digit values for counts 0 to 9", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expect(expected.map((_, i) => hotp(RFC_KEY, BigInt(i)))).toEqual(expected);
  });

  it("refuses short keys, bad counters and digit counts", () => {
    expect(() => hotp(RFC_KEY.subarray(0, 15), 0n)).toThrow(TypeError);
    expect(() => hotp(RFC_KEY, -1n)).toThrow(TypeError);
    expect(() => hotp(RFC_KEY, 1n << 64n)).toThrow(TypeError);
    expect(() => hotp(RFC_KEY, 0n, 5)).toThrow(TypeError);
    expect(() => hotp(RFC_KEY, 0n, 9)).toThrow(TypeError);
    expect(hotp(RFC_KEY, (1n << 64n) - 1n)).toMatch(/^\d{6}$/);
  });
});

describe("TOTP (RFC 6238 Appendix B, SHA-1)", () => {
  it("gives the published 8-digit values, including steps past 2038 and 32 bits", () => {
    const vectors: [number, string, string][] = [
      [59, "0000000000000001", "94287082"],
      [1111111109, "00000000023523EC", "07081804"],
      [1111111111, "00000000023523ED", "14050471"],
      [1234567890, "000000000273EF07", "89005924"],
      [2000000000, "0000000003F940AA", "69279037"],
      [20000000000, "0000000027BC86AA", "65353130"],
    ];
    for (const [time, step, code] of vectors) {
      expect(totpStep(time)).toBe(BigInt(`0x${step}`));
      expect(totpAt(RFC_KEY, time, 8)).toBe(code);
    }
  });

  it("uses 30-second steps from the epoch (T = 1 at 59 s, 2 at 60 s)", () => {
    expect(totpStep(0)).toBe(0n);
    expect(totpStep(29.999)).toBe(0n);
    expect(totpStep(30)).toBe(1n);
    expect(totpStep(59)).toBe(1n);
    expect(totpStep(60)).toBe(2n);
    expect(() => totpStep(-1)).toThrow(TypeError);
    expect(() => totpStep(Number.NaN)).toThrow(TypeError);
  });
});

describe("matching a typed code", () => {
  const now = 1_111_111_111n;
  const at = (step: bigint) => hotp(RFC_KEY, step);

  it("accepts the current step and one either side, and nothing further", () => {
    expect(matchTotpStep(RFC_KEY, at(now), now, -1n)).toBe(now);
    expect(matchTotpStep(RFC_KEY, at(now - 1n), now, -1n)).toBe(now - 1n);
    expect(matchTotpStep(RFC_KEY, at(now + 1n), now, -1n)).toBe(now + 1n);
    for (const off of [-3n, -2n, 2n, 3n]) {
      const code = at(now + off);
      // Skip the (unlikely) step whose code equals one in the window.
      if ([at(now - 1n), at(now), at(now + 1n)].includes(code)) continue;
      expect(matchTotpStep(RFC_KEY, code, now, -1n)).toBeUndefined();
    }
  });

  it("never accepts a step at or before the last one used (no replay)", () => {
    expect(matchTotpStep(RFC_KEY, at(now), now, now)).toBeUndefined();
    expect(matchTotpStep(RFC_KEY, at(now - 1n), now, now - 1n)).toBeUndefined();
    expect(matchTotpStep(RFC_KEY, at(now + 1n), now, now)).toBe(now + 1n);
    expect(matchTotpStep(RFC_KEY, at(now), now, now + 1n)).toBeUndefined();
  });

  it("refuses wrong, malformed and empty codes", () => {
    const wrong = String((Number(at(now)) + 1) % 1_000_000).padStart(6, "0");
    expect(matchTotpStep(RFC_KEY, wrong, now, -1n)).toBeUndefined();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5"]) {
      expect(matchTotpStep(RFC_KEY, bad, now, -1n)).toBeUndefined();
    }
  });

  it("skips steps before the epoch at step 0", () => {
    expect(matchTotpStep(RFC_KEY, hotp(RFC_KEY, 0n), 0n, -1n)).toBe(0n);
    expect(matchTotpStep(RFC_KEY, hotp(RFC_KEY, 1n), 0n, -1n)).toBe(1n);
  });

  it("normalizes typed codes", () => {
    expect(normalizeTotpCode("123 456")).toBe("123456");
    expect(normalizeTotpCode(" 123456 ")).toBe("123456");
    expect(normalizeTotpCode("12345")).toBeUndefined();
    expect(normalizeTotpCode("١٢٣٤٥٦")).toBeUndefined();
    expect(normalizeTotpCode(123456)).toBeUndefined();
    expect(normalizeTotpCode("1".repeat(21))).toBeUndefined();
  });
});

describe("base32 and the otpauth link", () => {
  it("encodes RFC 4648's test vectors (without padding) and decodes them back", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, encoded] of vectors) {
      expect(encodeBase32(new Uint8Array(Buffer.from(plain)))).toBe(encoded);
      expect(Buffer.from(decodeBase32(encoded) ?? []).toString()).toBe(plain);
    }
    expect(Buffer.from(decodeBase32("mzxw6ytboi======") ?? []).toString()).toBe("foobar");
    expect(decodeBase32("MZXW6YTBO1")).toBeUndefined();
    // Stray low bits are refused (one spelling).
    expect(decodeBase32("MZ")).toBeUndefined();
    expect(encodeBase32(RFC_KEY)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("makes a new 160-bit secret each time", () => {
    const a = newTotpSecret();
    const b = newTotpSecret();
    expect(a).toHaveLength(20);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("builds the otpauth link with the issuer, account and settings", () => {
    expect(otpauthUri(RFC_KEY, { issuer: "Oculus", account: "person@example.org" })).toBe(
      "otpauth://totp/Oculus:person%40example.org?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Oculus&algorithm=SHA1&digits=6&period=30",
    );
    expect(otpauthUri(RFC_KEY, { issuer: "Invented Society", account: "a b" })).toContain(
      "otpauth://totp/Invented%20Society:a%20b?",
    );
    for (const label of [
      { issuer: "A:B", account: "x" },
      { issuer: "", account: "x" },
      { issuer: "A", account: "" },
      { issuer: "A\n", account: "x" },
      { issuer: "A", account: "x\u0085" },
    ]) {
      expect(() => otpauthUri(RFC_KEY, label)).toThrow(TypeError);
    }
  });
});

describe("recovery codes", () => {
  it("are 24 Crockford base32 characters (120 bits) in six groups, all different", () => {
    const codes = Array.from({ length: 200 }, () => newRecoveryCode());
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
      expect(isCanonicalRecoveryCode(normalizeRecoveryCode(code))).toBe(true);
    }
    expect(new Set(codes).size).toBe(codes.length);
    expect(RECOVERY_CODE_COUNT).toBe(10);
  });

  it("are read forgivingly: case, spaces, dashes and Crockford's look-alikes", () => {
    const canonical = "0123456789ABCDEFGHJKMNPQ";
    expect(normalizeRecoveryCode(formatRecoveryCode(canonical))).toBe(canonical);
    expect(normalizeRecoveryCode("o123 4567 89ab cdef ghjk mnpq")).toBe(canonical);
    expect(normalizeRecoveryCode("Ol23-4567-89AB-CDEF-GHJK-MNPQ")).toBe("0123456789ABCDEFGHJKMNPQ");
    expect(normalizeRecoveryCode("i123-4567-89AB-CDEF-GHJK-MNPQ")).toBe("1123456789ABCDEFGHJKMNPQ");
    for (const bad of ["", "U123-4567-89AB-CDEF-GHJK-MNPQ", "0123-4567", 42, "x".repeat(65)]) {
      expect(normalizeRecoveryCode(bad)).toBeUndefined();
    }
  });

  it("are stored as SHA-256 of the canonical text, and only canonical text is hashed", () => {
    const canonical = "0123456789ABCDEFGHJKMNPQ";
    expect(Buffer.from(hashRecoveryCode(canonical))).toEqual(
      createHash("sha256").update(canonical).digest(),
    );
    expect(() => hashRecoveryCode("0123-4567-89AB-CDEF-GHJK-MNPQ")).toThrow(TypeError);
  });
});

describe("the code throttle", () => {
  it("allows 5 free wrong codes, then waits doubling to an hour, never forever", () => {
    expect(throttleDelaySeconds(SECOND_STEP_THROTTLE, 4)).toBe(0);
    expect(throttleDelaySeconds(SECOND_STEP_THROTTLE, 5)).toBe(1);
    expect(throttleDelaySeconds(SECOND_STEP_THROTTLE, 6)).toBe(2);
    expect(throttleDelaySeconds(SECOND_STEP_THROTTLE, 40)).toBe(3600);
    const t = 1_000_000_000_000;
    const d = throttleAttempt(SECOND_STEP_THROTTLE, { failures: 40, lastFailureAt: t }, t + 1000);
    expect(d).toEqual({ allowed: false, retryAfterSeconds: 3599 });
    expect(
      throttleAttempt(SECOND_STEP_THROTTLE, { failures: 40, lastFailureAt: t }, t + 3_600_000)
        .allowed,
    ).toBe(true);
  });
});
