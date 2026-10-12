"use client";

import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import { TextField } from "@/components/tool/OptionControls";
import type { Language } from "@/lib/i18n";
import { OCR_LANGUAGES, type OcrLanguage } from "@/lib/pdf/ocr";
import type { PdfToImageFormat, PdfToImageScale } from "@/lib/pdf/pdfToImages";
import { JPG_QUALITY_MAX, JPG_QUALITY_MIN } from "@/app/pdf-pro/export/exportDefaults";
import type { PdfToCsvFormat } from "@/lib/pdf/pdfToCsv";
import { STRINGS as PDF_TO_JPG_STRINGS } from "@/app/pdf-to-jpg/strings";
import { PDF_TO_TEXT_STRINGS } from "@/app/pdf-to-text/strings";
import { PDF_TO_EXCEL_STRINGS } from "@/app/pdf-to-excel/strings";
import { PDF_TO_CSV_STRINGS } from "@/app/pdf-to-csv/strings";
import { PDF_TO_JSON_STRINGS } from "@/app/pdf-to-json/strings";
import { PDF_TO_MARKDOWN_STRINGS } from "@/app/pdf-to-markdown/strings";
import { STRINGS as PDF_TO_POWERPOINT_STRINGS } from "@/app/pdf-to-powerpoint/strings";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import { resolvePageScope } from "@/app/pdf-pro/export/pageScope";
import type { ExportFormatId, ExportOptionsMap, PageScopeMode } from "@/app/pdf-pro/export/exportTypes";

/**
 * Mini-paneles de opciones de cada exportacion (Wave 7 · U8). Son los MISMOS controles (y las mismas etiquetas)
 * que las herramientas sueltas `/pdf-to-*`: lo unico propio es lo que PDF Pro añade (PNG, rango, paginas
 * seleccionadas). Cada panel recibe las opciones completas y un `setOptions(parche)`.
 */
export type ExportPanelProps<K extends ExportFormatId> = {
  language: Language;
  options: ExportOptionsMap[K];
  setOptions: (patch: Partial<ExportOptionsMap[K]>) => void;
  pageCount: number;
  /** Paginas elegidas en el visor o el organizador (0-based). */
  selectedPages: readonly number[];
};

type ScaleKey = "1" | "2" | "3";
const toScaleKey = (scale: PdfToImageScale): ScaleKey => String(scale) as ScaleKey;
const fromScaleKey = (key: ScaleKey): PdfToImageScale => (key === "1" ? 1 : key === "3" ? 3 : 2);

/** Mensaje de por que el alcance de paginas no se puede exportar, o `null` si es valido. */
export function scopeProblem(
  language: Language,
  options: ExportOptionsMap["images"],
  pageCount: number,
  selectedPages: readonly number[],
): string | null {
  const s = getExportStrings(language).images;
  const resolution = resolvePageScope(options, pageCount, selectedPages);
  if (resolution.ok) return null;
  if (resolution.reason === "rangeEmpty") return s.rangeEmpty;
  if (resolution.reason === "rangeInvalid") return s.rangeInvalid(pageCount);
  return s.selectionEmpty;
}

