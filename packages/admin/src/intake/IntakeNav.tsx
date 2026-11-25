/**
 * The sidebar's Intake links (T-073): Accessions, Deeds of gift and Donors,
 * shown only when the server answers the register (Donor relations and
 * managers, `donors.view`): the screens ask, the server decides.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-aria-components";
import { useLocation } from "react-router";
import { api } from "../api";
import type { AccessionPage } from "./model";
import styles from "./Intake.module.css";

export const INTAKE_ACCESS_KEY = ["accession-register", "access"] as const;

export function IntakeNav() {
  const location = useLocation();
  const access = useQuery({
    queryKey: INTAKE_ACCESS_KEY,
    queryFn: () => api<AccessionPage>("/api/accessions"),
    staleTime: 60_000,
  });
  if (access.data === undefined) return null;
  const links: [string, string][] = [
    ["/intake/accessions", "Accessions"],
    ["/intake/deeds", "Deeds of gift"],
    ["/intake/donors", "Donors"],
  ];
  return (
    <div className={styles.navGroup}>
      <span className={styles.groupLabel} id="intake-nav">
        Intake
      </span>
      <ul className={styles.nav} aria-labelledby="intake-nav">
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
    </div>
  );
}
