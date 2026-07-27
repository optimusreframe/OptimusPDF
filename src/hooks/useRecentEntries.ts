"use client";

import { useSyncExternalStore } from "react";
import {
  getRecentEntries,
  subscribeToRecentEntries,
  type RecentEntry,
} from "@/lib/recent";

const EMPTY: RecentEntry[] = [];

/**
 * Lee el historial local sin efectos: el snapshot del servidor es una
 * lista vacia y el cliente se sincroniza con localStorage.
 */
export function useRecentEntries(): RecentEntry[] {
  return useSyncExternalStore(
    subscribeToRecentEntries,
    getRecentEntries,
    () => EMPTY,
  );
}
