"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { errorCopy } from "@/components/tool/errorCopy";
import { useRoutedAnnouncement } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useI18n, type Language } from "@/lib/i18n";
import { toPdfError } from "@/lib/pdf/core";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { DocumentSessionHost } from "@/app/sign-pdf/DocumentSessionHost";
import { editResultText } from "@/app/sign-pdf/editReport";
import { CanvasCompactContext } from "@/app/sign-pdf/canvasCompact";
import {
  MultiFlow,
  SoloSignatureSurface,
  isEditOnlyJob,
  multiReady,
  prepareDocumentJob,
  runDocumentJobDetailed,
  type SignMode,
  type SignToolOptions,
} from "@/app/sign-pdf/SignToolClient";
import {
  EmbeddedBar,
  EmbeddedSessionShell,
  ModeHeader,
  type ModeWarning,
  useBusyFocus,
  useEmbeddedShell,
  useFocusReturn,
  useModeHostBridge,
  type EmbeddedPhase,
} from "@/app/sign-pdf/embeddedChrome";
import { useSignatureVault } from "@/app/sign-pdf/useSignatureVault";
import { useSessionBridge } from "@/app/sign-pdf/useSessionBridge";
import { DEFAULT_SESSION, viewOf, type SignSession } from "@/app/sign-pdf/signSession";
import { EMPTY_DOC_STATE, docIdOf, type DocId } from "@/app/sign-pdf/docSet";
import { soloReady } from "@/app/sign-pdf/soloSignature";
import { hasTextEdits } from "@/app/sign-pdf/textEdits";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS, withEmbeddedWording } from "@/app/sign-pdf/signEmbeddedStrings";
import type { VaultNotice } from "@/app/sign-pdf/vaultMessages";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { ProModeApplyError } from "@/app/pdf-pro/modes/modeContext";
import { proWarningText } from "@/app/pdf-pro/proStrings";
import type { ProSignatureState, ProWarning } from "@/app/pdf-pro/proTypes";

/**
 * Firmar DENTRO de PDF Pro (Wave 7 · U7): el mismo lienzo, paleta, baul de firmas, bloques y ceremonia de la
 * herramienta suelta, sin `ToolShell` ni dropzone, para UN documento («Solo yo» y «Varios firmantes»). La cola de
 * varios documentos de Firmar queda fuera de este modo (se usa la herramienta suelta).
 *
 * Es el MISMO codigo que la herramienta suelta, no una copia: `SoloSignatureSurface`, `MultiFlow`,
 * `DocumentSessionHost`, `prepareDocumentJob` y `runDocumentJob` (los mismos bytes de firma para la misma
 * sesion). Lo unico propio es el estado de la sesion (aqui un `useState`, alla el de `ToolShell`) y el final:
 * en lugar de descargar, el PDF firmado va a `onApply(bytes, etiqueta, { warnings })`, que el anfitrion
 * convierte en UN snapshot del documento de trabajo.
 *
 * Huella y snapshots. La sesion pertenece al documento con que se abrio (la identidad es `bytes`, o el `File`
 * si no hay): `documentKey` (la huella que sella cada firma capturada, y que `stampKeyOf` ata tambien a las
 * ediciones de texto) se calcula de ESE archivo y no cambia dentro del modo. Si desde fuera llega otro
 * documento (otro snapshot: Deshacer desde el historial, abrir otro archivo...), la sesion se DESCARTA entera
 * (se remonta con estado vacio) y se avisa si habia trabajo: ninguna captura ni sello de firma de un snapshot
 * vale para los bytes de otro. Aplicar es la unica transicion esperada: mientras se aplica, el snapshot nuevo
 * que crea el anfitrion no cuenta como «cambio externo». Si, aun asi, el documento cambio mientras se
 * generaba el PDF, el resultado se descarta (nunca se encadena sobre un documento que ya no es el de partida).
 *
 * Borradores. El modo NO escribe borradores de Firmar (`persistDraft={false}`): el borrador es el del propio
 * documento de PDF Pro, y la sesion de firma se descarta al salir (el aviso del modo lo dice). Asi no hay dos
 * borradores del mismo trabajo.
 *
 * Anfitrion. Con `ProModeHost` el modo registra su «aplicar» (`useModeHostBridge`) y el anfitrion dibuja
 * «Aplicar» y «Descartar», confirma antes si el PDF tiene firmas digitales y pregunta al salir con cambios; sin
 * anfitrion (uso aislado, pruebas) el modo dibuja sus propios botones.
 */

