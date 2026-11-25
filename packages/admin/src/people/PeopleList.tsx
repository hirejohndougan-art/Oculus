/** The people list (T-048): the members the person may see, with the roles they manage. */
import { useOutletContext } from "react-router";
import { problemText } from "../api";
import { Note, TextLink } from "../components/ui";
import type { FrameContext } from "../frame/Frame";
import frame from "../frame/Frame.module.css";
import styles from "./People.module.css";
import { grantText, refused, siteNames, usePeople } from "./shared";
import { when } from "./types";

export function PeopleList() {
  const { me } = useOutletContext<FrameContext>();
  const people = usePeople();
  const sites = siteNames(me);
  if (people.error !== null) {
    return (
      <>
        <h1 className={frame.pageTitle}>People</h1>
        <Note tone="amber">
          {refused(people.error)
            ? "Only system managers and site managers can see people."
            : problemText(people.error)}
        </Note>
      </>
    );
  }
  if (people.data === undefined) return <p role="status">Loading…</p>;
  const { rights } = people.data;
  return (
    <>
      <div className={styles.header}>
        <div>
          <h1 className={frame.pageTitle}>People</h1>
          <p className={frame.lead}>
            {rights.systemManager
              ? "Everyone in this organization."
              : "People who work on the sites you manage, and people with no role yet."}
          </p>
        </div>
        {rights.manageAccounts ? <TextLink href="/people/invite">Invite someone</TextLink> : null}
      </div>
      {people.data.truncated ? (
        <Note tone="blue">Only the first 2,000 people are listed.</Note>
      ) : null}
      <table className={styles.table}>
        <caption className={styles.muted}>
          {people.data.people.length === 1
            ? "1 person"
            : `${String(people.data.people.length)} people`}
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Roles</th>
            <th scope="col">Last signed in</th>
          </tr>
        </thead>
        <tbody>
          {people.data.people.map((p) => (
            <tr key={p.userId}>
              <td>
                <TextLink href={`/people/${p.userId}`}>{p.displayName}</TextLink>
                {p.disabled ? (
                  <span className={`${styles.pill} ${styles.pillRed}`}>Disabled</span>
                ) : null}
                {p.systemAdmin === true ? (
                  <span className={styles.pill}>System manager</span>
                ) : null}
              </td>
              <td>
                {p.nameOnly === true ? <span className={styles.muted}>Not shown</span> : p.email}
              </td>
              <td>
                {p.roles.length === 0 ? (
                  <span className={styles.muted}>No role</span>
                ) : (
                  p.roles.map((g) => (
                    <span key={g.id} className={styles.pill}>
                      {grantText(g, sites)}
                    </span>
                  ))
                )}
              </td>
              <td>
                {p.nameOnly === true ? (
                  <span className={styles.muted}>Not shown</span>
                ) : (
                  when(p.lastSignInAt ?? null)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
