"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileWarning,
  Info,
  Wrench,
} from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { Spinner } from "@/components/ui/Spinner";
import { REPAIR_STRINGS, type RepairStrings } from "@/app/repair-pdf/strings";
import { useI18n, localeTag } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  formatFileSize,
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

function Row({
  icon: Icon,
  tone,
  children,
}: {
  icon: typeof Info;
  tone: "neutral" | "good" | "warn";
  children: React.ReactNode;
}) {
  const color =
    tone === "warn"
      ? "text-destructive"
      : tone === "good"
        ? "text-success"
        : "text-muted-foreground";
  return (
    <div className="flex items-start gap-3">
      <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${color}`} />
      <p className="text-sm leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

/** Informe medido sobre el documento que se va a descargar. */
function RepairReportView({
  s,
  outcome,
  language,
}: {
  s: RepairStrings;
  outcome: RepairOutcome;
  language: string;
}) {
  const { report } = outcome;
  const { pagesRecovered, pagesDeclared } = report;
  // Solo se afirma una perdida cuando hay un denominador real y es mayor.
  const lost =
    pagesDeclared !== null && pagesDeclared > pagesRecovered
      ? pagesDeclared - pagesRecovered
      : 0;

  return (
    <div className="space-y-6">
      {/* Diagnostico */}
      <section>
        <h3 className="text-headline text-foreground">
          {s.damageTitle}
        </h3>
        <div className="mt-3 space-y-2">
          {report.damage.length === 0 ? (
            <Row icon={CheckCircle2} tone="good">
              {s.damageNone}
            </Row>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{s.damageIntro}</p>
              <ul className="space-y-2">
                {report.damage.map((signal) => (
                  <li key={signal}>
                    <Row icon={FileWarning} tone="warn">
                      {s.damage[signal]}
                    </Row>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      {/* Que se hizo */}
      <section>
        <h3 className="text-headline text-foreground">{s.planTitle}</h3>
        {report.actions.length === 0 ? (
          <div className="mt-3">
            <Row icon={CheckCircle2} tone="good">
              {s.actionsNone}
            </Row>
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {report.actions.map((action) => (
              <li key={action}>
                <Row icon={Wrench} tone="neutral">
                  {s.actions[action]}
                </Row>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Resultado medido */}
      <section>
        <h3 className="text-headline text-foreground">
          {s.resultTitle}
        </h3>
        <div className="mt-3 space-y-2">
          <Row icon={lost > 0 ? AlertTriangle : CheckCircle2} tone={lost > 0 ? "warn" : "good"}>
            {pagesDeclared !== null
              ? s.pagesRecoveredOf(pagesRecovered, pagesDeclared)
              : s.pagesRecovered(pagesRecovered)}
          </Row>

          {lost > 0 ? (
            <Row icon={AlertTriangle} tone="warn">
              {s.pagesLost(lost)}
            </Row>
          ) : pagesDeclared !== null ? (
            <Row icon={CheckCircle2} tone="good">
              {s.pagesComplete}
            </Row>
          ) : null}

          {report.failedPages.length > 0 ? (
            <Row icon={AlertTriangle} tone="warn">
              {s.failedPages(report.failedPages.join(", "))}
            </Row>
          ) : null}

          {report.bytesDiscarded > 0 ? (
            <Row icon={FileWarning} tone="warn">
              {s.bytesDiscarded(
                formatFileSize(report.bytesDiscarded, language),
              )}
            </Row>
          ) : null}

          <Row
            icon={report.textPreserved ? CheckCircle2 : AlertTriangle}
            tone={report.textPreserved ? "good" : "warn"}
          >
            {report.textPreserved ? s.textPreserved : s.textLost}
          </Row>
        </div>
      </section>
    </div>
  );
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
        return { blob: analysis.outcome.blob, filename };
      }

      const outcome = await repairPdf(file, {}, onProgress);
      return { blob: outcome.blob, filename };
    },
    [analysis, s.filenameSuffix],
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
