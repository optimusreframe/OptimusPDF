"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { toolHref } from "@/lib/tools-registry";
import { ExportCancelButton } from "@/app/pdf-pro/export/ExportCancelButton";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import { useExportStore } from "@/app/pdf-pro/export/useExportStore";
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
};

/**
 * Una tarjeta de exportacion. NO es duena de la exportacion (Wave 9): el estado y el motor viven en el almacen del
 * documento de trabajo (`export/exportStore.ts`), asi que la tarjeta se puede desmontar (otra pestaña, un modo) sin
 * cancelar nada y, al volver, lee de aqui el progreso o el resultado. Aqui solo se pinta y se pide empezar o cancelar.
 */
function ExportCard({ entry }: CardProps) {
  const { t, language } = useI18n();
  const s = getProStrings(language).docTools.convert;
  const strings = getExportStrings(language);
  const own = strings.card;
  const { document, pageCount } = useProWorkingDoc();
  const { store, state } = useExportStore();
  const selectedPages = useSelectedPages();
  const online = useOnline();
  const optionsId = useId();
  const reasonId = useId();
  const [showOptions, setShowOptions] = useState(false);
  const defaultOptions = useMemo(() => entry.defaultOptions?.(), [entry]);
  const options = state.options[entry.id] ?? defaultOptions;
  const exportButton = useRef<HTMLButtonElement>(null);
  const Icon = ICONS[entry.id] ?? FileOutput;
  const run = entry.run;
  const Options = entry.Options;

  // La exportacion de ESTA tarjeta (si la hay: en curso, terminada, con error o cancelada) y si hay otra distinta.
  const job = state.job && state.job.formatId === entry.id ? state.job : null;
  const busy = job?.phase === "running";
  const otherBusy = state.job?.phase === "running" && !busy;
  const error = job?.phase === "error" ? job.error : null;
  const copy = error ? errorCopy(t, error) : null;

  const setOptions = (patch: Record<string, unknown>) => store.setOptions(entry.id, defaultOptions, patch);

  const needsNetwork = entry.needsNetwork ? entry.needsNetwork(options) : entry.requiresNetwork;
  const reason = entry.validate?.(options, { language, pageCount, selectedPages }) ?? null;
  const disabled = busy || otherBusy || reason !== null;
  const snapshotBytes = document ? document.snapshots[document.cursor]?.byteLength ?? 0 : 0;
  const title = entry.title(language);
  // La version del documento que se exporto (o se esta exportando) y si el documento sigue siendo esa.
  const currentSnapshotId = document ? document.snapshots[document.cursor]?.id : undefined;
  const versionChanged = job !== null && currentSnapshotId !== undefined && currentSnapshotId !== job.snapshotId;

  const exportNow = () => {
    if (!run || !document || disabled) return;
    store.start({ entry, options, selectedPages, language });
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
          {busy && job ? <ProgressBar value={job.progress * 100} label={own.running} /> : null}
          {busy && job ? (
            <p data-export-from="" className="text-xs leading-relaxed text-muted-foreground">
              {own.runningFrom(job.versionLabel)}
            </p>
          ) : null}
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
              <ExportCancelButton
                variant="ghost"
                size="md"
                onCancel={() => store.cancel()}
                // «Cancelar» desaparece (se cancele o termine solo): el foco vuelve al boton de exportar, nunca a <body>.
                returnFocusTo={() => exportButton.current}
              >
                {own.cancel}
              </ExportCancelButton>
            ) : null}
          </div>
          {otherBusy && state.job ? (
            <p data-export-other="" className="text-xs leading-relaxed text-muted-foreground">
              {own.inProgressOther(strings.formatsShort[state.job.formatId])}
            </p>
          ) : null}
          {job?.phase === "done" && job.filename ? (
            <p data-export-result="" className="text-xs leading-relaxed text-foreground">
              {own.result(job.filename, job.versionLabel)}
              {versionChanged ? <span className="text-muted-foreground"> {own.versionChanged}</span> : null}
            </p>
          ) : null}
          {job?.phase === "cancelled" ? <p className="text-xs leading-relaxed text-muted-foreground">{own.cancelled}</p> : null}
          <ErrorBanner
            show={copy !== null}
            errorKey={error ?? undefined}
            title={copy?.title ?? ""}
            message={copy?.message ?? ""}
            hint={copy?.hint}
            actions={errorActions(t, error)}
            dismissLabel={t.common.close}
            onDismiss={() => store.dismiss()}
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
 *
 * Wave 9: la exportacion NO vive aqui. Cambiar de pestaña desmonta esta pestaña pero la exportacion sigue en el almacen
 * del documento (`export/exportStore.ts`); el indicador de la barra superior (`ExportIndicator`) la muestra y la cancela.
 */
export function ConvertTab() {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.convert;
  const { document } = useProWorkingDoc();
  const { store } = useExportStore();
  // Con esta pestaña a la vista la alerta de error de cada tarjeta se anuncia sola; sin ella lo anuncia el almacen.
  useEffect(() => store.registerView(), [store]);
  if (!document) return null;
  return (
    <div className="space-y-4" data-doc-tab="convert">
      <div>
        <h2 className="text-headline text-foreground">{s.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.intro}</p>
      </div>
      <ul aria-label={s.title} className="space-y-3">
        {getProExports().map((entry) => (
          <ExportCard key={entry.id} entry={entry} />
        ))}
      </ul>
    </div>
  );
}
