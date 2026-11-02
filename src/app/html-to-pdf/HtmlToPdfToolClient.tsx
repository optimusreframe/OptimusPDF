"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Globe, ShieldCheck } from "lucide-react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_HTML_TO_PDF_OPTIONS,
  htmlToPdf,
  type HtmlMargin,
  type HtmlOrientation,
  type HtmlPageSize,
  type HtmlToPdfOptions,
} from "@/lib/pdf/htmlToPdf";
import { snapshotToFile } from "@/lib/htmlSnapshot/client";
import type { SnapshotResult } from "@/lib/htmlSnapshot/types";
import { getTool } from "@/lib/tools-registry";
import { noteText, STRINGS } from "@/app/html-to-pdf/strings";
import { UrlSourcePanel } from "@/app/html-to-pdf/UrlSourcePanel";

const TOOL = getTool("html-to-pdf");

type Source = "url" | "file";

/** La página leída por el servidor que hay ahora en la lista de archivos (para el resumen y sus avisos). */
type LoadedSnapshot = { file: File; info: Pick<SnapshotResult, "finalUrl" | "title" | "notes"> };

export function HtmlToPdfToolClient() {
  const { language, t } = useI18n();
  const s = STRINGS[language];

  const [source, setSource] = useState<Source>("url");
  const [address, setAddress] = useState("");
  const [snapshot, setSnapshot] = useState<LoadedSnapshot | null>(null);
  /** Ya se cargó alguna página en esta visita: al volver a la pantalla inicial el foco va al campo. */
  const hasLoadedRef = useRef(false);
  const loadRef = useRef<((files: File[]) => void) | null>(null);

  const process = useCallback(
    async (
      files: File[],
      options: HtmlToPdfOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await htmlToPdf(file, options, onProgress, signal);
      return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
    },
    [s.filenameSuffix],
  );

  /** La consulta terminó: el HTML entra por el mismo camino que un archivo subido. */
  const onLoaded = useCallback((result: SnapshotResult) => {
    const file = snapshotToFile(result);
    hasLoadedRef.current = true;
    setSnapshot({ file, info: { finalUrl: result.finalUrl, title: result.title, notes: result.notes } });
    loadRef.current?.([file]);
  }, []);

  /** Si la persona quita la página de la lista (o la cambia), el resumen deja de aplicar. */
  const onFilesChanged = useCallback((next: File[]) => {
    setSnapshot((current) => (current && next.includes(current.file) ? current : null));
  }, []);

  const fromUrl = snapshot !== null;

  return (
    <ToolShell<HtmlToPdfOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_HTML_TO_PDF_OPTIONS}
      progressMessage={s.progress}
      process={process}
      loadRef={loadRef}
      hideDropzone={source === "url"}
      onFilesChanged={onFilesChanged}
      renderIdle={() => (
        <div className="mb-6">
          <SegmentedControl<Source>
            label={s.modeLabel}
            value={source}
            onChange={setSource}
            options={[
              { value: "url", label: s.modeUrl },
              { value: "file", label: s.modeFile },
            ]}
          />
          {source === "url" ? (
            <div className="mt-5">
              <UrlSourcePanel
                strings={s}
                address={address}
                onAddressChange={setAddress}
                onLoaded={onLoaded}
                onUseFile={() => setSource("file")}
                focusOnMount={hasLoadedRef.current}
                dismissLabel={t.common.close}
              />
            </div>
          ) : null}
        </div>
      )}
      renderMain={() => (
        <>
          {snapshot ? (
            <section data-snapshot-summary="" className="surface-card rounded-ios mb-6 p-5">
              <div className="flex items-center gap-3">
                <Globe aria-hidden="true" className="size-5 shrink-0 text-signal" />
                <h3 className="min-w-0 text-headline text-foreground">{s.snapshotTitle}</h3>
              </div>
              <dl className="mt-3 space-y-2 text-footnote">
                {snapshot.info.title ? (
                  <div>
                    <dt className="ui-label text-muted-foreground">{s.snapshotPageTitle}</dt>
                    <dd className="mt-0.5 break-words text-foreground">{snapshot.info.title}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="ui-label text-muted-foreground">{s.snapshotAddress}</dt>
                  <dd className="mt-0.5 break-all text-foreground">{snapshot.info.finalUrl}</dd>
                </div>
              </dl>
              <h4 className="mt-4 text-subheadline font-semibold text-foreground">{s.snapshotNotesTitle}</h4>
              {snapshot.info.notes.length === 0 ? (
                <p className="mt-1 text-footnote text-muted-foreground">{s.snapshotNoNotes}</p>
              ) : (
                <ul className="mt-1 list-disc space-y-1 pl-5 text-footnote leading-relaxed text-muted-foreground">
                  {snapshot.info.notes.map((note) => (
                    <li key={note.code}>{noteText(s.snapshotNotes[note.code], note.count)}</li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          <section className="surface-card rounded-ios p-5">
            <h3 className="text-headline text-foreground">{s.howItWorksTitle}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {fromUrl ? s.howItWorksBodyUrl : s.howItWorksBody}
            </p>

            {/*
              La advertencia de fidelidad es obligatoria y visible: el
              usuario tiene que saber ANTES de convertir que recibe una
              captura, no un documento con texto seleccionable.
            */}
            <div className="rounded-ios mt-4 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="text-xs leading-relaxed text-foreground">
                {fromUrl ? s.fidelityWarningUrl : s.fidelityWarning}
              </p>
            </div>

            <div className="mt-3 flex items-start gap-3">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-signal" />
              <div className="min-w-0">
                <h4 className="text-subheadline font-semibold text-foreground">{s.securityTitle}</h4>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {fromUrl ? s.securityBodyUrl : s.securityBody}
                </p>
              </div>
            </div>
          </section>
        </>
      )}
      renderOptions={({ options, setOptions }) => (
        <>
          <SegmentedControl<HtmlPageSize>
            label={s.pageSizeLabel}
            value={options.pageSize}
            onChange={(pageSize) => setOptions({ pageSize })}
            options={[
              { value: "letter", label: s.pageSizeLetter },
              { value: "a4", label: s.pageSizeA4 },
            ]}
          />

          <SegmentedControl<HtmlOrientation>
            label={s.orientationLabel}
            value={options.orientation}
            onChange={(orientation) => setOptions({ orientation })}
            options={[
              { value: "portrait", label: s.orientationPortrait },
              { value: "landscape", label: s.orientationLandscape },
            ]}
          />

          <div>
            <SegmentedControl<HtmlMargin>
              label={s.marginLabel}
              value={options.margin}
              onChange={(margin) => setOptions({ margin })}
              options={[
                { value: "none", label: s.marginNone },
                { value: "small", label: s.marginSmall },
                { value: "large", label: s.marginLarge },
              ]}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {s.optionsNote}
            </p>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {fromUrl ? s.fidelityWarningUrl : s.fidelityWarning}
          </p>
        </>
      )}
    />
  );
}
