import {
  applyPageAssembly,
  type ExternalSource,
  type PageAssemblyWarning,
  type PageEntry,
} from "@/lib/pdf/pageAssembly";
import type { ProOperation, ProOperationContext, ProOperationResult } from "@/app/pdf-pro/proTypes";

/**
 * Operacion «Aplicar» del organizador de paginas (Wave 7 · U4): lleva el plan virtual al documento de
 * trabajo como UN snapshot. Es una operacion de tipo `pages` (el recuento de paginas lo da el motor).
 * Los avisos del motor (marcadores quitados, etiquetas de pagina...) viajan en `report`: no encajan en
 * los codigos genericos de `ProWarning`, asi que el organizador los muestra con sus propios textos.
 */
export type PagesApplyOptions = {
  plan: readonly PageEntry[];
  externals: Readonly<Record<string, ExternalSource>>;
};

export type PagesApplyReport = { warnings: PageAssemblyWarning[]; pageCount: number };

export const pagesApplyOperation: ProOperation<PagesApplyOptions> = {
  id: "pages-apply",
  labelKey: "pagesApply",
  kind: "pages",
  async run(bytes, options, ctx: ProOperationContext): Promise<ProOperationResult> {
    const result = await applyPageAssembly(bytes, options.plan, options.externals, {
      signal: ctx.signal,
      onProgress: ctx.onProgress,
    });
    const report: PagesApplyReport = { warnings: result.warnings, pageCount: result.pageCount };
    return { bytes: result.bytes, pageCount: result.pageCount, report };
  },
};
