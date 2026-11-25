/**
 * The emails Oculus sends (T-040, D-085): a password reset link (D-078),
 * the one-time set-up code after a system admin resets someone's two-step
 * sign-in (D-077, D-081) and an invitation (D-068). Pure: each function
 * checks its values and returns the message as plain text and simple HTML,
 * or throws a `MailContentError` whose message names the rule, never the
 * value.
 *
 * - **Every value is checked before it is used.** The address must be
 *   exactly core's stored form (`normalizeEmail`: printable ASCII, no
 *   spaces, quotes or angle brackets), the token 32 bytes of base64url in
 *   its one spelling (43 characters), the expiry core's ISO form, the
 *   organization's name free of control characters, line breaks and
 *   direction overrides. **No header value may hold CR, LF or any other
 *   control character** (`checkHeaderValue`), so nothing typed or stored
 *   can add a header (`Bcc:`) or end the headers early.
 * - **Links come only from the configured admin origin**
 *   (`OCULUS_ADMIN_ORIGIN`, checked by `checkAdminOrigin`), never from a
 *   request's `Host`: `<origin>/reset#<token>` (D-081), `<origin>/sign-in`
 *   for the set-up code (the code is typed on the set-up screen, so it is
 *   never in a URL), `<origin>/invitation#<token>`. The token is in the
 *   fragment, which browsers send in no request line or `Referer`.
 * - **The subject holds no token** and nothing about the account: each kind
 *   has one fixed subject.
 * - **Plain text plus simple HTML built from the same paragraphs**, so the
 *   two can't say different things; every value in the HTML is escaped
 *   (`escapeHtml`), the link included. No images, no style sheets, no
 *   tracking pixels, nothing loaded from anywhere.
 * - Nothing about the account beyond the link (ROADMAP T-040): no name, no
 *   organization for a reset; an invitation names the organization the
 *   person is invited to, which the inviter chose.
 */
import { normalizeEmail } from "@oculus/core";

/** Which message: also the log's `operation` (never the address or token). */
export type MailKind =
  "password_reset" | "password_changed" | "two_step_setup" | "two_step_alert" | "invitation";

/** A message ready to send. */
export interface RenderedMail {
  readonly kind: MailKind;
  /** The account's (or invitee's) own address, in core's stored form. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * The bearer values in the message (the token). The development sender
   * hides them unless `OCULUS_DEV_MAIL_SHOW_TOKENS=1`; nothing else reads
   * them.
   */
  readonly secrets: readonly string[];
  /** Milliseconds since the epoch after which sending is pointless (the link has expired). */
  readonly notAfter: number;
}

/** Why a message can't be built. The message names the rule, never the value. */
export class MailContentError extends Error {
  override readonly name = "MailContentError";
  constructor(
    readonly code: "bad_address" | "bad_token" | "bad_expiry" | "bad_value" | "bad_origin",
  ) {
    super(`The message can't be built: ${code}.`);
  }
}

// C0 and C1 controls (CR and LF among them), DEL, and the Unicode line and
// paragraph separators: none may appear in a header.
const HEADER_REFUSED = /[\p{Cc}\u2028\u2029]/u;
// The same, plus the direction overrides that can make text read as
// something else (as core's display-name rule).
const TEXT_REFUSED = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/** 32 random bytes as base64url, no padding: the one spelling of every Oculus token. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_HEADER_VALUE = 998;
const MAX_ORGANIZATION_NAME = 200;

/**
 * Throws unless `value` is text fit for a header: no CR, LF or other
 * control character, no line or paragraph separator, at most 998
 * characters (RFC 5322 §2.1.1). Returns it unchanged.
 */
export function checkHeaderValue(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_HEADER_VALUE || HEADER_REFUSED.test(value)) {
    throw new MailContentError("bad_value");
  }
  return value;
}

/** Throws unless `value` is an address exactly in core's stored form. */
export function checkAddress(value: unknown): string {
  const text = checkHeaderValueAs(value, "bad_address");
  if (normalizeEmail(text) !== text) throw new MailContentError("bad_address");
  return text;
}

function checkHeaderValueAs(value: unknown, code: MailContentError["code"]): string {
  try {
    return checkHeaderValue(value);
  } catch {
    throw new MailContentError(code);
  }
}

function checkToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new MailContentError("bad_token");
  return value;
}

function checkExpiry(value: unknown): number {
  if (typeof value !== "string" || !ISO.test(value)) throw new MailContentError("bad_expiry");
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value) {
    throw new MailContentError("bad_expiry");
  }
  return at;
}

function checkCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new MailContentError("bad_value");
  }
  return value;
}

/** How long a message without a link is still worth sending (a day). */
const NOTICE_LIFE_MS = 86_400_000;

function checkName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_ORGANIZATION_NAME ||
    TEXT_REFUSED.test(value)
  ) {
    throw new MailContentError("bad_value");
  }
  return value;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The admin's origin for links, or a `MailContentError` (`bad_origin`):
 * a bare origin (`https://admin.example.org`, no path, query, fragment or
 * credentials), https only, except `http://localhost` (or 127.0.0.1, [::1])
 * outside production.
 */
