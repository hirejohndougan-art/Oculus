/**
 * The sidebar's links to People, Roles and the Audit trail (T-048), shown
 * only where the server answers: the screens ask, the server decides.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-aria-components";
import { useLocation } from "react-router";
import { api } from "../api";
import styles from "./People.module.css";
import { usePeople } from "./shared";

export const AUDIT_ACCESS_KEY = ["audit", "access"] as const;

export function AdminNav() {
  const location = useLocation();
  const people = usePeople();
  const audit = useQuery({
    queryKey: AUDIT_ACCESS_KEY,
    queryFn: () => api<unknown>("/api/audit?limit=1"),
  });
  const links: [string, string][] = [];
  if (people.data !== undefined) links.push(["/people", "People"], ["/roles", "Roles"]);
  if (audit.data !== undefined) links.push(["/audit", "Audit trail"]);
  if (links.length === 0) return null;
  return (
    <ul className={styles.nav} aria-label="Administration">
      {links.map(([href, label]) => (
        <li key={href}>
          <Link
            className={styles.navLink}
            href={href}
            {...(location.pathname.startsWith(href) ? { "aria-current": "page" as const } : {})}
          >
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
