"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  estimateUsage,
  getLibraryMeta,
  listDocuments,
  subscribeToLibrary,
  type LibraryMeta,
  type LibraryUsage,
} from "@/lib/docLibrary/store";
import { templateStatuses, type TemplateStatus } from "@/lib/docLibrary/templatesStore";
import type { DocumentEntry } from "@/lib/docLibrary/types";

export type LibrarySnapshot = {
  /** Ya se leyo la biblioteca (antes no se sabe si esta vacia o no disponible). */
  loaded: boolean;
  /** `false` = sin IndexedDB: la lista esta vacia y la interfaz lo explica. */
  available: boolean;
  documents: DocumentEntry[];
  /** Estado de la plantilla por documento (los que no estan, no tienen plantilla). */
  statuses: ReadonlyMap<string, TemplateStatus>;
  usage: LibraryUsage | null;
  meta: LibraryMeta | null;
};

const EMPTY_STATUSES: ReadonlyMap<string, TemplateStatus> = new Map();
const INITIAL: LibrarySnapshot = {
  loaded: false,
  available: true,
  documents: [],
  statuses: EMPTY_STATUSES,
  usage: null,
  meta: null,
};

async function readSnapshot(withUsage: boolean): Promise<LibrarySnapshot> {
  const listed = await listDocuments();
  if (!listed.available) {
    return { loaded: true, available: false, documents: [], statuses: EMPTY_STATUSES, usage: null, meta: null };
  }
  const [statuses, usage, meta] = await Promise.all([
    templateStatuses().catch(() => EMPTY_STATUSES),
    withUsage ? estimateUsage().catch(() => null) : Promise.resolve(null),
    withUsage ? getLibraryMeta().catch(() => null) : Promise.resolve(null),
  ]);
  return { loaded: true, available: true, documents: listed.documents, statuses, usage, meta };
}

/**
 * Lee «Mis documentos» (lista, estado de plantilla y, si se pide, uso y persistencia) y se mantiene al dia: se vuelve a
 * leer cuando la biblioteca cambia (esta pestana u otra, por `subscribeToLibrary`). Nunca lanza.
 */
export function useDocumentLibrary(options: { withUsage?: boolean } = {}): LibrarySnapshot & { refresh: () => Promise<void> } {
  const withUsage = options.withUsage ?? false;
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(INITIAL);
  const latest = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    latest.current += 1;
    const ticket = latest.current;
    let next: LibrarySnapshot;
    try {
      next = await readSnapshot(withUsage);
    } catch {
      next = { loaded: true, available: false, documents: [], statuses: EMPTY_STATUSES, usage: null, meta: null };
    }
    // Una lectura mas reciente gana: dos avisos seguidos no deben dejar la pantalla con la respuesta vieja.
    if (mounted.current && ticket === latest.current) setSnapshot(next);
  }, [withUsage]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = subscribeToLibrary(() => {
      void refresh();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refresh]);

  return { ...snapshot, refresh };
}
