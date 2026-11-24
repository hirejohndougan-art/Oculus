/**
 * "Forgot your password?" (D-078): asks for a reset link. The reply is the
 * same whether or not the address has an account, so this screen says the
 * same thing either way.
 */
import { useState, type SubmitEvent } from "react";
import { api, problemText } from "../api";
import { AuthLayout, authStyles } from "../components/AuthLayout";
import { Button, Field, Note, TextLink } from "../components/ui";

export const RESET_SENT =
  "If that address belongs to an account that can sign in, a link to choose a new password is on its way to it. The link works once, for 30 minutes. If nothing arrives, ask your administrator.";

export function ResetRequest() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (email.trim() === "") {
      setProblem("Type the email address you sign in with.");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await api("/api/password-reset", { body: { email } });
      setSent(true);
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Choose a new password"
      intro="Type the email address you sign in with, and Oculus will send a link to choose a new password. You'll still need the code from your authenticator app to sign in."
    >
      {sent ? (
        <Note tone="green" alert>
          {RESET_SENT}
        </Note>
      ) : (
        <form className={authStyles.form} onSubmit={(e) => void submit(e)} noValidate>
          <Field
            label="Email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
            isRequired
            autoFocus
          />
          {problem === undefined ? null : (
            <Note tone="amber" alert>
              {problem}
            </Note>
          )}
          <Button type="submit" isDisabled={busy}>
            {busy ? "Sending…" : "Send the link"}
          </Button>
        </form>
      )}
      <div className={authStyles.row}>
        <TextLink href="/sign-in">Back to sign in</TextLink>
      </div>
    </AuthLayout>
  );
}
