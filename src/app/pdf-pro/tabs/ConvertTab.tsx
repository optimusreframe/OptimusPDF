"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  ExternalLink,
  FileCode,
  FileOutput,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Presentation,
  ChevronDown,
  Braces,
  Table2,
} from "lucide-react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorActions, errorCopy } from "@/components/tool/errorCopy";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { useI18n } from "@/lib/i18n";
import { downloadBlob, toPdfError, type PdfErrorCode } from "@/lib/pdf/core";
import { toolHref } from "@/lib/tools-registry";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import { useSelectedPages } from "@/app/pdf-pro/export/useSelectedPages";
import { getProExports, type ProExport } from "@/app/pdf-pro/ops/proExports";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
// Registra las ocho exportaciones (imagenes, texto, Word, Excel, CSV, Markdown, JSON y PowerPoint).
import "@/app/pdf-pro/export/registerExports";

const ICONS: Record<string, typeof FileOutput> = {
  images: ImageIcon,
  text: FileText,
  word: FileText,
  excel: FileSpreadsheet,
  csv: Table2,
  markdown: FileCode,
  json: Braces,
  powerpoint: Presentation,
};

/** Documento grande: por encima de este peso se avisa antes de exportar. */
const LARGE_EXPORT_BYTES = 50 * 1024 * 1024;

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/** `false` solo cuando el navegador dice con seguridad que no hay conexion. */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    () => true,
  );
}

type CardProps = {
  entry: ProExport;
  /** Id de la tarjeta que esta exportando (solo una a la vez). */
  activeId: string | null;
  setActiveId: (id: string | null) => void;
};