export function checkAdminOrigin(value: unknown, production: boolean): string {
  if (typeof value !== "string" || value === "" || HEADER_REFUSED.test(value)) {
    throw new MailContentError("bad_origin");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MailContentError("bad_origin");
  }
  if (url.origin !== value) throw new MailContentError("bad_origin");
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && !production && LOOPBACK_HOSTS.has(url.hostname)) return value;
  throw new MailContentError("bad_origin");
}

/** Escapes text for HTML content and double- or single-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `17:35 UTC on 24 November 2026`: the time zone said, since the server's isn't the reader's. */
export function expiryText(at: number): string {
  const d = new Date(at);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ""} ${String(d.getUTCFullYear())}`;
}

/** A paragraph: plain text, or a link shown as its own address. */
type Part = { readonly text: string } | { readonly link: string };

function build(
  kind: MailKind,
  to: string,
  subject: string,
  parts: readonly Part[],
  secrets: readonly string[],
  notAfter: number,
): RenderedMail {
  checkHeaderValue(subject);
  const text = `${parts.map((p) => ("link" in p ? p.link : p.text)).join("\n\n")}\n`;
  const body = parts
    .map((p) =>
      "link" in p
        ? `<p><a href="${escapeHtml(p.link)}">${escapeHtml(p.link)}</a></p>`
        : `<p>${escapeHtml(p.text)}</p>`,
    )
    .join("\n");
  const html =
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<title>${escapeHtml(subject)}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
  return Object.freeze({
    kind,
    to,
    subject,
    text,
    html,
    secrets: Object.freeze([...secrets]),
    notAfter,
  });
}

/** What `renderPasswordReset` needs: D-078's `PasswordResetMessage`. */
export interface PasswordResetMailInput {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly requestedBy: "self" | "system_admin";
}

/** The reset link (D-078): `<origin>/reset#<token>`. */
export function renderPasswordReset(input: PasswordResetMailInput, origin: string): RenderedMail {
  const to = checkAddress(input.email);
  const token = checkToken(input.token);
  const at = checkExpiry(input.expiresAt);
  const by: unknown = input.requestedBy;
  if (by !== "self" && by !== "system_admin") throw new MailContentError("bad_value");
  const link = `${origin}/reset#${token}`;
  const opening =
    by === "self"
      ? "Someone asked to reset the password of the Oculus account that uses this email address. If it was you, open this link to choose a new password:"
      : "An Oculus system administrator sent you this link to choose a new password for your account:";
  return build(
    "password_reset",
    to,
    "Reset your Oculus password",
    [
      { text: opening },
      { link },
      {
        text: `The link works once and stops working at ${expiryText(at)}. Choosing a new password signs you out everywhere; your two-step sign-in stays as it is.`,
      },
      {
        text:
          by === "self"
            ? "If you didn't ask for this, ignore this email: your password stays the same."
            : "If you didn't expect this, ignore this email and tell your administrator.",
      },
    ],
    [token],
    at,
  );
}

/** What `renderTwoStepSetup` needs: D-077's `EnrolmentMessage`. */
export interface TwoStepSetupMailInput {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * The set-up code after a system admin's reset of two-step sign-in (D-077,
 * D-081). The set-up screen asks for it, so it is shown as text to copy,
 * never put in a URL; the link is only to the sign-in page.
 */
export function renderTwoStepSetup(input: TwoStepSetupMailInput, origin: string): RenderedMail {
  const to = checkAddress(input.email);
  const token = checkToken(input.token);
  const at = checkExpiry(input.expiresAt);
  return build(
    "two_step_setup",
    to,
    "Your Oculus set-up code",
    [
      {
        text: "An Oculus system administrator reset the two-step sign-in of your account. Sign in with your password; when Oculus asks for the set-up code from this email, enter this code:",
      },
      { text: token },
      {
        text: `The code works once and stops working at ${expiryText(at)}. Then you set up your authenticator app again. Sign in here:`,
      },
      { link: `${origin}/sign-in` },
      {
        text: "If you didn't expect this, tell your administrator. Nobody from Oculus will ask you for this code.",
      },
    ],
    [token],
    at,
  );
}

