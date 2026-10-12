"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import { addRecentEntry } from "@/lib/recent";
import type { ProtectedExport } from "@/app/pdf-pro/ops/protectExport";
import { downloadFileName, savePrompt, type SavePrompt } from "@/app/pdf-pro/save/proSave";
import { ProtectSaveSheet, SaveAsSheet, SaveConfirmSheet } from "@/app/pdf-pro/save/SaveSheets";
import { getSaveStrings } from "@/app/pdf-pro/save/saveStrings";
import { getProAction } from "@/app/pdf-pro/shell/proActions";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";

type SaveSheetId = "confirm" | "saveAs" | "protect";

/**
 * Descargar y guardar de PDF Pro (Wave 7 · U8): «Descargar PDF» (con aviso previo de firmas digitales y de la copia
 * sin cifrar), «Guardar como…» (nombre) y «Guardar con contraseña…». `guard` es el de los modos: con un modo
 * abierto y cambios sin aplicar, preguntar antes. Devuelve las acciones y las hojas ya montables.
 *
 * Reglas: la descarga deja el documento limpio (`markSaved`); NINGUNA de las tres crea snapshot ni toca el historial.
 */
export function useProSave(guard: (run: () => void) => void): {
  download: () => void;
  openSaveAs: () => void;
  openProtect: () => void;
  sheets: ReactNode;
} {
  const { language } = useI18n();
  const { doc } = useProWorkingDoc();
  const [sheet, setSheet] = useState<SaveSheetId | null>(null);
  const [prompt, setPrompt] = useState<SavePrompt | null>(null);
  const [name, setName] = useState("");
  /** Documentos (por id de sesion) cuyo aviso de «copia sin cifrar» ya se dio. */
  const acknowledged = useRef(new Set<string>());

  const downloadNamed = useCallback(
    (fileName?: string) => {
      const bytes = doc.current();
      const state = doc.getState();
      if (!bytes || !state.document) return;
      const outName = fileName ?? downloadFileName(state.document, state.dirty);
      downloadBlob(new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }), outName);
      doc.markSaved();
      addRecentEntry("pdf-pro", outName);
      doc.announce(getSaveStrings(language).downloaded(outName));
    },
    [doc, language],
  );

  const startDownload = useCallback(() => {
    const override = getProAction("save");
    if (override) {
      override();
      return;
    }
    const state = doc.getState();
    if (!state.document) return;
    const pending = savePrompt(state.document, state.dirty, acknowledged.current.has(state.document.id));
    if (pending) {
      setPrompt(pending);
      setSheet("confirm");
      return;
    }
    downloadNamed();
  }, [doc, downloadNamed]);

  const download = useCallback(() => guard(startDownload), [guard, startDownload]);
  const openSaveAs = useCallback(
    () =>
      guard(() => {
        const state = doc.getState();
        if (!state.document) return;
        setName(downloadFileName(state.document, state.dirty));
        setSheet("saveAs");
      }),
    [doc, guard],
  );
  const openProtect = useCallback(() => guard(() => setSheet("protect")), [guard]);
  const close = useCallback(() => setSheet(null), []);

  const confirmDownload = () => {
    const state = doc.getState();
    if (state.document) acknowledged.current.add(state.document.id);
    setSheet(null);
    downloadNamed();
  };

  const submitSaveAs = (fileName: string) => {
    doc.rename(fileName);
    setSheet(null);
    downloadNamed(fileName);
  };

  const onProtected = (result: ProtectedExport, fileName: string) => {
    downloadBlob(result.blob, fileName);
    // Se guardo una copia cifrada de ESTE snapshot: ya no hay cambios sin guardar. El historial no cambia.
    doc.markSaved();
    addRecentEntry("pdf-pro", fileName);
    setSheet(null);
  };

  const sheets = (
    <>
      <SaveConfirmSheet
        open={sheet === "confirm"}
        prompt={prompt}
        onClose={close}
        onDownload={confirmDownload}
        onProtect={() => setSheet("protect")}
      />
      <SaveAsSheet open={sheet === "saveAs"} defaultName={name} onClose={close} onSubmit={submitSaveAs} />
      <ProtectSaveSheet open={sheet === "protect"} onClose={close} onProtected={onProtected} />
    </>
  );
  return { download, openSaveAs, openProtect, sheets };
}
