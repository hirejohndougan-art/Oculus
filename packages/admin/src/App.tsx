/**
 * The admin's routes (React Router 8 as a library, D-073) and its providers:
 * TanStack Query for server data (4xx replies are not retried), and React
 * Aria's router link so its links navigate inside the app.
 */
import { useEffect, type ReactNode } from "react";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useHref,
  useLocation,
  useNavigate,
  type RouteObject,
} from "react-router";
import { RouterProvider as AriaRouterProvider } from "react-aria-components";
import { ApiError } from "./api";
import { endSession, isSessionEnded, isSignInPath } from "./session";
import { Frame } from "./frame/Frame";
import { Home } from "./frame/Home";
import { SiteHome, SiteNewRecord, SiteRecord, SiteReview } from "./frame/SiteHome";
import { Audit } from "./people/Audit";
import { Invite } from "./people/Invite";
import { PeopleList } from "./people/PeopleList";
import { Person } from "./people/Person";
import { Roles } from "./people/Roles";
import { Updates } from "./settings/Updates";
import { Code } from "./screens/Code";
import { SettingsLayout, SignInSettings, SitesSettings } from "./settings/Settings";
import { DublinCoreScreen } from "./settings/DublinCoreEditor";
import { TemplateList, TemplateScreen } from "./settings/TemplateEditor";
import { ResetComplete } from "./screens/ResetComplete";
import { ResetRequest } from "./screens/ResetRequest";
import { SetUp } from "./screens/SetUp";
import { SignIn } from "./screens/SignIn";

/**
 * What to do when the server says the session has ended (`401
 * unauthenticated`) on any query or mutation: set by `SessionWatch` inside
 * the router, which forgets the session (`endSession`) and goes to sign in.
 */
let onSessionEnded: (() => void) | undefined;

function sessionCheck(error: unknown): void {
  if (isSessionEnded(error)) onSessionEnded?.();
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: sessionCheck }),
    mutationCache: new MutationCache({ onError: sessionCheck }),
    defaultOptions: {
      queries: {
        retry: (count, error) =>
          !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

/**
 * Inside the router: when any query or mutation meets `401
 * unauthenticated` on a screen that needs a session, forget the session's
 * data and go to sign in. On the sign-in screens a 401 is expected.
 */
function SessionWatch() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const { pathname } = useLocation();
  useEffect(() => {
    if (isSignInPath(pathname)) {
      onSessionEnded = undefined;
      return undefined;
    }
    let handled = false;
    const handler = () => {
      if (handled) return;
      handled = true;
      void Promise.resolve(navigate("/sign-in", { replace: true })).then(() => {
        endSession(queries);
      });
    };
    onSessionEnded = handler;
    return () => {
      if (onSessionEnded === handler) onSessionEnded = undefined;
    };
  }, [pathname, navigate, queries]);
  return null;
}

/** Lets React Aria's links use the router. */
function AriaLinks(props: { readonly children?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <AriaRouterProvider navigate={(to) => void navigate(to)} useHref={useHref}>
      <SessionWatch />
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
          { path: "sites/:siteId/review", element: <SiteReview /> },
          { path: "sites/:siteId/records/new", element: <SiteNewRecord /> },
          { path: "sites/:siteId/records/:recordId", element: <SiteRecord /> },
          // People, roles and the audit trail (T-048).
          { path: "people", element: <PeopleList /> },
          { path: "people/invite", element: <Invite /> },
          { path: "people/:userId", element: <Person /> },
          { path: "roles", element: <Roles /> },
          { path: "audit", element: <Audit /> },
          {
            path: "settings",
            element: <SettingsLayout />,
            children: [
              { index: true, element: <Navigate to="/settings/sites" replace /> },
              { path: "sites", element: <SitesSettings /> },
              { path: "templates", element: <TemplateList /> },
              { path: "templates/:key", element: <TemplateScreen /> },
              { path: "templates/:key/dublin-core", element: <DublinCoreScreen /> },
              { path: "new-template", element: <TemplateScreen isNew /> },
              { path: "sign-in", element: <SignInSettings /> },
              // Software updates (T-060).
              { path: "updates", element: <Updates /> },
            ],
          },
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
