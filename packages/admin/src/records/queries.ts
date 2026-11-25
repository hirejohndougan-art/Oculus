/**
 * Server data for the item screens (T-046), through TanStack Query and the
 * fetch wrapper (D-073). Every request names the working site in
 * `X-Oculus-Site` (D-079). Record content lives only in the Query cache, in
 * memory, never in storage; signing out clears it.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useMe } from "../frame/useMe";
import type {
  ListedRecord,
  QueueEntry,
  ReadRecordReply,
  RecordTypeSummary,
  SiteAbilities,
  TemplateSummary,
  VersionSummary,
} from "./model";

export const recordKey = (recordId: string) => ["record", recordId] as const;
export const versionsKey = (recordId: string) => ["record", recordId, "versions"] as const;

export function useSiteAbilities(siteId: string | undefined) {
  return useQuery({
    queryKey: ["site", siteId, "abilities"],
    queryFn: () => api<SiteAbilities>("/api/working-site", { site: siteId ?? "" }),
    enabled: siteId !== undefined,
  });
}

/**
 * The organization's templates and record types: keyed by the organization
 * the session works in, so another organization's never answer after a
 * switch (D-019).
 */
export function useTemplates(siteId: string) {
  const organizationId = useMe().data?.organizationId;
  return useQuery({
    queryKey: ["templates", organizationId],
    queryFn: async () =>
      (await api<{ templates: TemplateSummary[] }>("/api/templates", { site: siteId })).templates,
    staleTime: 60_000,
    enabled: organizationId !== undefined,
  });
}

/** A template's stored Dublin Core mapping as the server sends it (T-050b, D-096). */
export interface StoredMappingReply {
  readonly version: number;
  readonly mapping: unknown;
}

/**
 * A template's stored Dublin Core mapping (T-050e, D-096), for the record
 * editor's note: a published record isn't shown on any public site when
 * its template has no mapping, or one that no longer fits it. Keyed by
 * organization, like the templates; the mapping and template screens
 * refresh it.
 */
export function useDublinCoreMapping(siteId: string, templateKey: string | undefined) {
  const organizationId = useMe().data?.organizationId;
  return useQuery({
    queryKey: ["dublin-core-status", organizationId, templateKey],
    queryFn: () =>
      api<StoredMappingReply>(`/api/templates/${templateKey ?? ""}/dublin-core`, { site: siteId }),
    staleTime: 60_000,
    enabled:
      organizationId !== undefined &&
      templateKey !== undefined &&
      /^[a-z][a-z0-9_-]{0,63}$/.test(templateKey),
  });
}

/**
 * Whether public output can use the mapping with this template: one is
 * stored, and every entry names a public field of the template (D-096:
 * public output refuses a mapping that no longer fits, such as a mapped
 * field since made staff only). The server's own check is the one that
 * counts; this only decides whether the editor warns.
 */
export function mappingFits(
  reply: StoredMappingReply,
  template: { readonly fields: readonly { readonly key: string; readonly visibility: string }[] },
): boolean {
  if (reply.version <= 0) return false;
  const mapping = reply.mapping;
  if (typeof mapping !== "object" || mapping === null) return false;
  const entries = (mapping as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return false;
  const publicKeys = new Set(
    template.fields.filter((f) => f.visibility === "public").map((f) => f.key),
  );
  return (entries as unknown[]).every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as { field?: unknown }).field === "string" &&
      publicKeys.has((e as { field: string }).field),
  );
}

export function useRecordTypes(siteId: string) {
  const organizationId = useMe().data?.organizationId;
  return useQuery({
    queryKey: ["record-types", organizationId],
    queryFn: async () =>
      (await api<{ recordTypes: RecordTypeSummary[] }>("/api/record-types", { site: siteId }))
        .recordTypes,
    staleTime: 60_000,
    enabled: organizationId !== undefined,
  });
}

export function useRecord(siteId: string, recordId: string) {
  return useQuery({
    queryKey: recordKey(recordId),
    queryFn: () =>
      api<ReadRecordReply>(`/api/records/${encodeURIComponent(recordId)}`, { site: siteId }),
    // The editor starts a fresh form for each version it is given: a
    // refetch on reconnect must not replace the form under typed edits. The
    // record is read again only after the person's own save, move, restore
    // or reload.
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
}

export interface ListParams {
  readonly q: string;
  readonly state: string;
  readonly type: string;
  readonly sort: "updated" | "title";
  readonly after: string | undefined;
}

/** The list's request: only what is set, in the query string (never in the page's address). */
export function listUrl(params: ListParams): string {
  const query = new URLSearchParams();
  const q = params.q.trim();
  if (q !== "") query.set("q", q);
  if (params.state !== "") query.set("state", params.state);
  if (params.type !== "") query.set("type", params.type);
  if (q === "" && params.sort !== "updated") query.set("sort", params.sort);
  if (params.after !== undefined) query.set("after", params.after);
  query.set("limit", "25");
  return `/api/records?${query.toString()}`;
}

export function useItems(siteId: string, params: ListParams) {
  return useQuery({
    queryKey: ["items", siteId, params],
    queryFn: () =>
      api<{ records: ListedRecord[]; next: string | null }>(listUrl(params), { site: siteId }),
  });
}

export function useReviewQueue(siteId: string, after: string | undefined) {
  return useQuery({
    queryKey: ["review-queue", siteId, after],
    queryFn: () =>
      api<{ records: QueueEntry[]; next: string | null }>(
        `/api/review-queue?limit=25${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
        { site: siteId },
      ),
  });
}

export function useVersions(siteId: string, recordId: string, enabled: boolean) {
  return useQuery({
    queryKey: versionsKey(recordId),
    queryFn: () =>
      api<{ versions: VersionSummary[]; next: number | null }>(
        `/api/records/${encodeURIComponent(recordId)}/versions?limit=100`,
        { site: siteId },
      ),
    enabled,
  });
}
