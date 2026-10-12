"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReadyEditor } from "@/app/edit-pdf/EditDocumentGate";
import type { EditNotice } from "@/app/edit-pdf/EditNotices";
import { exportEditedPdf, exportNotices, summarizeCounts, type ExportCounts } from "@/app/edit-pdf/editExport";
import { useEditPdfFeatureFlag } from "@/app/edit-pdf/editFeatureFlags";
import { inspectStructure, type PreparedDocument } from "@/app/edit-pdf/editPrepare";
import { isTool } from "@/app/edit-pdf/editTools";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { useEditSession } from "@/app/edit-pdf/useEditSession";
import { Spinner } from "@/components/ui/Spinner";
import { errorCopy } from "@/components/tool/errorCopy";
import { useI18n } from "@/lib/i18n";
import { MAX_SAFE_FILE_SIZE, toPdfError, type PdfErrorCode } from "@/lib/pdf/core";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
import { ProModeApplyError, useProModeControls, useProModeHost } from "@/app/pdf-pro/modes/modeContext";
import { getModeStrings } from "@/app/pdf-pro/modes/modeStrings";
import type { ProModeProps } from "@/app/pdf-pro/modes/modeTypes";

/**
 * Modos Editar y Anotar de PDF Pro (Wave 7 · U6): el MISMO editor de la herramienta suelta («Editar PDF»,
 * `ReadyEditor` → `EditWorkspace`) montado sobre el snapshot vigente, sin `ToolShell` ni zona de carga.
 *
 *  - `edit`: edicion del texto existente (bloques, barra compacta, tiradores), texto nuevo, imagenes, formas y
 *    «Aplanar pagina», con deshacer/rehacer propios y todos los avisos del editor.
 *  - `annotate`: la paleta de anotacion (resaltador, figuras, marca, texto, nota, imagen); el texto existente
 *    queda apagado salvo que se active «Seleccionar texto».
 *
 * «Aplicar» exporta con `exportEditedPdf` (texto → elementos → aplanar, el MISMO orden que la herramienta suelta)
 * y entrega los bytes a `onApply`, que crea UN snapshot. Los borradores se comparten con la herramienta suelta
 * (misma base y misma huella del contenido): un borrador de este PDF se recupera en cualquiera de los dos sitios.
 */

export type ProEditorVariant = "edit" | "annotate";

/** Cambios que cuenta la etiqueta del snapshot: todo lo que el editor anade, cambia o aplana. */
export function changeCount(counts: ExportCounts): number {
  return counts.editedTexts + counts.addedTexts + counts.images + counts.shapes + counts.flattenedPages;
}

type Prepared = { file: File; value: PreparedDocument };

