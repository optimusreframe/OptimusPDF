"use client";

import { Crop, Hash, LockOpen, Minimize2, RotateCw, ScanText, Stamp, Tags, Wrench, PanelTop } from "lucide-react";
import { localeTag } from "@/lib/i18n";
import { DEFAULT_COMPRESS_OPTIONS, type CompressOptions } from "@/lib/pdf/compress";
import {
  DEFAULT_HEADER_FOOTER_OPTIONS,
  hasHeaderFooterContent,
  type HeaderFooterOptions,
} from "@/lib/pdf/headerFooter";
import { hasAnyMetadata } from "@/lib/pdf/metadata";
import { DEFAULT_OCR_OPTIONS, type OcrOptions } from "@/lib/pdf/ocr";
import { DEFAULT_PAGE_NUMBERS_OPTIONS } from "@/lib/pdf/pageNumbers";
import { assessDamage, type RepairReport } from "@/lib/pdf/repair";
import { DEFAULT_WATERMARK_OPTIONS, type WatermarkOptions } from "@/lib/pdf/watermark";
import { PageNumbersOptionsPanel, type PageNumbersToolOptions } from "@/app/add-page-numbers/PageNumbersOptionsPanel";
import { PAGE_NUMBERS_STRINGS } from "@/app/add-page-numbers/strings";
import { WatermarkOptionsPanel } from "@/app/add-watermark/WatermarkOptionsPanel";
import { WATERMARK_STRINGS } from "@/app/add-watermark/strings";
import { watermarkCanRun } from "@/app/add-watermark/watermarkRules";
import { CompressOptionsPanel } from "@/app/compress-pdf/CompressOptionsPanel";
import { CompressSummary } from "@/app/compress-pdf/CompressSummary";
import { COMPRESS_STRINGS } from "@/app/compress-pdf/strings";
import { CROP_MIN_FRACTION } from "@/app/crop-pdf/cropRules";
import { OcrOptionsPanel } from "@/app/ocr-pdf/OcrOptionsPanel";
import { OCR_STRINGS } from "@/app/ocr-pdf/strings";
import { RepairReportView } from "@/app/repair-pdf/RepairReportView";
import { REPAIR_STRINGS } from "@/app/repair-pdf/strings";
import { rotateRangePlan } from "@/app/rotate-pdf/rotatePlan";
import { marginsToRect, hasAnyMargin } from "@/app/pdf-pro/ops/cropMath";
import {
  DEFAULT_PRO_CROP_OPTIONS,
  DEFAULT_PRO_ROTATE_OPTIONS,
  cropOperation,
  headerFooterOperation,
  metadataOperation,
  ocrOperation,
  pageNumbersOperation,
  repairOperation,
  rotateOperation,
  unlockOperation,
  watermarkOperation,
  type ProCompressReport,
  type ProCropOptions,
  type ProMetadataOptions,
  type ProMetadataReport,
  type ProRotateOptions,
  type ProUnlockOptions,
} from "@/app/pdf-pro/ops/docOperations";
import { compressOperation } from "@/app/pdf-pro/ops/docOperations";
import { EMPTY_METADATA_FORM, hasPatch, patchFromForm } from "@/app/pdf-pro/ops/metadataForm";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import type { DocPanelProps, DocToolCheck, DocToolContext, DocToolDefinition } from "@/app/pdf-pro/tabs/docToolTypes";
import { CropMarginsPanel } from "@/app/pdf-pro/tabs/panels/CropMarginsPanel";
import { HeaderFooterPanel } from "@/app/pdf-pro/tabs/panels/HeaderFooterPanel";
import { MetadataPanel } from "@/app/pdf-pro/tabs/panels/MetadataPanel";
import { RepairPanel } from "@/app/pdf-pro/tabs/panels/RepairPanel";
import { RotateRangePanel } from "@/app/pdf-pro/tabs/panels/RotateRangePanel";
import { UnlockPanel } from "@/app/pdf-pro/tabs/panels/UnlockPanel";
import type { DocToolId } from "@/app/pdf-pro/tabs/docToolsStrings";

/**
 * Registro de las herramientas de documento de PDF Pro (Wave 7 · U5): cada una une su operacion
 * (`ops/docOperations.ts`), el panel de opciones REUTILIZABLE (el mismo componente que la herramienta
 * suelta cuando existe) y las reglas de «se puede aplicar» con motivo.
 */

/** Forma comun para guardarlas en un arreglo (el tipo de opciones solo importa dentro de cada herramienta). */
export type AnyDocTool = DocToolDefinition<unknown>;

