import type { CanRunResult } from "@/components/tool/ToolShell";
import {
  unsupportedPasswordChars,
  validateProtectOptions,
  type ProtectOptions,
} from "@/lib/pdf/protect";
import type { ProtectStrings } from "@/app/protect-pdf/strings";

/**
 * Regla de «se puede proteger», COMPARTIDA por la herramienta suelta y por PDF Pro: el motivo exacto
 * (contrasena vacia, corta, con caracteres que el cifrado no admite, sin repetir...) se lee junto al boton.
 * Un caracter fuera de Latin-1 se SENALA por su nombre: nunca el mensaje de «ya esta protegido».
 */
export function protectCanRun(options: ProtectOptions, strings: ProtectStrings): CanRunResult {
  const invalid = validateProtectOptions(options);
  if (invalid === "mismatch" && options.confirm.length === 0) {
    return { ok: false, reason: strings.confirmRequired };
  }
  if (invalid === "unsupportedChars") {
    return {
      ok: false,
      reason: strings.errors.unsupportedChars.replace(
        "{chars}",
        unsupportedPasswordChars(options.password).join(" "),
      ),
    };
  }
  return invalid ? { ok: false, reason: strings.errors[invalid] } : { ok: true };
}
