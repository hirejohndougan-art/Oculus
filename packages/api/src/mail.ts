/**
 * Sending Oculus's email (T-040, D-085): the SMTP sender, the development
 * sender, their configuration from the environment, and the `Mailer` that
 * gives `@oculus/db` its delivery functions (`PasswordResetDelivery`,
 * `EnrolmentDelivery`, `InvitationDelivery`).
 *
 * **SMTP** through nodemailer (MIT-0, no dependencies), configured only by
 * the environment:
 * - `OCULUS_SMTP_HOST` (a host name or IP address), `OCULUS_SMTP_PORT`
 *   (default 587, or 465 with implicit TLS);
 * - `OCULUS_SMTP_TLS`: `starttls` (the default: STARTTLS **required**, the
 *   send fails if the server doesn't offer it), `implicit` (TLS from the
 *   first byte, port 465), or `none`, allowed only for a mail server on this
 *   machine (localhost, 127.0.0.1, ::1). TLS 1.2 or newer, the certificate
 *   always checked against the host name;
 * - `OCULUS_SMTP_USER` with `OCULUS_SMTP_PASSWORD`, or with
 *   `OCULUS_SMTP_PASSWORD_FILE` naming a file that holds it (a container's
 *   or systemd's secret file; one of the two, not both). The secret keyring
 *   (`OCULUS_SECRET_KEY`, D-077) holds only the sealing key, so the mail
 *   password is not in it;
 * - `OCULUS_MAIL_FROM` (an address) and `OCULUS_MAIL_FROM_NAME` (default
 *   "Oculus");
 * - links use `OCULUS_ADMIN_ORIGIN` (D-081), required with SMTP.
 * Every refusal names the variable and the rule, never the value.
 *
 * **The development sender** (`NODE_ENV=development` or `test` and no
 * `OCULUS_SMTP_HOST`) logs one `mail_dev` record per message (its kind
 * only). With `OCULUS_DEV_MAIL_DIR` it also writes each message to a file
 * there; with `OCULUS_DEV_MAIL_SHOW_TOKENS=1` the file (or, without a
 * folder, standard error) shows the token, otherwise the token is replaced
 * by `[token hidden]`. **It refuses to exist in production**
 * (`devTransport` throws), and `mailerFromEnv` refuses to start in
 * production without SMTP or with either development variable set.
 *
 * **Everything goes through the outbox** (mail-outbox.ts): the delivery
 * functions build and check the message and queue it, so they return in
 * microseconds whether or not the mail server answers; sends, retries and
 * failures happen later and are logged by kind and error class only. A
 * delivery rejects (and D-078 revokes the link) only when the message
 * can't be built (`MailContentError`: CR or LF in a value, a malformed
 * address or token) or isn't queued (`MailRefusedError`: closed, full, or
 * the recipient's hourly limit).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { ConnectionOptions } from "node:tls";
import { normalizeEmail } from "@oculus/core";
import type {
  EnrolmentDelivery,
  InvitationDelivery,
  PasswordChangedDelivery,
  PasswordResetDelivery,
  SecondStepAlertDelivery,
} from "@oculus/db";
import nodemailer from "nodemailer";
import { ADMIN_ORIGIN_ENV } from "./admin-files.js";
import { isProduction } from "./environment.js";
import {
  checkAdminOrigin,
  checkHeaderValue,
  MailContentError,
  renderInvitation,
  renderPasswordChanged,
  renderPasswordReset,
  renderSecondStepAlert,
  renderTwoStepSetup,
  type MailKind,
  type RenderedMail,
} from "./mail-messages.js";
import {
  createOutbox,
  MailRefusedError,
  type MailOutbox,
  type MailTransport,
  type OutboxOptions,
} from "./mail-outbox.js";
import type { ApiLogRecord } from "./staff-api.js";

export const MAIL_ENV = Object.freeze({
  host: "OCULUS_SMTP_HOST",
  port: "OCULUS_SMTP_PORT",
  tls: "OCULUS_SMTP_TLS",
  user: "OCULUS_SMTP_USER",
  password: "OCULUS_SMTP_PASSWORD",
  passwordFile: "OCULUS_SMTP_PASSWORD_FILE",
  from: "OCULUS_MAIL_FROM",
  fromName: "OCULUS_MAIL_FROM_NAME",
  devDir: "OCULUS_DEV_MAIL_DIR",
  devShowTokens: "OCULUS_DEV_MAIL_SHOW_TOKENS",
});

/** A configuration problem; the message names the variable, never its value. */
export class MailConfigError extends Error {
  override readonly name = "MailConfigError";
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: "starttls" | "implicit" | "none";
  readonly user?: string;
  readonly password?: string;
  readonly from: { readonly name: string; readonly address: string };
}