export function ImagesPanel({ language, options, setOptions, pageCount, selectedPages }: ExportPanelProps<"images">) {
  const jpg = PDF_TO_JPG_STRINGS[language];
  const s = getExportStrings(language).images;
  const problem = scopeProblem(language, options, pageCount, selectedPages);
  const resolution = resolvePageScope(options, pageCount, selectedPages);
  return (
    <div className="space-y-4">
      <SegmentedControl<PdfToImageFormat>
        label={s.formatLabel}
        value={options.format}
        onChange={(format) => setOptions({ format })}
        options={[
          { value: "jpg", label: s.jpg },
          { value: "png", label: s.png },
        ]}
      />
      {options.format === "png" ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{s.pngHint}</p>
      ) : (
        <div>
          <Slider
            label={jpg.qualityLabel}
            min={Math.round(JPG_QUALITY_MIN * 100)}
            max={Math.round(JPG_QUALITY_MAX * 100)}
            step={1}
            suffix="%"
            value={Math.round(options.quality * 100)}
            onChange={(value) => setOptions({ quality: value / 100 })}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{jpg.qualityHint}</p>
        </div>
      )}
      <div>
        <SegmentedControl<ScaleKey>
          label={jpg.scaleLabel}
          value={toScaleKey(options.scale)}
          onChange={(key) => setOptions({ scale: fromScaleKey(key) })}
          options={[
            { value: "1", label: s.dpi[1] },
            { value: "2", label: s.dpi[2] },
            { value: "3", label: s.dpi[3] },
          ]}
        />
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{jpg.scaleHint}</p>
      </div>
      <div>
        <SegmentedControl<PageScopeMode>
          label={s.scopeLabel}
          value={options.scope}
          onChange={(scope) => setOptions({ scope })}
          options={[
            { value: "all", label: s.scopeAll },
            { value: "range", label: s.scopeRange },
            { value: "selected", label: s.scopeSelected },
          ]}
        />
        {options.scope === "range" ? (
          <div className="mt-3">
            <TextField
              label={s.rangeLabel}
              value={options.range}
              placeholder={s.rangePlaceholder}
              maxLength={200}
              onChange={(range) => setOptions({ range })}
              hint={s.rangeHint(pageCount)}
            />
          </div>
        ) : null}
        {options.scope === "selected" && selectedPages.length > 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.selectedHint(selectedPages.length)}</p>
        ) : null}
        {problem ? (
          <p role="note" data-export-problem="" className="mt-2 text-xs leading-relaxed text-destructive-text">
            {problem}
          </p>
        ) : resolution.ok ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {s.summary(resolution.count, resolution.count > 1)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function TextPanel({ language, options, setOptions }: ExportPanelProps<"text">) {
  const s = PDF_TO_TEXT_STRINGS[language];
  return (
    <div className="space-y-2">
      <Checkbox label={s.ocrLabel} hint={s.ocrHint} checked={options.ocrFallback} onChange={(ocrFallback) => setOptions({ ocrFallback })} />
      <Checkbox
        label={s.pageSeparatorsLabel}
        hint={s.pageSeparatorsHint}
        checked={options.pageSeparators}
        onChange={(pageSeparators) => setOptions({ pageSeparators })}
      />
    </div>
  );
}

/** Word no tiene opciones: la herramienta suelta tampoco. */
export function WordPanel() {
  return null;
}

export function ExcelPanel({ language, options, setOptions }: ExportPanelProps<"excel">) {
  const s = PDF_TO_EXCEL_STRINGS[language];
  return (
    <Checkbox
      label={s.stripRepeatedLabel}
      hint={s.stripRepeatedHint}
      checked={options.stripRepeated}
      onChange={(stripRepeated) => setOptions({ stripRepeated })}
    />
  );
}

export function CsvPanel({ language, options, setOptions }: ExportPanelProps<"csv">) {
  const s = PDF_TO_CSV_STRINGS[language];
  return (
    <div className="space-y-3">
      <SegmentedControl<PdfToCsvFormat>
        label={s.formatLabel}
        value={options.format}
        onChange={(format) => setOptions({ format })}
        options={[
          { value: "csv", label: s.formatCsv },
          { value: "json", label: s.formatJson },
        ]}
      />
      <Checkbox
        label={s.stripRepeatedLabel}
        hint={s.stripRepeatedHint}
        checked={options.stripRepeated}
        onChange={(stripRepeated) => setOptions({ stripRepeated })}
      />
    </div>
  );
}

export function MarkdownPanel({ language, options, setOptions }: ExportPanelProps<"markdown">) {
  const s = PDF_TO_MARKDOWN_STRINGS[language];
  return (
    <div className="space-y-2">
      <Checkbox label={s.headingsLabel} hint={s.headingsHint} checked={options.detectHeadings} onChange={(detectHeadings) => setOptions({ detectHeadings })} />
      <Checkbox label={s.tablesLabel} hint={s.tablesHint} checked={options.detectTables} onChange={(detectTables) => setOptions({ detectTables })} />
      <Checkbox label={s.stripRepeatedLabel} hint={s.stripRepeatedHint} checked={options.stripRepeated} onChange={(stripRepeated) => setOptions({ stripRepeated })} />
      <Checkbox label={s.pageSeparatorsLabel} hint={s.pageSeparatorsHint} checked={options.pageSeparators} onChange={(pageSeparators) => setOptions({ pageSeparators })} />
      <Checkbox label={s.ocrLabel} hint={s.ocrHint} checked={options.ocrFallback} onChange={(ocrFallback) => setOptions({ ocrFallback })} />
      {options.ocrFallback ? (
        <div>
          <SegmentedControl<OcrLanguage>
            label={s.ocrLanguageLabel}
            value={options.ocrLanguage}
            onChange={(ocrLanguage) => setOptions({ ocrLanguage })}
            options={OCR_LANGUAGES.map((code) => ({ value: code, label: s.ocrLanguageNames[code] }))}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.ocrNotice}</p>
        </div>
      ) : null}
    </div>
  );
}

export function JsonPanel({ language, options, setOptions }: ExportPanelProps<"json">) {
  const s = PDF_TO_JSON_STRINGS[language];
  return (
    <Checkbox label={s.ocrLabel} hint={s.ocrHint} checked={options.ocrFallback} onChange={(ocrFallback) => setOptions({ ocrFallback })} />
  );
}

export function PowerpointPanel({ language, options, setOptions }: ExportPanelProps<"powerpoint">) {
  const s = PDF_TO_POWERPOINT_STRINGS[language];
  const own = getExportStrings(language).images;
  return (
    <div className="space-y-4">
      <div>
        <Slider
          label={s.qualityLabel}
          min={Math.round(JPG_QUALITY_MIN * 100)}
          max={Math.round(JPG_QUALITY_MAX * 100)}
          step={1}
          suffix="%"
          value={Math.round(options.quality * 100)}
          onChange={(value) => setOptions({ quality: value / 100 })}
        />
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.qualityHint}</p>
      </div>
      <div>
        <SegmentedControl<ScaleKey>
          label={s.scaleLabel}
          value={toScaleKey(options.scale)}
          onChange={(key) => setOptions({ scale: fromScaleKey(key) })}
          options={[
            { value: "1", label: own.dpi[1] },
            { value: "2", label: own.dpi[2] },
            { value: "3", label: own.dpi[3] },
          ]}
        />
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.scaleHint}</p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{s.notEditableBody}</p>
    </div>
  );
}
