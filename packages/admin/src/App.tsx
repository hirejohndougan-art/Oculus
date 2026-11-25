/**
 * The admin's routes (React Router 8 as a library, D-073) and its providers:
 * TanStack Query for server data (4xx replies are not retried), and React
 * Aria's router link so its links navigate inside the app.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useHref,
  useNavigate,
  type RouteObject,
} from "react-router";
import { RouterProvider as AriaRouterProvider } from "react-aria-components";
import { ApiError } from "./api";
import { Frame } from "./frame/Frame";
import { Home } from "./frame/Home";
import { SiteHome } from "./frame/SiteHome";
import { Audit } from "./people/Audit";
import { Invite } from "./people/Invite";
import { PeopleList } from "./people/PeopleList";
import { Person } from "./people/Person";
import { Roles } from "./people/Roles";
import { Code } from "./screens/Code";
import { ResetComplete } from "./screens/ResetComplete";
import { ResetRequest } from "./screens/ResetRequest";
import { SetUp } from "./screens/SetUp";
import { SignIn } from "./screens/SignIn";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** Lets React Aria's links use the router. */
function AriaLinks(props: { readonly children?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <AriaRouterProvider navigate={(to) => void navigate(to)} useHref={useHref}>
      {props.children ?? <Outlet />}
    </AriaRouterProvider>
  );
}

export const ROUTES: RouteObject[] = [
  {
    element: <AriaLinks />,
    children: [
      { path: "/sign-in", element: <SignIn /> },
      { path: "/sign-in/code", element: <Code /> },
      { path: "/sign-in/set-up", element: <SetUp /> },
      { path: "/forgot", element: <ResetRequest /> },
      { path: "/reset", element: <ResetComplete /> },
      {
        path: "/",
        element: <Frame />,
        children: [
          { index: true, element: <Home /> },
          { path: "sites/:siteId", element: <SiteHome /> },
          // People, roles and the audit trail (T-048).
          { path: "people", element: <PeopleList /> },
          { path: "people/invite", element: <Invite /> },
          { path: "people/:userId", element: <Person /> },
          { path: "roles", element: <Roles /> },
          { path: "audit", element: <Audit /> },
        ],
      },
    ],
  },
];

export function App(props: { readonly client?: QueryClient }) {
  const router = createBrowserRouter(ROUTES);
  return (
    <QueryClientProvider client={props.client ?? makeQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