export type SignEmbeddedFacts = {
  /** Estado de las firmas digitales del documento abierto en PDF Pro. */
  signatures?: ProSignatureState;
  /** El documento se abrio cifrado: se trabaja con una copia sin contrasena. */
  encrypted?: boolean;
};

export type SignEmbeddedProps = {
  /** Documento actual (snapshot vigente). */
  file: File;
  /** Bytes del snapshot vigente: su referencia es la identidad de la sesion (si falta, la del `File`). */
  bytes?: Uint8Array;
  lang: Language;
  /** Recibe el PDF firmado. Rechaza si no se pudo crear el snapshot: la sesion sigue abierta. */
  onApply: (
    bytes: Uint8Array,
    label: string,
    opts?: {
      warnings?: ProWarning[];
      /** Avisos ya redactados (B1: que paso con el texto original editado); el anfitrion los muestra tras aplicar. */
      notices?: string[];
    },
  ) => Promise<void>;
  /** Descarta la sesion de firma (sin snapshot). */
  onCancel: () => void;
  /** Avisa de si hay trabajo de firma sin aplicar. */
  onDirtyChange?: (dirty: boolean) => void;
  facts?: SignEmbeddedFacts;
};

/** Hay algo que se perderia al descartar la sesion. */
export function hasSignProgress(view: SignToolOptions): boolean {
  return (
    view.signaturePng !== "" ||
    view.rect.width > 0 ||
    view.fields.length > 0 ||
    Object.keys(view.captures).length > 0 ||
    view.textFields.some((field) => field.source === "manual") ||
    Object.values(view.textValues).some((value) => value.trim().length > 0) ||
    hasTextEdits(view.textEdits) ||
    view.signers.some((signer) => signer.name.trim().length > 0)
  );
}

/** Avisos del documento (firmas digitales, copia descifrada) para la etiqueta de aplicar. */
export function embeddedWarnings(facts: SignEmbeddedFacts | undefined): ProWarning[] {
  const warnings: ProWarning[] = [];
  if (facts?.signatures === "active") warnings.push({ code: "signaturesInvalidated" });
  else if (facts?.signatures === "unknown") warnings.push({ code: "signaturesUnknown" });
  if (facts?.encrypted) warnings.push({ code: "decryptedCopy" });
  return warnings;
}

export function SignEmbedded({ file, bytes, lang, onApply, onCancel, onDirtyChange, facts }: SignEmbeddedProps) {
  const e = SIGN_EMBEDDED_STRINGS[lang];
  return (
    <EmbeddedSessionShell file={file} bytes={bytes} resetNotice={e.sessionReset} onDirtyChange={onDirtyChange}>
      <SignEmbeddedSession initialFile={file} lang={lang} onApply={onApply} onCancel={onCancel} facts={facts} />
    </EmbeddedSessionShell>
  );
}

type SessionProps = {
  initialFile: File;
  lang: Language;
  onApply: SignEmbeddedProps["onApply"];
  onCancel: () => void;
  facts?: SignEmbeddedFacts;
};

