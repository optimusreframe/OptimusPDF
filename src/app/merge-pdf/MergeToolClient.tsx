"use client";

import { useCallback } from "react";
import { PageThumbnailGrid } from "@/components/tool/PageThumbnailGrid";
import {
  ToolShell,
  type ProcessResult,
} from "@/components/tool/ToolShell";
import { useT } from "@/lib/i18n";
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
};

const DEFAULT_OPTIONS: MergeToolOptions = { pages: [] };

export function MergeToolClient() {
  const t = useT();

  const process = useCallback(
    async (
      files: File[],
      options: MergeToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const blob = await mergePdfFiles(
        files,
        { pages: options.pages },
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
      renderMain={({ files, setOptions }) => (
        <PageThumbnailGrid
          files={files}
          selectable
          reorderable
          removable
          onItemsChange={(pages) => setOptions({ pages })}
        />
      )}
    />
  );
}
