/**
 * A record's sharing (T-041e, D-094), on its screen for people who may edit
 * it: the sites it is offered or shared to, withdrawing a share (asked
 * first), and, while it is published, offering it to another site by that
 * site's ID and its organization's, which the other site's manager gives
 * out. The other site sees only what the public site shows. Sites of this
 * organization are named; another organization's are shown by ID only,
 * since Oculus lists no other organization's sites.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, problemText } from "../api";
import { Button, Field, Note } from "../components/ui";
import { useMe } from "../frame/useMe";
import { ConfirmPanel } from "../records/controls";
import { issuesIn, whenText } from "../records/model";
import styles from "../records/Records.module.css";
import { SHARE_STATE_LABELS, cleanId, isId, isLive, type ShareSummary } from "./model";
import { moveShare, nextRecordSharesPage, refreshShares, useRecordShares } from "./queries";
import { useMorePages } from "./paging";
import { ShowMore } from "./ShowMore";

const OFFER_PROBLEMS: Readonly<Record<string, string>> = {
  unknown_site:
    "There is no such site under that organization, or it is this record's own site. Check both IDs with the other site's manager.",
  already_shared: "This record is already offered or shared to that site.",
  not_published: "Only a published record can be offered. Publish it first.",
};

export function SharingPanel(props: {
  readonly siteId: string;
  readonly recordId: string;
  readonly published: boolean;
}) {
  const queries = useQueryClient();
  const me = useMe().data;
  const shares = useRecordShares(props.siteId, props.recordId, true);
  const [organizationId, setOrganizationId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [errors, setErrors] = useState<{ organization?: string; site?: string }>({});
  const [status, setStatus] = useState<{ tone: "green" | "amber"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<ShareSummary>();
  // A ref, not only state: a second press before the re-render must not send twice.
  const sending = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (status !== undefined) statusRef.current?.focus();
  }, [status]);

  const where = (share: ShareSummary) => {
    const ours = me?.sites.find(
      (s) => s.siteId === share.targetSiteId && s.organizationId === share.targetOrganizationId,
    );
    if (ours !== undefined) return `${ours.siteName} (${ours.organizationName})`;
    return share.targetOrganizationId === me?.organizationId
      ? `A site of this organization (site ID ${share.targetSiteId})`
      : `A site of another organization (site ID ${share.targetSiteId}, organization ID ${share.targetOrganizationId})`;
  };

  async function offer() {
    const org = cleanId(organizationId);
    const site = cleanId(siteId);
    const found: { organization?: string; site?: string } = {};
    if (!isId(org))
      found.organization = "Paste the organization ID the other site's manager gave you.";
    if (!isId(site)) found.site = "Paste the site ID the other site's manager gave you.";
    setErrors(found);
    if (found.organization !== undefined || found.site !== undefined) return;
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    let result: { tone: "green" | "amber"; text: string };
    try {
      await api(`/api/records/${encodeURIComponent(props.recordId)}/shares`, {
        method: "POST",
        body: { targetOrganizationId: org, targetSiteId: site },
        site: props.siteId,
      });
      setOrganizationId("");
      setSiteId("");
      result = {
        tone: "green",
        text: "Offered. The other site's manager can now accept or decline it.",
      };
      await refreshShares(queries, site, props.recordId);
    } catch (error) {
      // The record is on screen, so a 404 here is the site: no such site
      // under that organization, or this record's own (S-050).
      const code =
        error instanceof ApiError && error.status === 422
          ? issuesIn(error.body)[0]?.code
          : error instanceof ApiError && error.status === 404
            ? "unknown_site"
            : undefined;
      result = {
        tone: "amber",
        text:
          (code !== undefined && Object.hasOwn(OFFER_PROBLEMS, code)
            ? OFFER_PROBLEMS[code]
            : undefined) ?? problemText(error),
      };
    }
    setStatus(result);
    setBusy(false);
    sending.current = false;
  }

  async function withdraw(share: ShareSummary) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    let result: { tone: "green" | "amber"; text: string };
    try {
      await moveShare(props.siteId, share.id, "withdraw");
      result = { tone: "green", text: "Withdrawn. That site no longer shows this record." };
    } catch (error) {
      result = {
        tone: "amber",
        text:
          error instanceof ApiError && error.status === 422
            ? "That share had already ended."
            : problemText(error),
      };
    }
    // The record's list here, and the other site's lists if they are cached.
    await refreshShares(queries, share.targetSiteId, props.recordId);
    setWithdrawing(undefined);
    setStatus(result);
    setBusy(false);
    sending.current = false;
  }

  const pages = useMorePages(shares.data, shares.dataUpdatedAt, (before) =>
    nextRecordSharesPage(props.siteId, props.recordId, before),
  );
  const list = pages.rows;
  const live = list.filter((s) => isLive(s.state));
  const ended = list.filter((s) => !isLive(s.state));

  return (
    <section className={styles.panel} aria-labelledby="sharing-title">
      <h2 id="sharing-title" className={styles.sectionTitle}>
        Sharing with other sites
      </h2>
      <p className={styles.meta}>
        Another site, of this organization or another one, can show this record read-only once its
        manager accepts. It sees only what the public site shows: never staff-only fields, notes or
        history.
      </p>
      <div ref={statusRef} tabIndex={-1} aria-live="polite" aria-atomic="true">
        {status === undefined ? null : <Note tone={status.tone}>{status.text}</Note>}
      </div>
      <ConfirmPanel
        key={withdrawing?.id ?? "closed"}
        isOpen={withdrawing !== undefined}
        title="Stop sharing with that site?"
        confirmLabel="Withdraw"
        danger
        busy={busy}
        onCancel={() => {
          setWithdrawing(undefined);
        }}
        onConfirm={() => {
          if (withdrawing !== undefined) void withdraw(withdrawing);
        }}
      >
        <p>
          {withdrawing === undefined ? "" : where(withdrawing)} stops showing this record at once.
          To share it again, offer it again.
        </p>
      </ConfirmPanel>
      {shares.isPending ? (
        <p role="status">Loading the sites it is shared with…</p>
      ) : shares.isError ? (
        <Note tone="amber" alert>
          The sharing list couldn't be loaded. {problemText(shares.error)}
        </Note>
      ) : live.length === 0 ? (
        <p>
          {pages.next === null
            ? "It isn't offered or shared to any other site."
            : "None of the shares shown so far are open. Show more to see older ones."}
        </p>
      ) : (
        <ul className={styles.versions} aria-label="Sites it is offered or shared to">
          {live.map((share) => (
            <li key={share.id} className={styles.version}>
              <span className={styles.versionTitle}>{where(share)}</span>
              <span>
                {SHARE_STATE_LABELS[share.state]} · offered {whenText(share.offeredAt)}
              </span>
              <span className={styles.actions}>
                <Button
                  variant="link"
                  isDisabled={busy}
                  onPress={() => {
                    setWithdrawing(share);
                  }}
                >
                  Withdraw from {where(share)}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {ended.length === 0 ? null : (
        <details className={styles.details}>
          <summary>
            Earlier shares ({String(ended.length)}
            {pages.next === null ? "" : " shown so far"})
          </summary>
          <ul>
            {ended.map((share) => (
              <li key={share.id}>
                {where(share)}: {SHARE_STATE_LABELS[share.state]}
                {share.endedAt === null && share.decidedAt === null
                  ? ""
                  : ` (${whenText(share.endedAt ?? share.decidedAt ?? share.offeredAt)})`}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ShowMore pages={pages} what="shares" />
      {props.published ? (
        <form
          className={styles.fieldset}
          aria-labelledby="offer-title"
          onSubmit={(event) => {
            event.preventDefault();
            void offer();
          }}
        >
          <h3 id="offer-title" className={styles.legend}>
            Offer to another site
          </h3>
          <p className={styles.meta}>
            Ask the other site's manager for their site ID and organization ID. They find both on
            their site's "Shared with this site" page.
          </p>
          <Field
            label="Organization ID"
            name="targetOrganizationId"
            value={organizationId}
            onChange={setOrganizationId}
            maxLength={64}
            error={errors.organization}
          />
          <Field
            label="Site ID"
            name="targetSiteId"
            value={siteId}
            onChange={setSiteId}
            maxLength={64}
            error={errors.site}
          />
          <div>
            <Button variant="secondary" type="submit" isDisabled={busy}>
              Offer this record
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.meta}>Only a published record can be offered to another site.</p>
      )}
    </section>
  );
}
