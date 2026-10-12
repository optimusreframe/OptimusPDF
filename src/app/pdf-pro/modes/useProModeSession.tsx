"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Language } from "@/lib/i18n";
import type { ProTabId } from "@/app/pdf-pro/ProTabs";
import { useProWorkingDocInstance } from "@/app/pdf-pro/useProWorkingDoc";
import type { ProWarning } from "@/app/pdf-pro/proTypes";
import { ProModeApplyError, type ProModeControls, type ProModeIntent } from "@/app/pdf-pro/modes/modeContext";
import type { ProModeDefinition, ProModeProps } from "@/app/pdf-pro/modes/modeTypes";
import { getProMode } from "@/app/pdf-pro/modes/proModes";
import { getModeStrings, modeShortName } from "@/app/pdf-pro/modes/modeStrings";

/**
 * Maquina de estados del host de modos de PDF Pro (Wave 7 · U6). La usa `ProSuite`; el host visual es
 * `ProModeHost` y las hojas de confirmacion `ProModeSheets`.
 *
 * Reglas:
 *  - la pestana activa con un modo registrado monta ese modo EN LUGAR DEL VISOR;
 *  - «Aplicar» crea UN snapshot (`mode-apply`) y vuelve a la pestana de la que se vino, con el foco en ella;
 *  - salir (otra pestana, cerrar el documento, descargar...) con cambios sin aplicar pregunta: aplicar,
 *    descartar o seguir;
 *  - antes de aplicar, un PDF con firmas digitales (o sin poder comprobarlo) pide confirmacion;
 *  - mientras se aplica nada mas se puede hacer (ni salir ni lanzar otra cosa).
 */

export type AppliedResult = { label: string; notices: string[]; warnings: ProWarning[] };

export type ProModeSession = {
  /** Modo de la pestana actual, si lo hay. */
  def: ProModeDefinition | undefined;
  active: boolean;
  dirty: boolean;
  busy: boolean;
  /** Error de la ultima aplicacion fallida (texto ya redactado), o `null`. */
  error: string | null;
  /** Resultado de la ultima aplicacion (se muestra al volver al visor hasta cerrarlo). */
  result: AppliedResult | null;
  dismissResult: () => void;
  /** Pagina del visor al entrar (el modo arranca ahi). */
  entryPage: number;
  intent: ProModeIntent | null;
  setIntent: (tool: string | null) => void;
  controlsRef: { current: ProModeControls | null };
  /** El modo registro controles: el host dibuja «Aplicar» y «Descartar». */
  hasControls: boolean;
  registerControls: (controls: ProModeControls | null) => void;
  reportPage: (page: number) => void;
  /** Ejecuta `proceed` ahora o, con un modo sucio, tras preguntar (aplicar / descartar / seguir). */
  guard: (proceed: () => void) => void;
  /** El boton «Aplicar» de la barra. */
  requestApply: () => void;
  /** El boton «Descartar» de la barra (y `onCancel` del modo). */
  requestDiscard: () => void;
  cancelApply: () => void;
  /** Lo que recibe el modo. */
  onApply: ProModeProps["onApply"];
  onDirtyChange: (dirty: boolean) => void;
  /** Estado de las hojas de confirmacion. */
  sheets: {
    leave: { open: boolean };
    discard: { open: boolean };
    signatures: { open: boolean };
  };
  /** Acciones de las hojas. */
  actions: {
    leaveApply: () => void;
    leaveDiscard: () => void;
    leaveStay: () => void;
    discardConfirm: () => void;
    discardCancel: () => void;
    signaturesConfirm: () => void;
    signaturesCancel: () => void;
  };
};

export type UseProModeSessionArgs = {
  tab: ProTabId;
  setTab: (tab: ProTabId) => void;
  language: Language;
  /** Devuelve el foco al control de esa pestana (nunca a <body>). */
  focusTab: (tab: ProTabId) => void;
  getViewerPage: () => number;
  /** Tras volver al visor: lleva la vista a esta pagina. */
  restoreViewerPage: (page: number) => void;
};

/** Error interno: el resultado ya no corresponde al documento (se cerro o cambio mientras se aplicaba). */
export class ProModeStaleError extends Error {
  constructor() {
    super("stale");
    this.name = "ProModeStaleError";
  }
}

