/**
 * The signed-in person, their organization and the sites they may open
 * (`GET /api/me`, D-072's `listMySites`), through TanStack Query. A 401
 * means the session has ended: the frame sends the person to sign in.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { Me } from "../types";

export const ME_KEY = ["me"] as const;

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: () => api<Me>("/api/me") });
}
