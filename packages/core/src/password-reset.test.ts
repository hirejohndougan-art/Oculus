// Password reset tokens, lives and throttle rules (password-reset.ts, D-078).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESET_SECONDS,
  RESET_ACCOUNT_THROTTLE,
  RESET_LIFE_BOUNDS,
  RESET_SOURCE_THROTTLE,
  hashResetToken,
  isResetLife,
  isResetToken,
  newResetToken,
  resetThrottleAccountKey,
  resetThrottleNetworkKey,
  resetThrottleSourceKey,
} from "./password-reset.js";
import {
  throttleAccountKey,
  throttleAttempt,
  throttleDelaySeconds,
  throttleSourceKey,
} from "./sign-in-throttle.js";

describe("reset tokens", () => {
  it("are 256 random bits in one spelling, different every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newResetToken()));
    expect(tokens.size).toBe(50);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isResetToken(t)).toBe(true);
      expect(Buffer.from(t, "base64url")).toHaveLength(32);
    }
  });

  it("refuse every other spelling of a real token", () => {
    const t = newResetToken();
    const bytes = Buffer.from(t, "base64url");
    const last = t.charCodeAt(42);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(String.fromCharCode(last));
    // The same bytes with a stray low bit in the last character.
    const stray = t.slice(0, 42) + (alphabet[index ^ 1] ?? "A");
    for (const other of [
      `${t}=`,
      bytes.toString("base64"),
      ` ${t}`,
      `${t} `,
      t.slice(0, 42),
      `${t}A`,
      stray,
      42,
      null,
      {},
    ]) {
      expect(isResetToken(other)).toBe(false);
    }
  });

  it("are stored as their SHA-256 only", () => {
    const t = newResetToken();
    const h = hashResetToken(t);
    expect(h).toHaveLength(32);
    expect(Buffer.from(h).toString("hex")).not.toContain(Buffer.from(t).toString("hex"));
    expect(hashResetToken(t)).toEqual(h);
    expect(hashResetToken(newResetToken())).not.toEqual(h);
  });
});

describe("reset lives", () => {
  it("are 30 minutes by default, 5 to 60 minutes if chosen, whole seconds", () => {
    expect(DEFAULT_RESET_SECONDS).toBe(1800);
    expect(RESET_LIFE_BOUNDS).toEqual({ min: 300, max: 3600 });
    for (const ok of [300, 1800, 3600]) expect(isResetLife(ok)).toBe(true);
    for (const bad of [299, 3601, 600.5, "600", Number.NaN, Infinity, undefined]) {
      expect(isResetLife(bad)).toBe(false);
    }
  });
});

describe("reset throttles", () => {
  it("have keys of their own, beside the sign-in keys", () => {
    expect(resetThrottleAccountKey("Someone@Example.org")).toBe(
      `reset:${throttleAccountKey("someone@example.org")}`,
    );
    expect(resetThrottleSourceKey("192.0.2.7")).toBe(`reset:${throttleSourceKey("192.0.2.7")}`);
    expect(resetThrottleSourceKey("2001:db8::1")).toBe("reset:source:v6:2001:db8:0:0::/64");
    expect(resetThrottleSourceKey("not an address")).toBe("reset:source:other");
  });

  it("count IPv6 clients per /48 too, and nothing else per network", () => {
    expect(resetThrottleNetworkKey("2001:db8:1:2:3:4:5:6")).toBe("reset:source:v6:2001:db8:1::/48");
    expect(resetThrottleNetworkKey("2001:db8:1:ffff::1")).toBe("reset:source:v6:2001:db8:1::/48");
    expect(resetThrottleNetworkKey("2001:db8::1")).toBe("reset:source:v6:2001:db8:0::/48");
    expect(resetThrottleNetworkKey("2001:DB8:1::1%eth0")).toBe("reset:source:v6:2001:db8:1::/48");
    for (const other of ["192.0.2.7", "::ffff:192.0.2.7", "not an address", 42, undefined]) {
      expect(resetThrottleNetworkKey(other)).toBeUndefined();
    }
  });

  it("let 3 requests for an address and 10 from a client through, then wait up to an hour", () => {
    expect(throttleDelaySeconds(RESET_ACCOUNT_THROTTLE, 2)).toBe(0);
    expect(throttleDelaySeconds(RESET_ACCOUNT_THROTTLE, 3)).toBe(60);
    expect(throttleDelaySeconds(RESET_ACCOUNT_THROTTLE, 100)).toBe(3600);
    expect(throttleDelaySeconds(RESET_SOURCE_THROTTLE, 9)).toBe(0);
    expect(throttleDelaySeconds(RESET_SOURCE_THROTTLE, 10)).toBe(30);
    expect(throttleDelaySeconds(RESET_SOURCE_THROTTLE, 100)).toBe(3600);
    const t0 = Date.UTC(2026, 10, 24, 12);
    let state;
    for (let i = 0; i < 3; i++) {
      const d = throttleAttempt(RESET_ACCOUNT_THROTTLE, state, t0);
      if (!d.allowed) throw new Error("refused early");
      state = d.next;
    }
    expect(throttleAttempt(RESET_ACCOUNT_THROTTLE, state, t0)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect(throttleAttempt(RESET_ACCOUNT_THROTTLE, state, t0 + 60_000).allowed).toBe(true);
    // Forgotten after a day.
    expect(throttleAttempt(RESET_ACCOUNT_THROTTLE, state, t0 + 86_400_000)).toMatchObject({
      allowed: true,
      next: { failures: 1 },
    });
  });
});