export function useProModeSession({
  tab,
  setTab,
  language,
  focusTab,
  getViewerPage,
  restoreViewerPage,
}: UseProModeSessionArgs): ProModeSession {
  const doc = useProWorkingDocInstance();
  const def = getProMode(tab);
  const modeTab = def?.tab ?? null;

  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AppliedResult | null>(null);
  const [intent, setIntentState] = useState<ProModeIntent | null>(null);
  const [hasControls, setHasControls] = useState(false);
  const [leave, setLeave] = useState<{ proceed: () => void } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [signatureOpen, setSignatureOpen] = useState(false);

  const controlsRef = useRef<ProModeControls | null>(null);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const applyLockRef = useRef(false);
  const returnTabRef = useRef<ProTabId>("home");
  const lastTabRef = useRef<ProTabId>(tab);
  const pageRef = useRef<number | null>(null);
  const signatureResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const signaturesConfirmedRef = useRef(false);
  const nonceRef = useRef(0);
  const langRef = useRef(language);
  useEffect(() => {
    langRef.current = language;
  });

  /* A que pestana se vuelve: la de la que se vino al abrir el modo (nunca otro modo ni el mismo). */
  useEffect(() => {
    const previous = lastTabRef.current;
    lastTabRef.current = tab;
    if (previous === tab) return;
    if (getProMode(tab) && !getProMode(previous)) returnTabRef.current = previous;
    if (!getProMode(tab)) pageRef.current = null;
  }, [tab]);

  /* Pagina con la que entra el modo: la del visor en el instante de entrar (lectura sin efectos, una por entrada). */
  const entryPage = useMemo(
    () => (modeTab ? getViewerPage() : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo cuenta el instante de entrar
    [modeTab],
  );

  /* Cada cambio de modo (o salir) parte limpio. */
  const [prevModeTab, setPrevModeTab] = useState<string | null>(modeTab);
  if (prevModeTab !== modeTab) {
    setPrevModeTab(modeTab);
    setDirtyState(false);
    setError(null);
    if (modeTab === null) setIntentState(null);
  }
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    if (modeTab === null) {
      controlsRef.current = null;
      dirtyRef.current = false;
    }
  }, [modeTab]);

  const setDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirtyState(value);
  }, []);

  const setBusyBoth = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  const registerControls = useCallback((controls: ProModeControls | null) => {
    controlsRef.current = controls;
    setHasControls(controls !== null);
  }, []);

  const reportPage = useCallback((page: number) => {
    pageRef.current = page;
  }, []);

  const setIntent = useCallback((tool: string | null) => {
    if (tool === null) {
      setIntentState(null);
      return;
    }
    nonceRef.current += 1;
    setIntentState({ tool, nonce: nonceRef.current });
  }, []);

  /* ------------------------------ salir ------------------------------ */

  const exit = useCallback(() => {
    const target = returnTabRef.current;
    const page = pageRef.current;
    controlsRef.current = null;
    setHasControls(false);
    setDirty(false);
    setIntentState(null);
    setTab(target);
    // Al volver el visor se vuelve a montar: se lleva a la pagina en la que se estaba trabajando.
    if (page !== null) restoreViewerPage(page);
    focusTab(target);
  }, [setTab, restoreViewerPage, focusTab, setDirty]);

  /* ------------------------------ firmas ------------------------------ */

  const askSignatures = useCallback((): Promise<boolean> => {
    signatureResolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      signatureResolveRef.current = resolve;
      setSignatureOpen(true);
    });
  }, []);

  const settleSignatures = useCallback((ok: boolean) => {
    const resolve = signatureResolveRef.current;
    signatureResolveRef.current = null;
    setSignatureOpen(false);
    resolve?.(ok);
  }, []);

  /** Pide confirmacion si el PDF tiene firmas (o no se pudo comprobar). `true` = seguir. */
  const confirmSignatures = useCallback(async (): Promise<boolean> => {
    if (signaturesConfirmedRef.current) return true;
    const signatures = doc.getState().document?.signatures ?? "none";
    if (signatures === "none") return true;
    const ok = await askSignatures();
    return ok;
  }, [doc, askSignatures]);

  /* ------------------------------ aplicar ------------------------------ */

  const onApply = useCallback<ProModeProps["onApply"]>(
    async (bytes, label, opts) => {
      if (!(await confirmSignatures())) return;
      const snapshot = await doc.commit(bytes, label, "mode-apply", {
        opId: `mode:${def?.id ?? "mode"}`,
      });
      if (!snapshot) throw new ProModeStaleError();
      setResult({ label, notices: opts?.notices ?? [], warnings: opts?.warnings ?? [] });
      setError(null);
      exit();
    },
    [doc, def?.id, confirmSignatures, exit],
  );

  const runApply = useCallback(async (): Promise<boolean> => {
    const controls = controlsRef.current;
    // Cerrojo SINCRONO: un segundo clic (o «Aplicar y salir») que llegue mientras se espera la confirmacion de
    // firmas no puede lanzar una segunda aplicacion = un segundo snapshot.
    if (!controls || busyRef.current || applyLockRef.current) return false;
    applyLockRef.current = true;
    setError(null);
    if (!(await confirmSignatures())) {
      applyLockRef.current = false;
      return false;
    }
    signaturesConfirmedRef.current = true;
    setBusyBoth(true);
    try {
      return await controls.apply();
    } catch (caught) {
      const text = getModeStrings(langRef.current).host;
      setError(
        caught instanceof ProModeApplyError
          ? caught.userMessage
          : caught instanceof ProModeStaleError
            ? text.applyStale
            : text.applyFailed,
      );
      return false;
    } finally {
      signaturesConfirmedRef.current = false;
      applyLockRef.current = false;
      setBusyBoth(false);
    }
  }, [confirmSignatures, setBusyBoth]);

  const requestApply = useCallback(() => {
    void runApply();
  }, [runApply]);

  const cancelApply = useCallback(() => {
    controlsRef.current?.cancel?.();
  }, []);

  /* ------------------------------ descartar ------------------------------ */

  const discardNow = useCallback(() => {
    const controls = controlsRef.current;
    const name = getModeStrings(langRef.current).host;
    void (async () => {
      try {
        await controls?.discard();
      } catch {
        // Borrar el borrador es un extra: no impide salir.
      }
      doc.announce(name.discarded(modeShortName(langRef.current, def?.tab ?? "edit")));
      exit();
    })();
  }, [doc, def?.tab, exit]);

  const requestDiscard = useCallback(() => {
    if (busyRef.current) return;
    if (dirtyRef.current) setDiscardOpen(true);
    else discardNow();
  }, [discardNow]);

  /* ------------------------------ guarda de salida ------------------------------ */

  const guard = useCallback(
    (proceed: () => void) => {
      if (busyRef.current) return;
      if (modeTab === null || !dirtyRef.current) {
        proceed();
        return;
      }
      setLeave({ proceed });
    },
    [modeTab],
  );

  const actions = useMemo(
    () => ({
      leaveApply: () => {
        const pending = leave;
        setLeave(null);
        if (!pending) return;
        void runApply().then((applied) => {
          // Aplicado: el modo ya salio hacia su pestana; se sigue con lo que se pedia (otra pestana, cerrar...).
          if (applied) pending.proceed();
        });
      },
      leaveDiscard: () => {
        const pending = leave;
        setLeave(null);
        if (!pending) return;
        const controls = controlsRef.current;
        void (async () => {
          try {
            await controls?.discard();
          } catch {
            // Sin bloquear la salida.
          }
          setDirty(false);
          pending.proceed();
        })();
      },
      leaveStay: () => {
        setLeave(null);
        doc.announce(getModeStrings(langRef.current).host.kept);
      },
      discardConfirm: () => {
        setDiscardOpen(false);
        discardNow();
      },
      discardCancel: () => setDiscardOpen(false),
      signaturesConfirm: () => settleSignatures(true),
      signaturesCancel: () => settleSignatures(false),
    }),
    [leave, runApply, setDirty, doc, discardNow, settleSignatures],
  );

  const dismissResult = useCallback(() => setResult(null), []);

  /* Al abrir otro documento o cerrar este, no sobrevive el resultado de aplicar. */
  const documentId = doc.getState().document?.id ?? null;
  useEffect(() => {
    return () => setResult(null);
  }, [documentId]);

  return {
    def,
    active: def !== undefined,
    dirty,
    busy,
    error,
    result,
    dismissResult,
    entryPage,
    intent,
    setIntent,
    controlsRef,
    hasControls,
    registerControls,
    reportPage,
    guard,
    requestApply,
    requestDiscard,
    cancelApply,
    onApply,
    onDirtyChange: setDirty,
    sheets: {
      leave: { open: leave !== null },
      discard: { open: discardOpen },
      signatures: { open: signatureOpen },
    },
    actions,
  };
}
