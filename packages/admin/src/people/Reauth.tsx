/**
 * Entering the password and a code again (D-069, D-077) before a change to
 * a person, shown in the page where the change was asked for (no modal).
 * The server answers a change made without a recent entry with
 * `reauthentication_required`; `useReauthenticated` keeps the change and
 * runs it again once the form succeeds.
 */
import { useState, type SubmitEvent } from "react";
import { ApiError, api, problemText } from "../api";
import { Button, Field, Note } from "../components/ui";
import styles from "./People.module.css";

export function Reauth(props: {
  readonly onDone: () => void;
  readonly onCancel: () => void;
  /** What the change is, as "For changes to people". */
  readonly what?: string;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const typed = code.trim();
    const body = /^\d{6}$/.test(typed)
      ? { password, code: typed }
      : { password, recoveryCode: typed };
    try {
      await api("/api/reauthenticate", { body });
      setPassword("");
      setCode("");
      props.onDone();
    } catch (error) {
      setProblem(
        error instanceof ApiError &&
          (error.code === "invalid_credentials" || error.code === "invalid_code")
          ? "That password or code isn't right."
          : problemText(error),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={styles.confirm}
      aria-labelledby="reauth-title"
      onSubmit={(event) => void submit(event)}
    >
      <h2 id="reauth-title" className={styles.confirmTitle}>
        Confirm it's you
      </h2>
      <p>{props.what ?? "For changes to people"}, enter your password and a code again.</p>
      <Field
        label="Your password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        autoFocus
      />
      <Field
        label="Code from your app, or a recovery code"
        name="code"
        autoComplete="one-time-code"
        value={code}
        onChange={setCode}
      />
      {problem === undefined ? null : (
        <Note tone="amber" alert>
          {problem}
        </Note>
      )}
      <div className={styles.actions}>
        <Button type="submit" variant="dark" isDisabled={busy || password === "" || code === ""}>
          Confirm and continue
        </Button>
        <Button variant="secondary" onPress={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Runs a change; if the server asks for a recent entry, keeps the change
 * until `reauth` is done (render `form` where the change was asked for).
 */
export function useReauthenticated(what?: string) {
  const [waiting, setWaiting] = useState<(() => Promise<void>) | undefined>();
  async function run(change: () => Promise<void>): Promise<void> {
    try {
      await change();
    } catch (error) {
      if (error instanceof ApiError && error.code === "reauthentication_required") {
        setWaiting(() => change);
        return;
      }
      throw error;
    }
  }
  const form =
    waiting === undefined ? null : (
      <Reauth
        {...(what === undefined ? {} : { what })}
        onDone={() => {
          const change = waiting;
          setWaiting(undefined);
          void run(change).catch(() => undefined);
        }}
        onCancel={() => {
          setWaiting(undefined);
        }}
      />
    );
  return { run, form };
}
