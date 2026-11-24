/** The shapes the sign-in routes and `GET /api/me` answer with (D-081). */

export interface SiteChoice {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly siteId: string;
  readonly siteName: string;
}

export interface Me {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly systemAdmin: boolean;
  readonly displayName: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  readonly csrfToken: string | null;
  readonly sites: readonly SiteChoice[];
}

export interface PendingState {
  readonly expiresAt: string;
  readonly next: "code" | "set_up";
  readonly setUpLinkRequired: boolean;
  readonly csrfToken: string | null;
}

export interface OrganizationChoice {
  readonly organizationId: string;
  readonly name: string;
}

/** What the sign-in screens pass each other through the router's state. */
export interface SignInNotice {
  readonly notice?: string;
}
