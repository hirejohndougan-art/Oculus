/**
 * Choosing a new password from a reset link (D-078). The link carries the
 * token in the fragment (`/reset#<token>`), which the browser never sends to
 * the server or in a Referer; this screen reads it once and takes it out of
 * the address bar and history at once. Nobody is signed in by a reset: the
 * person signs in afresh, with their code.
 */
import { useState, type SubmitEvent } from "react";
import { ApiError, api, problemText } from "../api";
import { AuthLayout, authStyles } from "../components/AuthLayout";
import { Button, Field, Note, TextLink } from "../components/ui";

/** Reads the token from the fragment once and removes it from the address bar. */
function takeToken(): string {
  const hash = window.location.hash;
  if (hash.length > 1) {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }
  return hash.startsWith("#") ? hash.slice(1) : "";
}

export function ResetComplete() {
  const [token] = useState(takeToken);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [state, setState] = useState<"form" | "done" | "dead">(token === "" ? "dead" : "form");
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    setFieldError(undefined);
    setProblem(undefined);
    if (password === "") {
      setFieldError("Type a new password.");
      return;
    }
    if (password !== again) {
      setProblem("The two passwords aren't the same. Type them again.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/password-reset/complete", { body: { token, password } });
      setPassword("");
      setAgain("");
      setState("done");
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_reset") {
        setState("dead");
      } else if (error instanceof ApiError && error.code === "invalid_password") {
        const issues = Array.isArray(error.body.issues) ? error.body.issues : [];
        const first = issues[0] as { message?: unknown } | undefined;
        setFieldError(
          typeof first?.message === "string"
            ? first.message
            : "Choose a longer password that isn't a common one.",
        );
      } else {
        setProblem(problemText(error));
      }
    } finally {
      setBusy(false);
    }
  }

  if (state === "dead") {
    return (
      <AuthLayout
        title="This link can't be used"
        intro="Reset links work once, for 30 minutes, and a newer link replaces an older one."
      >
        <Note tone="amber" alert>
          This reset link can't be used. Ask for a new one.
        </Note>
        <div className={authStyles.row}>
          <TextLink href="/forgot">Ask for a new link</TextLink>
          <TextLink href="/sign-in">Back to sign in</TextLink>
        </div>
      </AuthLayout>
    );
  }

  if (state === "done") {
    return (
      <AuthLayout
        title="Your password is changed"
        intro="Every session that was signed in with the old password has ended."
      >
        <Note tone="green" alert>
          Your new password is saved. Sign in with it and the code from your authenticator app.
        </Note>
        <div className={authStyles.row}>
          <TextLink href="/sign-in">Sign in</TextLink>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      intro="Choose a password you don't use anywhere else. A short sentence of four or more words is easy to remember and hard to guess."
    >
      <form className={authStyles.form} onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          help="At least 8 characters; 15 or more is better."
          value={password}
          onChange={setPassword}
          error={fieldError}
          isRequired
          autoFocus
        />
        <Field
          label="Type it again"
          name="again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={setAgain}
          isRequired
        />
        {problem === undefined ? null : (
          <Note tone="amber" alert>
            {problem}
          </Note>
        )}
        <Button type="submit" isDisabled={busy}>
          {busy ? "Saving…" : "Save the new password"}
        </Button>
      </form>
    </AuthLayout>
  );
}
