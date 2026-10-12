import type { CanRunResult } from "@/components/tool/ToolShell";
import type { CropOptions } from "@/lib/pdf/crop";
import type { CropStrings } from "@/app/crop-pdf/strings";

/** Fraccion minima (del ancho o del alto) que debe conservar el recorte; el motor rechaza < 8 pt. */
export const CROP_MIN_FRACTION = 0.03;

/**
 * Regla de «se puede recortar», COMPARTIDA por la herramienta suelta y por PDF Pro: el motor rechaza un
 * lado menor de 8 pt, asi que aqui se avisa antes (menos del 3 % de la pagina).
 */
export function cropCanRun(options: Pick<CropOptions, "rect">, strings: CropStrings): CanRunResult {
  return options.rect.width < CROP_MIN_FRACTION || options.rect.height < CROP_MIN_FRACTION
    ? { ok: false, reason: strings.selectionTooSmall }
    : { ok: true };
}
