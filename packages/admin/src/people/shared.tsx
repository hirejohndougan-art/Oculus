/** Pieces the people screens share: site names, the in-page confirmation, queries. */
import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { Button } from "../components/ui";
import type { Me } from "../types";
import styles from "./People.module.css";
import { ROLE_NAMES, type PeopleList, type RoleEntry } from "./types";

export const PEOPLE_KEY = ["people"] as const;
export const ROLES_KEY = ["roles"] as const;

export function usePeople() {
  return useQuery({ queryKey: PEOPLE_KEY, queryFn: () => api<PeopleList>("/api/people") });
}

export function useRoles() {
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn: async () => (await api<{ roles: RoleEntry[] }>("/api/roles")).roles,
  });
}

/** Whether a query was refused for lack of rights (403). */
export function refused(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** The organization's sites the signed-in person can name, by ID. */
export function siteNames(me: Me): ReadonlyMap<string, string> {
  return new Map(
    me.sites
      .filter((s) => s.organizationId === me.organizationId)
      .map((s) => [s.siteId, s.siteName]),
  );
}

/** "Cataloger on Invented Archive", "Site manager on every site". */
export function grantText(
  grant: { readonly role: string; readonly siteId: string | null; readonly scope?: string | null },
  sites: ReadonlyMap<string, string>,
): string {
  const role = ROLE_NAMES[grant.role] ?? grant.role;
  const site =
    grant.siteId === null ? "every site" : (sites.get(grant.siteId) ?? "a site you can't open");
  const scope = grant.scope === null || grant.scope === undefined ? "" : ", one collection";
  return `${role} on ${site}${scope}`;
}

/**
 * An in-page confirmation for a dangerous action (no modal: T-046 found
 * React Aria's modals failing Alfa). Focus moves to it when it opens.
 */
export function Confirm(props: {
  readonly id: string;
  readonly title: string;
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly isDisabled?: boolean;
}) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <section
      ref={box}
      className={styles.confirm}
      aria-labelledby={`confirm-${props.id}-title`}
      tabIndex={-1}
    >
      <h3 id={`confirm-${props.id}-title`} className={styles.confirmTitle}>
        {props.title}
      </h3>
      {props.children}
      <div className={styles.actions}>
        <Button variant="dark" onPress={props.onConfirm} isDisabled={props.isDisabled ?? false}>
          {props.confirmLabel}
        </Button>
        <Button variant="secondary" onPress={props.onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
