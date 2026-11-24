/**
 * Test helpers for the admin's screens: the real routes in a memory router
 * with a fresh Query client, and a fake `fetch` answering from a table of
 * replies, recording every request (method, path, headers, body).
 */
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router";
import { vi } from "vitest";
import { makeQueryClient, ROUTES } from "./App";
import { setCsrfToken } from "./api";

export interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type Reply = readonly [status: number, body: unknown];
type Handler = (sent: Sent) => Reply;

/** Replaces `fetch` with one answering `routes["METHOD /path"]`; unknown routes get 404. */
export function fakeServer(routes: Record<string, Reply | Handler>): Sent[] {
  const sent: Sent[] = [];
  setCsrfToken(null);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const request: Sent = { method: init.method ?? "GET", path: input, headers, body };
      sent.push(request);
      const route = routes[`${request.method} ${input}`];
      const [status, reply] =
        route === undefined
          ? ([404, { error: "not_found" }] as const)
          : typeof route === "function"
            ? route(request)
            : route;
      return Promise.resolve(
        new Response(reply === undefined ? "" : JSON.stringify(reply), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return sent;
}

/** Renders the app's real routes at `path`. Returns the router for its location. */
export function renderAt(path: string) {
  const router = createMemoryRouter(ROUTES, { initialEntries: [path] });
  const utils = render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...utils };
}

export const CSRF = "c".repeat(43);
export const PENDING = {
  expiresAt: "2026-11-24T18:00:00.000Z",
  next: "code",
  setUpLinkRequired: false,
  csrfToken: CSRF,
};

export const ORG_A = "00000000-0000-4000-8000-00000000000a";
export const ORG_B = "00000000-0000-4000-8000-00000000000b";
export const SITE_1 = "00000000-0000-4000-8000-000000000001";
export const SITE_2 = "00000000-0000-4000-8000-000000000002";
export const SITE_3 = "00000000-0000-4000-8000-000000000003";

/** A `GET /api/me` reply for an invented person with the given sites. */
export function me(
  sites: { siteId: string; organizationId: string; siteName: string; organizationName: string }[],
) {
  return {
    userId: "00000000-0000-4000-8000-0000000000ff",
    organizationId: ORG_A,
    organizationName: "Invented Archive",
    systemAdmin: false,
    displayName: "Ada Invented",
    email: "ada@example.org",
    expiresAt: "2026-11-24T23:00:00.000Z",
    idleExpiresAt: "2026-11-24T19:00:00.000Z",
    csrfToken: "f".repeat(43),
    sites,
  };
}