function define<T>(tool: DocToolDefinition<T>): AnyDocTool {
  return tool as unknown as AnyDocTool;
}

const labels = (ctx: DocToolContext) => getProStrings(ctx.language).docTools.labels;
const text = (ctx: DocToolContext) => getProStrings(ctx.language).docTools;

const OK: DocToolCheck = { ok: true };

/** La pagina 1 entra en el rango «desde» (1-based). */
function firstInRange(fromPage: number): boolean {
  return (Math.floor(fromPage) || 1) <= 1;
}

function rangeCheck(fromPage: number, ctx: DocToolContext): DocToolCheck {
  if ((Math.floor(fromPage) || 1) > ctx.pageCount && ctx.pageCount > 0) {
    return { ok: false, reason: text(ctx).runner.rangeBeyond };
  }
  return OK;
}

/** Total `{p}` que imprimiria el rango real (igual que `pageNumbers.ts`). */
function lastNumber(firstNumber: number, fromPage: number, toPage: number, pageCount: number): number {
  const start = Math.max(0, Math.floor(firstNumber));
  const from = Math.min(Math.max(1, Math.floor(fromPage) || 1), Math.max(1, pageCount));
  const rawTo = Math.floor(toPage) || pageCount;
  const to = Math.min(Math.max(from, rawTo), Math.max(1, pageCount));
  return start + (to - from + 1) - 1;
}

/* ------------------------------ Marca de agua ------------------------------ */

const watermarkTool = define<WatermarkOptions>({
  id: "watermark",
  tab: "home",
  icon: Stamp,
  operation: watermarkOperation,
  defaults: (ctx) => ({ ...DEFAULT_WATERMARK_OPTIONS, text: WATERMARK_STRINGS[ctx.language].textPlaceholder }),
  canRun: (options, ctx) => {
    const base = watermarkCanRun(options, WATERMARK_STRINGS[ctx.language]);
    return base.ok ? rangeCheck(options.fromPage, ctx) : base;
  },
  describe: (options, ctx) =>
    options.kind === "text" ? labels(ctx).watermarkText(options.text.trim()) : labels(ctx).watermarkImage,
  Panel: ({ options, setOptions, ctx }: DocPanelProps<WatermarkOptions>) => (
    <WatermarkOptionsPanel options={options} setOptions={setOptions} strings={WATERMARK_STRINGS[ctx.language]} />
  ),
  previewOptions: (options) => (firstInRange(options.fromPage) ? { ...options, fromPage: 1, toPage: 1 } : null),
});

/* ------------------------------ Numerar paginas ------------------------------ */

const pageNumbersTool = define<PageNumbersToolOptions>({
  id: "page-numbers",
  tab: "home",
  icon: Hash,
  operation: pageNumbersOperation,
  defaults: () => ({ ...DEFAULT_PAGE_NUMBERS_OPTIONS, preset: "number" }),
  canRun: (options, ctx) => rangeCheck(options.fromPage, ctx),
  describe: (_options, ctx) => labels(ctx).pageNumbers,
  Panel: ({ options, setOptions, ctx }: DocPanelProps<PageNumbersToolOptions>) => (
    <PageNumbersOptionsPanel
      options={options}
      setOptions={setOptions}
      strings={PAGE_NUMBERS_STRINGS[ctx.language]}
      totalPages={ctx.pageCount}
    />
  ),
  previewOptions: (options, ctx) => {
    if (!firstInRange(options.fromPage)) return null;
    // Con una sola pagina `{p}` valdria 1: se fija el total REAL del rango.
    const total = lastNumber(options.firstNumber, options.fromPage, options.toPage, ctx.pageCount);
    return { ...options, template: options.template.replaceAll("{p}", String(total)), fromPage: 1, toPage: 1 };
  },
});

/* ------------------------------ Encabezado, pie y Bates ------------------------------ */

