"use client";

import { useCallback, useState } from "react";
import { PageThumbnailGrid } from "@/components/tool/PageThumbnailGrid";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import {
  PageNumbersOptionsPanel,
  type PageNumbersToolOptions,
} from "@/app/add-page-numbers/PageNumbersOptionsPanel";
import { PAGE_NUMBERS_STRINGS } from "@/app/add-page-numbers/strings";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  DEFAULT_PAGE_NUMBERS_OPTIONS,
  addPageNumbers,
} from "@/lib/pdf/pageNumbers";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("add-page-numbers");

const DEFAULT_OPTIONS: PageNumbersToolOptions = {
  ...DEFAULT_PAGE_NUMBERS_OPTIONS,
  preset: "number",
};

export function PageNumbersToolClient() {
  const { language } = useI18n();
  const strings = PAGE_NUMBERS_STRINGS[language];
  const [totalPages, setTotalPages] = useState(0);

  const process = useCallback(
    async (
      files: File[],
      options: PageNumbersToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      // `PageNumbersToolOptions` extiende las opciones del motor: el
      // campo `preset` solo lo usa la interfaz y el motor lo ignora.
      const blob = await addPageNumbers(file, options, onProgress);
      return { blob, filename: withSuffix(file.name, strings.filenameSuffix) };
    },
    [strings.filenameSuffix],
  );

  return (
    <ToolShell<PageNumbersToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      renderMain={({ files }) => (
        <PageThumbnailGrid
          files={files}
          onItemsChange={(items) => setTotalPages(items.length)}
        />
      )}
      renderOptions={({ options, setOptions }) => (
        <PageNumbersOptionsPanel
          options={options}
          setOptions={setOptions}
          strings={strings}
          totalPages={totalPages}
        />
      )}
    />
  );
}