function ExportCard({ entry, activeId, setActiveId }: CardProps) {
  const { t, language } = useI18n();
  const s = getProStrings(language).docTools.convert;
  const own = getExportStrings(language).card;
  const { doc, document, pageCount } = useProWorkingDoc();
  const selectedPages = useSelectedPages();
  const online = useOnline();
  const optionsId = useId();
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [cancelledNote, setCancelledNote] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [options, setOptionsState] = useState<unknown>(() => entry.defaultOptions?.());
  const controller = useRef<AbortController | null>(null);
  const exportButton = useRef<HTMLButtonElement>(null);
  const Icon = ICONS[entry.id] ?? FileOutput;
  const copy = error ? errorCopy(t, error) : null;
  const run = entry.run;
  const Options = entry.Options;

  // Si la tarjeta se desmonta (otra pestaña, documento cerrado) la exportacion en curso se cancela.
  useEffect(() => () => controller.current?.abort(), []);

  const setOptions = (patch: Record<string, unknown>) =>
    setOptionsState((previous: unknown) => ({ ...(previous as Record<string, unknown>), ...patch }));

  const needsNetwork = entry.needsNetwork ? entry.needsNetwork(options) : entry.requiresNetwork;
  const reason = entry.validate?.(options, { language, pageCount, selectedPages }) ?? null;
  const otherBusy = activeId !== null && activeId !== entry.id;
  const disabled = busy || otherBusy || reason !== null;
  const snapshotBytes = document ? document.snapshots[document.cursor]?.byteLength ?? 0 : 0;
  const title = entry.title(language);

  const exportNow = async () => {
    if (!run || !document || disabled) return;
    const bytes = doc.current();
    if (!bytes) return;
    const mine = new AbortController();
    controller.current = mine;
    setActiveId(entry.id);
    setBusy(true);
    setProgress(0);
    setError(null);
    setCancelledNote(false);
    try {
      const result = await run(bytes, {
        name: document.name,
        language,
        signal: mine.signal,
        onProgress: (value) => {
          if (!mine.signal.aborted) setProgress(value);
        },
        options,
        selectedPages,
        pageCount,
        file: doc.currentFile() ?? undefined,
      });
      if (mine.signal.aborted) {
        setCancelledNote(true);
        return;
      }
      downloadBlob(result.blob, result.filename);
      doc.announce(own.done(result.filename));
    } catch (caught) {
      const code = toPdfError(caught).code;
      if (code === "cancelled" || mine.signal.aborted) setCancelledNote(true);
      else setError(code);
    } finally {
      if (controller.current === mine) controller.current = null;
      setBusy(false);
      setActiveId(null);
    }
  };

  const cancel = () => {
    controller.current?.abort();
    doc.announce(own.cancelled);
    // El boton «Cancelar» desaparece: el foco vuelve al de exportar (nunca a <body>).
    window.requestAnimationFrame(() => exportButton.current?.focus({ preventScroll: true }));
  };

  return (
    <li className="space-y-3 rounded-ios-sm border border-hairline bg-white/5 p-3" data-export={entry.id}>
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-signal" />
        <div className="min-w-0 flex-1">
          <h3 className="text-subheadline font-semibold text-foreground">{title}</h3>
          <p className="text-footnote text-muted-foreground">{entry.body(language)}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral">
          {entry.needsNetwork
            ? needsNetwork
              ? own.mayNeedNetwork
              : own.localOnly
            : entry.requiresNetwork
              ? s.requiresNetwork
              : s.localOnly}
        </Badge>
      </div>

      {run ? (
        <>
          {Options ? (
            <div>
              <button
                type="button"
                aria-expanded={showOptions}
                aria-controls={optionsId}
                onClick={() => setShowOptions((value) => !value)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-1 text-subheadline font-semibold text-signal-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                <ChevronDown aria-hidden="true" className={`size-4 transition-transform ${showOptions ? "rotate-180" : ""}`} />
                {showOptions ? own.hideOptions : own.showOptions}
              </button>
              <div id={optionsId} hidden={!showOptions} data-export-options="" className="mt-2">
                {showOptions ? (
                  <Options
                    language={language}
                    options={options}
                    setOptions={setOptions}
                    pageCount={pageCount}
                    selectedPages={selectedPages}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {needsNetwork ? (
            <p className="text-xs leading-relaxed text-muted-foreground" data-export-network="">
              {online ? own.ocrNetwork : own.ocrOffline}
            </p>
          ) : null}
          {snapshotBytes > LARGE_EXPORT_BYTES ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{own.largeDocument}</p>
          ) : null}
          {reason && !showOptions ? (
            <p id={reasonId} data-run-reason="" className="text-xs leading-relaxed text-muted-foreground">
              {reason}
            </p>
          ) : null}
          {busy ? <ProgressBar value={progress * 100} label={own.running} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              ref={exportButton}
              fullWidth={!busy}
              className={busy ? "flex-1" : undefined}
              variant="secondary"
              aria-disabled={disabled || undefined}
              aria-describedby={reason && !showOptions ? reasonId : undefined}
              onClick={() => void exportNow()}
            >
              {busy ? own.running : title}
            </Button>
            {busy ? (
              <Button variant="ghost" size="md" onClick={cancel}>
                {own.cancel}
              </Button>
            ) : null}
          </div>
          {otherBusy ? <p className="text-xs leading-relaxed text-muted-foreground">{own.inProgressOther}</p> : null}
          {cancelledNote && !busy ? <p className="text-xs leading-relaxed text-muted-foreground">{own.cancelled}</p> : null}
          <ErrorBanner
            show={copy !== null}
            errorKey={error ?? undefined}
            title={copy?.title ?? ""}
            message={copy?.message ?? ""}
            hint={copy?.hint}
            actions={errorActions(t, error)}
            dismissLabel={t.common.close}
            onDismiss={() => setError(null)}
            className="mb-0"
          />
        </>
      ) : (
        <>
          <p className="text-footnote text-muted-foreground">{s.comingSoon}</p>
          <Link
            href={toolHref(entry.slug)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-full px-1 text-subheadline font-semibold text-signal-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            {s.openTool(t.tools[entry.slug].name)}
          </Link>
        </>
      )}
    </li>
  );
}

/**
 * Pestaña «Convertir» (Wave 7 · U5 deja el contenedor, U8 lo completa): una tarjeta por exportacion registrada
 * en `ops/proExports.ts`. Las ocho de `export/registerExports.ts` (imagenes JPG/PNG, texto, Word, Excel, CSV,
 * Markdown, JSON, PowerPoint) tienen su mini-panel de opciones, progreso, cancelacion y error claro. Exportar NO
 * toca el historial ni el estado «guardado» del documento.
 */
export function ConvertTab() {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.convert;
  const { document } = useProWorkingDoc();
  const [activeId, setActiveId] = useState<string | null>(null);
  if (!document) return null;
  return (
    <div className="space-y-4" data-doc-tab="convert">
      <div>
        <h2 className="text-headline text-foreground">{s.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.intro}</p>
      </div>
      <ul aria-label={s.title} className="space-y-3">
        {getProExports().map((entry) => (
          <ExportCard key={entry.id} entry={entry} activeId={activeId} setActiveId={setActiveId} />
        ))}
      </ul>
    </div>
  );
}
