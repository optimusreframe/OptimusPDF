import { toWinAnsiSafe } from "@/lib/pdf/core";
import type { CanRunResult } from "@/components/tool/ToolShell";
import type { WatermarkOptions } from "@/lib/pdf/watermark";
import type { WatermarkStrings } from "@/app/add-watermark/strings";

/**
 * Regla de «se puede aplicar» de la marca de agua, COMPARTIDA por la herramienta suelta y por PDF Pro:
 * una marca sin texto (o sin imagen) no estampa nada, asi que se avisa del motivo en vez de procesar.
 */
export function watermarkCanRun(options: WatermarkOptions, strings: WatermarkStrings): CanRunResult {
  if (options.kind === "text" && toWinAnsiSafe(options.text.trim()).length === 0) {
    return { ok: false, reason: strings.textRequired };
  }
  if (options.kind === "image" && !options.image) {
    return { ok: false, reason: strings.imageRequired };
  }
  return { ok: true };
}