const headerFooterTool = define<HeaderFooterOptions>({
  id: "header-footer",
  tab: "home",
  icon: PanelTop,
  operation: headerFooterOperation,
  defaults: (ctx) => ({
    ...DEFAULT_HEADER_FOOTER_OPTIONS,
    header: { left: "", center: "", right: "" },
    footer: { left: "", center: PAGE_NUMBERS_STRINGS[ctx.language].templatePageNofP, right: "" },
    documentName: ctx.fileName,
    locale: localeTag(ctx.language),
  }),
  canRun: (options, ctx) => {
    if (!hasHeaderFooterContent(options)) return { ok: false, reason: text(ctx).headerFooter.nothingToStamp };
    return rangeCheck(options.fromPage, ctx);
  },
  describe: (options, ctx) =>
    options.bates && [...Object.values(options.header), ...Object.values(options.footer)].some((t) => t.includes("{bates}"))
      ? labels(ctx).bates
      : labels(ctx).headerFooter,
  Panel: HeaderFooterPanel,
  previewOptions: (options, ctx) => {
    if (!firstInRange(options.fromPage)) return null;
    const total = String(lastNumber(options.firstNumber, options.fromPage, options.toPage, ctx.pageCount));
    const fix = (value: string) => value.replaceAll("{p}", total);
    return {
      ...options,
      header: { left: fix(options.header.left), center: fix(options.header.center), right: fix(options.header.right) },
      footer: { left: fix(options.footer.left), center: fix(options.footer.center), right: fix(options.footer.right) },
      fromPage: 1,
      toPage: 1,
    };
  },
});

/* ------------------------------ Comprimir ------------------------------ */

const compressTool = define<CompressOptions>({
  id: "compress",
  tab: "home",
  icon: Minimize2,
  operation: compressOperation as DocToolDefinition<CompressOptions>["operation"],
  defaults: () => ({ ...DEFAULT_COMPRESS_OPTIONS }),
  canRun: () => OK,
  describe: (options, ctx) => {
    const l = labels(ctx);
    return l.compress(`${l.levels[options.level]}${options.mode === "flatten" ? `, ${l.flattened}` : ""}`);
  },
  Panel: ({ options, setOptions, ctx }: DocPanelProps<CompressOptions>) => (
    <CompressOptionsPanel options={options} setOptions={setOptions} strings={COMPRESS_STRINGS[ctx.language]} fileSize={ctx.byteLength} />
  ),
  Result: ({ report, ctx }) => {
    const r = report as ProCompressReport | null;
    if (!r) return null;
    return (
      <CompressSummary
        strings={COMPRESS_STRINGS[ctx.language]}
        locale={localeTag(ctx.language)}
        filename={ctx.fileName}
        originalSize={r.originalSize}
        compressedSize={r.compressedSize}
        mode={r.mode}
        alreadyOptimized={r.alreadyOptimized}
        className="p-4"
      />
    );
  },
});

/* ------------------------------ Recortar ------------------------------ */

const cropTool = define<ProCropOptions>({
  id: "crop",
  tab: "home",
  icon: Crop,
  operation: cropOperation,
  defaults: () => ({ ...DEFAULT_PRO_CROP_OPTIONS, margins: { ...DEFAULT_PRO_CROP_OPTIONS.margins } }),
  canRun: (options, ctx) => {
    if (!hasAnyMargin(options.margins)) return { ok: false, reason: text(ctx).crop.nothingToCrop };
    if (options.scope === "range") {
      const beyond = rangeCheck(options.fromPage, ctx);
      if (!beyond.ok) return beyond;
    }
    if (ctx.firstPage) {
      const rect = marginsToRect(options.margins, ctx.firstPage);
      // Misma regla que la herramienta suelta (`cropRules.ts`): menos del 3 % de la pagina no se conserva.
      if (rect.width < CROP_MIN_FRACTION || rect.height < CROP_MIN_FRACTION) {
        return { ok: false, reason: text(ctx).crop.tooSmall };
      }
    }
    return OK;
  },
  describe: (_options, ctx) => labels(ctx).crop,
  Panel: CropMarginsPanel,
  previewOptions: (options) => (options.scope === "all" || firstInRange(options.fromPage) ? { ...options, scope: "all" } : null),
});

/* ------------------------------ Rotar ------------------------------ */

const rotateTool = define<ProRotateOptions>({
  id: "rotate",
  tab: "home",
  icon: RotateCw,
  operation: rotateOperation,
  defaults: () => ({ ...DEFAULT_PRO_ROTATE_OPTIONS }),
  canRun: (options, ctx) => {
    if (options.scope === "all") return OK;
    const beyond = rangeCheck(options.fromPage, ctx);
    if (!beyond.ok) return beyond;
    const selected = Object.keys(rotateRangePlan(options, Math.max(1, ctx.pageCount)).byPage ?? {}).length;
    return selected === 0 ? { ok: false, reason: text(ctx).rotate.nothingSelected } : OK;
  },
  describe: (options, ctx) => {
    const l = labels(ctx);
    const scope =
      options.scope === "all"
        ? l.rotateScopeAll
        : l.rotateScopeRange(
            Math.min(Math.max(1, Math.floor(options.fromPage) || 1), Math.max(1, ctx.pageCount)),
            Math.floor(options.toPage) || ctx.pageCount,
          );
    return l.rotate(options.angle, scope);
  },
  Panel: RotateRangePanel,
  previewOptions: (options, ctx) => {
    if (options.scope === "all") return options;
    const plan = rotateRangePlan(options, Math.max(1, ctx.pageCount));
    return plan.byPage && plan.byPage[1] !== undefined ? { ...options, scope: "all" } : null;
  },
});

