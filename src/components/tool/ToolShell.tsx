"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { FileList } from "@/components/tool/FileList";
import { OptionsPanel } from "@/components/tool/OptionsPanel";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { addRecentEntry } from "@/lib/recent";
import {
  downloadBlob,
  toPdfError,
  type PdfErrorCode,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { ACCENT_BG_SOFT, ACCENT_TEXT, type Tool } from "@/lib/tools-registry";

export type ProcessResult = {
  blob: Blob;
  filename: string;
};

export type ToolRenderContext<TOptions> = {
  files: File[];
  options: TOptions;
  setOptions: (patch: Partial<TOptions>) => void;
  /**
   * Publica un error en el banner del shell. Opcional para quien lo
   * necesite: una herramienta puede seguir mostrando su propio aviso
   * local sin usar esto.
   */
  setError: (code: PdfErrorCode) => void;
};

export type ToolShellProps<TOptions> = {
  tool: Tool;
  defaultOptions: TOptions;
  /** Contenido del panel de opciones (sidebar desktop / sheet movil). */
  renderOptions?: (context: ToolRenderContext<TOptions>) => ReactNode;
  /** Contenido extra de la columna principal (miniaturas, previews...). */
  renderMain?: (context: ToolRenderContext<TOptions>) => ReactNode;
  /**
   * `signal` se aborta al cancelar. Los motores que no lo necesiten
   * pueden declarar menos parametros: una funcion de aridad 3 sigue
   * siendo asignable a este tipo.
   */
  process: (
    files: File[],
    options: TOptions,
    onProgress: ProgressCallback,
    signal: AbortSignal,
  ) => Promise<ProcessResult>;
  /** Numero minimo de archivos para habilitar el procesado. */
  minFiles?: number;
  /**
   * Condicion adicional para habilitar el boton de procesar. Se suma al
   * minimo de archivos; sin ella el comportamiento es el de siempre.
   */
  canRun?: (files: File[], options: TOptions) => boolean;
  /**
   * Mensaje del overlay de progreso. Por defecto, el nombre de la
   * herramienta; una herramienta con pasos largos puede narrarlos.
   */
  progressMessage?: string;
  /**
   * Se rellena con el disparador del mismo procesado que lanza el boton
   * del shell. Lo necesita quien conduce al usuario por un flujo propio
   * y quiere rematarlo con un boton suyo, sin duplicar ni la ejecucion ni
   * la pantalla de descarga.
   */
  runRef?: RefObject<(() => void) | null>;
  /**
   * Contenido extra despues de `DownloadScreen`, solo en `phase === "done"`.
   * Lo necesita quien quiere ofrecer algo mas que "empezar de nuevo" justo
   * tras descargar (ej. un prompt para reusar datos en otro documento). No
   * incluye un `reset()` propio a proposito: quien pasa `renderDone` es el
   * mismo componente que crea y pasa `resetRef` (o `runRef`), asi que ya
   * lo tiene en su propio closure -- reenviarlo aqui duplicaria la API sin
   * necesidad, y ademas ensuciaria este render con una funcion que lee
   * refs (`react-hooks/refs` lo marca con razon: nada impide que una
   * implementacion de `renderDone` la invoque sincronicamente en vez de
   * dentro de su propio manejador de evento).
   */
  renderDone?: (context: {
    result: ProcessResult;
    options: TOptions;
  }) => ReactNode;
  /**
   * Se rellena con una version de `reset()` que acepta un patch parcial de
   * opciones en vez de volver siempre a `defaultOptions`. Lo necesita quien
   * quiere reiniciar el flujo (archivo fuera, vuelta a `"idle"`) pero
   * conservando algo que el usuario ya cargo (ej. el roster de firmantes).
   */
  resetRef?: RefObject<((patch?: Partial<TOptions>) => void) | null>;
  /**
   * Se rellena con una funcion que carga archivos y un patch de opciones
   * sin pasar por el dropzone. Lo necesita quien reanuda un borrador
   * guardado (archivo reconstruido desde bytes) o importa una
   * configuracion. A diferencia de `resetRef`, deja `phase` en `"files"`
   * (hay archivo) en vez de `"idle"`.
   */
  loadRef?: RefObject<
    ((files: File[], patch?: Partial<TOptions>) => void) | null
  >;
};

type Phase = "idle" | "files" | "options" | "processing" | "done";

export function ToolShell<TOptions>({
  tool,
  defaultOptions,
  renderOptions,
  renderMain,
  process,
  minFiles = 1,
  canRun: canRunProp,
  progressMessage,
  runRef,
  renderDone,
  resetRef,
  loadRef,
}: ToolShellProps<TOptions>) {
  const t = useT();
  const Icon = tool.icon;
  const copy = t.tools[tool.slug];

  const [phase, setPhase] = useState<Phase>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [options, setOptionsState] = useState<TOptions>(defaultOptions);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const runIdRef = useRef(0);
  /** Controlador de la ejecucion en curso; `cancel()` lo aborta. */
  const abortRef = useRef<AbortController | null>(null);

  const setOptions = useCallback((patch: Partial<TOptions>) => {
    setOptionsState((previous) => ({ ...previous, ...patch }));
  }, []);

  const onFilesChange = useCallback((next: File[]) => {
    setFiles(next);
    setError(null);
    setPhase(next.length === 0 ? "idle" : "files");
  }, []);

  /**
   * Base de `reset()` y del `resetRef` expuesto: vuelve siempre a
   * `"idle"` sin archivos (nunca a un `phase` que exija `files` para
   * pintar, ver `showWorkspace` mas abajo), y aborta cualquier `process()`
   * en vuelo -- `reset()` hoy solo se alcanza tras `"done"` (sin ejecucion
   * en marcha), pero `resetRef` es publico y llamable en cualquier
   * momento, asi que necesita la misma guardia que ya usa `cancel()`.
   * Solo sobrevive del estado anterior lo que el patch nombra
   * explicitamente -- fusionar contra `defaultOptions`, no contra el
   * `options` actual, para no arrastrar datos del documento anterior
   * (huecos, valores de texto) que ya no describen el archivo nuevo.
   */
  const resetWith = useCallback(
    (patch?: Partial<TOptions>) => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setFiles([]);
      setOptionsState({ ...defaultOptions, ...patch });
      setResult(null);
      setProgress(0);
      setError(null);
      setPhase("idle");
    },
    [defaultOptions],
  );

  const reset = useCallback(() => resetWith(), [resetWith]);

  /**
   * Igual que `resetWith`, pero con archivos: entra directo a `"files"`
   * (o `"idle"` si `files` viene vacio) en vez de siempre a `"idle"`, para
   * quien reanuda un borrador o importa una configuracion sin pasar por
   * el dropzone. Misma guardia de `runIdRef`/`abortRef` que `resetWith`.
   */
  const loadWith = useCallback(
    (nextFiles: File[], patch?: Partial<TOptions>) => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      setFiles(nextFiles);
      setOptionsState({ ...defaultOptions, ...patch });
      setResult(null);
      setProgress(0);
      setError(null);
      setPhase(nextFiles.length === 0 ? "idle" : "files");
    },
    [defaultOptions],
  );

  const run = useCallback(async () => {
    if (files.length < minFiles) {
      setError(minFiles > 1 ? "needTwo" : "empty");
      return;
    }
    // La condicion propia de la herramienta se vuelve a evaluar aqui, no
    // solo al pintar el boton. Confiar en `disabled` deja pasar cualquier
    // ejecucion que arranque desde un render con estado ya obsoleto, y en
    // herramientas con consentimiento explicito eso es saltarse la
    // confirmacion.
    if (canRunProp && !canRunProp(files, options)) {
      setError("nothingSelected");
      return;
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    const controller = new AbortController();
    abortRef.current = controller;

    setError(null);
    setProgress(0);
    setPhase("processing");

    try {
      const output = await process(
        files,
        options,
        (value) => {
          if (runIdRef.current !== runId) return;
          setProgress(Math.round(Math.min(1, Math.max(0, value)) * 100));
        },
        controller.signal,
      );
      if (runIdRef.current !== runId) return;
      setResult(output);
      addRecentEntry(tool.slug, output.filename);
      setPhase("done");
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setError(toPdfError(caught).code);
      setPhase("files");
    }
  }, [canRunProp, files, minFiles, options, process, tool.slug]);

  useEffect(() => {
    if (!runRef) return;
    runRef.current = () => void run();
    return () => {
      runRef.current = null;
    };
  }, [run, runRef]);

  useEffect(() => {
    if (!resetRef) return;
    resetRef.current = resetWith;
    return () => {
      resetRef.current = null;
    };
  }, [resetWith, resetRef]);

  useEffect(() => {
    if (!loadRef) return;
    loadRef.current = loadWith;
    return () => {
      loadRef.current = null;
    };
  }, [loadWith, loadRef]);

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    // Ademas de ignorar el resultado, se pide al motor que pare: los
    // que escuchan la senal dejan de gastar CPU en el acto.
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("files");
    setProgress(0);
    setError("cancelled");
  }, []);

  const canRun =
    files.length >= minFiles &&
    (canRunProp ? canRunProp(files, options) : true);
  const showWorkspace = phase === "files" || phase === "options";

  const context: ToolRenderContext<TOptions> = {
    files,
    options,
    setOptions,
    setError,
  };

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-40 md:px-6 md:pt-12 md:pb-16">
      <header className="mb-8 flex items-start gap-4">
        <span
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-ios",
            ACCENT_BG_SOFT[tool.accent],
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-6", ACCENT_TEXT[tool.accent])}
          />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-black tracking-[-0.025em] text-foreground md:text-3xl">
              {copy.name}
            </h1>
            <Badge variant={tool.status === "live" ? "live" : "soon"} dot>
              {tool.status === "live" ? t.common.live : t.common.soon}
            </Badge>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {copy.description}
          </p>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-ios mb-6 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          <div>
            <p className="hud-label text-[10px] text-destructive">
              {t.tool.errors.title}
            </p>
            <p className="mt-1 text-sm text-foreground">
              {t.tool.errors[error]}
            </p>
          </div>
        </div>
      ) : null}

      {phase === "idle" ? (
        <FileDropzone
          tool={tool}
          files={files}
          onFilesChange={onFilesChange}
          onError={setError}
        />
      ) : null}

      {showWorkspace ? (
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <div className="min-w-0 flex-1">
            <h2 className="hud-label mb-3 text-[11px] text-muted-foreground">
              {t.tool.filesTitle}
            </h2>
            <FileList
              files={files}
              onChange={onFilesChange}
              reorderable={tool.multiple}
            />

            {tool.multiple ? (
              <FileDropzone
                tool={tool}
                files={files}
                onFilesChange={onFilesChange}
                onError={setError}
                compact
                className="mt-4"
              />
            ) : null}

            {renderMain ? <div className="mt-8">{renderMain(context)}</div> : null}

            <div className="mt-8 hidden md:block">
              <Button size="lg" disabled={!canRun} onClick={() => void run()}>
                {t.tool.run}
              </Button>
            </div>
          </div>

          {renderOptions ? (
            <OptionsPanel
              open={phase === "options"}
              onOpenChange={(open) => setPhase(open ? "options" : "files")}
              footer={
                <Button
                  fullWidth
                  size="lg"
                  disabled={!canRun}
                  onClick={() => {
                    setPhase("files");
                    void run();
                  }}
                >
                  {t.tool.run}
                </Button>
              }
            >
              {renderOptions(context)}
            </OptionsPanel>
          ) : null}
        </div>
      ) : null}

      {showWorkspace ? (
        <div
          className="glass-bar fixed inset-x-0 z-30 flex items-center gap-3 border-t border-white/10 px-4 py-3 md:hidden"
          style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
        >
          {renderOptions ? (
            <Button
              variant="secondary"
              size="md"
              onClick={() => setPhase("options")}
            >
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              {t.tool.openOptions}
            </Button>
          ) : null}
          <Button
            size="md"
            fullWidth
            disabled={!canRun}
            onClick={() => void run()}
          >
            {t.tool.run}
          </Button>
        </div>
      ) : null}

      {phase === "processing" ? (
        <ProcessingOverlay
          progress={progress}
          message={progressMessage ?? copy.name}
          onCancel={cancel}
        />
      ) : null}

      {phase === "done" && result ? (
        <>
          <DownloadScreen
            slug={tool.slug}
            filename={result.filename}
            size={result.blob.size}
            onDownload={() => downloadBlob(result.blob, result.filename)}
            onStartOver={reset}
          />
          {renderDone ? renderDone({ result, options }) : null}
        </>
      ) : null}
    </div>
  );
}
