import type { Language } from "@/lib/i18n";
import { localeTag } from "@/lib/i18n";
import { isIosWebKit } from "@/lib/image/platform";
import type { ConvertProblem } from "@/lib/media/image/convert";
import { limitsFor } from "@/lib/media/image/sizing";
import { formatFileSize } from "@/lib/pdf/core";
import { STRINGS, fill } from "@/app/image-converter/strings";

/** El motivo de un fallo, en el idioma elegido y con el limite de ESTE dispositivo en `tooBig` / `tooManyPixels`. */
export function problemReason(language: Language, problem: ConvertProblem): string {
  const limits = limitsFor(isIosWebKit());
  const max = problem === "tooManyPixels" ? String(Math.round(limits.maxInputPixels / 1_000_000)) : formatFileSize(limits.maxFileBytes, localeTag(language));
  return fill(STRINGS[language].problemLine[problem], { max });
}
