/**
 * Joining from an invitation (T-075, D-068). The email links to
 * `/invitation#<token>`: the token is in the fragment, which the browser
 * never sends to the server or in a Referer, and this screen reads it once
 * and takes it out of the address bar and history at once (as the reset
 * link does). It is kept only in this screen's state.
 *
 * A new person types the address the invitation was sent to, their name
 * and a password; the account is made and signed in, and the next screen is
 * setting up two-step sign-in. Someone who already has an Oculus account is
 * told so (only once the whole form is right) and joins with the account
 * they are signed in with instead.
 */
import { useState, type SubmitEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, api, problemText } from "../api";
import { AuthLayout, authStyles } from "../components/AuthLayout";
import { Button, Field, Note, TextLink } from "../components/ui";
import type { PendingState } from "../types";

/** Reads the token from the fragment once and removes it from the address bar. */
function takeToken(): string {
  const hash = window.location.hash;
  if (hash.length > 1) {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }
  return hash.startsWith("#") ? hash.slice(1) : "";
}

interface Accepted extends Partial<PendingState> {
  readonly joined: true;
  readonly signedIn: boolean;
}

interface FormIssue {
  readonly path?: readonly unknown[];
  readonly message?: unknown;
}

export const DEAD_INVITATION = "This invitation link can't be used. Ask for a new one.";
export const SIGN_IN_FIRST =
  "Sign in to your Oculus account in this browser first, then open the invitation link from your email again.";

type State = "form" | "dead" | "exists" | "made" | "joined";

export function AcceptInvitation() {
  const navigate = useNavigate();
  const [token] = useState(takeToken);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [state, setState] = useState<State>(token === "" ? "dead" : "form");
  const [organizationName, setOrganizationName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    setNameError(undefined);
    setPasswordError(undefined);
    setProblem(undefined);
    if (email.trim() === "" || name.trim() === "" || password === "") {
      setProblem("Type your email address, your name and a password.");
      return;
    }
    if (password !== again) {
      setProblem("The two passwords aren't the same. Type them again.");
      return;
    }
    setBusy(true);
    try {
      const reply = await api<Accepted>("/api/invitation/accept", {
        body: { token, email, displayName: name.trim(), password },
      });
      setPassword("");
      setAgain("");
      if (reply.signedIn && reply.next !== undefined) {
        await navigate(reply.next === "code" ? "/sign-in/code" : "/sign-in/set-up", {
          replace: true,
        });
      } else {
        setState("made");
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "invalid_invitation") {
        setState("dead");
      } else if (error instanceof ApiError && error.code === "account_exists") {
        setPassword("");
        setAgain("");
        setState("exists");
      } else if (error instanceof ApiError && error.code === "invalid_form") {
        const issues = (Array.isArray(error.body.issues) ? error.body.issues : []) as FormIssue[];
        const messageFor = (field: string) => {
          const found = issues.find((i) => Array.isArray(i.path) && i.path[0] === field);
          return typeof found?.message === "string" ? found.message : undefined;
        };
        setNameError(messageFor("displayName"));
        setPasswordError(messageFor("password"));
      } else {
        setProblem(problemText(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function joinSignedIn() {
    if (busy) return;
    setProblem(undefined);
    setBusy(true);
    try {
      // Who is signed in here (and this session's CSRF token).
      await api("/api/me");
      const reply = await api<{ organizationName?: string }>("/api/invitation/accept-signed-in", {
        body: { token },
      });
      setOrganizationName(typeof reply.organizationName === "string" ? reply.organizationName : "");
      setState("joined");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setProblem(SIGN_IN_FIRST);
      } else if (error instanceof ApiError && error.code === "already_member") {
        setProblem("You're already in this organization. Sign in as usual.");
      } else if (error instanceof ApiError && error.code === "invalid_invitation") {
        setProblem(
          `${DEAD_INVITATION} If you are signed in, check it is the account the invitation was sent to.`,
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
        intro="Invitation links work once, until they expire, and only for the address they were sent to."
      >
        <Note tone="amber" alert>
          {DEAD_INVITATION}
        </Note>
        <div className={authStyles.row}>
          <TextLink href="/sign-in">Go to sign in</TextLink>
        </div>
      </AuthLayout>
    );
  }

  if (state === "made") {
    return (
      <AuthLayout title="Your account is ready" intro="Sign in to finish setting it up.">
        <Note tone="green" alert>
          Your account is made. Sign in with your email address and the password you just chose.
          You'll then set up two-step sign-in.
        </Note>
        <div className={authStyles.row}>
          <TextLink href="/sign-in">Sign in</TextLink>
        </div>
      </AuthLayout>
    );
  }

  if (state === "joined") {
    return (
      <AuthLayout title="You've joined" intro="Your account now works in one more organization.">
        <Note tone="green" alert>
          {organizationName === ""
            ? "You've joined the organization that invited you."
            : `You've joined ${organizationName}.`}{" "}
          Choose it from the organization menu, or when you next sign in.
        </Note>
        <div className={authStyles.row}>
          <TextLink href="/">Go to Oculus</TextLink>
        </div>
      </AuthLayout>
    );
  }

  if (state === "exists") {
    return (
      <AuthLayout
        title="You already have an account"
        intro="This invitation can be added to the Oculus account you already have."
      >
        <Note tone="blue">
          You already have an Oculus account with that email address. If you're signed in to it in
          this browser, join with it now. If not, {SIGN_IN_FIRST.charAt(0).toLowerCase()}
          {SIGN_IN_FIRST.slice(1)}
        </Note>
        {problem === undefined ? null : (
          <Note tone="amber" alert>
            {problem}
          </Note>
        )}
        <Button onPress={() => void joinSignedIn()} isDisabled={busy}>
          {busy ? "Joining…" : "Join with my account"}
        </Button>
        <div className={authStyles.row}>
          <TextLink href="/sign-in">Go to sign in</TextLink>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Join Oculus"
      intro="You've been invited to catalog, arrange and publish the collection. Make your account: then you'll set up two-step sign-in with an authenticator app."
    >
      <form className={authStyles.form} onSubmit={(e) => void submit(e)} noValidate>
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          help="The address the invitation was sent to."
          value={email}
          onChange={setEmail}
          isRequired
          autoFocus
        />
        <Field
          label="Your name"
          name="name"
          autoComplete="name"
          help="As your colleagues will see it."
          value={name}
          onChange={setName}
          error={nameError}
          isRequired
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          help="At least 8 characters; 15 or more is better. A short sentence is easy to remember and hard to guess."
          value={password}
          onChange={setPassword}
          error={passwordError}
          isRequired
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
          {busy ? "Making your account…" : "Make my account"}
        </Button>
        <div className={authStyles.row}>
          <Button
            variant="link"
            onPress={() => {
              setState("exists");
            }}
          >
            I already have an Oculus account
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