type Env = Readonly<Record<string, string | undefined>>;

const HOST_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
// Characters that never belong in a credential typed into a variable.
const CREDENTIAL_REFUSED = /\p{Cc}/u;

function set(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Reads the SMTP settings; throws a `MailConfigError` naming the variable at fault. */
export function smtpConfigFromEnv(
  env: Env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): SmtpConfig {
  const host = set(env, MAIL_ENV.host);
  if (host === undefined) throw new MailConfigError(`${MAIL_ENV.host} is not set.`);
  if (!HOST_NAME.test(host) && isIP(host) === 0) {
    throw new MailConfigError(`${MAIL_ENV.host} must be a host name or an IP address.`);
  }
  const tlsText = set(env, MAIL_ENV.tls) ?? "starttls";
  if (tlsText !== "starttls" && tlsText !== "implicit" && tlsText !== "none") {
    throw new MailConfigError(`${MAIL_ENV.tls} must be starttls, implicit or none.`);
  }
  if (tlsText === "none" && !LOOPBACK.has(host.toLowerCase())) {
    throw new MailConfigError(
      `${MAIL_ENV.tls}=none is allowed only for a mail server on this machine (localhost); use starttls or implicit.`,
    );
  }
  const portText = set(env, MAIL_ENV.port) ?? (tlsText === "implicit" ? "465" : "587");
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new MailConfigError(`${MAIL_ENV.port} must be a port number.`);
  }
  const user = set(env, MAIL_ENV.user);
  const inline = set(env, MAIL_ENV.password);
  const file = set(env, MAIL_ENV.passwordFile);
  if (inline !== undefined && file !== undefined) {
    throw new MailConfigError(`Set ${MAIL_ENV.password} or ${MAIL_ENV.passwordFile}, not both.`);
  }
  let password = inline;
  if (file !== undefined) {
    try {
      // One trailing line break is the file's, not the password's.
      password = readFile(file).replace(/\r?\n$/, "");
    } catch {
      throw new MailConfigError(`${MAIL_ENV.passwordFile} names a file that can't be read.`);
    }
  }
  if ((user === undefined) !== (password === undefined || password === "")) {
    throw new MailConfigError(
      `${MAIL_ENV.user} and its password (${MAIL_ENV.password} or ${MAIL_ENV.passwordFile}) go together.`,
    );
  }
  if (user !== undefined && (CREDENTIAL_REFUSED.test(user) || user.length > 512)) {
    throw new MailConfigError(`${MAIL_ENV.user} holds a control character or is too long.`);
  }
  if (password !== undefined && (CREDENTIAL_REFUSED.test(password) || password.length > 1024)) {
    throw new MailConfigError("The SMTP password holds a control character or is too long.");
  }
  const fromText = set(env, MAIL_ENV.from);
  const address = normalizeEmail(fromText);
  if (fromText === undefined || address === undefined) {
    throw new MailConfigError(`${MAIL_ENV.from} must be an email address.`);
  }
  const name = set(env, MAIL_ENV.fromName) ?? "Oculus";
  try {
    checkHeaderValue(name);
  } catch {
    throw new MailConfigError(`${MAIL_ENV.fromName} holds a line break or control character.`);
  }
  if (name.length > 100 || name.trim() !== name) {
    throw new MailConfigError(`${MAIL_ENV.fromName} must be 1 to 100 characters, trimmed.`);
  }
  return Object.freeze({
    host,
    port,
    tls: tlsText,
    ...(user === undefined || password === undefined ? {} : { user, password }),
    from: Object.freeze({ name, address }),
  });
}

/** Test-only settings for the SMTP sender (a test CA, shorter waits). */
export interface SmtpTestingOptions {
  readonly tls?: ConnectionOptions;
  readonly timeoutsMs?: number;
}

/**
 * The SMTP sender. One connection per message (no pool: messages are few,
 * and nothing lingers between them); the outbox's signal stops a send at
 * once (nodemailer closes the connection).
 */
