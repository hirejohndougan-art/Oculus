/**
 * The second step (T-045, D-052, D-077): the 6-digit code from the
 * authenticator app, or one recovery code instead. A person in several
 * organizations then chooses one; the same code is sent again with it
 * (nothing was used up). Five wrong codes end the waiting session.
 */
import { useEffect, useState, type SubmitEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { endSession } from "../session";
import { ApiError, api, problemText } from "../api";
import { AuthLayout, authStyles } from "../components/AuthLayout";
import { OrganizationPicker } from "../components/OrganizationPicker";
import { Button, Field, Note } from "../components/ui";
import type { OrganizationChoice, PendingState } from "../types";
import { usePendingSession } from "./pending";

export const WRONG_CODE = "That code isn't right, or was used already. Try the next code.";
export const CODE_AGAIN =
  "That code has run out while you chose. Type the new code from your app; your choice of organization is kept.";

export function Code() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const pending = usePendingSession();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [organizations, setOrganizations] = useState<readonly OrganizationChoice[]>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [cancelFailed, setCancelFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pending?.next === "set_up") void navigate("/sign-in/set-up", { replace: true });
  }, [pending, navigate]);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (code.trim() === "") {
      setProblem(recovery ? "Type one of your recovery codes." : "Type the 6-digit code.");
      return;
    }
    if (organizations !== undefined && organizationId === undefined) {
      setProblem("Choose the organization to work in.");
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await api("/api/sign-in/code", {
        body: {
          ...(recovery ? { recoveryCode: code } : { code }),
          ...(organizationId === undefined ? {} : { organizationId }),
        },
      });
      setCode("");
      // A new session: nothing of an earlier one may show (its token is the reply's).
      endSession(queries, { keepCsrfToken: true });
      await navigate("/", { replace: true });
    } catch (error) {
      if (!(error instanceof ApiError)) {
        setProblem(problemText(error));
      } else if (error.code === "choose_organization") {
        setOrganizations((error.body.organizations ?? []) as OrganizationChoice[]);
      } else if (error.code === "invalid_code" && organizations !== undefined) {
        // The code timed out (or was used) while the organization was
        // chosen: ask for a fresh one, keeping the choice.
        setOrganizations(undefined);
        setCode("");
        setProblem(CODE_AGAIN);
      } else if (error.code === "invalid_code") {
        setProblem(WRONG_CODE);
      } else if (error.code === "use_recovery_code") {
        setRecovery(true);
        setCode("");
        setProblem(
          "Codes from your app can't be checked just now. Use one of your recovery codes instead.",
        );
      } else if (error.code === "set_up_required") {
        await navigate("/sign-in/set-up", { replace: true });
      } else if (error.code === "too_many_attempts" || error.code === "unauthenticated") {
        await navigate("/sign-in", {
          replace: true,
          state: {
            notice:
              error.code === "too_many_attempts"
                ? "Too many wrong codes. Sign in again."
                : "Your sign-in took too long and has ended. Sign in again.",
          },
        });
      } else {
        setProblem(problemText(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    // Back to sign in only once the waiting session has really ended (or
    // the server says there is none).
    try {
      await api("/api/sign-out", { body: {} });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setCancelFailed(true);
        setProblem(`Your sign-in wasn't cancelled: ${problemText(error)}`);
        return;
      }
    }
    await navigate("/sign-in", { replace: true });
  }

  return (
    <AuthLayout
      title={organizations === undefined ? "Enter your code" : "Choose an organization"}
      intro={
        organizations !== undefined
          ? "You work for more than one organization. Oculus keeps their records apart, so choose the one to work in now; you can switch later."
          : recovery
            ? "Type one of the recovery codes you saved when you set up two-step sign-in. Each code works once."
            : "Open your authenticator app and type the 6-digit code it shows for Oculus. This second step keeps your account safe even if someone learns your password."
      }
    >
      <form className={authStyles.form} onSubmit={(e) => void submit(e)} noValidate>
        {organizations === undefined ? (
          recovery ? (
            <Field
              key="recovery"
              label="Recovery code"
              name="recoveryCode"
              autoComplete="off"
              help="24 letters and digits; dashes and spaces don't matter."
              value={code}
              onChange={setCode}
              isRequired
              autoFocus
              maxLength={64}
            />
          ) : (
            <Field
              key="code"
              label="6-digit code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={setCode}
              isRequired
              autoFocus
              maxLength={16}
            />
          )
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
        {cancelFailed ? (
          <Button
            variant="secondary"
            onPress={() => {
              setCancelFailed(false);
              void cancel();
            }}
          >
            Try again
          </Button>
        ) : null}
        <Button type="submit" isDisabled={busy || pending === undefined}>
          {busy ? "Checking…" : "Continue"}
        </Button>
        <div className={authStyles.row}>
          {organizations === undefined ? (
            <Button
              variant="link"
              onPress={() => {
                setRecovery(!recovery);
                setCode("");
                setProblem(undefined);
              }}
            >
              {recovery ? "Use the code from my app" : "Use a recovery code instead"}
            </Button>
          ) : null}
          <Button variant="link" onPress={() => void cancel()}>
            Cancel and sign in again
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}

export type { PendingState };
