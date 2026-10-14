"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { EditDocumentGate } from "@/app/edit-pdf/EditDocumentGate";
import { EditDraftsSheet } from "@/app/edit-pdf/EditDraftsSheet";
import { loadEditDraft, type EditDraftSummary } from "@/app/edit-pdf/editDrafts";
import { exportEditedPdf, exportNotices, summarizeCounts } from "@/app/edit-pdf/editExport";
import { useEditPdfFeatureFlag } from "@/app/edit-pdf/editFeatureFlags";
import type { PreparedDocument, SignatureState } from "@/app/edit-pdf/editPrepare";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { useEditSession } from "@/app/edit-pdf/useEditSession";
import { useI18n } from "@/lib/i18n";
import { PdfError, withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import { resumeKindsOfTool } from "@/lib/resumeLinks";
import { getTool } from "@/lib/tools-registry";
import { useResumeLink, type ResumeOutcome } from "@/lib/useResumeLink";
import { ResumeGoneNotice } from "@/components/tool/ResumeGoneNotice";

/*
 * La herramienta «Editar PDF» (Wave 5 · U5): todo inline sobre el documento,
 * sin formularios ni paneles de opciones aparte.
 *
 *  - `EditDocumentGate` comprueba el archivo al abrirlo (cifrado, firmas
 *    digitales, formularios, borrador previo) y monta el lienzo.
 *  - La sesion de edicion vive AQUI, fuera del area de trabajo del `ToolShell`:
 *    la fase de procesado desmonta `renderMain` y una vuelta atras tras un error o
 *    una cancelacion no debe perder las ediciones. Se reinicia solo cuando
 *    cambia el archivo.
 *  - Antes de exportar, si el documento tiene firmas digitales (o no se pudo
 *    comprobar), se pide confirmacion explicita (`beforeRun`).
 *  - La descarga lleva el resumen de lo hecho y la lista de avisos.
 *  - «Ver borradores» y «Borrar datos» siguen el patron de Firmar.
 *
 * El ajuste `editExistingText` apagado NO devuelve a ningun editor antiguo: solo
 * desactiva la edicion del texto que ya trae el PDF.
 */

const TOOL = getTool("edit-pdf");
const DEFAULT_OPTIONS = {};
/** `/edit-pdf?resume=edit:<huella>` (desde Recientes, U0.6): el unico tipo de trabajo que restaura el editor. */
const RESUME_KINDS = resumeKindsOfTool("edit-pdf");

function fileKeyOf(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function EditInlineTool() {
  const { language, t } = useI18n();
  const s = EDIT_STRINGS[language];
  const flow = EDIT_FLOW_STRINGS[language];
  const existingText = useEditPdfFeatureFlag("editExistingText");
  const edit = useEditSession();
  const sessionRef = useRef(edit.session);
  const sessionFileRef = useRef<File | null>(null);
  const preparedRef = useRef<PreparedDocument | null>(null);
  const [prepared, setPrepared] = useState<PreparedDocument | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const loadRef = useRef<((files: File[]) => void) | null>(null);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const [signatureAsk, setSignatureAsk] = useState<Exclude<SignatureState, "none"> | null>(null);
  const askResolveRef = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    sessionRef.current = edit.session;
  });

  const onPrepared = useCallback((document: PreparedDocument | null) => {
    preparedRef.current = document;
    setPrepared(document);
  }, []);
  const cancelFile = useCallback(() => resetRef.current?.(), []);

  const process = useCallback(
    async (
      files: File[],
      _options: object,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const original = files[0];
      const document = preparedRef.current;
      // Sin documento preparado no hay copia de trabajo (aun se esta comprobando).
      if (!document) throw new PdfError("empty");
      const result = await exportEditedPdf(document.file, sessionRef.current, { signal, onProgress });
      const items = exportNotices(
        result.warnings,
        {
          signatures: document.signatures,
          wasEncrypted: document.wasEncrypted,
          flattenedPages: result.counts.flattenedPages,
        },
        flow,
      );
      return {
        blob: result.blob,
        filename: withSuffix(original.name, s.filenameSuffix),
        summary: summarizeCounts(result.counts, flow),
        notices: items.length > 0 ? { title: flow.noticesTitle, items } : undefined,
      };
    },
    [flow, s.filenameSuffix],
  );

  /* Confirmacion de firmas: se pregunta ANTES del overlay de progreso (que es modal). */
  const beforeRun = useCallback((): boolean | Promise<boolean> => {
    const document = preparedRef.current;
    if (!document || document.signatures === "none") return true;
    return new Promise<boolean>((resolve) => {
      askResolveRef.current?.(false);
      askResolveRef.current = resolve;
      setSignatureAsk(document.signatures === "active" ? "active" : "unknown");
    });
  }, []);

  const settleSignatureAsk = (ok: boolean) => {
    askResolveRef.current?.(ok);
    askResolveRef.current = null;
    setSignatureAsk(null);
  };

  /**
   * Abre el documento de un borrador por su id: el editor lo restaura despues por la huella del contenido (`useEditDrafts`).
   * `gone` = ya no existe (se borro o se perdio); `failed` = no se pudo leer ahora (almacen bloqueado o sin soporte).
   */
  const openDraftById = useCallback(async (id: string): Promise<ResumeOutcome> => {
    const loaded = await loadEditDraft(id);
    if (!loaded.ok) return loaded.reason === "unavailable" || loaded.reason === "unsupported" ? "failed" : "gone";
    setResumeFailed(false);
    setDraftsOpen(false);
    loadRef.current?.([
      new File([loaded.draft.bytes as BlobPart], loaded.draft.meta.fileName, {
        type: "application/pdf",
      }),
    ]);
    return "restored";
  }, []);

  const resumeDraft = useCallback(
    async (draft: EditDraftSummary) => {
      if ((await openDraftById(draft.id)) !== "restored") setResumeFailed(true);
    },
    [openDraftById],
  );

  // `/edit-pdf?resume=edit:<id>`: abre ese borrador al entrar; si ya no existe lo dice `ResumeGoneNotice`.
  const resumeLink = useResumeLink(RESUME_KINDS, async (target) => {
    const outcome = await openDraftById(target.id);
    if (outcome === "failed") setResumeFailed(true);
    return outcome;
  });

  return (
    <Fragment>
      <div className="mx-auto mb-4 flex w-full max-w-[1200px] flex-wrap items-center gap-2 px-4 md:px-6">
        <Button
          variant="ghost"
          size="sm"
          data-edit-drafts-button=""
          className="pointer-coarse:h-11 pointer-coarse:before:hidden"
          onClick={() => {
            setResumeFailed(false);
            setDraftsOpen(true);
          }}
        >
          {flow.draftsButton}
        </Button>
        {/* Region de estado siempre montada: solo cambia su texto. */}
        <p
          role="status"
          data-resume-status=""
          className={resumeFailed ? "text-xs text-destructive-text" : "sr-only"}
        >
          {resumeFailed ? flow.draftsResumeFailed : ""}
        </p>
        <ResumeGoneNotice state={resumeLink} className="basis-full" />
      </div>
      <EditDraftsSheet
        open={draftsOpen}
        onClose={() => setDraftsOpen(false)}
        onResume={(draft) => void resumeDraft(draft)}
        flow={flow}
      />
      <ConfirmSheet
        open={signatureAsk !== null}
        onClose={() => settleSignatureAsk(false)}
        onConfirm={() => settleSignatureAsk(true)}
        title={flow.signaturesConfirmTitle}
        body={
          signatureAsk === "unknown"
            ? flow.signaturesConfirmBodyUnknown
            : flow.signaturesConfirmBodyActive
        }
        confirmLabel={flow.signaturesConfirmAction}
        cancelLabel={flow.signaturesConfirmCancel}
        closeLabel={t.common.close}
      />
      <ToolShell<object>
        tool={TOOL}
        defaultOptions={DEFAULT_OPTIONS}
        process={process}
        beforeRun={beforeRun}
        resetRef={resetRef}
        loadRef={loadRef}
        progressMessage={s.progressMessage}
        cancelledMessage={flow.exportCancelled}
        canRun={() =>
          prepared === null
            ? { ok: false, reason: "" }
            : edit.pendingChangeCount > 0
              ? { ok: true }
              : { ok: false, reason: flow.exportNeedsChange }
        }
        // Editar comprueba, descifra (hoja de contrasena) y avisa por su cuenta antes de abrir el lienzo.
        inputPolicy="off"
        renderMain={({ files, setError }) => {
          const file = files[0];
          if (!file) return null;
          return (
            <FileSession file={file} sessionFileRef={sessionFileRef} onNewFile={edit.reset}>
              <EditDocumentGate
                key={fileKeyOf(file)}
                file={file}
                session={edit}
                strings={s}
                flow={flow}
                existingText={existingText}
                onError={setError}
                onPrepared={onPrepared}
                onCancelFile={cancelFile}
              />
            </FileSession>
          );
        }}
      />
    </Fragment>
  );
}

/**
 * Reinicia la sesion solo cuando el archivo es OTRO objeto: volver de un error
 * o de una cancelacion conserva el mismo `File` (y las ediciones), y volver a
 * subir el mismo documento tras «Empezar de nuevo» es un `File` nuevo.
 */
function FileSession({
  file,
  sessionFileRef,
  onNewFile,
  children,
}: {
  file: File;
  sessionFileRef: { current: File | null };
  onNewFile: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (sessionFileRef.current !== file) {
      sessionFileRef.current = file;
      onNewFile();
    }
  }, [file, sessionFileRef, onNewFile]);
  return <>{children}</>;
}
