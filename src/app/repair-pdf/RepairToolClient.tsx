"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { Spinner } from "@/components/ui/Spinner";
import { RepairReportView, Row } from "@/app/repair-pdf/RepairReportView";
import { REPAIR_STRINGS } from "@/app/repair-pdf/strings";
import { useI18n, localeTag } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  RepairError,
  repairPdf,
  type RepairFailure,
  type RepairOutcome,
} from "@/lib/pdf/repair";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("repair-pdf");

/**
 * Reparar PDF: el analisis y la reparacion ocurren AL ELEGIR EL ARCHIVO,
 * no al pulsar el boton.
 *
 * El motivo es de honestidad, no de rendimiento. `ToolShell` sustituye el
 * area de trabajo por `DownloadScreen` en cuanto termina de procesar, y esa
 * pantalla es generica ("listo, descarga"). Si la reparacion se hiciera al
 * pulsar el boton, el informe de lo que REALMENTE se recupero — que es el
 * producto principal de esta herramienta — quedaria justo detras de la
 * pantalla que dice "listo". Reparando antes, el usuario lee el informe
 * completo (incluidas las paginas perdidas) ANTES de decidir si se
 * descarga el resultado.
 *
 * El resultado se guarda atado al objeto `File` exacto que lo produjo
 * (comparacion por identidad, como en unlock-pdf): asi es imposible que el
 * informe que se esta leyendo corresponda a un archivo distinto del que se
 * va a descargar.
 */

type Analysis =
  | { status: "idle"; file: null }
  | { status: "running"; file: File }
  | { status: "ready"; file: File; outcome: RepairOutcome }
  | { status: "failed"; file: File; reason: RepairFailure };

/** Puente entre el archivo que gobierna `ToolShell` y este componente. */
function FileWatcher({
  file,
  onFile,
}: {
  file: File | undefined;
  onFile: (file: File | null) => void;
}) {
  useEffect(() => {
    onFile(file ?? null);
  }, [file, onFile]);
  return null;
}

export function RepairToolClient() {
  const { language } = useI18n();
  const s = REPAIR_STRINGS[language];
  const tag = localeTag(language);

  const [analysis, setAnalysis] = useState<Analysis>({
    status: "idle",
    file: null,
  });
  /** Ultimo archivo atendido, para no reanalizar en cada remontaje. */
  const attendedRef = useRef<File | null>(null);

  const handleFile = useCallback((next: File | null) => {
    if (attendedRef.current === next) return;
    attendedRef.current = next;
    setAnalysis(
      next
        ? { status: "running", file: next }
        : { status: "idle", file: null },
    );
  }, []);

  // Analisis + reparacion en memoria del archivo recien elegido.
  useEffect(() => {
    if (analysis.status !== "running") return;
    const { file } = analysis;

    let cancelled = false;
    repairPdf(file)
      .then((outcome) => {
        if (cancelled || attendedRef.current !== file) return;
        setAnalysis({ status: "ready", file, outcome });
      })
      .catch((error: unknown) => {
        if (cancelled || attendedRef.current !== file) return;
        const reason: RepairFailure =
          error instanceof RepairError ? error.reason : "unreadable";
        setAnalysis({ status: "failed", file, reason });
      });

    return () => {
      cancelled = true;
    };
  }, [analysis]);

  const restrictedNotices = useCallback(
    (opened: boolean | undefined) =>
      opened ? { title: s.restrictedCopyTitle, items: [s.restrictedCopyNotice] } : undefined,
    [s.restrictedCopyNotice, s.restrictedCopyTitle],
  );

  const process = useCallback(
    async (
      files: File[],
      _options: Record<string, never>,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const filename = withSuffix(file.name, s.filenameSuffix);

      // El resultado ya calculado solo vale si pertenece EXACTAMENTE a
      // este archivo. Si no, se repara de nuevo en vez de entregar el
      // documento de otro.
      if (analysis.status === "ready" && analysis.file === file) {
        onProgress(1);
        return {
          blob: analysis.outcome.blob,
          filename,
          notices: restrictedNotices(analysis.outcome.report.openedDecryptedCopy),
        };
      }

      const outcome = await repairPdf(file, {}, onProgress);
      return {
        blob: outcome.blob,
        filename,
        notices: restrictedNotices(outcome.report.openedDecryptedCopy),
      };
    },
    [analysis, restrictedNotices, s.filenameSuffix],
  );

  /**
   * Solo se descarga con una reparacion resuelta con exito y perteneciente
   * al archivo actual. Fallar cerrado: mientras se analiza, si fallo, o si
   * el informe es de otro archivo, el boton se queda apagado.
   */
  const canRun = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return false;
      return analysis.status === "ready" && analysis.file === file;
    },
    [analysis],
  );

  return (
    <ToolShell<Record<string, never>>
      tool={TOOL}
      defaultOptions={{}}
      process={process}
      canRun={canRun}
      // Reparar abre justo los PDF danados y analiza el archivo al elegirlo (su propio informe).
      inputPolicy="off"
      renderMain={({ files }) => {
        const file = files[0] ?? null;
        const current = analysis.file === file ? analysis : null;

        return (
          <>
            <FileWatcher file={files[0]} onFile={handleFile} />

            <section className="glass rounded-ios space-y-6 p-5">
              {/* Alcance real: visible siempre, tambien antes de procesar. */}
              <div className="flex items-start gap-3">
                <Info
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0">
                  <h3 className="text-headline text-foreground">
                    {s.scopeTitle}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {s.scopeBody}
                  </p>
                </div>
              </div>

              <hr className="border-white/10" />

              {/* `current` no nulo implica `analysis.file === file`, y el
                  estado "idle" solo existe con `file: null`, asi que aqui
                  ya no puede darse. */}
              {!file || !current ? (
                <Row icon={Info} tone="neutral">
                  {s.idleBody}
                </Row>
              ) : current.status === "running" ? (
                <div className="flex items-center gap-3">
                  <Spinner />
                  <p className="text-sm text-muted-foreground">{s.analyzing}</p>
                </div>
              ) : current.status === "failed" ? (
                <div className="rounded-ios border border-destructive/40 bg-destructive/10 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle
                      aria-hidden="true"
                      className="mt-0.5 size-5 shrink-0 text-destructive"
                    />
                    <div className="min-w-0">
                      <h3 className="text-headline text-destructive-text">
                        {s.errorTitle}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-foreground">
                        {s.errors[current.reason]}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <RepairReportView
                  s={s}
                  outcome={current.outcome}
                  language={tag}
                />
              )}

              {file && file.size > MAX_SAFE_FILE_SIZE ? (
                <p className="text-xs leading-relaxed text-destructive">
                  {s.largeFile}
                </p>
              ) : null}
            </section>
          </>
        );
      }}
    />
  );
}
