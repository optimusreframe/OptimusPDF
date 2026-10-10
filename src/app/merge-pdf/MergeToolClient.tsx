"use client";

import { useCallback } from "react";
import { PageThumbnailGrid } from "@/components/tool/PageThumbnailGrid";
import {
  ToolShell,
  type ProcessResult,
} from "@/components/tool/ToolShell";
import { useI18n, useT } from "@/lib/i18n";
import { MERGE_STRINGS } from "@/app/merge-pdf/strings";
import { slugify, type PageRef, type ProgressCallback } from "@/lib/pdf/core";
import { mergePdfFiles } from "@/lib/pdf/merge";
import { getTool } from "@/lib/tools-registry";

/**
 * Patron de referencia para una herramienta live:
 *   page.tsx (server, metadata SEO) -> este cliente -> ToolShell -> lib/pdf/<motor>.ts
 * Copia esta estructura para el resto de herramientas.
 */

const TOOL = getTool("merge-pdf");

export type MergeToolOptions = {
  /** Plan de paginas producido por PageThumbnailGrid. */
  pages: PageRef[];
  /**
   * Archivos a los que pertenece `pages` cuando el plan esta COMPLETO (todos leidos). `null` mientras
   * se leen o si el plan es de otros archivos: entonces el plan no se usa y se unen TODAS las paginas
   * de TODOS los archivos, nunca un plan a medias.
   */
  planFiles: File[] | null;
};

const DEFAULT_OPTIONS: MergeToolOptions = { pages: [], planFiles: null };

function sameFiles(a: File[] | null, b: File[]): a is File[] {
  return a !== null && a.length === b.length && a.every((file, index) => file === b[index]);
}

/** Plan de paginas que de verdad corresponde a `files` (vacio = todas las paginas de todos los archivos). */
export function effectivePlan(files: File[], options: MergeToolOptions): PageRef[] {
  return sameFiles(options.planFiles, files) ? options.pages : [];
}

export function MergeToolClient() {
  const t = useT();
  const { language } = useI18n();
  const strings = MERGE_STRINGS[language];

  const process = useCallback(
    async (
      files: File[],
      options: MergeToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const blob = await mergePdfFiles(
        files,
        { pages: effectivePlan(files, options) },
        onProgress,
      );
      const base =
        t.filenames["merge-pdf"] ?? slugify(t.tools["merge-pdf"].name);
      return { blob, filename: `${base}.pdf` };
    },
    [t],
  );

  return (
    <ToolShell<MergeToolOptions>
      tool={TOOL}
      minFiles={2}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      canRun={(files, options) => {
        // La rejilla informa de las paginas; si todas estan desmarcadas no queda nada que unir.
        const plan = effectivePlan(files, options);
        return plan.length > 0 && plan.every((page) => !page.selected)
          ? { ok: false, reason: t.tool.needPageSelected }
          : { ok: true };
      }}
      renderMain={({ files, setOptions }) => (
        <PageThumbnailGrid
          files={files}
          selectable
          reorderable
          removable
          onItemsChange={(pages, meta) => setOptions({ pages, planFiles: meta.files })}
        />
      )}
      // El panel (con «Procesar» en su pie, siempre a la vista) evita que el boton quede al final de
      // una lista de miniaturas larguisima, bajo el pliegue.
      renderOptions={({ files, options }) => {
        const plan = effectivePlan(files, options);
        const ready = sameFiles(options.planFiles, files);
        return (
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">{strings.summaryFiles(files.length)}</p>
            <p className="text-sm text-foreground" role="status">
              {ready
                ? strings.summaryPages(plan.filter((page) => page.selected).length, plan.length)
                : strings.reading}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">{strings.hint}</p>
          </div>
        );
      }}
    />
  );
}
