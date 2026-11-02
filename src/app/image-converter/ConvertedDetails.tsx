"use client";

import { localeTag, useI18n } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import { STRINGS } from "@/app/image-converter/strings";

/** Lo que se sabe de cada imagen convertida, para el desglose «antes -> despues» de la pantalla de descarga. */
export type ConvertedRow = {
  sourceName: string;
  outputName: string;
  sourceBytes: number;
  outputBytes: number;
  width: number;
  height: number;
  capped: boolean;
};

/**
 * El resultado de `ToolShell` es solo un `Blob`: el desglose se guarda aparte, ligado a ese mismo Blob (se olvida con el). Asi la
 * pantalla de descarga lo encuentra sin que el shell tenga que conocer nada de imagenes.
 */
const ROWS = new WeakMap<Blob, readonly ConvertedRow[]>();

export function rememberConvertedRows(blob: Blob, rows: readonly ConvertedRow[]): void {
  ROWS.set(blob, rows);
}

export function ConvertedDetails({ result }: { result: Blob }) {
  const { language } = useI18n();
  const s = STRINGS[language];
  const locale = localeTag(language);
  const rows = ROWS.get(result);
  if (!rows || rows.length === 0) return null;
  const size = (bytes: number): string => formatFileSize(bytes, locale);
  return (
    <details open={rows.length <= 5} className="rounded-ios border border-hairline bg-white/5 p-3 text-left" data-converted-details="">
      <summary className="min-h-11 cursor-pointer py-2 text-subheadline font-medium text-foreground">{s.detailsSummary}</summary>
      <ul className="mt-1 space-y-2.5 text-footnote text-muted-foreground">
        {rows.map((row) => (
          <li key={row.outputName} className="break-words" data-converted-row="">
            {/* Un solo texto «original → resultado»: en un ZIP dice como se llamo cada una (y cual se renombro por repetida). */}
            <span className="block font-medium text-foreground">{`${row.sourceName} → ${row.outputName}`}</span>
            <span className="tabular-nums">
              {size(row.sourceBytes)} → {size(row.outputBytes)} · {row.width} × {row.height} px
            </span>
            {row.capped ? <span className="block">{s.detailsCapped}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
