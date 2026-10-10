"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorCopy } from "@/components/tool/errorCopy";
import { useFocusTarget } from "@/components/tool/useFocusTarget";
import { useOwnToolFocus } from "@/components/tool/useOwnToolFocus";
import { OptionsPanel } from "@/components/tool/OptionsPanel";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { addRecentEntry } from "@/lib/recent";
import {
  downloadBlob,
  slugify,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import type { ImageMargin, ImagePageSize } from "@/lib/pdf/imagesToPdf";
import {
  DEFAULT_SCAN_OPTIONS,
  normalizeImageOrientation,
  scanToPdf,
  type ScanFilter,
  type ScanToPdfOptions,
} from "@/lib/pdf/scanToPdf";
import {
  detectDocumentInBlob,
  preloadDocumentDetection,
} from "@/lib/scan/documentDetection";
import {
  DEFAULT_QUAD,
  warpPerspective,
  type QuadCorners,
} from "@/lib/scan/perspective";
import { ACCENT_BG_SOFT, ACCENT_TEXT, getTool } from "@/lib/tools-registry";
import { CameraStage } from "@/app/scan-to-pdf/CameraStage";
import { CaptureStrip, type ScanCapture } from "@/app/scan-to-pdf/CaptureStrip";
import { CornerEditor } from "@/app/scan-to-pdf/CornerEditor";
import { STRINGS } from "@/app/scan-to-pdf/strings";

const TOOL = getTool("scan-to-pdf");

type Phase = "capture" | "options" | "processing" | "done";

type ScanResult = { blob: Blob; filename: string };

/**
 * Con una captura todavia en deteccion, el PDF se compondria con la foto
 * cruda y el recorte que termine despues no llegaria nunca al resultado.
 * Por eso el gate mira `pending`, no solo si hay capturas.
 */
export function canGenerate(captures: ScanCapture[]): boolean {
  return captures.length > 0 && captures.every((capture) => !capture.pending);
}

/**
 * Esta herramienta no usa `ToolShell` porque su entrada no son archivos
 * que el usuario suelta, sino fotogramas que se capturan en vivo. La
 * maquina de estados y el layout replican los de `ToolShell` para que la
 * experiencia sea la misma que en el resto del catalogo.
 */
export function ScanToPdfClient() {
  const { t, language } = useI18n();
  const s = STRINGS[language];
  const Icon = TOOL.icon;
  const copy = t.tools["scan-to-pdf"];

  const [phase, setPhase] = useState<Phase>("capture");
  const [captures, setCaptures] = useState<ScanCapture[]>([]);
  const [options, setOptions] = useState<ScanToPdfOptions>(DEFAULT_SCAN_OPTIONS);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  // Mismo foco que ToolShell: un aviso nuevo recibe el foco (nunca <body>).
  const { bannerRef } = useOwnToolFocus({
    bannerKey: error && error !== "cancelled" ? error : null,
    checking: false,
  });
  const [result, setResult] = useState<ScanResult | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const runIdRef = useRef(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  /** Parametros del destino de foco pedido (que captura, que accion, que posicion). */
  const focusArgRef = useRef<{ id: string; action: string; index: number }>({ id: "", action: "edit", index: 0 });

  /*
   * Foco con destino logico (mismo mecanismo que ToolShell): descartar, mover, deshacer el recorte, cerrar el
   * editor de esquinas, cancelar y volver a empezar desmontan el control pulsado; el foco pasa en el mismo
   * commit a la siguiente captura, a la misma accion de su captura, a la camara o al boton que sustituye.
   */
  const { request: askFocus } = useFocusTarget<
    "capture" | "afterRemove" | "camera" | "run" | "download" | "editor"
  >((target) => {
    const camera = (action: string) =>
      document.querySelector<HTMLElement>(`[data-camera-stage] [data-camera-action="${action}"]`);
    const cameraCandidates = [camera("capture"), camera("start"), camera("native"), camera("upload")];
    const lis = () => Array.from(stripRef.current?.querySelectorAll<HTMLElement>("[data-capture-id]") ?? []);
    const action = (li: Element | null | undefined, name: string) =>
      li?.querySelector<HTMLElement>(`[data-capture-action="${name}"]`) ?? null;
    switch (target) {
      case "capture": {
        const { id, action: wanted } = focusArgRef.current;
        const li = lis().find((item) => item.getAttribute("data-capture-id") === id);
        const siblings = Array.from(li?.querySelectorAll<HTMLElement>("[data-capture-action]") ?? []);
        return { candidates: [action(li, wanted), ...siblings, ...cameraCandidates] };
      }
      case "afterRemove": {
        const all = lis();
        const li = all[Math.min(focusArgRef.current.index, all.length - 1)];
        return { candidates: [action(li, "remove"), ...cameraCandidates] };
      }
      case "camera":
        return { candidates: cameraCandidates };
      case "run":
        return { candidates: Array.from(document.querySelectorAll<HTMLElement>("[data-scan-generate]")) };
      case "download":
        return { candidates: [downloadRef.current] };
      case "editor":
        return {
          candidates: [
            document.querySelector<HTMLElement>('[data-corner-editor] [data-editor-action="close"]'),
          ],
        };
    }
  });

  // Los object URL de las miniaturas se revocan al desmontar.
  const capturesRef = useRef<ScanCapture[]>([]);
  useEffect(() => {
    capturesRef.current = captures;
  }, [captures]);
  useEffect(
    () => () => {
      for (const capture of capturesRef.current) URL.revokeObjectURL(capture.url);
    },
    [],
  );

  // El detector vive en un chunk aparte: se adelanta su descarga en cuanto
  // se abre la herramienta para que la primera captura no espere por el.
  useEffect(() => {
    preloadDocumentDetection();
  }, []);

  const patchOptions = useCallback((patch: Partial<ScanToPdfOptions>) => {
    setOptions((previous) => ({ ...previous, ...patch }));
  }, []);

  /**
   * Sustituye la version efectiva de una captura y rota su object URL.
   * El original crudo nunca se toca aqui, por eso "deshacer" siempre
   * puede volver a el.
   */
  const replaceCaptureBlob = useCallback(
    (
      id: string,
      blob: Blob,
      corners: QuadCorners | null,
      cornersSource: ScanCapture["cornersSource"],
    ) => {
      setCaptures((previous) =>
        previous.map((capture) => {
          if (capture.id !== id) return capture;
          if (capture.blob !== blob) URL.revokeObjectURL(capture.url);
          return {
            ...capture,
            blob,
            url:
              capture.blob === blob ? capture.url : URL.createObjectURL(blob),
            corners,
            cornersSource,
            pending: false,
          };
        }),
      );
    },
    [],
  );

  /**
   * Publica la foto enderezada por su EXIF. Pasa a ser tambien el
   * original al que vuelve "deshacer": toda la cadena posterior
   * —deteccion, recorte, filtros— parte ya de la imagen bien orientada.
   * Si la captura ya no esta (se borro o hubo `reset`), el `map` no la
   * encuentra y el resultado tardio se descarta sin crear object URL.
   */
  const replaceCaptureSource = useCallback((id: string, blob: Blob) => {
    setCaptures((previous) =>
      previous.map((capture) => {
        if (capture.id !== id) return capture;
        URL.revokeObjectURL(capture.url);
        return {
          ...capture,
          originalBlob: blob,
          blob,
          url: URL.createObjectURL(blob),
        };
      }),
    );
  }, []);

  const markPending = useCallback((id: string, pending: boolean) => {
    setCaptures((previous) =>
      previous.map((capture) =>
        capture.id === id ? { ...capture, pending } : capture,
      ),
    );
  }, []);

  /** Endereza el original con las esquinas dadas y publica el resultado. */
  const applyCorners = useCallback(
    async (
      id: string,
      source: Blob,
      corners: QuadCorners,
      cornersSource: "auto" | "manual",
    ) => {
      markPending(id, true);
      try {
        const cropped = await warpPerspective(source, corners);
        // Si el motor no pudo enderezar devuelve el mismo blob: en ese
        // caso no hay recorte que anunciar.
        if (cropped === source) replaceCaptureBlob(id, source, null, null);
        else replaceCaptureBlob(id, cropped, corners, cornersSource);
      } catch {
        replaceCaptureBlob(id, source, null, null);
      }
    },
    [markPending, replaceCaptureBlob],
  );

  /**
   * Registra una captura y encadena sobre ella los pasos asincronos que
   * la resuelven. La entrada nace `pending` de forma sincrona, antes de
   * cualquier `await`: si el hueco se reservara despues, el gate de
   * generacion no veria la foto en curso y el PDF podria componerse sin
   * ella.
   *
   * `fromDevice` distingue las fotos que llegan de un input de archivo
   * (camara del sistema o galeria) de los fotogramas capturados en vivo:
   * solo las primeras traen EXIF que enderezar, el canvas ya devuelve el
   * bitmap derecho y volver a decodificarlo seria recomprimir por nada.
   */
  const addCapture = useCallback(
    (blob: Blob, fromDevice = false) => {
      setError(null);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setCaptures((previous) => [
        ...previous,
        {
          id,
          originalBlob: blob,
          blob,
          url: URL.createObjectURL(blob),
          corners: null,
          cornersSource: null,
          pending: true,
        },
      ]);

      void (async () => {
        let source = blob;
        if (fromDevice) {
          const straight = await normalizeImageOrientation(blob);
          if (straight !== blob) {
            source = straight;
            replaceCaptureSource(id, straight);
          }
        }

        // Deteccion automatica: si sale con confianza, el recorte se
        // aplica solo y la tira lo anuncia con la insignia "Recortada".
        const detected = await detectDocumentInBlob(source);
        if (!detected) {
          markPending(id, false);
          return;
        }
        await applyCorners(id, source, detected.corners, "auto");
      })();
    },
    [applyCorners, markPending, replaceCaptureSource],
  );

  const importCapture = useCallback(
    (file: File) => addCapture(file, true),
    [addCapture],
  );

  const editCorners = useCallback(
    (id: string) => {
      setEditingId(id);
      askFocus("editor");
    },
    [askFocus],
  );

  /** Cierra el editor de esquinas y devuelve el foco a su boton «Recortar» de la captura. */
  const closeEditor = useCallback(
    (id: string) => {
      setEditingId(null);
      focusArgRef.current = { id, action: "edit", index: 0 };
      askFocus("capture");
    },
    [askFocus],
  );

  const undoCrop = useCallback(
    (id: string) => {
      const target = capturesRef.current.find((capture) => capture.id === id);
      if (target) replaceCaptureBlob(id, target.originalBlob, null, null);
      // «Deshacer recorte» desaparece: el foco pasa a «Recortar» de la misma captura.
      focusArgRef.current = { id, action: "edit", index: 0 };
      askFocus("capture");
    },
    [replaceCaptureBlob, askFocus],
  );

  const removeCapture = useCallback(
    (id: string) => {
    focusArgRef.current = {
      id,
      action: "remove",
      index: Math.max(0, capturesRef.current.findIndex((capture) => capture.id === id)),
    };
    askFocus("afterRemove");
    setEditingId((current) => (current === id ? null : current));
    setCaptures((previous) => {
      const target = previous.find((capture) => capture.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return previous.filter((capture) => capture.id !== id);
    });
    },
    [askFocus],
  );

  const moveCapture = useCallback(
    (index: number, offset: number) => {
    const moved = capturesRef.current[index];
    if (moved) {
      // Al reordenar, la fila se mueve en el DOM y el foco se pierde: vuelve a la misma flecha (o a la otra).
      focusArgRef.current = { id: moved.id, action: offset < 0 ? "up" : "down", index };
      askFocus("capture");
    }
    setCaptures((previous) => {
      const target = index + offset;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    },
    [askFocus],
  );

  const reset = useCallback(() => {
    runIdRef.current += 1;
    for (const capture of capturesRef.current) URL.revokeObjectURL(capture.url);
    setEditingId(null);
    setCaptures([]);
    setOptions(DEFAULT_SCAN_OPTIONS);
    setResult(null);
    setProgress(0);
    setError(null);
    setPhase("capture");
    askFocus("camera");
  }, [askFocus]);

  const run = useCallback(async () => {
    // Se vuelve a comprobar aqui, sobre el mismo array cuyos blobs se van
    // a componer: el `disabled` del boton es un estado de render y podria
    // ir por detras de una deteccion que sigue en curso.
    if (!canGenerate(captures)) {
      if (captures.length === 0) setError("empty");
      return;
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    setError(null);
    setProgress(0);
    setPhase("processing");

    try {
      const blob = await scanToPdf(
        captures.map((capture) => capture.blob),
        options,
        (value) => {
          if (runIdRef.current !== runId) return;
          setProgress(Math.round(Math.min(1, Math.max(0, value)) * 100));
        },
      );
      if (runIdRef.current !== runId) return;

      const base =
        t.filenames["scan-to-pdf"] ?? slugify(t.tools["scan-to-pdf"].name);
      const filename = `${base}.pdf`;
      setResult({ blob, filename });
      addRecentEntry("scan-to-pdf", filename);
      setPhase("done");
      askFocus("download");
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setError(toPdfError(caught).code);
      setPhase("capture");
    }
  }, [captures, options, t, askFocus]);

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    setPhase("capture");
    setProgress(0);
    setError("cancelled");
    askFocus("run");
  }, [askFocus]);

  const canRun = canGenerate(captures);
  const runReason = canRun
    ? ""
    : captures.length === 0
      ? s.needCapture
      : s.capturePending;
  const showWorkspace = phase === "capture" || phase === "options";
  const editing = captures.find((capture) => capture.id === editingId) ?? null;

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pt-8 pb-40 md:px-6 md:pt-12 md:pb-16">
      <header className="mb-8 flex items-start gap-4">
        <span
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-ios",
            ACCENT_BG_SOFT[TOOL.accent],
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-6", ACCENT_TEXT[TOOL.accent])}
          />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-title-1 text-foreground">
              {copy.name}
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {copy.description}
          </p>
        </div>
      </header>

      <ErrorBanner
        show={error !== null && error !== "cancelled"}
        errorKey={error ?? undefined}
        bannerRef={bannerRef}
        {...(error && error !== "cancelled" ? errorCopy(t, error) : { title: "", message: "" })}
        onDismiss={() => {
          setError(null);
          askFocus("camera");
        }}
        dismissLabel={t.common.close}
      />
      {/* Cancelar no es un fallo: aviso neutro en la region viva (como en ToolShell). */}
      <p role="status" aria-live="polite" className={error === "cancelled" ? "mb-6 text-subheadline text-muted-foreground" : undefined}>
        {error === "cancelled" ? t.tool.errors.cancelled : null}
      </p>

      {showWorkspace ? (
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <div className="min-w-0 flex-1" inert={phase === "options"}>
            <CameraStage
              filter={options.filter}
              onCapture={addCapture}
              onImport={importCapture}
            />

            <div className="mt-8" ref={stripRef}>
              <CaptureStrip
                captures={captures}
                filter={options.filter}
                onMove={moveCapture}
                onRemove={removeCapture}
                onEditCorners={editCorners}
                onUndoCrop={undoCrop}
              />
            </div>

            {/* Un solo boton de generar por pantalla: en escritorio vive en el pie del panel; en movil, en la barra. */}
            {runReason ? (
              <p id="scan-run-reason-bar" className="mt-6 text-footnote text-muted-foreground md:hidden">
                {runReason}
              </p>
            ) : null}
          </div>

          <OptionsPanel
            open={phase === "options"}
            onOpenChange={(open) => setPhase(open ? "options" : "capture")}
            footer={
              <>
                {runReason ? (
                  <p id="scan-run-reason" className="mb-2 text-footnote text-muted-foreground">
                    {runReason}
                  </p>
                ) : null}
                <Button
                  fullWidth
                  size="lg"
                  data-scan-generate=""
                  disabled={!canRun}
                  aria-describedby={runReason ? "scan-run-reason" : undefined}
                  onClick={() => {
                    setPhase("capture");
                    void run();
                  }}
                >
                  {s.generate}
                </Button>
              </>
            }
          >
            <div>
              <SegmentedControl<ScanFilter>
                label={s.filterLabel}
                value={options.filter}
                onChange={(filter) => patchOptions({ filter })}
                options={[
                  { value: "color", label: s.filterColor },
                  { value: "grayscale", label: s.filterGrayscale },
                  { value: "bw", label: s.filterBw },
                  { value: "enhance", label: s.filterEnhance },
                ]}
              />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {s.filterHint}
              </p>
            </div>

            <SegmentedControl<ImagePageSize>
              label={s.pageSizeLabel}
              value={options.pageSize}
              onChange={(pageSize) => patchOptions({ pageSize })}
              options={[
                { value: "a4", label: s.pageSizeA4 },
                { value: "letter", label: s.pageSizeLetter },
                { value: "fit", label: s.pageSizeFit },
              ]}
            />

            <SegmentedControl<ImageMargin>
              label={s.marginLabel}
              value={options.margin}
              onChange={(margin) => patchOptions({ margin })}
              options={[
                { value: "none", label: s.marginNone },
                { value: "small", label: s.marginSmall },
                { value: "large", label: s.marginLarge },
              ]}
            />
          </OptionsPanel>
        </div>
      ) : null}

      {showWorkspace ? (
        <div
          inert={phase === "options"}
          className="glass-bar fixed inset-x-0 z-30 flex items-center gap-3 border-t border-white/10 px-4 py-3 md:hidden"
          style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
        >
          <Button
            variant="secondary"
            size="md"
            onClick={() => setPhase("options")}
          >
            <SlidersHorizontal aria-hidden="true" className="size-4" />
            {t.tool.openOptions}
          </Button>
          <Button
            size="md"
            fullWidth
            data-scan-generate=""
            disabled={!canRun}
            aria-describedby={runReason ? "scan-run-reason-bar" : undefined}
            onClick={() => void run()}
          >
            {s.generate}
          </Button>
        </div>
      ) : null}

      {editing ? (
        <CornerEditor
          source={editing.originalBlob}
          corners={editing.corners ?? DEFAULT_QUAD}
          onCancel={() => closeEditor(editing.id)}
          onConfirm={(corners) => {
            const target = editing;
            closeEditor(target.id);
            void applyCorners(
              target.id,
              target.originalBlob,
              corners,
              "manual",
            );
          }}
        />
      ) : null}

      {phase === "processing" ? (
        <ProcessingOverlay
          progress={progress}
          message={copy.name}
          onCancel={cancel}
        />
      ) : null}

      {phase === "done" && result ? (
        <DownloadScreen
          slug="scan-to-pdf"
          filename={result.filename}
          size={result.blob.size}
          onDownload={() => downloadBlob(result.blob, result.filename)}
          onStartOver={reset}
          downloadButtonRef={downloadRef}
        />
      ) : null}
    </div>
  );
}
