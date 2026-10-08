"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Info, SlidersHorizontal, X } from "lucide-react";
import { useScrollEdge } from "@/components/layout/useScrollEdge";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { FileList } from "@/components/tool/FileList";
import { OptionsPanel } from "@/components/tool/OptionsPanel";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { springs, withCrossFadeOpacity } from "@/lib/motion";
import { addRecentEntry } from "@/lib/recent";
import {
  downloadBlob,
  toPdfError,
  type PdfErrorCode,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  toolHref,
  type Tool,
} from "@/lib/tools-registry";

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

/** A donde va el foco tras el proximo render (ver `focusPending`). */
type FocusTarget = "run" | "download" | "dropzone";

/** Un elemento se puede enfocar si esta pintado (fixed incluido) y no es inert. */
function isFocusable(element: HTMLElement | null): element is HTMLElement {
  return (
    !!element &&
    element.isConnected &&
    element.getClientRects().length > 0 &&
    !element.closest("[inert]")
  );
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Errores con una salida directa: el mensaje ya la nombra en lenguaje
 * llano; aqui se convierte en un boton que lleva a ella.
 */
const ERROR_ACTIONS: Partial<Record<PdfErrorCode, { href: string; labelKey: "encryptedAction" }>> = {
  encrypted: { href: toolHref("unlock-pdf"), labelKey: "encryptedAction" },
};

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
  const belowHasContent = useScrollEdge("bottom");

  const [phase, setPhase] = useState<Phase>("idle");
  const [files, setFiles] = useState<File[]>([]);
  const [options, setOptionsState] = useState<TOptions>(defaultOptions);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const runIdRef = useRef(0);
  /** Controlador de la ejecucion en curso; `cancel()` lo aborta. */
  const abortRef = useRef<AbortController | null>(null);
  /** Archivos descartados por formato en la ultima carga (aviso no bloqueante). */
  const [skipped, setSkipped] = useState<string[]>([]);

  /*
   * Foco por fase. Lo que tenia el foco antes de procesar se desmonta
   * (el boton Procesar vive en el area de trabajo), asi que el overlay no
   * puede "devolverlo": aqui se decide el destino segun lo que acaba de
   * pasar y se aplica tras el render. Reintenta unos frames porque, al
   * terminar, el overlay sigue saliendo (AnimatePresence) y hasta que
   * retira `inert` del resto de la pagina el destino no es enfocable.
   */
  const pendingFocusRef = useRef<FocusTarget | null>(null);
  const runDesktopRef = useRef<HTMLButtonElement>(null);
  const runMobileRef = useRef<HTMLButtonElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const dropzoneButtonRef = useRef<HTMLButtonElement>(null);

  const setOptions = useCallback((patch: Partial<TOptions>) => {
    setOptionsState((previous) => ({ ...previous, ...patch }));
  }, []);

  const onFilesChange = useCallback((next: File[]) => {
    setFiles((previous) => {
      // Al quitar el ultimo archivo la lista se desmonta: el foco va a la
      // zona de carga en vez de caer a <body>.
      if (next.length === 0 && previous.length > 0) {
        pendingFocusRef.current = "dropzone";
      }
      return next;
    });
    setError(null);
    setSkipped([]);
    setPhase(next.length === 0 ? "idle" : "files");
  }, []);

  const onSkipped = useCallback((files: File[]) => {
    setSkipped(files.map((file) => file.name));
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
      setSkipped([]);
      pendingFocusRef.current = "dropzone";
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
      setSkipped([]);
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
      pendingFocusRef.current = "download";
      setPhase("done");
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setError(toPdfError(caught).code);
      pendingFocusRef.current = "run";
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
    pendingFocusRef.current = "run";
    setPhase("files");
    setProgress(0);
    setError("cancelled");
  }, []);

  // Aplica el foco pendiente tras el render de la fase nueva.
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    const candidates = (): (HTMLButtonElement | null)[] => {
      switch (target) {
        case "run":
          return [runDesktopRef.current, runMobileRef.current];
        case "download":
          return [downloadRef.current];
        case "dropzone":
          return [dropzoneButtonRef.current];
      }
    };
    let attempts = 0;
    let frame = 0;
    const tryFocus = () => {
      const element = candidates().find(isFocusable);
      if (element) {
        element.focus({ preventScroll: true });
        if (document.activeElement === element) return;
      }
      attempts += 1;
      if (attempts < 30) frame = window.requestAnimationFrame(tryFocus);
    };
    tryFocus();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [phase, files]);

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

  // Barra de accion fija en movil: el final de la pagina reserva su alto
  // (globals.css lee este atributo; se retira siempre al salir de la fase).
  useEffect(() => {
    if (!showWorkspace) return;
    document.documentElement.setAttribute("data-action-bar", "");
    return () => {
      document.documentElement.removeAttribute("data-action-bar");
    };
  }, [showWorkspace]);

  const skippedNotice =
    skipped.length === 1
      ? fillTemplate(t.tool.skippedOne, { names: skipped[0] })
      : skipped.length > 1
        ? fillTemplate(t.tool.skippedMany, {
            count: String(skipped.length),
            names: skipped.join(", "),
          })
        : null;

  const errorAction = error ? ERROR_ACTIONS[error] : undefined;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-40 md:px-6 md:pt-10 md:pb-16">
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-title-1 text-foreground">{copy.name}</h1>
            {tool.status === "soon" ? (
              <Badge variant="soon">{t.common.soon}</Badge>
            ) : null}
          </div>
          <p className="mt-1.5 max-w-2xl text-callout text-muted-foreground">
            {copy.description}
          </p>
        </div>
      </header>

      <AnimatePresence initial={false}>
        {error ? (
          <motion.div
            key={error}
            role="alert"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={withCrossFadeOpacity(springs.snappy)}
            className="mb-6 flex items-start gap-3 rounded-ios border border-destructive/35 bg-destructive/10 p-4 pr-2"
          >
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-destructive"
            />
            <div className="min-w-0 flex-1">
              <p className="text-subheadline font-semibold text-foreground">
                {t.tool.errors.title}
              </p>
              <p className="mt-0.5 text-subheadline text-muted-foreground">
                {t.tool.errors[error]}
              </p>
              {errorAction ? (
                <Link
                  href={errorAction.href}
                  className={cn(buttonClasses("secondary", "sm"), "mt-3")}
                >
                  {t.tool.errors[errorAction.labelKey]}
                </Link>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setError(null)}
              aria-label={t.common.close}
              className="group -mt-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
            >
              <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/10 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]">
                <X className="size-4" />
              </span>
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/*
        Region viva SIEMPRE montada: varios lectores de pantalla no anuncian
        una region que nace ya con contenido, asi que mientras no hay aviso el
        <p role="status"> existe vacio (sin caja ni margen) y lo unico que
        cambia es su texto. La caja visible (icono + boton de cierre) solo
        aparece con aviso; el boton queda fuera de la region para que no se
        lea junto al mensaje.
      */}
      <div
        className={
          skippedNotice
            ? "mb-6 flex items-start gap-3 rounded-ios border border-hairline bg-white/5 p-4 pr-2"
            : undefined
        }
      >
        {skippedNotice ? (
          <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        ) : null}
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={
            skippedNotice
              ? "min-w-0 flex-1 pt-0.5 text-subheadline text-foreground"
              : undefined
          }
        >
          {skippedNotice}
        </p>
        {skippedNotice ? (
          <button
            type="button"
            onClick={() => setSkipped([])}
            aria-label={t.common.close}
            className="group -mt-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
          >
            <span className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/10 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]">
              <X className="size-4" />
            </span>
          </button>
        ) : null}
      </div>

      {phase === "idle" ? (
        <FileDropzone
          tool={tool}
          files={files}
          onFilesChange={onFilesChange}
          onError={setError}
          onSkipped={onSkipped}
          buttonRef={dropzoneButtonRef}
        />
      ) : null}

      {showWorkspace ? (
        <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-8">
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="ui-label text-muted-foreground">
                {t.tool.filesTitle}
              </h2>
              {files.length > 1 ? (
                <span className="text-caption text-muted-foreground tabular-nums">
                  {files.length}
                </span>
              ) : null}
            </div>
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
                onSkipped={onSkipped}
                compact
                className="mt-3"
              />
            ) : null}

            {renderMain ? <div className="mt-8">{renderMain(context)}</div> : null}

            <div className="mt-8 hidden md:block">
              <Button
                ref={runDesktopRef}
                size="lg"
                disabled={!canRun}
                onClick={() => void run()}
              >
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
          data-scrolled={belowHasContent ? "true" : "false"}
          className="material-thick scroll-edge-top fixed inset-x-0 z-30 flex items-center gap-2 px-4 py-3 md:hidden"
          style={{
            borderWidth: 0,
            bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))",
          }}
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
            ref={runMobileRef}
            size="md"
            fullWidth
            disabled={!canRun}
            onClick={() => void run()}
          >
            {t.tool.run}
          </Button>
        </div>
      ) : null}

      <AnimatePresence>
        {phase === "processing" ? (
          <ProcessingOverlay
            key="processing"
            progress={progress}
            message={progressMessage ?? copy.name}
            onCancel={cancel}
          />
        ) : null}
      </AnimatePresence>

      {phase === "done" && result ? (
        <>
          <DownloadScreen
            slug={tool.slug}
            filename={result.filename}
            size={result.blob.size}
            onDownload={() => downloadBlob(result.blob, result.filename)}
            onStartOver={reset}
            downloadButtonRef={downloadRef}
          />
          {renderDone ? renderDone({ result, options }) : null}
        </>
      ) : null}
    </div>
  );
}
