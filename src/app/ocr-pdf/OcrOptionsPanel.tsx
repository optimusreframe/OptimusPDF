"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { OcrStrings } from "@/app/ocr-pdf/strings";
import { MAX_SAFE_FILE_SIZE } from "@/lib/pdf/core";
import { OCR_LANGUAGES, type OcrLanguage, type OcrOptions } from "@/lib/pdf/ocr";

export type OcrOptionsPanelProps = {
  options: OcrOptions;
  setOptions: (patch: Partial<OcrOptions>) => void;
  strings: OcrStrings;
  fileSize?: number;
};

/** Idioma del reconocimiento y avisos de descarga/tamano de OCR, COMPARTIDO por la herramienta suelta y por PDF Pro. */
export function OcrOptionsPanel({ options, setOptions, strings: s, fileSize }: OcrOptionsPanelProps) {
  return (
    <>
      <div>
        {/* `wrap`: con la fuente al 150 % en el panel de 280 px («Portugués» se salia 8 px de la pantalla a 834 px) los idiomas pasan a otra fila. */}
        <SegmentedControl<OcrLanguage>
          wrap
          label={s.languageLabel}
          value={options.language}
          onChange={(value) => setOptions({ language: value })}
          options={OCR_LANGUAGES.map((code) => ({
            value: code,
            label: s.languageNames[code],
          }))}
        />
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.languageHint}</p>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{s.downloadNotice}</p>

      {fileSize !== undefined && fileSize > MAX_SAFE_FILE_SIZE ? (
        <p className="text-xs leading-relaxed text-destructive">{s.largeFile}</p>
      ) : null}
    </>
  );
}
