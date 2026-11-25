/**
 * The one way the admin forgets a session's data (T-046, D-083): the CSRF
 * token, every cached server reply (records, lists, templates, the person)
 * and the items lists' search words and filters. Called when a session ends
 * (signing out, the server answering `401 unauthenticated` anywhere) and
 * when a new one begins (after the second step or set-up), so nothing of one
 * person's session reaches the next person in the same tab.
 */
import type { QueryClient } from "@tanstack/react-query";
import { ApiError, setCsrfToken } from "./api";
import { forgetLists } from "./records/listMemory";

export function endSession(
  queries: QueryClient,
  options: { readonly keepCsrfToken?: boolean } = {},
): void {
  // A new session's token arrives with the reply that began it: keep that one.
  if (options.keepCsrfToken !== true) setCsrfToken(null);
  queries.clear();
  forgetLists();
}

/** Whether an error is the server saying there is no session (any more). */
export function isSessionEnded(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === "unauthenticated";
}

/** The screens a person sees without a session: a 401 there is expected. */
export function isSignInPath(pathname: string): boolean {
  return (
    pathname === "/sign-in" ||
    pathname.startsWith("/sign-in/") ||
    pathname === "/forgot" ||
    pathname === "/reset" ||
    pathname === "/invitation"
  );
}