export function ProEditorMode({
  variant,
  file,
  bytes,
  lang,
  onApply,
  onDirtyChange,
}: ProModeProps & { variant: ProEditorVariant }) {
  const { t } = useI18n();
  const strings = EDIT_STRINGS[lang];
  const flow = EDIT_FLOW_STRINGS[lang];
  const m = getModeStrings(lang);
  const { document } = useProWorkingDoc();
  const host = useProModeHost();
  const existingFlag = useEditPdfFeatureFlag("editExistingText");
  const edit = useEditSession();
  const [textSelect, setTextSelect] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const draftRef = useRef<{ discard: () => Promise<void> } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef(edit.session);
  useEffect(() => {
    sessionRef.current = edit.session;
  });

  const wasEncrypted = document?.wasEncrypted ?? false;
  const signatures = document?.signatures ?? "unknown";

  /* El documento ya llega descifrado y con las firmas comprobadas: solo falta contar formularios y marcadores. */
  useEffect(() => {
    let cancelled = false;
    void inspectStructure(bytes).then((structure) => {
      if (cancelled) return;
      setPrepared({
        file,
        value: {
          file,
          wasEncrypted,
          signatures,
          formFields: structure.formFields,
          flattenLoss: structure.flattenLoss,
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [bytes, file, wasEncrypted, signatures]);
  const ready = prepared && prepared.file === file ? prepared.value : null;
  const preparedRef = useRef<PreparedDocument | null>(null);
  useEffect(() => {
    preparedRef.current = ready;
  });

  /* Cambios sin aplicar: el host pregunta al salir. */
  const dirty = edit.pendingChangeCount > 0;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  /* ------------------------------ aplicar / descartar ------------------------------ */

  const apply = useCallback(async (): Promise<boolean> => {
    const doc = preparedRef.current;
    if (!doc) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    let outBytes: Uint8Array;
    let counts: ExportCounts;
    let notices: string[];
    try {
      const result = await exportEditedPdf(doc.file, sessionRef.current, { signal: controller.signal });
      outBytes = new Uint8Array(await result.blob.arrayBuffer());
      counts = result.counts;
      const items = exportNotices(
        result.warnings,
        { signatures: doc.signatures, wasEncrypted: doc.wasEncrypted, flattenedPages: result.counts.flattenedPages },
        flow,
      );
      const summary = summarizeCounts(result.counts, flow);
      notices = [...(summary ? [summary] : []), ...items];
    } catch (error) {
      const code: PdfErrorCode = toPdfError(error).code;
      if (code === "cancelled" || controller.signal.aborted) return false;
      const copy = errorCopy(t, code);
      throw new ProModeApplyError(`${m.host.applyFailed}. ${copy.message}`);
    } finally {
      abortRef.current = null;
    }
    // El borrador de ESTE snapshot ya no tiene sentido (lo aplicado vive en el snapshot nuevo): se borra antes de
    // entregar los bytes, mientras el autoguardado sigue vivo, para que no lo resucite al desmontarse el editor.
    await draftRef.current?.discard().catch(() => undefined);
    const label = variant === "edit" ? m.edit.label(changeCount(counts)) : m.annotate.label(changeCount(counts));
    await onApply(outBytes, label, { notices });
    return true;
  }, [flow, t, m, variant, onApply]);

  const discard = useCallback(async () => {
    abortRef.current?.abort();
    await draftRef.current?.discard().catch(() => undefined);
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  useProModeControls(ready ? { apply, discard, cancel } : null);

  /* ------------------------------ herramienta pedida desde fuera ------------------------------ */

  const intent = host?.intent ?? null;
  const toolRequest = useMemo(
    () => (intent && isTool(intent.tool) ? { tool: intent.tool, nonce: intent.nonce } : null),
    [intent],
  );

  /* ------------------------------ avisos extra ------------------------------ */

  const extraNotices = useMemo<EditNotice[]>(
    () =>
      bytes.byteLength > MAX_SAFE_FILE_SIZE ? [{ id: "large-file", tone: "warning", text: m.edit.largeFile }] : [],
    [bytes.byteLength, m.edit.largeFile],
  );

  const existingText = variant === "edit" ? existingFlag : existingFlag && textSelect;

  /* Entrar con el teclado (E, A, la paleta de comandos) deja el foco en <body> al desmontarse el visor: pasa a la
     paleta de herramientas del editor (la herramienta activa), para seguir con el teclado sin buscarlo. */
  const hasReady = ready !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasReady) return;
    let frames = 0;
    let frame = 0;
    const attempt = () => {
      const active = window.document.activeElement;
      // Con una hoja abierta (la paleta de comandos se esta cerrando) se espera a que termine y devuelva su foco.
      const sheetOpen = window.document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
      // Si se entro pulsando una pestaña (o el dock) el foco ya esta donde la persona lo puso: se respeta.
      const onTabControl = !!active?.closest('[data-pro-region="tabs"]');
      if (onTabControl) return;
      if (active && rootRef.current?.contains(active)) return;
      const stop = rootRef.current?.querySelector<HTMLElement>('[data-tool-palette] [tabindex="0"]');
      if (stop && !sheetOpen) {
        stop.focus({ preventScroll: true });
        return;
      }
      frames += 1;
      if (frames < 90) frame = window.requestAnimationFrame(attempt);
    };
    frame = window.requestAnimationFrame(attempt);
    return () => window.cancelAnimationFrame(frame);
  }, [hasReady]);

  if (!ready) {
    return (
      <div data-pro-editor-preparing="" className="surface-card rounded-ios-lg flex items-center gap-2 p-5">
        <p role="status" className="flex items-center gap-2 text-subheadline text-muted-foreground">
          <Spinner className="size-4" />
          {m.edit.preparing}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-pro-editor=""
      data-variant={variant}
      data-busy={host?.busy ? "" : undefined}
      className="flex h-full min-h-0 flex-col gap-2"
    >
      {variant === "annotate" ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={existingText}
            aria-disabled={!existingFlag || undefined}
            data-annotate-text-toggle=""
            title={existingFlag ? undefined : m.annotate.textToggleDisabled}
            onClick={() => {
              if (existingFlag) setTextSelect((value) => !value);
            }}
            className="relative flex min-h-9 items-center gap-2 rounded-ios-sm px-3 text-footnote font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal pointer-coarse:min-h-11 aria-checked:text-foreground aria-disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className={
                existingText
                  ? "size-2.5 rounded-full bg-signal forced-colors:bg-[Highlight]"
                  : "size-2.5 rounded-full border border-muted-foreground"
              }
            />
            {m.annotate.textToggle}
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ReadyEditor
          document={ready}
          session={edit}
          strings={strings}
          flow={flow}
          existingText={existingText}
          onError={() => undefined}
          onCancelFile={() => undefined}
          embedded
          variant={variant}
          initialPage={host?.initialPage}
          onPageChange={(page) => host?.reportPage(page)}
          hideFormLink
          extraNotices={extraNotices}
          draftRef={draftRef}
          toolRequest={toolRequest}
        />
      </div>
    </div>
  );
}
