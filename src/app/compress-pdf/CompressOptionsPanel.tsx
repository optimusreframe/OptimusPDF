"use client";

import { Checkbox } from "@/components/ui/Checkbox";
import { LevelCards } from "@/app/compress-pdf/LevelCards";
import type { CompressStrings } from "@/app/compress-pdf/strings";
import { MAX_SAFE_FILE_SIZE } from "@/lib/pdf/core";
import type { CompressOptions } from "@/lib/pdf/compress";

export type CompressOptionsPanelProps = {
  options: CompressOptions;
  setOptions: (patch: Partial<CompressOptions>) => void;
  strings: CompressStrings;
  /** Peso del archivo, para avisar de que aplanar un archivo enorme puede agotar la memoria. */
  fileSize?: number;
};

/**
 * Panel de opciones de Comprimir (nivel + «Aplanar documento escaneado»), COMPARTIDO por la herramienta
 * suelta y por PDF Pro: misma interfaz y mismas opciones del motor `compress.ts`.
 */
export function CompressOptionsPanel({ options, setOptions, strings: s, fileSize }: CompressOptionsPanelProps) {
  return (
    <>
      <LevelCards
        label={s.levelLabel}
        value={options.level}
        onChange={(level) => setOptions({ level })}
        options={[
          { value: "extreme", name: s.extremeName, hint: s.extremeHint },
          { value: "recommended", name: s.recommendedName, hint: s.recommendedHint },
          { value: "low", name: s.lowName, hint: s.lowHint },
        ]}
      />

      <Checkbox
        label={s.flattenModeLabel}
        hint={s.flattenModeHint}
        checked={options.mode === "flatten"}
        onChange={(checked) => setOptions({ mode: checked ? "flatten" : "recompress" })}
      />

      {options.mode === "flatten" && fileSize !== undefined && fileSize > MAX_SAFE_FILE_SIZE ? (
        <p className="text-xs leading-relaxed text-destructive">{s.largeFile}</p>
      ) : null}
    </>
  );
}
