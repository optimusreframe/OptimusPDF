"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { PDF_WORKER_SRC, getPdfJs } from "@/lib/pdf/core";
import { PasswordSheet } from "@/components/tool/PasswordSheet";
import { useI18n } from "@/lib/i18n";
import { useProFeatureFlag } from "@/app/pdf-pro/proFeatureFlags";
import { ProEmptyState } from "@/app/pdf-pro/ProEmptyState";
import { ProSuite } from "@/app/pdf-pro/ProSuite";
import { useProDraftAutosave } from "@/app/pdf-pro/proDraftAutosave";
import { proDraftsSupported, type SaveProDraftResult } from "@/app/pdf-pro/proDrafts";
import { useProCreate } from "@/app/pdf-pro/create/useProCreate";
import { useExportRunning } from "@/app/pdf-pro/export/useExportStore";
import { unloadGuardNeeded } from "@/app/pdf-pro/session/proLimits";
import { useReplaceGuard } from "@/app/pdf-pro/session/useReplaceGuard";
import { useUnloadGuard } from "@/app/pdf-pro/session/useUnloadGuard";
import { useProDraftList } from "@/app/pdf-pro/useProDrafts";
import { useProSession } from "@/app/pdf-pro/useProSession";
import { ProWorkingDocProvider, useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
import { ResumeGoneNotice } from "@/components/tool/ResumeGoneNotice";
import { resumeKindsOfTool } from "@/lib/resumeLinks";
import { useResumeLink } from "@/lib/useResumeLink";

/**
 * Entrada de PDF Pro (`/pdf-pro`). Monta el documento de trabajo y decide entre el estado vacio
 * (elegir/arrastrar un PDF, retomar un borrador) y la suite. Mientras hay un documento abierto marca
 * `data-pro-suite` en <html> para que el pie y la reserva de la barra movil no se pinten y la suite
 * ocupe la altura completa (como `data-action-bar` en `ToolShell`).
 */
export function ProToolClient() {
  return (
    <ProWorkingDocProvider>
      <ProApp />
    </ProWorkingDocProvider>
  );
}

const NO_SUBSCRIBE = () => () => {};

/** `/pdf-pro?resume=pro:<huella>` (desde Recientes, U0.6): el unico tipo de trabajo que restaura PDF Pro. */
const RESUME_KINDS = resumeKindsOfTool("pdf-pro");

/** Por que no se pudo guardar el borrador automatico (para avisar), o `null` si todo va bien. */
export type AutosaveIssue = "failed" | "tooBig" | "quota" | null;

function issueOf(result: SaveProDraftResult): AutosaveIssue {
  if (result.ok) return null;
  if (result.reason === "tooBig") return "tooBig";
  if (result.reason === "quota") return "quota";
  return "failed";
}

function ProApp() {
  const { t } = useI18n();
  const { announcement, document: workingDocument, dirty, stepInFlight, doc } = useProWorkingDoc();
  const session = useProSession();
  const { document: proDocument, intake } = session;
  const autosave = useProFeatureFlag("proAutosave");
  // El problema del borrador pertenece al documento en el que ocurrio: abrir otro no hereda el aviso del anterior.
  const [autosaveState, setAutosaveState] = useState<{ docId: string | null; issue: AutosaveIssue }>({ docId: null, issue: null });
  const autosaveIssue = autosaveState.docId === (workingDocument?.id ?? null) ? autosaveState.issue : null;
  // Mientras el borrador espera su escritura (debounce o guardado en curso) todavia no cubre lo ultimo hecho.
  const [draftWritePending, setDraftWritePending] = useState(false);
  useProDraftAutosave({
    enabled: autosave,
    onPendingChange: setDraftWritePending,
    onResult: (result) => {
      // Un guardado superado por otro mas reciente no dice nada del estado real: se ignora.
      if (!result.ok && result.reason === "superseded") return;
      setAutosaveState({ docId: doc.getState().document?.id ?? null, issue: issueOf(result) });
    },
  });
  const drafts = useProDraftList();
  const draftsSupported = useSyncExternalStore(NO_SUBSCRIBE, proDraftsSupported, () => true);
  // Abre el borrador de `?resume=pro:<id>` (el mismo `restoreDraft` de «Documentos recientes»); si ya no existe, avisa.
  const resumeLink = useResumeLink(RESUME_KINDS, (target) => session.restoreDraft(target.id, { quietGone: true }));

  // Cerrar o recargar la pestaña pide confirmacion con cambios sin descargar que el borrador no cubre (autoguardado
  // apagado, sin soporte, fallido, PDF cifrado o documento demasiado grande), con un paso en vuelo y, Wave 10, con una
  // exportacion en curso (se perderia el archivo que esta a punto de descargarse).
  const exportRunning = useExportRunning();
  const currentBytes = workingDocument ? (workingDocument.snapshots[workingDocument.cursor]?.byteLength ?? 0) : 0;
  useUnloadGuard(
    unloadGuardNeeded({
      dirty,
      autosaveEnabled: autosave,
      autosaveSupported: draftsSupported,
      autosaveFailed: autosaveIssue !== null,
      wasEncrypted: workingDocument?.wasEncrypted ?? false,
      currentBytes,
      draftWritePending,
      stepInFlight,
      exportRunning,
    }),
  );

  // Cambiar de documento con cambios sin descargar pide confirmacion; nuevo (imagenes, en blanco) tambien.
  const replace = useReplaceGuard();
  const openGuarded = replace.request;
  const create = useProCreate(
    useCallback(
      (file: File) => openGuarded(() => void session.openGenerated(file)),
      [openGuarded, session],
    ),
  );

  const headingRef = useRef<HTMLHeadingElement>(null);
  const dropzoneRef = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);

  // Con un documento abierto la suite ocupa la altura completa: sin pie ni reserva de la barra movil. En el
  // estado vacio NO se ocultan (la barra movil es la unica navegacion en un telefono).
  const hasDocument = proDocument !== null;
  useEffect(() => {
    if (!hasDocument) return;
    const root = window.document.documentElement;
    root.setAttribute("data-pro-suite", "");
    return () => root.removeAttribute("data-pro-suite");
  }, [hasDocument]);

  // El foco nunca cae a <body>: al abrir un documento va al titulo de la suite y, al cerrarlo, a la zona de carga. Se
  // aplica en la fase de LAYOUT del mismo commit que monta/desmonta los controles (antes de pintar el siguiente
  // cuadro): `document.activeElement` no pasa por <body> ni un fotograma. Si el destino aun no se deja enfocar
  // (animaciones de salida, controles que montan un instante despues) se reintenta cuadro a cuadro.
  const hadDocumentRef = useRef(false);
  useLayoutEffect(() => {
    if (hasDocument === hadDocumentRef.current) return;
    hadDocumentRef.current = hasDocument;
    const pick = () => (hasDocument ? headingRef.current : dropzoneRef.current);
    const first = pick();
    first?.focus({ preventScroll: true });
    if (first && window.document.activeElement === first) return;
    let frames = 0;
    let frame = 0;
    const retry = () => {
      const target = pick();
      target?.focus({ preventScroll: true });
      frames += 1;
      if ((!target || window.document.activeElement !== target) && frames < 60) frame = window.requestAnimationFrame(retry);
    };
    frame = window.requestAnimationFrame(retry);
    return () => window.cancelAnimationFrame(frame);
  }, [hasDocument]);

  // Cerrar el aviso de un archivo roto (o cancelar la hoja de contraseña) retira el control que tenia el foco: pasa al
  // titulo del documento o a la zona de carga en el MISMO commit, nunca a <body>.
  const previousPhaseRef = useRef(intake.phase);
  useLayoutEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = intake.phase;
    if (intake.phase !== "idle" || (previous !== "problem" && previous !== "password")) return;
    const active = window.document.activeElement;
    // El aviso y la hoja salen con una animacion: mientras salen siguen en el DOM (inertes) con el foco dentro.
    const leaving = !!active?.closest('[data-error-banner], [role="dialog"]');
    if (active && active !== window.document.body && active.isConnected && !leaving) return;
    (hasDocument ? headingRef.current : dropzoneRef.current)?.focus({ preventScroll: true });
  }, [intake.phase, hasDocument]);

  // Sin conexion: se precargan pdf.js y su worker con la pagina (en la cache HTTP) para que el PRIMER documento abra aunque
  // la red se corte antes de elegirlo. Los motores de conversion NO se precargan: siguen siendo carga diferida.
  useEffect(() => {
    if (typeof Worker === "undefined" || typeof navigator === "undefined" || navigator.onLine === false) return;
    const root = window.document.documentElement;
    // «Nuevo desde imagenes» tambien funciona sin red (modulo ligero: jszip solo se carga en su modo ZIP).
    void import("@/lib/pdf/imagesToPdf").catch(() => undefined);
    void getPdfJs()
      .then(() => fetch(PDF_WORKER_SRC, { cache: "force-cache" }))
      .then((response) => response.arrayBuffer())
      // Marca para las pruebas: desde aqui el primer documento abre aunque la red se corte.
      .then(() => root.setAttribute("data-pro-warm", "ready"))
      .catch(() => undefined);
    return () => root.removeAttribute("data-pro-warm");
  }, []);

  // Con un documento abierto, en reposo, se precargan los motores LIGEROS de exportacion (texto, Markdown y JSON, que
  // comparten el extractor) para que sigan funcionando si la red se corta. Los pesados (Word, Excel, PowerPoint,
  // imagenes en ZIP) NO: siguen cargandose solo al usarlos.
  useEffect(() => {
    if (!hasDocument || typeof navigator === "undefined" || navigator.onLine === false) return;
    const schedule: (callback: () => void) => number =
      typeof window.requestIdleCallback === "function"
        ? (callback) => window.requestIdleCallback(callback, { timeout: 4000 })
        : (callback) => window.setTimeout(callback, 1500);
    const cancel = typeof window.cancelIdleCallback === "function" ? window.cancelIdleCallback.bind(window) : window.clearTimeout.bind(window);
    const handle = schedule(() => {
      void Promise.all([
        import("@/lib/pdf/pdfToText"),
        import("@/lib/pdf/pdfToMarkdown"),
        import("@/lib/pdf/pdfToJson"),
      ])
        // Marca para las pruebas: texto, Markdown y JSON ya estan en la cache del navegador.
        .then(() => window.document.documentElement.setAttribute("data-pro-engines", "ready"))
        .catch(() => undefined);
    });
    return () => {
      cancel(handle);
      window.document.documentElement.removeAttribute("data-pro-engines");
    };
  }, [hasDocument]);

  // Un problema nuevo con el archivo lleva el foco al aviso.
  const problemKey = intake.phase === "problem" ? `${intake.code}:${intake.file?.name ?? ""}` : null;
  useEffect(() => {
    if (!problemKey) return;
    const frame = window.requestAnimationFrame(() => bannerRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [problemKey]);

  const password = intake.phase === "password" ? intake : null;

  return (
    <>
      {/* UNICA region viva de la pagina: anuncia abrir, aplicar, deshacer y rehacer. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {/* `key` por anuncio: dos mensajes iguales seguidos («Rotar» dos veces) vuelven a leerse. */}
        <span key={announcement?.id ?? 0}>{announcement?.text ?? ""}</span>
      </p>

      {proDocument ? null : (
        <ResumeGoneNotice region="alert" state={resumeLink} className="mx-auto w-full max-w-[960px] px-4 pt-6 md:px-6 md:pt-10" />
      )}

      {proDocument ? (
        <ProSuite
          openedFrom={session.openedFrom}
          openedTotal={session.openedTotal}
          draftOffer={session.draftOffer}
          draftBusy={session.draftBusy}
          onRestoreDraft={() => session.draftOffer && void session.restoreDraft(session.draftOffer.id)}
          onDiscardDraft={() => void session.discardDraft()}
          onClose={session.closeDocument}
          headingRef={headingRef}
          intakeProblem={intake.phase === "problem" ? { code: intake.code, fileName: intake.file?.name ?? null } : null}
          onDismissProblem={session.dismissProblem}
          problemBannerRef={bannerRef}
          autosaveIssue={autosave ? autosaveIssue : null}
          onOpenFile={(file) => openGuarded(() => void session.openFile(file))}
          onOpenDraft={(id) => openGuarded(() => void session.restoreDraft(id))}
          onNewFromImages={create.pickImages}
          onNewBlank={create.openBlank}
        />
      ) : (
        <ProEmptyState
          intake={intake}
          drafts={drafts.drafts}
          draftsSupported={drafts.supported}
          draftsLoaded={drafts.loaded}
          draftBusy={session.draftBusy}
          draftError={session.draftError}
          onFile={(file) => void session.openFile(file)}
          onDropzoneError={session.reportProblem}
          onOpenDraft={(id) => void session.restoreDraft(id)}
          onDismissProblem={session.dismissProblem}
          onNewFromImages={create.pickImages}
          onNewBlank={create.openBlank}
          dropzoneRef={dropzoneRef}
          bannerRef={bannerRef}
        />
      )}

      {create.node}
      {replace.node}

      <PasswordSheet
        key={password ? `${password.file.name}:${password.file.size}` : "none"}
        open={password !== null}
        onClose={session.cancelPassword}
        onSubmit={(value) => void session.submitPassword(value)}
        onCancel={session.cancelPassword}
        busy={password?.busy ?? false}
        wrong={password?.wrong ?? false}
        failed={password?.failed ?? false}
        attempt={password?.attempt ?? 0}
        fileName={password?.file.name}
        strings={t.tool.password}
      />
    </>
  );
}
