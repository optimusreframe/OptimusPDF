"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useI18n } from "@/lib/i18n";
import { attachProUndoShortcuts } from "@/app/pdf-pro/proShortcuts";
import { ProWorkingDoc, type ProModeRegistration, type ProWorkingDocOptions } from "@/app/pdf-pro/proWorkingDoc";
import type { ProModeId, ProWorkingState } from "@/app/pdf-pro/proTypes";

/**
 * Conexion de React al documento de trabajo (Wave 7 · U2).
 *
 *  - `ProWorkingDocProvider` crea UNA instancia por montaje de `/pdf-pro` (o recibe una por
 *    `doc`, para tests), mantiene su idioma y engancha los atajos Ctrl/Cmd+Z / Ctrl+Shift+Z /
 *    Ctrl+Y a nivel de documento.
 *  - `useProWorkingDoc()` devuelve el estado reactivo y la instancia (`doc`) para llamar a
 *    `commit`, `undo`, `goTo`, `registerMode`... Sin proveedor, lanza un error claro.
 *  - `useProMode(modeId, { hasOwnUndo })` registra un modo con sesion propia mientras este montado.
 */
const ProWorkingDocContext = createContext<ProWorkingDoc | null>(null);

export type ProWorkingDocProviderProps = {
  children: ReactNode;
  /** Instancia ya creada (tests). Por defecto el proveedor crea la suya. */
  doc?: ProWorkingDoc;
  options?: ProWorkingDocOptions;
  /** `false` desactiva los atajos globales (tests de componentes sueltos). */
  shortcuts?: boolean;
};

export function ProWorkingDocProvider({ children, doc, options, shortcuts = true }: ProWorkingDocProviderProps) {
  const { language } = useI18n();
  const [owned] = useState(() => doc ?? new ProWorkingDoc({ language, ...options }));
  const instance = doc ?? owned;

  useEffect(() => {
    instance.setLanguage(language);
  }, [instance, language]);

  useEffect(() => {
    if (!shortcuts) return;
    return attachProUndoShortcuts(instance);
  }, [instance, shortcuts]);

  return <ProWorkingDocContext.Provider value={instance}>{children}</ProWorkingDocContext.Provider>;
}

/** La instancia del documento de trabajo del proveedor (o `explicit`). */
export function useProWorkingDocInstance(explicit?: ProWorkingDoc): ProWorkingDoc {
  const fromContext = useContext(ProWorkingDocContext);
  const doc = explicit ?? fromContext;
  if (!doc) {
    throw new Error("useProWorkingDoc necesita <ProWorkingDocProvider> (o una instancia explicita)");
  }
  return doc;
}

export type UseProWorkingDoc = ProWorkingState & { doc: ProWorkingDoc };

/** Estado reactivo del documento de trabajo + la instancia. */
export function useProWorkingDoc(explicit?: ProWorkingDoc): UseProWorkingDoc {
  const doc = useProWorkingDocInstance(explicit);
  const state = useSyncExternalStore(doc.subscribe, doc.getState, doc.getState);
  return { ...state, doc };
}

const NO_SUBSCRIBE = () => () => {};
const NO_STATE = (): ProWorkingState | null => null;

/**
 * Estado del documento de trabajo SI hay proveedor (los modos de Firmar y Rellenar lo leen para avisar de firmas
 * digitales y de la copia descifrada); `null` fuera de uno, sin lanzar (un modo suelto, un test de componente).
 */
export function useOptionalProWorkingDocState(): ProWorkingState | null {
  const doc = useContext(ProWorkingDocContext);
  return useSyncExternalStore(
    doc ? doc.subscribe : NO_SUBSCRIBE,
    doc ? doc.getState : NO_STATE,
    NO_STATE,
  );
}

/** Registra un modo con sesion propia mientras `active` (por defecto, mientras el componente esta montado). */
export function useProMode(
  modeId: ProModeId,
  registration: ProModeRegistration,
  active = true,
  explicit?: ProWorkingDoc,
): void {
  const doc = useProWorkingDocInstance(explicit);
  const { hasOwnUndo } = registration;
  useEffect(() => {
    if (!active) return;
    return doc.registerMode(modeId, { hasOwnUndo });
  }, [doc, modeId, hasOwnUndo, active]);
}
