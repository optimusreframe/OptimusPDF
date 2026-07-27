"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
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
  scanToPdf,
  type ScanFilter,
  type ScanToPdfOptions,
} from "@/lib/pdf/scanToPdf";
import { ACCENT_BG_SOFT, ACCENT_TEXT, getTool } from "@/lib/tools-registry";
import { CameraStage } from "@/app/scan-to-pdf/CameraStage";
import { CaptureStrip, type ScanCapture } from "@/app/scan-to-pdf/CaptureStrip";
import { STRINGS } from "@/app/scan-to-pdf/strings";

const TOOL = getTool("scan-to-pdf");

type Phase = "capture" | "options" | "processing" | "done";

type ScanResult = { blob: Blob; filename: string };

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
  const [result, setResult] = useState<ScanResult | null>(null);
  const runIdRef = useRef(0);

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

  const patchOptions = useCallback((patch: Partial<ScanToPdfOptions>) => {
    setOptions((previous) => ({ ...previous, ...patch }));
  }, []);

  const addCapture = useCallback((blob: Blob) => {
    setError(null);
    setCaptures((previous) => [
      ...previous,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        blob,
        url: URL.createObjectURL(blob),
      },
    ]);
  }, []);

  const removeCapture = useCallback((id: string) => {
    setCaptures((previous) => {
      const target = previous.find((capture) => capture.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return previous.filter((capture) => capture.id !== id);
    });
  }, []);

  const moveCapture = useCallback((index: number, offset: number) => {
    setCaptures((previous) => {
      const target = index + offset;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    for (const capture of capturesRef.current) URL.revokeObjectURL(capture.url);
    setCaptures([]);
    setOptions(DEFAULT_SCAN_OPTIONS);
    setResult(null);
    setProgress(0);
    setError(null);
    setPhase("capture");
  }, []);

  const run = useCallback(async () => {
    if (captures.length === 0) {
      setError("empty");
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
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setError(toPdfError(caught).code);
      setPhase("capture");
    }
  }, [captures, options, t]);

  const cancel = useCallback(() => {
    runIdRef.current += 1;
    setPhase("capture");
    setProgress(0);
    setError("cancelled");
  }, []);

  const canRun = captures.length > 0;
  const showWorkspace = phase === "capture" || phase === "options";

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
            <h1 className="text-2xl font-black tracking-[-0.025em] text-foreground md:text-3xl">
              {copy.name}
            </h1>
            <Badge variant="live" dot>
              {t.common.live}
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

      {showWorkspace ? (
        <div className="flex flex-col gap-6 md:flex-row md:items-start">
          <div className="min-w-0 flex-1">
            <CameraStage filter={options.filter} onCapture={addCapture} />

            <div className="mt-8">
              <CaptureStrip
                captures={captures}
                filter={options.filter}
                onMove={moveCapture}
                onRemove={removeCapture}
              />
            </div>

            <div className="mt-8 hidden md:block">
              <Button size="lg" disabled={!canRun} onClick={() => void run()}>
                {s.generate}
              </Button>
            </div>
          </div>

          <OptionsPanel
            open={phase === "options"}
            onOpenChange={(open) => setPhase(open ? "options" : "capture")}
            footer={
              <Button
                fullWidth
                size="lg"
                disabled={!canRun}
                onClick={() => {
                  setPhase("capture");
                  void run();
                }}
              >
                {s.generate}
              </Button>
            }
          >
            <div>
              <SegmentedControl<ScanFilter>
                label={s.filterLabel}
                value={options.filter}
                onChange={(filter) => patchOptions({ filter })}
                options={[
                  { value: "color", label: s.filterColor },
                  { value: "bw", label: s.filterBw },
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
          <Button size="md" fullWidth disabled={!canRun} onClick={() => void run()}>
            {s.generate}
          </Button>
        </div>
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
        />
      ) : null}
    </div>
  );
}