/* ------------------------------ Metadatos ------------------------------ */

const metadataTool = define<ProMetadataOptions>({
  id: "metadata",
  tab: "home",
  icon: Tags,
  operation: metadataOperation,
  defaults: () => ({ mode: "set", form: { ...EMPTY_METADATA_FORM }, original: null, keepXmp: false }),
  canRun: (options, ctx) => {
    const s = text(ctx).metadata;
    if (!options.original) return { ok: false, reason: s.loading };
    if (options.mode === "strip") {
      return hasAnyMetadata(options.original) ? OK : { ok: false, reason: s.stripNothing };
    }
    return hasPatch(patchFromForm(options.form, options.original)) ? OK : { ok: false, reason: s.nothingChanged };
  },
  describe: (options, ctx) => (options.mode === "strip" ? labels(ctx).metadataStrip : labels(ctx).metadataSet),
  Panel: MetadataPanel,
  Result: ({ report, ctx }) => {
    const r = report as ProMetadataReport | null;
    return r?.xmpRemoved ? <p className="text-xs leading-relaxed text-muted-foreground">{text(ctx).metadata.xmpRemovedNote}</p> : null;
  },
});

/* ------------------------------ Reparar ------------------------------ */

const repairTool = define<undefined>({
  id: "repair",
  tab: "home",
  icon: Wrench,
  operation: repairOperation,
  defaults: () => undefined,
  canRun: (_options, ctx) =>
    assessDamage(ctx.bytes).length === 0 ? { ok: false, reason: text(ctx).repair.nothingToRepair } : OK,
  describe: (_options, ctx) => labels(ctx).repair,
  Panel: RepairPanel,
  Result: ({ report, ctx }) =>
    report ? (
      <RepairReportView s={REPAIR_STRINGS[ctx.language]} outcome={{ report: report as RepairReport }} language={localeTag(ctx.language)} />
    ) : null,
});

/* ------------------------------ OCR ------------------------------ */

const ocrTool = define<OcrOptions>({
  id: "ocr",
  tab: "home",
  icon: ScanText,
  needsNetwork: true,
  operation: ocrOperation as DocToolDefinition<OcrOptions>["operation"],
  defaults: (ctx) => ({ ...DEFAULT_OCR_OPTIONS, language: ctx.language === "en" ? "eng" : "spa" }),
  canRun: () => OK,
  describe: (options, ctx) => labels(ctx).ocr(OCR_STRINGS[ctx.language].languageNames[options.language]),
  Panel: ({ options, setOptions, ctx }: DocPanelProps<OcrOptions>) => (
    <OcrOptionsPanel options={options} setOptions={setOptions} strings={OCR_STRINGS[ctx.language]} fileSize={ctx.byteLength} />
  ),
});

/* ------------------------------ Quitar proteccion ------------------------------ */

const unlockTool = define<ProUnlockOptions>({
  id: "unlock",
  tab: "protect",
  icon: LockOpen,
  operation: unlockOperation,
  defaults: () => ({ password: "", acknowledgeSignatureInvalidation: false, inspected: "pending" }),
  canRun: (options, ctx) => {
    const s = text(ctx).unlock;
    if (options.inspected === "pending") return { ok: false, reason: s.checking };
    if (options.inspected === "failed") return { ok: false, reason: s.inspectFailed };
    if (options.inspected === "none") return { ok: false, reason: s.noRestrictions };
    return options.acknowledgeSignatureInvalidation ? OK : { ok: false, reason: s.consentRequired };
  },
  describe: (_options, ctx) => labels(ctx).unlock,
  Panel: UnlockPanel,
});

/** Todas, en el orden en que se ofrecen. */
export const DOC_TOOLS: readonly AnyDocTool[] = [
  watermarkTool,
  pageNumbersTool,
  headerFooterTool,
  compressTool,
  cropTool,
  rotateTool,
  metadataTool,
  repairTool,
  ocrTool,
  unlockTool,
];

export function getDocTool(id: DocToolId): AnyDocTool {
  const tool = DOC_TOOLS.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`Herramienta de documento desconocida: ${id}`);
  return tool;
}