export function smtpTransport(config: SmtpConfig, testing: SmtpTestingOptions = {}): MailTransport {
  const wait = testing.timeoutsMs ?? 10_000;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.tls === "implicit",
    requireTLS: config.tls === "starttls",
    ignoreTLS: config.tls === "none",
    ...(config.user === undefined || config.password === undefined
      ? {}
      : { auth: { user: config.user, pass: config.password } }),
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      ...(isIP(config.host) === 0 ? { servername: config.host } : {}),
      ...testing.tls,
    },
    connectionTimeout: wait,
    greetingTimeout: wait,
    socketTimeout: 2 * wait,
    dnsTimeout: wait,
    // Nodemailer's own log would write addresses and, with debug, the
    // message itself: off (D-085).
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(mail: RenderedMail, signal: AbortSignal): Promise<void> {
      await transporter.sendMail({
        from: { name: config.from.name, address: config.from.address },
        // As an object, so nodemailer's address parser never splits or
        // reinterprets it (it is core's stored form, checked again by the
        // message builder).
        to: { name: "", address: mail.to },
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        disableFileAccess: true,
        disableUrlAccess: true,
        signal,
      });
    },
  };
}

/** What `devTransport` needs. */
export interface DevTransportOptions {
  readonly env: Env;
  readonly log: (record: ApiLogRecord) => void;
  /** Where to show a message when no folder is set and tokens are shown (default: standard error). */
  readonly write?: (text: string) => void;
}

/**
 * The development sender: logs `mail_dev` (the kind only), and writes the
 * message to `OCULUS_DEV_MAIL_DIR` if set, the token hidden unless
 * `OCULUS_DEV_MAIL_SHOW_TOKENS=1`. **Throws in production**, here and again
 * at every send.
 */
export function devTransport(options: DevTransportOptions): MailTransport {
  const { env, log } = options;
  if (isProduction(env)) {
    throw new MailConfigError(
      "refusing to start: the development mail sender can't run in production (set NODE_ENV=development, or configure OCULUS_SMTP_HOST).",
    );
  }
  const dir = set(env, MAIL_ENV.devDir);
  const showText = set(env, MAIL_ENV.devShowTokens);
  if (showText !== undefined && showText !== "1") {
    throw new MailConfigError(`${MAIL_ENV.devShowTokens} may only be 1.`);
  }
  const show = showText === "1";
  const write =
    options.write ??
    ((text: string) => {
      process.stderr.write(text);
    });
  return {
    send(mail: RenderedMail): Promise<void> {
      if (isProduction(env)) {
        return Promise.reject(
          new MailConfigError("The development mail sender can't send in production."),
        );
      }
      log({ event: "mail_dev", operation: mail.kind });
      if (dir === undefined && !show) return Promise.resolve();
      let body = `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}`;
      if (!show) {
        for (const secret of mail.secrets) body = body.replaceAll(secret, "[token hidden]");
      }
      if (dir === undefined) {
        write(`--- Oculus development email (${mail.kind}) ---\n${body}---\n`);
      } else {
        writeFileSync(join(dir, `${String(Date.now())}-${mail.kind}-${randomUUID()}.txt`), body, {
          flag: "wx",
          mode: 0o600,
        });
      }
      return Promise.resolve();
    },
  };
}

/** The delivery functions `@oculus/db` takes, over one outbox. */
export interface Mailer {
  /** For `requestPasswordReset` and `sendPasswordReset` (D-078). */
  readonly deliverReset: PasswordResetDelivery;
  /** For `resetSecondFactor` (D-077): the one-time set-up code. */
  readonly deliverEnrolment: EnrolmentDelivery;
  /** For `createInvitation` (D-068). */
  readonly deliverInvitation: InvitationDelivery;
  /** For `completePasswordReset`'s `notifyChanged`: the notice after a reset. */
  readonly deliverPasswordChanged: PasswordChangedDelivery;
  /** For `sendSecondStepAlertNotices` (D-077): someone is guessing codes. */
  readonly deliverAlert: SecondStepAlertDelivery;
  readonly outbox: MailOutbox;
  /** Stops the outbox (drops what is waiting, aborts sends in progress). */
  close(): Promise<void>;
}

export interface MailerOptions {
  readonly transport: MailTransport;
  /** The admin's origin, checked by `checkAdminOrigin`; links are built from it alone. */
  readonly adminOrigin: string;
  readonly production: boolean;
  readonly log: (record: ApiLogRecord) => void;
  readonly outbox?: Omit<OutboxOptions, "transport" | "log">;
}

