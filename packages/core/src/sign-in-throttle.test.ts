// Sign-in throttling rules and counter keys (sign-in-throttle.ts, D-068).
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_THROTTLE,
  OTHER_SOURCE_KEY,
  SOURCE_THROTTLE,
  decideSignInAttempt,
  throttleAccountKey,
  throttleReauthKey,
  throttleAttempt,
  throttleDelaySeconds,
  throttleSourceKey,
  type ThrottleState,
} from "./sign-in-throttle.js";

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);

/** Runs `n` attempts at time `at`, each let through or not, returning the final state. */
function fail(n: number, at: number, start?: ThrottleState): ThrottleState | undefined {
  let state = start;
  for (let i = 0; i < n; i++) {
    const d = throttleAttempt(ACCOUNT_THROTTLE, state, at);
    if (!d.allowed) return state;
    state = d.next;
  }
  return state;
}

describe("throttleDelaySeconds", () => {
  it("is free, then doubles, then stops at the longest wait", () => {
    const delays = Array.from({ length: 20 }, (_, n) => throttleDelaySeconds(ACCOUNT_THROTTLE, n));
    expect(delays.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(delays.slice(5, 10)).toEqual([1, 2, 4, 8, 16]);
    expect(Math.max(...delays)).toBe(900);
    expect(throttleDelaySeconds(ACCOUNT_THROTTLE, 1_000_000)).toBe(900);
    expect(throttleDelaySeconds(SOURCE_THROTTLE, 19)).toBe(0);
    expect(throttleDelaySeconds(SOURCE_THROTTLE, 20)).toBe(1);
  });
});

describe("throttleAttempt", () => {
  it("lets five attempts through, then makes the sixth wait", () => {
    const five = fail(5, T0);
    expect(five).toEqual({ failures: 5, lastFailureAt: T0 });
    expect(throttleAttempt(ACCOUNT_THROTTLE, five, T0)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(throttleAttempt(ACCOUNT_THROTTLE, five, T0 + 999).allowed).toBe(false);
    expect(throttleAttempt(ACCOUNT_THROTTLE, five, T0 + 1000)).toEqual({
      allowed: true,
      next: { failures: 6, lastFailureAt: T0 + 1000 },
    });
  });

  it("never counts a refused attempt, so the wait doesn't grow while someone keeps trying", () => {
    const state: ThrottleState = { failures: 9, lastFailureAt: T0 };
    // delay(9) = 16 s. Hammering every 100 ms changes nothing.
    for (let t = T0; t < T0 + 16_000; t += 100) {
      const d = throttleAttempt(ACCOUNT_THROTTLE, state, t);
      expect(d.allowed).toBe(false);
    }
    expect(throttleAttempt(ACCOUNT_THROTTLE, state, T0 + 16_000).allowed).toBe(true);
  });

  it("keeps nobody out for longer than the longest wait after the last counted attempt", () => {
    const state: ThrottleState = { failures: 500, lastFailureAt: T0 };
    const d = throttleAttempt(ACCOUNT_THROTTLE, state, T0);
    expect(d).toEqual({ allowed: false, retryAfterSeconds: 900 });
    expect(throttleAttempt(ACCOUNT_THROTTLE, state, T0 + 900_000).allowed).toBe(true);
  });

  it("forgets a counter after the reset time with no failure", () => {
    const state: ThrottleState = { failures: 40, lastFailureAt: T0 };
    const d = throttleAttempt(ACCOUNT_THROTTLE, state, T0 + 24 * 3600 * 1000);
    expect(d).toEqual({ allowed: true, next: { failures: 1, lastFailureAt: T0 + 86_400_000 } });
    const s = throttleAttempt(SOURCE_THROTTLE, state, T0 + 3600 * 1000);
    expect(s).toEqual({ allowed: true, next: { failures: 1, lastFailureAt: T0 + 3_600_000 } });
  });

  it("starts again if the clock went back far, and waits if it went back a little", () => {
    const state: ThrottleState = { failures: 20, lastFailureAt: T0 };
    expect(throttleAttempt(ACCOUNT_THROTTLE, state, T0 - 120_000)).toEqual({
      allowed: true,
      next: { failures: 1, lastFailureAt: T0 - 120_000 },
    });
    expect(throttleAttempt(ACCOUNT_THROTTLE, state, T0 - 1000)).toEqual({
      allowed: false,
      retryAfterSeconds: 900,
    });
  });

  it("treats no counter and a zero counter alike", () => {
    expect(throttleAttempt(ACCOUNT_THROTTLE, undefined, T0)).toEqual({
      allowed: true,
      next: { failures: 1, lastFailureAt: T0 },
    });
    expect(throttleAttempt(ACCOUNT_THROTTLE, { failures: 0, lastFailureAt: null }, T0)).toEqual({
      allowed: true,
      next: { failures: 1, lastFailureAt: T0 },
    });
  });
});

describe("throttleAccountKey", () => {
  it("hashes what was typed, ignoring case, so addresses are never stored", () => {
    const k = throttleAccountKey("Pat.Example@Example.ORG");
    expect(k).toMatch(/^account:[0-9a-f]{64}$/);
    expect(k).toBe(throttleAccountKey("pat.example@example.org"));
    expect(k).not.toContain("example");
    expect(throttleAccountKey("not an address")).toMatch(/^account:[0-9a-f]{64}$/);
    expect(throttleAccountKey("a@example.org")).not.toBe(throttleAccountKey("b@example.org"));
  });
});

describe("throttleSourceKey", () => {
  it("counts IPv4 per address", () => {
    expect(throttleSourceKey("192.0.2.1")).toBe("source:v4:192.0.2.1");
    expect(throttleSourceKey("198.51.100.255")).toBe("source:v4:198.51.100.255");
  });

  it("counts IPv6 per /64, however it is written", () => {
    const k = "source:v6:2001:db8:0:1::/64";
    expect(throttleSourceKey("2001:db8:0:1::1")).toBe(k);
    expect(throttleSourceKey("2001:0db8:0000:0001:ffff:ffff:ffff:ffff")).toBe(k);
    expect(throttleSourceKey("2001:DB8:0:1:a:b:c:d")).toBe(k);
    expect(throttleSourceKey("2001:db8:0:1::1%eth0")).toBe(k);
    expect(throttleSourceKey("2001:db8:0:2::1")).toBe("source:v6:2001:db8:0:2::/64");
    expect(throttleSourceKey("::1")).toBe("source:v6:0:0:0:0::/64");
    expect(throttleSourceKey("fe80::1:2:3:4")).toBe("source:v6:fe80:0:0:0::/64");
    expect(throttleSourceKey("64:ff9b::192.0.2.1")).toBe("source:v6:64:ff9b:0:0::/64");
  });

  it("counts IPv4 written as IPv6 as the IPv4 address", () => {
    expect(throttleSourceKey("::ffff:192.0.2.1")).toBe("source:v4:192.0.2.1");
    expect(throttleSourceKey("::ffff:c000:201")).toBe("source:v4:192.0.2.1");
    expect(throttleSourceKey("0:0:0:0:0:ffff:192.0.2.1")).toBe("source:v4:192.0.2.1");
  });

  it("shares one bucket for the edge cases D-068 lists for T-037 and T-045", () => {
    const zero = "source:v6:0:0:0:0::/64";
    expect(throttleSourceKey("::1")).toBe(zero);
    expect(throttleSourceKey("::192.0.2.1")).toBe(zero);
    expect(throttleSourceKey("::198.51.100.7")).toBe(zero);
    const nat64 = "source:v6:64:ff9b:0:0::/64";
    expect(throttleSourceKey("64:ff9b::192.0.2.1")).toBe(nat64);
    expect(throttleSourceKey("64:ff9b::203.0.113.9")).toBe(nat64);
  });

  it("puts anything it can't read in one shared counter", () => {
    for (const bad of [
      "",
      "localhost",
      "192.0.2",
      "192.0.2.1.5",
      "1:2:3:4:5:6:7:8:9",
      "1::2::3",
      "12345::1",
      "x".repeat(200),
      undefined,
      42,
      null,
    ]) {
      expect(throttleSourceKey(bad)).toBe(OTHER_SOURCE_KEY);
    }
  });

  it("only makes keys the database's check accepts", () => {
    const check =
      /^((reset:)?(account:[0-9a-f]{64}|source:v4:[0-9.]{7,15}|source:v6:[0-9a-f:]{7,39}::\/64|source:other)|reauth:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
    for (const a of [
      "192.0.2.1",
      "255.255.255.255",
      "::1",
      "::",
      "ffff:ffff:ffff:ffff::",
      "2001:db8::",
      "::ffff:0.0.0.0",
      "junk",
    ]) {
      expect(throttleSourceKey(a)).toMatch(check);
    }
    expect(throttleAccountKey("x")).toMatch(check);
    expect(throttleReauthKey("0B0E7F3C-1D2A-4B5C-8D6E-7F8091A2B3C4")).toMatch(check);
  });
});

describe("decideSignInAttempt (S-018: strangers can't keep a person out at a known address)", () => {
  const waiting: ThrottleState = { failures: 400, lastFailureAt: T0 };

  it("keeps the account's wait for an address that isn't known, counting nothing", () => {
    expect(
      decideSignInAttempt(
        { account: waiting, source: undefined, known: undefined, isKnown: false },
        T0 + 60_000,
      ),
    ).toEqual({ allowed: false, retryAfterSeconds: 840 });
  });

  it("lets a known address through the account's wait, counting every counter", () => {
    const d = decideSignInAttempt(
      { account: waiting, source: undefined, known: undefined, isKnown: true },
      T0 + 60_000,
    );
    expect(d).toEqual({
      allowed: true,
      account: { failures: 401, lastFailureAt: T0 + 60_000 },
      source: { failures: 1, lastFailureAt: T0 + 60_000 },
      known: { failures: 1, lastFailureAt: T0 + 60_000 },
    });
  });

  it("gives a known address only the account rule's guesses, then its own wait", () => {
    let known: ThrottleState | undefined;
    let account: ThrottleState | undefined = waiting;
    const tally: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = decideSignInAttempt({ account, source: undefined, known, isKnown: true }, T0 + 1);
      tally.push(d.allowed ? "checked" : `wait ${String(d.retryAfterSeconds)}`);
      if (d.allowed) ({ known, account } = d);
    }
    expect(tally).toEqual([...Array<string>(5).fill("checked"), "wait 1", "wait 1"]);
  });

  it("keeps the address counter for everyone, known or not", () => {
    const busy: ThrottleState = { failures: 25, lastFailureAt: T0 };
    expect(
      decideSignInAttempt(
        { account: undefined, source: busy, known: undefined, isKnown: true },
        T0,
      ),
    ).toEqual({ allowed: false, retryAfterSeconds: 32 });
  });

  it("answers the shorter of the account's and the known address's waits", () => {
    const d = decideSignInAttempt(
      {
        account: waiting,
        source: undefined,
        known: { failures: 6, lastFailureAt: T0 },
        isKnown: true,
      },
      T0,
    );
    expect(d).toEqual({ allowed: false, retryAfterSeconds: 2 });
  });
});

describe("throttleReauthKey", () => {
  it("is per user and can't be an account or address key", () => {
    const id = "0b0e7f3c-1d2a-4b5c-8d6e-7f8091a2b3c4";
    expect(throttleReauthKey(id)).toBe(`reauth:${id}`);
    expect(throttleReauthKey(id)).not.toBe(throttleAccountKey(`reauth:${id}`));
  });
});
