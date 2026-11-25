/** The shapes the sign-in routes and `GET /api/me` answer with (D-081). */

export interface SiteChoice {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly siteId: string;
  readonly siteName: string;
  /**
   * The site's public address (`OCULUS_PUBLIC_SITES`, checked at startup),
   * or null when it has none (T-070, D-109).
   */
  readonly publicOrigin?: string | null;
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
  /** How long the session may sit unused, in seconds (T-062, D-098). */
  readonly idleSeconds?: number;
  /** A short non-secret name for the session, for the tabs' messages (T-062, D-098). */
  readonly sessionMarker?: string;
  readonly csrfToken: string | null;
  readonly sites: readonly SiteChoice[];
  /** The desktop launcher opens public sites in the default browser (T-071). */
  readonly opensPublicSites?: "desktop";
  /** Wrong two-step codes for this account in the last 30 days (D-077, D-085). */
  readonly secondStepAlerts?: { readonly recent: number; readonly lastAt: string | null };
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
