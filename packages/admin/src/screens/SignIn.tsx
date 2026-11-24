/**
 * The Login screen (mockup Login, T-045): email and password. A right
 * password starts a session waiting for its code (or for setting up
 * two-step sign-in, D-052); every wrong answer reads the same (D-068).
 */
import { useState, type SubmitEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, api, problemText } from "../api";
import { AuthLayout, authStyles } from "../components/AuthLayout";
import { Button, Field, Note, TextLink } from "../components/ui";
import type { PendingState, SignInNotice } from "../types";

export const WRONG_PASSWORD =
  "That email address and password don't match an account that can sign in here.";

export function SignIn() {
  const navigate = useNavigate();
  const location = useLocation();
  const notice = (location.state as SignInNotice | null)?.notice;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (email.trim() === "" || password === "") {
      setProblem("Type your email address and your password.");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      const reply = await api<PendingState>("/api/sign-in", { body: { email, password } });
      setPassword("");
      await navigate(reply.next === "code" ? "/sign-in/code" : "/sign-in/set-up");
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.code === "invalid_credentials"
          ? WRONG_PASSWORD
          : problemText(error),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      intro="Sign in to catalog, arrange and publish the collection. You'll need your password and the code from your authenticator app."
    >
      {notice === undefined ? null : <Note tone="blue">{notice}</Note>}
      <form className={authStyles.form} onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={setEmail}
          isRequired
          autoFocus
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          isRequired
        />
        {problem === undefined ? null : (
          <Note tone="amber" alert>
            {problem}
          </Note>
        )}
        <Button type="submit" isDisabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <div className={authStyles.row}>
          <TextLink href="/forgot">Forgot your password?</TextLink>
        </div>
      </form>
      <Note tone="blue">
        Volunteers sign in with the account an administrator made for them. Roles decide what each
        person can see and change.
      </Note>
    </AuthLayout>
  );
}
