/**
 * Pieces the intake screens share (T-073): the deed status pill, the note
 * for people without a Donor relations role, and the problem text for the
 * accession codes.
 */
import type { ReactNode } from "react";
import { ApiError, problemText } from "../api";
import { Note } from "../components/ui";
import frame from "../frame/Frame.module.css";
import { DEED_LABELS, type DeedStatus } from "./model";
import { notPermitted } from "./queries";
import styles from "./Intake.module.css";

export function DeedPill(props: { readonly status: DeedStatus }) {
  const tone =
    props.status === "signed"
      ? styles.pillGreen
      : props.status === "not_needed"
        ? ""
        : props.status === "sent"
          ? styles.pillBlue
          : styles.pillAmber;
  return <span className={`${styles.pill} ${tone}`}>{DEED_LABELS[props.status]}</span>;
}

/** A screen's title with the reason it can't be shown. */
export function Refused(props: { readonly title: string; readonly error: unknown }) {
  return (
    <>
      <h1 className={frame.pageTitle}>{props.title}</h1>
      <Note tone="amber">
        {notPermitted(props.error)
          ? "Accessions, deeds and donors are for people with the Donor relations role, and for managers."
          : problemText(props.error)}
      </Note>
    </>
  );
}

export function Loading(): ReactNode {
  return <p role="status">Loading…</p>;
}

/** Plain words for the codes an accession save is refused with. */
export function accessionProblem(error: unknown): string {
  if (!(error instanceof ApiError)) return problemText(error);
  const codes = Array.isArray(error.body.issues)
    ? (error.body.issues as { code?: unknown; message?: unknown }[])
    : [];
  switch (error.code) {
    case "version_conflict":
      return "Someone else saved this accession since you opened it. Reload it and make your change again.";
    case "not_permitted":
      return "You can't save this: an accession can name only records of sites where you work with donors and accessions.";
    case "not_found":
      return "This accession no longer exists, or you can't see it.";
    case "too_many_records":
      return "That is too many records to check at once. Save it with fewer records.";
    case "invalid": {
      // The service's own messages are fixed sentences that never quote the
      // accession's text, so they can be shown as they are.
      const messages = codes
        .map((i) => (typeof i.message === "string" ? i.message : ""))
        .filter((m) => m !== "");
      return messages.length > 0
        ? messages.join(" ")
        : "Something in the accession isn't right. Check it and try again.";
    }
    default:
      return problemText(error);
  }
}
