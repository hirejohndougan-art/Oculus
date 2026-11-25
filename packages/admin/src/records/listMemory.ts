/**
 * The items list's search words and filters per site, for this tab only:
 * in memory, never in the address or in storage, and forgotten whenever a
 * session ends or begins (`endSession`, session.ts), so the next person in
 * the same tab never sees them (T-046, D-083).
 */
import type { ListParams } from "./queries";

export interface RememberedList {
  readonly params: ListParams;
  readonly pages: readonly (string | undefined)[];
}

const remembered = new Map<string, RememberedList>();

export function rememberedList(siteId: string): RememberedList | undefined {
  return remembered.get(siteId);
}

export function rememberList(siteId: string, list: RememberedList): void {
  remembered.set(siteId, list);
}

/** Forgets every list's search words and filters. */
export function forgetLists(): void {
  remembered.clear();
}
