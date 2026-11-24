/**
 * Password hashing and the rules for new passwords (T-036, D-052, D-068).
 *
 * **Hashing.** scrypt from `node:crypto` with N=2^14, r=8, p=5 (16 MiB), a
 * 16-byte random salt and a 32-byte key, stored as one PHC-format string:
 * `$scrypt$ln=14,r=8,p=5$<salt>$<hash>` (standard base64 without padding).
 * Always the async `crypto.scrypt` (the libuv thread pool), never
 * `scryptSync`, and at most `MAX_CONCURRENT_HASHES` run at once, with at
 * most `MAX_QUEUED_HASHES` waiting; beyond that `PasswordWorkBusyError` is
 * thrown, so a burst of sign-ins can't starve the server or grow memory
 * without bound. Hashes are compared with `timingSafeEqual`.
 *
 * Every failed `verifyPassword` costs at least one scrypt run at today's
 * settings, whatever it is given: a stored hash it can't read, or a
 * password longer than `MAX_PASSWORD_BYTES` or not well-formed, is checked
 * against `dummyPasswordHash()` and then refused, and a wrong password for
 * a hash with cheaper settings is padded with a dummy run. Sign-in uses the
 * same dummy hash for an unknown user, so a wrong user name costs the same
 * as a wrong password (ASVS 5.0 6.3.8).
 *
 * A stored hash whose settings differ from today's (`SCRYPT_SETTINGS`)
 * `needsRehash`: sign-in stores a new hash after a correct password. When
 * Argon2id arrives (U-004) the same field moves each person over.
 *
 * **New passwords** (ASVS 5.0 6.2): at least `MIN_PASSWORD_LENGTH`
 * characters (15 recommended on the form), at most `MAX_PASSWORD_BYTES`
 * bytes of UTF-8, no composition rules. Every password is put in Unicode
 * NFC before it is measured, checked or hashed (D-068, replacing D-052's
 * "no normalization"), and is otherwise used as typed (no trimming or case
 * change); a lone surrogate is refused. Refused: one of the
 * bundled common passwords (`common-passwords.ts`), compared ignoring case,
 * and a password that is mostly context words ("oculus", the organization's
 * name, the person's name or email): with every context word of 4 or more
 * letters taken out, fewer than `MIN_PASSWORD_LENGTH` characters remain.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { COMMON_PASSWORDS_TEXT } from "./common-passwords.js";
import { issue, type Issue, type Validated } from "./issues.js";

/** Fewest characters (Unicode code points) in a new password (ASVS 6.2.1). */
export const MIN_PASSWORD_LENGTH = 8;
/** The length the password form recommends (ASVS 6.2.1). */
export const RECOMMENDED_PASSWORD_LENGTH = 15;
/** Most bytes of UTF-8 in a password: keeps requests and hashing bounded (D-052). */
export const MAX_PASSWORD_BYTES = 1024;

/** Today's scrypt settings (D-052): N = 2^ln. */
export const SCRYPT_SETTINGS = Object.freeze({ ln: 14, r: 8, p: 5 });
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** scrypt computations allowed at once in this process. */
export const MAX_CONCURRENT_HASHES = 4;
/** scrypt computations allowed to wait for a slot; more are refused. */
export const MAX_QUEUED_HASHES = 64;

/** Thrown when too many password checks are already running or waiting. */
export class PasswordWorkBusyError extends Error {
  constructor() {
    super("Too many password checks are running; try again shortly.");
    this.name = "PasswordWorkBusyError";
  }
}

// ---------------------------------------------------------------------------
// The PHC string

