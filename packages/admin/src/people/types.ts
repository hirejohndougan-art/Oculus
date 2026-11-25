/** The shapes the people, roles and audit routes answer with (T-048, D-084). */

export interface Grant {
  readonly id: string;
  readonly role: string;
  readonly siteId: string | null;
  readonly scope: string | null;
  readonly grantedAt: string;
}

export interface Rights {
  readonly systemManager: boolean;
  readonly manageSites: readonly string[];
  readonly manageAccounts: boolean;
}

/** `nameOnly`: a member with no role, as a site manager sees them (T-064): no email, state or sign-in. */
export interface PersonSummary {
  readonly userId: string;
  readonly displayName: string;
  readonly email?: string;
  readonly disabled?: boolean;
  readonly systemAdmin?: boolean;
  readonly lastSignInAt?: string | null;
  readonly roles: readonly Grant[];
  readonly nameOnly?: true;
}

export interface PeopleList {
  readonly people: readonly PersonSummary[];
  readonly truncated: boolean;
  readonly rights: Rights;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly organizationId: string | null;
  readonly stage: "second_step" | "full";
  readonly signedInAt: string;
  readonly lastSeenAt: string;
  readonly label: string | null;
}

export interface PersonDetail {
  readonly person: PersonSummary & { readonly addedAt?: string };
  readonly rights: Rights;
  readonly sessions?: readonly SessionRow[];
  readonly secondStep?: {
    readonly inUse: boolean;
    readonly enrolledAt: string | null;
    readonly recentAlerts: number;
    readonly lastAlertAt: string | null;
    /** The newest alerts (D-085): when, how many wrong codes, what became of the email. */
    readonly alerts?: readonly {
      readonly at: string;
      readonly failures: number;
      readonly notice: "emailed" | "covered" | "pending";
    }[];
  };
}

export interface RoleEntry {
  readonly role: string;
  readonly label: string;
  readonly permissions: readonly string[];
  readonly grantable: boolean;
}

export type AuditEntry =
  | {
      readonly type: "record";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly recordId: string;
      readonly version: number;
      readonly action: string;
      readonly title: string | null;
      readonly kind: string | null;
      readonly changedFields: readonly string[];
      readonly reason: string | null;
      readonly deleted: boolean;
    }
  | {
      readonly type: "people";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly kind: string;
      readonly subjectId: string | null;
      readonly subjectName: string | null;
      readonly role: string | null;
      readonly siteId: string | null;
      readonly scope: string | null;
      readonly invitedEmail: string | null;
    }
  | {
      /** A change to the server itself (T-060a): system managers only. */
      readonly type: "system";
      readonly at: string;
      /** `user:<id>`, `command_line` for a command on the server, or `timer` for the daily purge. */
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly kind: string;
      readonly version: string;
      readonly fromVersion: string | null;
      /** A purge step's files and bytes (S-052); absent or null for an update. */
      readonly files?: number | null;
      readonly bytes?: number | null;
    }
  | {
      /** A definition made or changed (S-064): a type, term, site, storage, mapping or settings. */
      readonly type: "definition";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly subject: string;
      readonly key: string | null;
      readonly action: string;
      readonly name: string | null;
      readonly changes: readonly string[];
    }
  | {
      readonly type: "file";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly kind: string;
      readonly recordId: string;
      readonly title: string | null;
      readonly fileId: string;
      readonly bytes: number;
    }
  | {
      readonly type: "move";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly eventId: string;
      readonly recordId: string;
      readonly title: string | null;
      readonly locationId: string;
      readonly locationName: string | null;
    }
  | {
      readonly type: "accession";
      readonly at: string;
      readonly actor: string;
      readonly actorName: string | null;
      readonly accessionId: string;
      readonly version: number;
      readonly number: string | null;
    }
  | {
      readonly type: "share";
      readonly at: string;
      /** `user:<id>`, `automatic` when the record's deletion or move ended it, or `other_organization`. */
      readonly actor: string;
      readonly actorName: string | null;
      readonly shareId: string;
      readonly kind: string;
      readonly recordId: string;
      readonly title: string | null;
      readonly deleted?: boolean;
      readonly targetSiteId: string | null;
    };

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  readonly next: string | null;
}

export const ROLE_NAMES: Readonly<Record<string, string>> = {
  site_manager: "Site manager",
  cataloger: "Cataloger",
  reviewer: "Reviewer",
  read_only: "Read-only",
  scanner: "Scanner",
  donor_relations: "Donor relations",
};

export const PERMISSION_NAMES: Readonly<Record<string, string>> = {
  "records.view": "See records",
  "records.create": "Add records",
  "records.edit": "Edit records",
  "records.delete": "Delete records",
  "records.history": "See old versions",
  "records.publish": "Publish",
  "media.attach": "Attach scans",
  "donors.view": "See donor details",
  "donors.edit": "Edit donor details",
  "site.settings": "Site settings",
  "site.people": "Manage the site's people",
};

/** A time as the reader's locale shows it. */
export function when(iso: string | null): string {
  if (iso === null) return "never";
  const time = new Date(iso);
  return Number.isNaN(time.getTime())
    ? iso
    : time.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
