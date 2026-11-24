/**
 * Sign-in throttling rules (T-036, D-052, D-068; OWASP ASVS 5.0 6.1.1,
 * 6.3.1). Pure: `packages/db` keeps the counters and asks `throttleAttempt`.
 *
 * Two counters are checked before any password is: one for the account
 * (keyed by the email address typed, whether or not an account has it, so
 * the throttle itself says nothing about which addresses exist) and one for
 * the client's address. Each attempt that is let through counts as a
 * failure up front, so many attempts sent at once are all counted; a
 * correct password then clears the account's counter and takes one off the
 * address's.
 *
 * After `free` failures each further failure brings a wait before the next
 * attempt, doubling from `baseSeconds` up to `maxSeconds`. An attempt made
 * during the wait is refused without checking the password and **is not
 * counted**, so the wait never grows while someone keeps trying: the
 * longest anyone can be kept out is `maxSeconds` after the last attempt
 * that was let through. A counter starts again from nothing once
 * `resetAfterSeconds` pass with no failure. Nothing is ever locked for good.
 *
 * | Counter | Free failures | Then waits of | Longest wait | Forgotten after |
 * |---|---|---|---|---|
 * | account | 5 | 1, 2, 4 … s | 15 minutes | 24 hours without a failure |
 * | address | 20 | 1, 2, 4 … s | 15 minutes | 1 hour without a failure |
 *
 * So one account takes at most about 100 guesses a day from anywhere, and
 * one address about 100 a day across all accounts, before two-step sign-in
 * (T-038, required for everyone) is even reached.
 *
 * **Known addresses (S-018, D-068 amendment).** Anyone may type anyone's
 * address, so the account counter alone let a stranger guessing once per
 * wait keep a person (the install's only system admin included) waiting for
 * ever. A client address (`throttleSourceKey`, never `OTHER_SOURCE_KEY`)
 * from which the account signed in with the right password in the last
 * `KNOWN_SOURCE_SECONDS` is *known* for it, and has a counter of its own
 * for that account with the account rule. During an account wait an
 * attempt from a known address is still let through, as long as its own
 * counter and the address counter allow it (`decideSignInAttempt`); every
 * attempt let through is counted on every counter that applies. So strangers
 * elsewhere can't keep the person out at a known address, and a known
 * address gets no more guesses than the account rule gives it.
 */
import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/** One counter's rule. */
export interface ThrottleRule {
  /** Failures allowed before any wait. */
  readonly free: number;
  /** The first wait, in seconds; each later failure doubles it. */
  readonly baseSeconds: number;
  /** The longest wait, in seconds. */
  readonly maxSeconds: number;
  /** A counter with no failure for this long starts again from 0. */
  readonly resetAfterSeconds: number;
}

/** The account counter's rule. */
export const ACCOUNT_THROTTLE: ThrottleRule = Object.freeze({
  free: 5,
  baseSeconds: 1,
  maxSeconds: 15 * 60,
  resetAfterSeconds: 24 * 60 * 60,
});

/** The client address counter's rule (looser: offices share addresses). */
export const SOURCE_THROTTLE: ThrottleRule = Object.freeze({
  free: 20,
  baseSeconds: 1,
  maxSeconds: 15 * 60,
  resetAfterSeconds: 60 * 60,
});

/**
 * How long after a right password an address stays known for the account
 * (S-018): 30 days, so the person's usual networks stay known between
 * visits; a new network waits like a stranger's until its first sign-in.
 */
export const KNOWN_SOURCE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The most addresses kept known for one account (S-018 review): the newest
 * by last right password. Someone with the password can't fill the table,
 * and an old network drops out when a 21st is used.
 */
export const MAX_KNOWN_SOURCES = 20;

/** A known address's own counter for the account: the account rule. */
export const KNOWN_SOURCE_THROTTLE: ThrottleRule = ACCOUNT_THROTTLE;

/** A stored counter. */
export interface ThrottleState {
  readonly failures: number;
  /** Milliseconds since the epoch, by the database's clock; null if none yet. */
  readonly lastFailureAt: number | null;
}

/** Seconds to wait after the `failures`-th failure before another attempt. */
export function throttleDelaySeconds(rule: ThrottleRule, failures: number): number {
  if (failures < rule.free) return 0;
  const doublings = Math.min(failures - rule.free, 40);
  return Math.min(rule.baseSeconds * 2 ** doublings, rule.maxSeconds);
}

/** What `throttleAttempt` decided. */
export type ThrottleDecision =
  | { readonly allowed: true; readonly next: ThrottleState }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Whether an attempt at `now` (ms) may go ahead under `rule`, and if so the
 * counter with this attempt counted as a failure.
 */
export function throttleAttempt(
  rule: ThrottleRule,
  state: ThrottleState | undefined,
  now: number,
): ThrottleDecision {
  const last = state?.lastFailureAt ?? null;
  let failures = state?.failures ?? 0;
  // Never failed, or forgotten. A database clock that went back more than a
  // minute behind the stored time starts the counter again too, so a clock
  // change can't keep anyone waiting longer than the rule says.
  if (last === null || now - last >= rule.resetAfterSeconds * 1000 || now < last - 60_000) {
    failures = 0;
  }
  if (failures > 0 && last !== null) {
    const waitMs = throttleDelaySeconds(rule, failures) * 1000 - Math.max(now - last, 0);
    if (waitMs > 0) return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
  }
  return { allowed: true, next: { failures: failures + 1, lastFailureAt: now } };
}

