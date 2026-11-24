/**
 * The session waiting for its second step, read once when a screen opens
 * (`GET /api/sign-in/pending`, which also hands this page its CSRF token).
 * Without one (expired, or never signed in) the person goes back to the
 * Login screen.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, api } from "../api";
import type { PendingState } from "../types";

export function usePendingSession(): PendingState | undefined {
  const navigate = useNavigate();
  const [state, setState] = useState<PendingState>();
  useEffect(() => {
    let live = true;
    api<PendingState>("/api/sign-in/pending")
      .then((reply) => {
        if (live) setState(reply);
      })
      .catch((error: unknown) => {
        if (!live) return;
        const notice =
          error instanceof ApiError && error.status === 401
            ? "Sign in first. A sign-in waits 10 minutes for its code."
            : "Oculus couldn't be reached. Try again.";
        void navigate("/sign-in", { replace: true, state: { notice } });
      });
    return () => {
      live = false;
    };
  }, [navigate]);
  return state;
}