function SignEmbeddedSession({ initialFile, lang, onApply, onCancel, facts }: SessionProps) {
  const {
    identity,
    getIdentity,
    phase,
    setPhase: onPhase,
    setDirty: onDirty,
    notice,
    dismissNotice: onDismissNotice,
  } = useEmbeddedShell();
  const { t } = useI18n();
  const e = SIGN_EMBEDDED_STRINGS[lang];
  const strings = useMemo(() => withEmbeddedWording(lang), [lang]);
  const editStrings = EDIT_STRINGS[lang].inline;
  const certificateEnabled = useSignPdfFeatureFlag("completionCertificate");
  const vaultEnabled = useSignPdfFeatureFlag("signatureVault");
  const vault = useSignatureVault(vaultEnabled);
  // La sesion arranca con el archivo con que se abrio y no lo cambia: otro documento remonta todo.
  const [file] = useState(initialFile);
  const files = useMemo(() => [file], [file]);
  const applyRef = useRef<() => Promise<boolean>>(async () => false);
  // «Cancelar» del anfitrion mientras se aplica: el PDF que se esta generando se descarta al terminar.
  const cancelledRef = useRef(false);
  const { hosted, hostBusy, initialPage, reportPage } = useModeHostBridge(
    () => applyRef.current(),
    () => {
      cancelledRef.current = true;
    },
  );
  const [session, setSession] = useState<SignSession>(() => {
    // Con anfitrion, arranca en la pagina que se miraba en el visor.
    const id = docIdOf(initialFile);
    return initialPage > 0
      ? { ...DEFAULT_SESSION, docs: { [id]: { ...EMPTY_DOC_STATE, fieldPageIndex: initialPage } } }
      : DEFAULT_SESSION;
  });
  const setShellOptions = useCallback((patch: Partial<SignSession>) => {
    setSession((previous) => ({ ...previous, ...patch }));
  }, []);
  const bridge = useSessionBridge();

  const [composerOpen, setComposerOpen] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultNotice, setVaultNotice] = useState<VaultNotice | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef<EmbeddedPhase>("editing");
  const rootRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(true);
  const statusId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useFocusReturn(rootRef);

  const warnings = useMemo(() => embeddedWarnings(facts), [facts]);

  const changePhase = useCallback(
    (next: EmbeddedPhase) => {
      phaseRef.current = next;
      onPhase(next);
    },
    [onPhase],
  );

  /**
   * Genera el PDF firmado (los mismos `prepareDocumentJob` + `runDocumentJob` que la herramienta suelta) y se lo
   * da a `onApply`. Devuelve `true` si el documento se aplico. Los fallos propios son `ProModeApplyError` con el
   * texto ya redactado (el anfitrion lo muestra); los de `onApply` se relanzan tal cual.
   */
  const runApply = useCallback(
    async (docId: DocId, current: SignSession, ready: boolean): Promise<boolean> => {
      if (phaseRef.current !== "editing") return false;
      if (!ready) {
        if (hosted) throw new ProModeApplyError(e.notReady);
        setError(e.notReady);
        return false;
      }
      changePhase("applying");
      cancelledRef.current = false;
      setError(null);
      setProgress(0);
      let result: Uint8Array;
      let label: string;
      let notices: string[] = [];
      try {
        const job = await prepareDocumentJob(docId, file, current, {
          language: lang,
          strings: SIGN_STRINGS[lang],
          certificateEnabled,
        });
        const { blob, edits } = await runDocumentJobDetailed(job, (value) => {
          if (mountedRef.current) setProgress(value);
        });
        result = new Uint8Array(await blob.arrayBuffer());
        job.commit();
        // Que paso con el texto original editado (B1): resumen y avisos para la tarjeta de «Aplicado».
        const editText = editResultText(edits ? [{ docName: file.name, report: edits }] : [], lang, strings);
        notices = [...(editText.summary ? [editText.summary] : []), ...(editText.notices?.items ?? [])];
        // Los nombres de la etiqueta son los de quienes firman ESTE documento (tienen algun hueco), con nombre.
        const signing = new Set(viewOf(current, docId).fields.map((field) => field.signerId));
        const names =
          current.mode === "multi"
            ? current.signers
                .filter((signer) => signing.has(signer.id))
                .map((signer) => signer.name.trim())
                .filter(Boolean)
            : [];
        label = isEditOnlyJob(job)
          ? e.labelEdited
          : names.length > 0
            ? e.labelSignedBy(e.joinNames(names))
            : e.labelSigned;
      } catch (caught) {
        if (mountedRef.current) changePhase("editing");
        const message = `${e.applyFailed} ${errorCopy(t, toPdfError(caught).code).message}`;
        if (hosted) throw new ProModeApplyError(message);
        if (mountedRef.current) setError(message);
        return false;
      }
      if (cancelledRef.current) {
        cancelledRef.current = false;
        if (mountedRef.current) changePhase("editing");
        return false;
      }
      // El documento cambio mientras se generaba el PDF firmado: no se encadena sobre otro.
      if (getIdentity() !== identity) {
        if (mountedRef.current) changePhase("editing");
        if (hosted) throw new ProModeApplyError(e.staleResult);
        return false;
      }
      try {
        await onApply(
          result,
          label,
          warnings.length > 0 || notices.length > 0
            ? { ...(warnings.length > 0 ? { warnings } : {}), ...(notices.length > 0 ? { notices } : {}) }
            : undefined,
        );
      } catch (caught) {
        if (mountedRef.current) changePhase("editing");
        if (hosted) throw caught;
        if (mountedRef.current) setError(e.applyFailed);
        return false;
      }
      // `onApply` resolvio: el documento se aplico (con anfitrion, la confirmacion de firmas digitales ya se pidio
      // antes de llamar aqui). El anfitrion sustituye el modo al crear el snapshot, pero React lo desmonta DESPUES
      // de este punto: si pasado ese instante sigue montado con el mismo documento (un anfitrion que no lo
      // sustituye, o una confirmacion rechazada por la via propia), la sesion continua.
      window.setTimeout(() => {
        if (mountedRef.current && getIdentity() === identity) changePhase("editing");
      }, 0);
      return true;
    },
    [changePhase, certificateEnabled, e, file, getIdentity, hosted, identity, lang, onApply, strings, t, warnings],
  );

  return (
    <CanvasCompactContext.Provider value>
    <section
      ref={rootRef}
      aria-label={e.regionLabel}
      tabIndex={-1}
      data-pro-mode="sign"
      data-phase={phase}
      data-hosted={hosted ? "" : undefined}
      className="flex h-full min-h-0 flex-1 flex-col outline-none"
    >
      <DocumentSessionHost
        files={files}
        session={session}
        setShellOptions={setShellOptions}
        bridge={bridge}
        strings={strings}
        holdMessage={null}
        // El contenedor ocupa la region del modo (no el apilado de la herramienta suelta): asi la zona de
        // contenido se desplaza por si sola y la barra queda abajo.
        className="flex min-h-0 flex-1 flex-col"
      >
        {({ docId, file: activeFile, view, setView, session: hostSession }) => (
          <SessionBody
            docId={docId}
            file={activeFile}
            view={view}
            setView={setView}
            strings={strings}
            editStrings={editStrings}
            lang={lang}
            phase={phase}
            hostBusy={hostBusy}
            hosted={hosted}
            progress={progress}
            error={error}
            notice={notice}
            onDismissNotice={onDismissNotice}
            warnings={warnings}
            statusId={statusId}
            vaultEnabled={vaultEnabled}
            hasSaved={
              vaultEnabled && vault.status === "ready" && vault.entries.some((entry) => entry.signature !== null)
            }
            composerOpen={composerOpen}
            setComposerOpen={setComposerOpen}
            vaultOpen={vaultOpen}
            setVaultOpen={setVaultOpen}
            vaultNotice={vaultNotice}
            setVaultNotice={setVaultNotice}
            onDirty={onDirty}
            reportPage={reportPage}
            bindApply={(ready) => {
              applyRef.current = () => runApply(docId, hostSession, ready);
            }}
            onApplyNow={(ready) => void runApply(docId, hostSession, ready).catch(() => {})}
            onCancel={onCancel}
          />
        )}
      </DocumentSessionHost>
    </section>
    </CanvasCompactContext.Provider>
  );
}

