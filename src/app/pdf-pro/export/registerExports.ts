import type { ToolSlug } from "@/lib/tools-registry";
import type { ComponentType } from "react";
import {
  CsvPanel,
  ExcelPanel,
  ImagesPanel,
  JsonPanel,
  MarkdownPanel,
  PowerpointPanel,
  TextPanel,
  scopeProblem,
} from "@/app/pdf-pro/export/ExportOptionPanels";
import { defaultExportOptions, exportUsesOcr } from "@/app/pdf-pro/export/exportDefaults";
import { runExportFormat } from "@/app/pdf-pro/export/exportRunners";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import type { ExportFormatId, ExportOptionsMap } from "@/app/pdf-pro/export/exportTypes";
import {
  registerProExport,
  type ProExport,
  type ProExportOptionsProps,
} from "@/app/pdf-pro/ops/proExports";

/**
 * Registra en la pestaña «Convertir» las ocho exportaciones de PDF Pro (Wave 7 · U8), cada una con su motor
 * (carga diferida), su mini-panel de opciones y su aviso de red. Se importa por efecto desde `ConvertTab`.
 * Los marcadores de U5 (`images`, `text`) se REEMPLAZAN por `id`.
 */

const SLUGS: Record<ExportFormatId, ToolSlug> = {
  images: "pdf-to-jpg",
  text: "pdf-to-text",
  word: "pdf-to-word",
  excel: "pdf-to-excel",
  csv: "pdf-to-csv",
  markdown: "pdf-to-markdown",
  json: "pdf-to-json",
  powerpoint: "pdf-to-powerpoint",
};

function entry<K extends ExportFormatId>(
  id: K,
  Options?: ComponentType<never>,
  extra: Partial<ProExport> = {},
): ProExport {
  return {
    id,
    title: (language) => getExportStrings(language).formats[id].title,
    body: (language) => getExportStrings(language).formats[id].body,
    slug: SLUGS[id],
    requiresNetwork: false,
    defaultOptions: () => defaultExportOptions(id),
    Options: Options as unknown as ComponentType<ProExportOptionsProps> | undefined,
    needsNetwork: (options) => exportUsesOcr(id, options as ExportOptionsMap[K]),
    async run(bytes, context) {
      const file =
        context.file ??
        new File([bytes as unknown as BlobPart], context.name, { type: "application/pdf" });
      return runExportFormat(id, {
        file,
        name: context.name,
        language: context.language,
        options: (context.options ?? defaultExportOptions(id)) as ExportOptionsMap[K],
        selectedPages: context.selectedPages,
        pageCount: context.pageCount,
        signal: context.signal,
        onProgress: context.onProgress,
      });
    },
    ...extra,
  };
}

let registered = false;

/** Registra las ocho exportaciones (una sola vez; un `__reset` de pruebas puede volver a llamarla). */
export function registerAllProExports(force = false): void {
  if (registered && !force) return;
  registered = true;
  registerProExport(
    entry("images", ImagesPanel as unknown as ComponentType<never>, {
      validate: (options, info) =>
        scopeProblem(info.language, options as ExportOptionsMap["images"], info.pageCount, info.selectedPages),
    }),
  );
  registerProExport(entry("text", TextPanel as unknown as ComponentType<never>));
  registerProExport(entry("word"));
  registerProExport(entry("excel", ExcelPanel as unknown as ComponentType<never>));
  registerProExport(entry("csv", CsvPanel as unknown as ComponentType<never>));
  registerProExport(entry("markdown", MarkdownPanel as unknown as ComponentType<never>));
  registerProExport(entry("json", JsonPanel as unknown as ComponentType<never>));
  registerProExport(entry("powerpoint", PowerpointPanel as unknown as ComponentType<never>));
}

registerAllProExports();
