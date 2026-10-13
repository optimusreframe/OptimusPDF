"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n";
import { getExportStore, type ExportStore, type ExportStoreState } from "@/app/pdf-pro/export/exportStore";
import { useProWorkingDocInstance } from "@/app/pdf-pro/useProWorkingDoc";

/**
 * Conexion de React al almacen de exportacion (Wave 9): el almacen del documento de trabajo del proveedor y su estado
 * reactivo. Tambien le pasa el idioma, que usa para los anuncios que hace por su cuenta (terminar, cancelar, error).
 * Lo usan la pestaña «Convertir» y el indicador de la barra superior.
 */
export function useExportStore(): { store: ExportStore; state: ExportStoreState } {
  const doc = useProWorkingDocInstance();
  const { language } = useI18n();
  const store = getExportStore(doc);
  useEffect(() => {
    store.setLanguage(language);
  }, [store, language]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { store, state };
}