/** A parsed stored hash. Only settings within these bounds are ever run. */
interface ScryptHash {
  readonly ln: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

// Standard base64 without padding, as the PHC string format uses: 16 bytes
// are 22 characters, 32 bytes are 43.
const PHC_SCRYPT =
  /^\$scrypt\$ln=([1-9][0-9]?),r=([1-9][0-9]?),p=([1-9][0-9]?)\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

// Bounds on stored settings, so a damaged or planted row can't ask for
// gigabytes of memory, seconds of work or settings scrypt refuses: ln 10–20,
// r 1–32, p 1–16, N < 2^(16·r) (RFC 7914 §2), memory (128·N·r bytes) at most
// 64 MiB, and work (N·r·p) at most 2^21, about 3 times today's.
// The database's CHECK on users.password_hash says the same (0009).
const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;
/** The most work (N·r·p) a stored hash may ask for. */
export const MAX_SCRYPT_WORK = 2 ** 21;

function parseScryptHash(stored: unknown): ScryptHash | undefined {
  if (typeof stored !== "string") return undefined;
  const match = PHC_SCRYPT.exec(stored);
  if (match === null) return undefined;
  const ln = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (ln < 10 || ln > 20 || r > 32 || p > 16) return undefined;
  if (ln >= 16 * r) return undefined;
  if (128 * 2 ** ln * r > MAX_SCRYPT_MEMORY) return undefined;
  if (2 ** ln * r * p > MAX_SCRYPT_WORK) return undefined;
  const salt = Buffer.from(match[4] ?? "", "base64");
  const hash = Buffer.from(match[5] ?? "", "base64");
  if (salt.length !== SALT_BYTES || hash.length !== KEY_BYTES) return undefined;
  return { ln, r, p, salt, hash };
}

function formatScryptHash(h: ScryptHash): string {
  const b64 = (b: Buffer): string => b.toString("base64").replace(/=+$/, "");
  return `$scrypt$ln=${String(h.ln)},r=${String(h.r)},p=${String(h.p)}$${b64(h.salt)}$${b64(h.hash)}`;
}

/** True if `stored` is a password hash this module can check. */
export function isPasswordHash(stored: unknown): stored is string {
  return parseScryptHash(stored) !== undefined;
}

/** True if `stored` was made with other settings than today's (or can't be read). */
export function passwordHashNeedsRehash(stored: unknown): boolean {
  const h = parseScryptHash(stored);
  if (h === undefined) return true;
  return h.ln !== SCRYPT_SETTINGS.ln || h.r !== SCRYPT_SETTINGS.r || h.p !== SCRYPT_SETTINGS.p;
}

// ---------------------------------------------------------------------------
// Running scrypt, a few at a time

let running = 0;
const waiting: (() => void)[] = [];
let started = 0;

/**
 * How many scrypt computations this process has started. For tests and
 * metrics only: sign-in tests use it to show an unknown user costs a hash.
 */
export function passwordWorkCount(): number {
  return started;
}

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_HASHES) {
    if (waiting.length >= MAX_QUEUED_HASHES) throw new PasswordWorkBusyError();
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  } else {
    running += 1;
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    // The slot passes straight to the next waiter, so `running` stays as is.
    if (next === undefined) running -= 1;
    else next();
  }
}

function runScrypt(
  password: Buffer,
  salt: Buffer,
  ln: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return withSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const N = 2 ** ln;
        const options: ScryptOptions = { N, r, p, maxmem: 128 * N * r * 2 };
        started += 1;
        scrypt(password, salt, KEY_BYTES, options, (error, key) => {
          if (error) reject(error);
          else resolve(key);
        });
      }),
  );
}

function utf8Bytes(password: string): Buffer {
  return Buffer.from(password, "utf8");
}

// A lone surrogate: half of a UTF-16 pair with no other half.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The form a password is checked, measured and hashed in: Unicode NFC, so
 * the same password typed on two keyboards (a precomposed "é" or "e" plus
 * a combining accent) is the same password. `undefined` for what isn't
 * well-formed text (not a string, or a lone surrogate, which has no UTF-8
 * form and would otherwise be hashed as U+FFFD).
 */
export function passwordText(password: unknown): string | undefined {
  if (typeof password !== "string" || LONE_SURROGATE.test(password)) return undefined;
  return password.normalize("NFC");
}

/**
 * Hashes a new password with today's settings. The password must be a string
 * of at most `MAX_PASSWORD_BYTES` bytes (check it with `checkNewPassword`
 * first); anything else throws.
 */
export async function hashPassword(password: string): Promise<string> {
  const text = passwordText(password);
  if (text === undefined) throw new TypeError("A password is well-formed text.");
  const bytes = utf8Bytes(text);
  if (bytes.length > MAX_PASSWORD_BYTES) {
    throw new RangeError(`A password is at most ${String(MAX_PASSWORD_BYTES)} bytes.`);
  }
  const { ln, r, p } = SCRYPT_SETTINGS;
  const salt = randomBytes(SALT_BYTES);
  const hash = await runScrypt(bytes, salt, ln, r, p);
  return formatScryptHash({ ln, r, p, salt, hash });
}

let dummy: Promise<string> | undefined;

/**
 * A hash of a random password nobody knows, made once per process with
 * today's settings. Checking a password against it costs what checking a
 * real one costs, and never succeeds.
 */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString("base64")).catch((error: unknown) => {
    dummy = undefined;
    throw error;
  });
  return dummy;
}

function scryptWork(h: { readonly ln: number; readonly r: number; readonly p: number }): number {
  return 2 ** h.ln * h.r * h.p;
}

/** One scrypt run at today's settings that can never match anything. */
async function runDummy(): Promise<void> {
  const fake = parseScryptHash(await dummyPasswordHash());
  if (fake === undefined) throw new Error("The dummy password hash can't be read.");
  // Hash something of a fixed size, so a long password costs no more.
  await runScrypt(randomBytes(32), fake.salt, fake.ln, fake.r, fake.p);
}

/** What `verifyPassword` found. */
export interface PasswordCheck {
  /** True only if the password matches a readable stored hash. */
  readonly ok: boolean;
  /** True if `ok` and the stored hash should be replaced with a new one. */
  readonly needsRehash: boolean;
}

const REFUSED: PasswordCheck = Object.freeze({ ok: false, needsRehash: false });

