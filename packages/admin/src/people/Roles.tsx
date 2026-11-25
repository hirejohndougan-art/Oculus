/**
 * The roles (T-048): what each built-in role lets people do (D-072).
 * Built-in roles can't be changed; custom roles come in a later update
 * (T-041a), so this page reads only.
 */
import { problemText } from "../api";
import { Note } from "../components/ui";
import frame from "../frame/Frame.module.css";
import styles from "./People.module.css";
import { refused, useRoles } from "./shared";
import { PERMISSION_NAMES } from "./types";

export function Roles() {
  const roles = useRoles();
  if (roles.error !== null) {
    return (
      <>
        <h1 className={frame.pageTitle}>Roles</h1>
        <Note tone="amber">
          {refused(roles.error)
            ? "Only system managers and site managers can see roles."
            : problemText(roles.error)}
        </Note>
      </>
    );
  }
  if (roles.data === undefined) return <p role="status">Loading…</p>;
  const permissions = Object.keys(PERMISSION_NAMES);
  return (
    <>
      <div>
        <h1 className={frame.pageTitle}>Roles</h1>
        <p className={frame.lead}>
          What each role lets a person do on the site where they hold it. Only system managers
          change System settings, sites, templates and vocabularies.
        </p>
      </div>
      <Note tone="blue">
        These are Oculus's built-in roles and can't be changed. Roles of your own come in a later
        update.
      </Note>
      <table className={styles.table}>
        <caption className={styles.muted}>Built-in roles and what they allow</caption>
        <thead>
          <tr>
            <th scope="col">Role</th>
            {permissions.map((p) => (
              <th key={p} scope="col">
                {PERMISSION_NAMES[p]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roles.data.map((r) => (
            <tr key={r.role}>
              <th scope="row">{r.label}</th>
              {permissions.map((p) => (
                <td key={p}>
                  {r.permissions.includes(p) ? "Yes" : <span className={styles.muted}>No</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