type BodyProps = {
  docId: DocId;
  file: File;
  view: SignToolOptions;
  setView: (patch: Partial<SignToolOptions>) => void;
  strings: ReturnType<typeof withEmbeddedWording>;
  editStrings: (typeof EDIT_STRINGS)["es"]["inline"];
  lang: Language;
  phase: EmbeddedPhase;
  hostBusy: boolean;
  hosted: boolean;
  progress: number;
  error: string | null;
  notice: string | null;
  onDismissNotice: () => void;
  warnings: ProWarning[];
  statusId: string;
  vaultEnabled: boolean;
  hasSaved: boolean;
  composerOpen: boolean;
  setComposerOpen: (open: boolean) => void;
  vaultOpen: boolean;
  setVaultOpen: (open: boolean) => void;
  vaultNotice: VaultNotice | null;
  setVaultNotice: (notice: VaultNotice | null) => void;
  onDirty: (dirty: boolean) => void;
  reportPage: (page: number) => void;
  /** Deja listo el «aplicar» que invoca el anfitrion (con el documento y la sesion de ESTE pintado). */
  bindApply: (ready: boolean) => void;
  onApplyNow: (ready: boolean) => void;
  onCancel: () => void;
};

function SessionBody({
  docId,
  file,
  view,
  setView,
  strings,
  editStrings,
  lang,
  phase,
  hostBusy,
  hosted,
  progress,
  error,
  notice,
  onDismissNotice,
  warnings,
  statusId,
  vaultEnabled,
  hasSaved,
  composerOpen,
  setComposerOpen,
  vaultOpen,
  setVaultOpen,
  vaultNotice,
  setVaultNotice,
  onDirty,
  reportPage,
  bindApply,
  onApplyNow,
  onCancel,
}: BodyProps) {
  const e = SIGN_EMBEDDED_STRINGS[lang];
  const noticeRouted = useRoutedAnnouncement(notice ?? "");
  // Avisos de la cabecera: los del documento y, con texto editado, la nota de que el original se elimina (B1: se
  // pliegan todos en UNA linea «N avisos» y el lienzo no pierde alto).
  const headerWarnings = useMemo<ModeWarning[]>(
    () => [
      ...warnings.map((warning) => ({
        code: warning.code,
        short: e.warningShort[warning.code as keyof typeof e.warningShort],
        full: proWarningText(lang, warning),
      })),
      ...(hasTextEdits(view.textEdits)
        ? [{ code: "editedText", short: e.editedTextShort, full: strings.editTextNote, tone: "info" as const }]
        : []),
    ],
    [warnings, e, lang, view.textEdits, strings.editTextNote],
  );
  const ready = view.mode === "single" ? soloReady(view) : multiReady(view, view.signature);
  const dirty = hasSignProgress(view);

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    bindApply(ready);
  });
  useEffect(() => {
    reportPage(view.fieldPageIndex);
  }, [reportPage, view.fieldPageIndex]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = phase === "applying" || hostBusy;
  useBusyFocus(scrollRef, busy);

  return (
    <>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-2 max-md:scroll-pb-48 max-md:pb-52 md:px-4"
        data-pro-mode-scroll=""
        inert={busy}
      >
        <div className="mx-auto w-full max-w-[1100px] space-y-3">
          <h2 className="sr-only">{e.title}</h2>

          <ModeHeader
            leading={
              <div className="w-full max-w-xs min-w-[14rem] flex-1">
                <SegmentedControl<SignMode>
                  label={strings.modeLabel}
                  hideLabel
                  value={view.mode}
                  onChange={(mode) => setView({ mode })}
                  options={[
                    { value: "single", label: strings.modeSingle },
                    { value: "multi", label: strings.modeMulti },
                  ]}
                />
              </div>
            }
            notesLabel={e.notesLabel}
            notes={[view.mode === "single" ? strings.modeSingleHint : strings.modeMultiHint, e.notDigital, e.sessionNote]}
            warningsLabel={e.warningsTitle}
            warningsCount={e.warningsCount}
            warnings={headerWarnings}
          />

          {notice ? (
            <div
              role={noticeRouted ? undefined : "status"}
              className="flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5"
            >
              <span className="text-footnote text-foreground">{notice}</span>
              <Button variant="ghost" size="sm" onClick={onDismissNotice}>
                {SIGN_STRINGS[lang].confirmClose}
              </Button>
            </div>
          ) : null}

          {view.mode === "single" ? (
            <SoloSignatureSurface
              flowKey={docId}
              file={file}
              options={view}
              setOptions={setView}
              strings={strings}
              editStrings={editStrings}
              vaultEnabled={vaultEnabled}
              hasSaved={hasSaved}
              composerOpen={composerOpen}
              onComposerOpenChange={setComposerOpen}
              vaultOpen={vaultOpen}
              onVaultOpenChange={setVaultOpen}
              vaultNotice={vaultNotice}
              onVaultNoticeChange={setVaultNotice}
            />
          ) : (
            <MultiFlow
              key={docId}
              file={file}
              options={view}
              setOptions={setView}
              onFinish={() => onApplyNow(ready)}
              strings={strings}
              editStrings={editStrings}
              persistDraft={false}
            />
          )}
        </div>
      </div>

      <EmbeddedBar
        phase={phase}
        progress={progress}
        ready={ready}
        readyText={e.ready}
        notReadyText={e.notReady}
        error={error}
        statusId={statusId}
        applyLabel={e.apply}
        discardLabel={e.discard}
        applyingLabel={e.applying}
        onApply={() => onApplyNow(ready)}
        onCancel={onCancel}
        hosted={hosted}
      />
    </>
  );
}
