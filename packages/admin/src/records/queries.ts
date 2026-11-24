/**
 * Server data for the item screens (T-046), through TanStack Query and the
 * fetch wrapper (D-073). Every request names the working site in
 * `X-Oculus-Site` (D-079). Record content lives only in the Query cache, in
 * memory, never in storage; signing out clears it.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
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

export function useTemplates(siteId: string) {
  return useQuery({
    queryKey: ["templates"],
    queryFn: async () =>
      (await api<{ templates: TemplateSummary[] }>("/api/templates", { site: siteId })).templates,
    staleTime: 60_000,
  });
}

export function useRecordTypes(siteId: string) {
  return useQuery({
    queryKey: ["record-types"],
    queryFn: async () =>
      (await api<{ recordTypes: RecordTypeSummary[] }>("/api/record-types", { site: siteId }))
        .recordTypes,
    staleTime: 60_000,
  });
}

export function useRecord(siteId: string, recordId: string) {
  return useQuery({
    queryKey: recordKey(recordId),
    queryFn: () =>
      api<ReadRecordReply>(`/api/records/${encodeURIComponent(recordId)}`, { site: siteId }),
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