/** What `renderInvitation` needs: D-068's `InvitationMessage`. */
export interface InvitationMailInput {
  readonly email: string;
  readonly organizationName: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** An invitation (D-068): `<origin>/invitation#<token>`. */
export function renderInvitation(input: InvitationMailInput, origin: string): RenderedMail {
  const to = checkAddress(input.email);
  const token = checkToken(input.token);
  const at = checkExpiry(input.expiresAt);
  const organization = checkName(input.organizationName);
  return build(
    "invitation",
    to,
    "You're invited to Oculus",
    [
      {
        text: `You've been invited to join ${organization} in Oculus, its collections system. Open this link to accept and choose your password:`,
      },
      { link: `${origin}/invitation#${token}` },
      {
        text: `The link works once, only for this email address, and stops working at ${expiryText(at)}.`,
      },
      { text: "If you weren't expecting this, ignore this email." },
    ],
    [token],
    at,
  );
}

/** What `renderPasswordChanged` needs: D-085's `PasswordChangedMessage`. */
export interface PasswordChangedMailInput {
  readonly email: string;
  readonly changedAt: string;
}

/**
 * The notice after a reset link was used (OWASP Forgot Password): no token
 * and no link but the sign-in page.
 */
export function renderPasswordChanged(
  input: PasswordChangedMailInput,
  origin: string,
): RenderedMail {
  const to = checkAddress(input.email);
  const at = checkExpiry(input.changedAt);
  return build(
    "password_changed",
    to,
    "Your Oculus password was changed",
    [
      {
        text: `The password of the Oculus account that uses this email address was changed with a reset link at ${expiryText(at)}, and every session of the account was signed out.`,
      },
      { text: "If that was you, there is nothing more to do. Sign in here:" },
      { link: `${origin}/sign-in` },
      {
        text: "If it wasn't you, tell your administrator at once: someone who can read your email may have changed it.",
      },
    ],
    [],
    at + NOTICE_LIFE_MS,
  );
}

function isList(value: unknown): boolean {
  return Array.isArray(value);
}

/** People an admin's summary lists at most (the rest are counted). */
export const ALERT_SUMMARY_MAX_LINES = 50;

/** What `renderSecondStepAlert` needs: D-085's `SecondStepAlertMessage`. */
export type SecondStepAlertMailInput =
  | {
      readonly to: "person";
      readonly email: string;
      readonly failures: number;
      readonly at: string;
    }
  | {
      readonly to: "system_admin";
      readonly email: string;
      readonly people: readonly {
        readonly email: string;
        readonly failures: number;
        readonly at: string;
      }[];
      readonly more: number;
    };

function codesText(failures: number): string {
  return failures === 1 ? "1 wrong code" : `${String(failures)} wrong codes`;
}

/**
 * "Someone is guessing your two-step codes" (D-077): to the person, or one
 * summary to a system admin listing the people by address only (never the
 * self-chosen display name, review L1), at most 50 lines and "and N more".
 * No token; the only link is the sign-in page.
 */
export function renderSecondStepAlert(
  input: SecondStepAlertMailInput,
  origin: string,
): RenderedMail {
  const to = checkAddress(input.email);
  if (input.to === "person") {
    const failures = checkCount(input.failures);
    const at = checkExpiry(input.at);
    return build(
      "two_step_alert",
      to,
      "Someone may know your Oculus password",
      [
        {
          text: `Someone has been entering wrong two-step sign-in codes for your Oculus account (${codesText(failures)} by ${expiryText(at)}). Codes are asked for only after the right password, so whoever it is probably knows your password. Your two-step sign-in has kept them out.`,
        },
        {
          text: 'If it wasn\'t you, choose a new password now: open the sign-in page and use "Forgot your password?".',
        },
        { link: `${origin}/sign-in` },
        {
          text: "If it was you mistyping codes, you can ignore this email. Your system administrators have been told too. Oculus sends at most one such email a day.",
        },
      ],
      [],
      at + NOTICE_LIFE_MS,
    );
  }
  if ((input.to as unknown) !== "system_admin") throw new MailContentError("bad_value");
  const people: readonly {
    readonly email: unknown;
    readonly failures: unknown;
    readonly at: unknown;
  }[] = input.people;
  if (!isList(input.people) || people.length === 0 || people.length > ALERT_SUMMARY_MAX_LINES) {
    throw new MailContentError("bad_value");
  }
  const more = input.more;
  if (typeof more !== "number" || !Number.isInteger(more) || more < 0 || more > 1_000_000) {
    throw new MailContentError("bad_value");
  }
  let newest = 0;
  const lines = people.map((p) => {
    const address = checkAddress(p.email);
    const failures = checkCount(p.failures);
    const at = checkExpiry(p.at);
    newest = Math.max(newest, at);
    return { text: `${address}: ${codesText(failures)} by ${expiryText(at)}` };
  });
  const count = people.length + more;
  return build(
    "two_step_alert",
    to,
    "Oculus: someone is guessing two-step codes",
    [
      {
        text: `Someone has been entering wrong two-step sign-in codes for ${count === 1 ? "this Oculus account" : `these ${String(count)} Oculus accounts`}. Codes are asked for only after the right password, so those passwords are probably known to someone else. Two-step sign-in has kept them out.`,
      },
      ...lines,
      ...(more > 0 ? [{ text: `And ${String(more)} more.` }] : []),
      {
        text: "Confirm with each person another way. If it wasn't them, end their sessions and have them choose a new password. They have been told too, and each person's page shows their recent alerts.",
      },
      { link: `${origin}/sign-in` },
      { text: "Oculus sends at most one such email a day about each person." },
    ],
    [],
    newest + NOTICE_LIFE_MS,
  );
}
