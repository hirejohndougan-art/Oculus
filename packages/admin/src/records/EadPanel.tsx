/**
 * EAD export for an archival unit (T-059b, D-120): two download links, EAD
 * 2002 (what TARO takes) and EAD3, for the unit and everything below it the
 * person may view. The server sends a download (never shown in the admin's
 * origin); staff-only values are in the file, marked audience="internal".
 */
import styles from "./Records.module.css";

/** The staff export's address for a version. */
export function eadUrl(recordId: string, version: "ead2002" | "ead3"): string {
  return `/api/records/${encodeURIComponent(recordId)}/ead?version=${version}`;
}

export function EadPanel(props: { recordId: string }) {
  return (
    <section className={styles.panel} aria-labelledby="ead-title">
      <h2 id="ead-title" className={styles.sectionTitle}>
        Finding aid (EAD)
      </h2>
      <p className={styles.meta}>
        Download this unit and everything below it as an EAD finding aid. Staff-only fields are
        included and marked as staff-only, so don't publish this file as it is.
      </p>
      <p>
        <a className={styles.downloadLink} href={eadUrl(props.recordId, "ead2002")} download>
          Download EAD 2002 (for TARO)
        </a>
        {" · "}
        <a className={styles.downloadLink} href={eadUrl(props.recordId, "ead3")} download>
          Download EAD3
        </a>
      </p>
    </section>
  );
}
