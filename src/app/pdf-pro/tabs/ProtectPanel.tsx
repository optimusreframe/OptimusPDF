"use client";

import { useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorActions, errorCopy } from "@/components/tool/errorCopy";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useI18n } from "@/lib/i18n";
import { downloadBlob, toPdfError, type PdfErrorCode } from "@/lib/pdf/core";
import { DEFAULT_PROTECT_OPTIONS, ProtectValidationError, type ProtectOptions } from "@/lib/pdf/protect";
import { ProtectOptionsPanel } from "@/app/protect-pdf/ProtectOptionsPanel";
import { protectCanRun } from "@/app/protect-pdf/protectRules";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { buildProtectedExport, protectedFileName, type ProtectedExport } from "@/app/pdf-pro/ops/protectExport";
import { getProStrings, proWarningText } from "@/app/pdf-pro/proStrings";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";

export type ProtectPanelProps = {
  /** Bytes a cifrar; por defecto, los del snapshot actual. */
  bytes?: Uint8Array;
  fileName?: string;
  /**
   * Si se da, el resultado se entrega aqui (p. ej. el panel «Exportar» de U8) en vez de descargarse. En ambos
   * casos el documento de trabajo NO cambia: no hay snapshot ni borrador del archivo cifrado.
   */
  onProtected?: (result: ProtectedExport, fileName: string) => void;
};

/**
 * Panel «Guardar con contraseña…»: el mismo formulario y las mismas validaciones que Proteger PDF
 * (`ProtectOptionsPanel` + `protectCanRun`, con la comprobacion Latin-1) como opcion de guardado.
 */
export function ProtectPanel({ bytes, fileName, onProtected }: ProtectPanelProps) {
  const { t, language } = useI18n();
  const strings = getProStrings(language);
  const s = strings.docTools.protect;
  const protect = PROTECT_STRINGS[language];
  const { doc, document } = useProWorkingDoc();
  const [options, setOptionsState] = useState<ProtectOptions>({ ...DEFAULT_PROTECT_OPTIONS });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [legacy, setLegacy] = useState(false);

  if (!document) return null;
  const snapshot = document.snapshots[document.cursor];
  const source = bytes ?? snapshot.bytes;
  const name = fileName ?? document.name;
  const check = protectCanRun(options, protect);
  const disabled = busy || !check.ok;
  const copy = error ? errorCopy(t, error) : null;

  const setOptions = (patch: Partial<ProtectOptions>) => setOptionsState((previous) => ({ ...previous, ...patch }));

  const save = async () => {
    if (disabled) return;
    setBusy(true);
    setProgress(0);
    setError(null);
    setLegacy(false);
    try {
      const result = await buildProtectedExport(source, options, setProgress);
      const outName = protectedFileName(name, language);
      setLegacy(result.legacyRevisionIgnoredRestrictions);
      if (onProtected) onProtected(result, outName);
      else {
        downloadBlob(result.blob, outName);
        // Se guardo una copia de ESTE snapshot (cifrada): ya no hay cambios sin guardar. El historial no cambia.
        doc.markSaved();
        addRecent(outName);
      }
      doc.announce(s.saved(outName));
      // La contrasena no se conserva en pantalla tras guardar.
      setOptionsState({ ...DEFAULT_PROTECT_OPTIONS });
    } catch (caught) {
      // Una validacion fallida ya se explica con el motivo junto al boton: aqui solo errores del motor.
      setError(caught instanceof ProtectValidationError ? "unknown" : toPdfError(caught).code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="pro-protect-save-title" data-protect-panel="" className="space-y-4">
      <div>
        <h3 id="pro-protect-save-title" className="flex items-center gap-2 text-headline text-foreground">
          <ShieldCheck aria-hidden="true" className="size-5 shrink-0 text-accent-security" />
          {s.saveTitle}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.notAStep}</p>
      </div>

      {document.signatures === "active" ? (
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
          {s.signaturesWarning}
        </p>
      ) : null}

      <ProtectOptionsPanel options={options} setOptions={setOptions} strings={protect} fileSize={source.byteLength} />

      <div className="space-y-2">
        {!check.ok ? (
          <p id="pro-protect-reason" data-run-reason="" className="text-xs leading-relaxed text-muted-foreground">
            {check.reason}
          </p>
        ) : null}
        {busy ? <ProgressBar value={progress * 100} label={s.saving} /> : null}
        <Button
          fullWidth
          aria-disabled={disabled || undefined}
          aria-describedby={!check.ok ? "pro-protect-reason" : undefined}
          data-protect-save=""
          onClick={() => void save()}
        >
          {busy ? s.saving : s.saveButton}
        </Button>
      </div>

      {legacy ? <p className="text-xs leading-relaxed text-accent-edit">{s.legacyIgnored}</p> : null}
      {document.wasEncrypted ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{proWarningText(language, { code: "decryptedCopy" })}</p>
      ) : null}
      <ErrorBanner
        show={copy !== null}
        errorKey={error ?? undefined}
        title={copy?.title ?? s.failed}
        message={copy?.message ?? s.failed}
        hint={copy?.hint}
        actions={errorActions(t, error)}
        dismissLabel={t.common.close}
        onDismiss={() => setError(null)}
        className="mb-0"
      />
    </section>
  );
}

function addRecent(name: string): void {
  void import("@/lib/recent").then((module) => module.addRecentEntry("pdf-pro", name));
}
