"use client";

import { useCallback } from "react";
import { AlertTriangle, Clock, Download, FileText, Languages } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Checkbox } from "@/components/ui/Checkbox";
import { TRANSLATE_STRINGS } from "@/app/translate-pdf/strings";
import { useI18n } from "@/lib/i18n";
import {
  MAX_SAFE_FILE_SIZE,
  withSuffix,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_TRANSLATE_OPTIONS,
  TRANSLATE_LANGUAGES,
  canTranslate,
  findPair,
  targetsFor,
  translatePdfToReport,
  type TranslateLanguage,
  type TranslateOptions,
} from "@/lib/pdf/translate";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("translate-pdf");

export function TranslateReportToolClient() {
  const { language } = useI18n();
  const s = TRANSLATE_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: TranslateOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const { blob } = await translatePdfToReport(
        file,
        // El informe se redacta en el idioma de la interfaz, no en el
        // del documento: quien lo lee es quien esta usando la app.
        { ...options, reportLanguage: language },
        onProgress,
        signal,
      );
      // Markdown, no PDF: la extension tiene que decir la verdad sobre
      // lo que el usuario se acaba de descargar.
      return { blob, filename: withSuffix(file.name, s.filenameSuffix, "md") };
    },
    [language, s.filenameSuffix],
  );

  return (
    <ToolShell<TranslateOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_TRANSLATE_OPTIONS}
      process={process}
      canRun={(_files, options) => {
        if (canTranslate(options)) return { ok: true };
        // Par sin modelo (mismo idioma): nada que explicar aqui, el selector ya lo avisa.
        const pair = findPair(options.source, options.target);
        return { ok: false, reason: pair ? s.consentPending : "" };
      }}
      progressMessage={s.howItWorksTitle}
      renderMain={() => (
        <section className="glass rounded-ios p-5">
          <div className="flex items-start gap-3">
            <Languages
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-accent-optimize"
            />
            <div className="min-w-0">
              <h3 className="text-headline text-foreground">
                {s.howItWorksTitle}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {s.howItWorksBody}
              </p>
            </div>
          </div>

          {/*
            El aviso de "esto no es un PDF traducido" es el punto entero
            de esta herramienta: va en destructivo, arriba del todo y sin
            depender de que nadie abra el panel de opciones.
          */}
          <div className="rounded-ios mt-4 flex items-start gap-3 border border-destructive/40 bg-destructive/10 p-4">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-destructive"
            />
            <div className="min-w-0">
              <p className="ui-label text-destructive-text">
                {s.notAPdfTitle}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-foreground">
                {s.notAPdfBody}
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-ios flex items-start gap-3 border border-white/10 bg-white/5 p-4">
              <FileText
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <p className="text-xs leading-relaxed text-foreground">
                {s.aiNotice}
              </p>
            </div>
            <div className="rounded-ios flex items-start gap-3 border border-white/10 bg-white/5 p-4">
              <Download
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <p className="text-xs leading-relaxed text-foreground">
                {s.privacyNotice}
              </p>
            </div>
            <div className="rounded-ios flex items-start gap-3 border border-white/10 bg-white/5 p-4">
              <Clock
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <p className="text-xs leading-relaxed text-foreground">
                {s.slowNotice}
              </p>
            </div>
          </div>
        </section>
      )}
      renderOptions={({ files, options, setOptions }) => {
        const pair = findPair(options.source, options.target);
        const targets = targetsFor(options.source);

        return (
          <>
            <div>
              <SegmentedControl<TranslateLanguage>
                label={s.sourceLabel}
                value={options.source}
                onChange={(source) => {
                  // Cambiar de origen puede dejar el destino invalido
                  // (mismo idioma). Se reencamina al primer destino
                  // valido y SIEMPRE se retira el consentimiento: el
                  // modelo a descargar ya no es el mismo.
                  const available = targetsFor(source);
                  const target = available.includes(options.target)
                    ? options.target
                    : available[0];
                  setOptions({ source, target, consentedModel: null });
                }}
                options={TRANSLATE_LANGUAGES.map((code) => ({
                  value: code,
                  label: s.languageNames[code],
                }))}
              />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {s.sourceHint}
              </p>
            </div>

            <SegmentedControl<TranslateLanguage>
              label={s.targetLabel}
              value={options.target}
              onChange={(target) =>
                setOptions({ target, consentedModel: null })
              }
              options={targets.map((code) => ({
                value: code,
                label: s.languageNames[code],
              }))}
            />

            <Checkbox
              label={s.ocrLabel}
              hint={s.ocrHint}
              checked={options.ocrFallback}
              onChange={(ocrFallback) => setOptions({ ocrFallback })}
            />

            {/*
              Consentimiento explicito antes de bajar ~110-125 MB. El
              valor guardado es el identificador del modelo, no un
              booleano: si el usuario cambia de par, el consentimiento
              anterior deja de coincidir y hay que volver a pedirlo.
            */}
            {pair ? (
              <div className="rounded-ios border border-white/10 bg-white/5 p-4">
                <p className="text-subheadline font-semibold text-foreground">
                  {s.consentTitle}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {s.consentBody
                    .replace("{model}", pair.model)
                    .replace("{size}", String(pair.approxDownloadMb))}
                </p>
                <Checkbox
                  className="mt-3"
                  label={s.consentCheckbox}
                  hint={s.consentHint}
                  checked={options.consentedModel === pair.model}
                  onChange={(accepted) =>
                    setOptions({
                      consentedModel: accepted ? pair.model : null,
                    })
                  }
                />
              </div>
            ) : null}

            {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
              <p className="text-xs leading-relaxed text-destructive">
                {s.largeFile}
              </p>
            ) : null}
          </>
        );
      }}
    />
  );
}
