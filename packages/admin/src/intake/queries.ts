/**
 * Intake's server data (T-073): the accession register, one accession, and
 * an agent's donor contact. The server decides who may see them
 * (`donors.view`); a 403 means the person has no Donor relations role.
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import type { AccessionPage, AccessionView, DonorContactView } from "./model";

export const REGISTER_KEY = ["accessions"] as const;
export const accessionKey = (id: string) => ["accessions", "one", id] as const;
export const contactKey = (agentId: string) => ["donor-contact", agentId] as const;

/** At most this many pages (of 200) are read for one screen. */
export const MAX_PAGES = 25;

export interface Register {
  readonly accessions: readonly AccessionView[];
  /** More accessions exist than were read. */
  readonly truncated: boolean;
}

/** The organization's accessions, newest first, read page by page. */
export async function readRegister(signal?: AbortSignal): Promise<Register> {
  const out: AccessionView[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: string = before === null ? "" : `?before=${encodeURIComponent(before)}`;
    const reply: AccessionPage = await api<AccessionPage>(`/api/accessions${query}`, {
      ...(signal === undefined ? {} : { signal }),
    });
    out.push(...reply.accessions);
    before = reply.next;
    if (before === null) return { accessions: out, truncated: false };
  }
  return { accessions: out, truncated: true };
}

export function useRegister() {
  return useQuery({
    queryKey: REGISTER_KEY,
    queryFn: ({ signal }) => readRegister(signal),
  });
}

export function useAccession(id: string | undefined) {
  return useQuery({
    queryKey: accessionKey(id ?? ""),
    queryFn: () => api<AccessionView>(`/api/accessions/${encodeURIComponent(id ?? "")}`),
    enabled: id !== undefined,
    // The form starts from what was read; a refetch must not replace typed edits.
    refetchOnWindowFocus: false,
  });
}

/** An agent's contact details, or null when none are saved. */
export function useContact(agentId: string) {
  return useQuery({
    queryKey: contactKey(agentId),
    queryFn: async (): Promise<DonorContactView | null> => {
      try {
        return await api<DonorContactView>(`/api/donor-contacts/${encodeURIComponent(agentId)}`);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    refetchOnWindowFocus: false,
  });
}

/** Whether the server refused because the person has no Donor relations role. */
export function notPermitted(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}
