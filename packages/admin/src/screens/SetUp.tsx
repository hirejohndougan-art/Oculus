/**
 * Setting up two-step sign-in at the first sign-in (D-052, D-077), or after
 * a system admin reset it (then the one-time set-up code from the email is
 * needed). Three steps: start (a new secret), scan the QR code or type the
 * key, then confirm with a code from the app; the 10 recovery codes are then
 * shown **once** and never again. The secret and the codes live only in
 * this screen's state: never in storage, a cache or the address bar.
 */
import { useState, type SubmitEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { endSession } from "../session";
import { CheckboxButton, CheckboxField } from "react-aria-components";
import { ApiError, api, problemText } from "../api";
import { AuthLayout, authStyles } from "../components/AuthLayout";
import { OrganizationPicker } from "../components/OrganizationPicker";
import { QrCode } from "../components/QrCode";
import { Button, Field, Note } from "../components/ui";
import type { OrganizationChoice } from "../types";
import { CODE_AGAIN, WRONG_CODE } from "./Code";
import { usePendingSession } from "./pending";
import styles from "./SetUp.module.css";

interface Secret {
  readonly secret: string;
  readonly otpauthUri: string;
}

/** The key in groups of four, as authenticator apps show and accept it. */
export function groupedKey(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

export function SetUp() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const pending = usePendingSession();
  const [link, setLink] = useState("");
  const [secret, setSecret] = useState<Secret>();
  const [code, setCode] = useState("");
  const [organizations, setOrganizations] = useState<readonly OrganizationChoice[]>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function failed(error: unknown) {
    if (!(error instanceof ApiError)) {
      setProblem(problemText(error));
    } else if (error.code === "set_up_link_required") {
      setProblem(
        "That set-up code isn't right or has expired. Use the newest email from your administrator, or ask them to send a new one.",
      );
    } else if (error.code === "already_set_up") {
      await navigate("/sign-in/code", { replace: true });
    } else if (error.code === "invalid_code" && organizations !== undefined) {
      // The code ran out while the organization was chosen: ask for a new
      // one, keeping the choice.
      setOrganizations(undefined);
      setCode("");
      setProblem(CODE_AGAIN);
    } else if (error.code === "invalid_code") {
      setProblem(WRONG_CODE);
    } else if (error.code === "choose_organization") {
      setOrganizations((error.body.organizations ?? []) as OrganizationChoice[]);
    } else if (error.code === "too_many_attempts" || error.code === "unauthenticated") {
      await navigate("/sign-in", {
        replace: true,
        state: { notice: "Your sign-in has ended. Sign in again to finish setting up." },
      });
    } else {
      setProblem(problemText(error));
    }
  }

  async function start(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (pending?.setUpLinkRequired === true && link.trim() === "") {
      setProblem("Type the set-up code from the email your administrator sent.");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      setSecret(
        await api<Secret>("/api/sign-in/set-up", {
          body: pending?.setUpLinkRequired === true ? { setUpLink: link.trim() } : {},
        }),
      );
      setLink("");
    } catch (error) {
      await failed(error);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (code.trim() === "") {
      setProblem("Type the 6-digit code your app shows now.");
      return;
    }
    if (organizations !== undefined && organizationId === undefined) {
      setProblem("Choose the organization to work in.");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const reply = await api<{ recoveryCodes: string[] }>("/api/sign-in/set-up/confirm", {
        body: { code, ...(organizationId === undefined ? {} : { organizationId }) },
      });
      setSecret(undefined);
      setCode("");
      setRecoveryCodes(reply.recoveryCodes);
    } catch (error) {
      await failed(error);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setRecoveryCodes(undefined);
    // A new session: nothing of an earlier one may show (its token is the reply's).
    endSession(queries, { keepCsrfToken: true });
    await navigate("/", { replace: true });
  }

  if (recoveryCodes !== undefined) {
    return (
      <AuthLayout
        title="Save your recovery codes"
        intro="If you lose your phone, each of these codes lets you sign in once instead of a code from the app. They are shown only now."
      >
        <Note tone="amber">
          Write these down or print them, and keep them somewhere safe, away from your password.
          Oculus can't show them again.
        </Note>
        <ol className={styles.codes} aria-label="Recovery codes">
          {recoveryCodes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ol>
        <CheckboxField isSelected={saved} onChange={setSaved}>
          <CheckboxButton className={styles.check}>
            <span className={styles.box} aria-hidden="true" />I have saved these codes somewhere
            safe
          </CheckboxButton>
        </CheckboxField>
        <Button variant="primary" isDisabled={!saved} onPress={() => void finish()}>
          Continue to Oculus
        </Button>
      </AuthLayout>
    );
  }

  if (secret !== undefined) {
    return (
      <AuthLayout
        title="Scan the code with your app"
        intro="Open an authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator or 2FAS), add an account, and scan this code. Then type the 6-digit code the app shows."
      >
        <div className={styles.qr}>
          <QrCode
            value={secret.otpauthUri}
            label="QR code to add Oculus to your authenticator app"
          />
        </div>
        <div>
          <p className={styles.keyLabel}>Can't scan it? Type this key into the app instead:</p>
          <p className={styles.key}>
            <code>{groupedKey(secret.secret)}</code>
          </p>
        </div>
        <form className={authStyles.form} onSubmit={(e) => void confirm(e)} noValidate>
          {organizations === undefined ? (
            <Field
              label="6-digit code from the app"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={setCode}
              isRequired
              maxLength={16}
            />
          ) : (
            <OrganizationPicker
              organizations={organizations}
              value={organizationId}
              onChange={setOrganizationId}
            />
          )}
          {problem === undefined ? null : (
            <Note tone="amber" alert>
              {problem}
            </Note>
          )}
          <Button type="submit" isDisabled={busy}>
            {busy ? "Checking…" : "Confirm"}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Set up two-step sign-in"
      intro="Every Oculus account signs in with a password and a code from an authenticator app on your phone. Setting it up takes a minute."
    >
      <form className={authStyles.form} onSubmit={(e) => void start(e)} noValidate>
        {pending?.setUpLinkRequired === true ? (
          <Field
            label="Set-up code from the email"
            name="setUpLink"
            autoComplete="off"
            help="Your administrator reset your two-step sign-in. The email they sent has a one-time set-up code."
            value={link}
            onChange={setLink}
            isRequired
            autoFocus
            maxLength={100}
          />
        ) : null}
        {problem === undefined ? null : (
          <Note tone="amber" alert>
            {problem}
          </Note>
        )}
        <Button type="submit" variant="primary" isDisabled={busy || pending === undefined}>
          {busy ? "Starting…" : "Start setting up"}
        </Button>
      </form>
    </AuthLayout>
  );
}