/** The counters one sign-in attempt is decided on (S-018). */
export interface SignInCounters {
  readonly account: ThrottleState | undefined;
  readonly source: ThrottleState | undefined;
  /**
   * The known address's own counter for the account, or undefined when the
   * address isn't known for it (never signed in from there, or not within
   * `KNOWN_SOURCE_SECONDS`).
   */
  readonly known: ThrottleState | undefined;
  /** Whether the address is known for the account. */
  readonly isKnown: boolean;
}

/** What `decideSignInAttempt` decided: the counters to store if allowed. */
export type SignInAttemptDecision =
  | {
      readonly allowed: true;
      readonly account: ThrottleState;
      readonly source: ThrottleState;
      /** The known address's counter to store, or undefined if not known. */
      readonly known: ThrottleState | undefined;
    }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/** The counter with one more failure at `now` (`throttleAttempt`'s reset rules). */
function counted(rule: ThrottleRule, state: ThrottleState | undefined, now: number): ThrottleState {
  const d = throttleAttempt(rule, state, now);
  if (d.allowed) return d.next;
  // Counted during its own wait (a known address let through): one more.
  return { failures: (state?.failures ?? 0) + 1, lastFailureAt: now };
}

/**
 * Whether a sign-in attempt at `now` may go ahead (S-018, D-068). The
 * address counter always applies. The account counter applies too, except
 * that from an address known for the account its own counter stands in for
 * it: the attempt goes ahead if that counter allows it, even during the
 * account's wait. An attempt let through is counted on the account and
 * address counters (the account's even during its wait, since the password
 * is then checked), and on the known address's counter when there is one.
 * A refusal counts nothing, and its wait is the shortest that would let the
 * attempt through.
 */
export function decideSignInAttempt(counters: SignInCounters, now: number): SignInAttemptDecision {
  const source = throttleAttempt(SOURCE_THROTTLE, counters.source, now);
  const account = throttleAttempt(ACCOUNT_THROTTLE, counters.account, now);
  const known = counters.isKnown
    ? throttleAttempt(KNOWN_SOURCE_THROTTLE, counters.known, now)
    : undefined;
  const ownWait = (d: ThrottleDecision | undefined): number =>
    d === undefined ? Infinity : d.allowed ? 0 : d.retryAfterSeconds;
  // The account side is passed if either the account or the known address allows it.
  const accountSideWait = Math.min(ownWait(account), ownWait(known));
  if (!source.allowed || accountSideWait > 0) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(ownWait(source), accountSideWait),
    };
  }
  return {
    allowed: true,
    account: counted(ACCOUNT_THROTTLE, counters.account, now),
    source: source.next,
    known: counters.isKnown ? counted(KNOWN_SOURCE_THROTTLE, counters.known, now) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Keys

/**
 * The account counter's key for whatever was typed as the email address:
 * `account:` and the SHA-256 (hex) of its lower-case form. Hashed so the
 * table never holds addresses (typed by anyone, often mistyped), and the
 * same for an address with an account as for one without.
 */
export function throttleAccountKey(typed: string): string {
  return `account:${createHash("sha256").update(typed.toLowerCase(), "utf8").digest("hex")}`;
}

/**
 * The counter for re-entering the password in a signed-in session
 * (`reauthenticate`, S-018): `reauth:` and the user's ID. Separate from the
 * account counter, which anyone can push by typing the person's address at
 * sign-in, so strangers can't keep a signed-in person from a sensitive
 * change; only someone holding one of the person's sessions moves it.
 */
export function throttleReauthKey(userId: string): string {
  return `reauth:${userId.toLowerCase()}`;
}

/** The key for an address that can't be read: all such attempts share it. */
export const OTHER_SOURCE_KEY = "source:other";

/**
 * The client address counter's key. IPv4 is counted per address
 * (`source:v4:192.0.2.1`); IPv6 per /64 network (`source:v6:2001:db8:0:0::/64`),
 * the block one subscriber is normally given, so changing the last 64 bits
 * doesn't get a fresh counter. IPv4 written as IPv6 (`::ffff:192.0.2.1`)
 * counts as the IPv4 address. A zone (`%eth0`) is dropped. Anything else
 * shares `OTHER_SOURCE_KEY`.
 */
export function throttleSourceKey(address: unknown): string {
  if (typeof address !== "string" || address.length > 100) return OTHER_SOURCE_KEY;
  if (isIPv4(address)) return `source:v4:${canonicalIPv4(address)}`;
  const bare = address.replace(/%[^%]*$/, "");
  if (!isIPv6(bare)) return OTHER_SOURCE_KEY;
  const groups = expandIPv6(bare.toLowerCase());
  if (groups === undefined) return OTHER_SOURCE_KEY;
  const mapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff
      ? [groups[6] ?? 0, groups[7] ?? 0]
      : undefined;
  if (mapped !== undefined) {
    const [hi, lo] = mapped as [number, number];
    return `source:v4:${String(hi >> 8)}.${String(hi & 255)}.${String(lo >> 8)}.${String(lo & 255)}`;
  }
  return `source:v6:${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

function canonicalIPv4(address: string): string {
  return address
    .split(".")
    .map((part) => String(Number(part)))
    .join(".");
}

/** The eight 16-bit groups of an IPv6 address `isIPv6` accepted. */
function expandIPv6(address: string): number[] | undefined {
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    // An embedded IPv4 address is the last two groups.
    if (!isIPv4(last)) return undefined;
    const [a, b, c, d] = last.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  if (groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  return groups;
}