/**
 * Checks `password` against `stored` (a PHC string, or `undefined` for a
 * user that doesn't exist). Always runs exactly one scrypt computation:
 * against the dummy hash when there is no usable stored hash or the
 * password is too long or not a string, which then never matches.
 */
export async function verifyPassword(
  password: unknown,
  stored: string | undefined,
): Promise<PasswordCheck> {
  const parsed = parseScryptHash(stored);
  const text = passwordText(password);
  if (parsed === undefined || text === undefined || utf8Bytes(text).length > MAX_PASSWORD_BYTES) {
    await runDummy();
    return REFUSED;
  }
  const key = await runScrypt(utf8Bytes(text), parsed.salt, parsed.ln, parsed.r, parsed.p);
  if (!timingSafeEqual(key, parsed.hash)) {
    // A hash cheaper than today's settings would fail faster than a current
    // one: pad the failure to today's cost, so failures cost the same
    // whatever a user's stored hash is.
    if (scryptWork(parsed) < scryptWork(SCRYPT_SETTINGS)) await runDummy();
    return REFUSED;
  }
  return { ok: true, needsRehash: passwordHashNeedsRehash(stored) };
}

// ---------------------------------------------------------------------------
// Rules for a new password

let common: ReadonlySet<string> | undefined;

function commonPasswords(): ReadonlySet<string> {
  common ??= new Set(COMMON_PASSWORDS_TEXT.split("\n").filter((line) => line !== ""));
  return common;
}

/** True if `password`, ignoring case, is one of the bundled common passwords. */
export function isCommonPassword(password: string): boolean {
  return commonPasswords().has(password.toLowerCase());
}

/** Words refused as most of any password in this install (D-052, ASVS 6.2.11). */
export const DEFAULT_CONTEXT_WORDS: readonly string[] = Object.freeze([
  "oculus",
  "dickinson",
  "historical",
  "society",
  "archive",
  "archives",
  "museum",
  "library",
]);

/** Context words shorter than this are ignored (they'd remove too much). */
const MIN_CONTEXT_WORD = 4;

/** Who and where a new password is for, to find its context words. */
export interface PasswordContext {
  readonly email?: string;
  readonly displayName?: string;
  readonly organizationName?: string;
  /** More words to refuse, beyond `DEFAULT_CONTEXT_WORDS`. */
  readonly words?: readonly string[];
}

/**
 * The context words for a new password: `DEFAULT_CONTEXT_WORDS`, the words
 * of the organization's name, the person's name and their email's local part
 * and domain labels, lower case, 4 or more letters or digits each.
 */
export function passwordContextWords(context: PasswordContext = {}): string[] {
  const words = new Set<string>(DEFAULT_CONTEXT_WORDS);
  const add = (text: unknown): void => {
    if (typeof text !== "string") return;
    for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (Array.from(word).length >= MIN_CONTEXT_WORD) words.add(word);
    }
  };
  add(context.email);
  add(context.displayName);
  add(context.organizationName);
  for (const w of context.words ?? []) add(w);
  return [...words];
}

function characters(text: string): number {
  return Array.from(text).length;
}

/**
 * Checks a new password against D-052's rules, in its NFC form
 * (`passwordText`). Returns that form (never trimmed or otherwise changed)
 * or the issues: `not_text`, `invalid_text` (a lone surrogate),
 * `too_short`, `too_long`, `common_password`, `context_words`. The messages
 * never repeat the password.
 */
export function checkNewPassword(input: unknown, context: PasswordContext = {}): Validated<string> {
  if (typeof input !== "string") {
    return { ok: false, issues: [issue([], "not_text", "A password must be text.")] };
  }
  const password = passwordText(input);
  if (password === undefined) {
    return {
      ok: false,
      issues: [issue([], "invalid_text", "A password can't contain broken characters.")],
    };
  }
  const issues: Issue[] = [];
  if (utf8Bytes(password).length > MAX_PASSWORD_BYTES) {
    issues.push(
      issue([], "too_long", `A password can be at most ${String(MAX_PASSWORD_BYTES)} bytes long.`),
    );
  } else if (characters(password) < MIN_PASSWORD_LENGTH) {
    issues.push(
      issue(
        [],
        "too_short",
        `A password needs at least ${String(MIN_PASSWORD_LENGTH)} characters; ${String(RECOMMENDED_PASSWORD_LENGTH)} or more is better.`,
      ),
    );
  } else if (isCommonPassword(password)) {
    issues.push(
      issue([], "common_password", "That password is one of the most common ones. Choose another."),
    );
  } else {
    let rest = password.toLowerCase();
    // Longest words first, so "archives" goes before "archive".
    const words = passwordContextWords(context).sort((a, b) => b.length - a.length);
    for (const word of words) rest = rest.split(word).join("");
    if (characters(rest) < MIN_PASSWORD_LENGTH) {
      issues.push(
        issue(
          [],
          "context_words",
          "That password is mostly made of names or words connected with this site. Choose another.",
        ),
      );
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: password };
}