/** Makes the delivery functions over an outbox. */
export function createMailer(options: MailerOptions): Mailer {
  const origin = checkAdminOrigin(options.adminOrigin, options.production);
  const { log } = options;
  const outbox = createOutbox({ ...options.outbox, transport: options.transport, log });

  /** Builds and queues; rejects (never throws) if it can't. Nothing waits for the mail server. */
  const hand = (kind: MailKind, signal: AbortSignal | undefined, render: () => RenderedMail) => {
    try {
      if (signal?.aborted === true) throw new MailRefusedError("aborted");
      outbox.enqueue(render());
      return Promise.resolve();
    } catch (error) {
      if (error instanceof MailContentError) {
        try {
          log({ event: "mail_refused", operation: kind, code: error.code });
        } catch {
          // Logging can't stop the caller.
        }
      }
      // A fixed error: the caller drops it unread anyway (D-078).
      return Promise.reject(
        error instanceof MailContentError || error instanceof MailRefusedError
          ? error
          : new Error("The message was not queued."),
      );
    }
  };

  return Object.freeze({
    deliverReset: (message, signal) =>
      hand("password_reset", signal, () => renderPasswordReset(message, origin)),
    deliverEnrolment: (message) =>
      hand("two_step_setup", undefined, () => renderTwoStepSetup(message, origin)),
    deliverInvitation: (message, signal) =>
      hand("invitation", signal, () => renderInvitation(message, origin)),
    deliverPasswordChanged: (message) =>
      hand("password_changed", undefined, () => renderPasswordChanged(message, origin)),
    deliverAlert: (message) =>
      hand("two_step_alert", undefined, () => renderSecondStepAlert(message, origin)),
    outbox,
    close: () => outbox.close(),
  } satisfies Mailer);
}

/** Options for `mailerFromEnv`. */
export interface MailerFromEnvOptions {
  readonly log: (record: ApiLogRecord) => void;
  readonly outbox?: MailerOptions["outbox"];
  /** For tests: read the password file. */
  readonly readFile?: (path: string) => string;
  /** For tests: the development sender's standard-error writer. */
  readonly write?: (text: string) => void;
}

/**
 * The mailer the environment asks for: SMTP when `OCULUS_SMTP_HOST` is set,
 * otherwise the development sender outside production. **Refuses** (throws
 * a `MailConfigError`) in production without SMTP, or with
 * `OCULUS_DEV_MAIL_DIR` or `OCULUS_DEV_MAIL_SHOW_TOKENS` set.
 */
export function mailerFromEnv(env: Env, options: MailerFromEnvOptions): Mailer {
  const production = isProduction(env);
  if (
    production &&
    (set(env, MAIL_ENV.devDir) !== undefined || set(env, MAIL_ENV.devShowTokens) !== undefined)
  ) {
    throw new MailConfigError(
      `refusing to start: ${MAIL_ENV.devDir} and ${MAIL_ENV.devShowTokens} are for development only.`,
    );
  }
  const originText = set(env, ADMIN_ORIGIN_ENV);
  if (set(env, MAIL_ENV.host) !== undefined) {
    const config = smtpConfigFromEnv(env, options.readFile);
    if (originText === undefined) {
      throw new MailConfigError(`${ADMIN_ORIGIN_ENV} must be set: email links are built from it.`);
    }
    return createMailer({
      transport: smtpTransport(config),
      adminOrigin: originOrThrow(originText, production),
      production,
      log: options.log,
      ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
    });
  }
  if (production) {
    throw new MailConfigError(
      `refusing to start: no password reset sender (mail) is configured: set ${MAIL_ENV.host} and ${MAIL_ENV.from} (D-085).`,
    );
  }
  return createMailer({
    transport: devTransport({
      env,
      log: options.log,
      ...(options.write === undefined ? {} : { write: options.write }),
    }),
    // Development without an admin origin: links point at localhost.
    adminOrigin: originOrThrow(originText ?? "http://localhost", production),
    production,
    log: options.log,
    ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
  });
}

function originOrThrow(origin: string, production: boolean): string {
  try {
    return checkAdminOrigin(origin, production);
  } catch {
    throw new MailConfigError(
      `${ADMIN_ORIGIN_ENV} must be a bare https origin (http only for localhost in development).`,
    );
  }
}
