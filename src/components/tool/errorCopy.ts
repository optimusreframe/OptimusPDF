import type { Dictionary } from "@/lib/i18n";
import type { PdfErrorCode } from "@/lib/pdf/core";
import type { ErrorBannerAction } from "@/components/tool/ErrorBanner";
import { reloadPage } from "@/lib/reloadPage";

/**
 * Texto del banner de error (Wave 6 · U1/U5), en UN solo sitio: `ToolShell` y las
 * herramientas con cabecera propia (pdf-to-pdfa, compare, summarizer, scan) lo
 * piden aqui, asi el mismo archivo malo se explica con las mismas palabras en todas.
 *
 * - `fileProblem`: el error es de un archivo concreto (lo vio la comprobacion de la
 *   subida o se afino tras un fallo del motor): titulo «No se puede usar este archivo».
 * - `sheet`: el PDF cifrado se abre con la hoja de contrasena (no con el enlace a
 *   Desbloquear), asi que el mensaje habla de escribirla.
 * - `suggestSplit`: el aviso de archivo grande propone «Dividir PDF» (nunca en el propio Dividir PDF).
 *
 * `tooLarge` NO es un fallo sino un aviso (el archivo se puede procesar bajo responsabilidad
 * propia): `kind` lo dice para que el banner use la variante de aviso, con su propio titulo.
 */
export type ErrorCopy = {
  title: string;
  message: string;
  hint?: string;
  kind: "error" | "warning";
};

export function errorCopy(
  t: Dictionary,
  code: PdfErrorCode,
  options: { fileProblem?: boolean; sheet?: boolean; suggestSplit?: boolean } = {},
): ErrorCopy {
  const { fileProblem = false, sheet = false, suggestSplit = true } = options;
  const hints = t.tool.errorHints as Partial<Record<PdfErrorCode, string>>;
  if (code === "tooLarge") {
    return {
      kind: "warning",
      title: t.tool.largeFileTitle,
      message: t.tool.errors.tooLarge,
      hint: suggestSplit ? t.tool.errorHints.tooLargeSplit : t.tool.errorHints.tooLarge,
    };
  }
  return {
    kind: "error",
    title: fileProblem ? t.tool.fileProblemTitle : t.tool.errors.title,
    message: sheet ? t.tool.encryptedSheetMessage : t.tool.errors[code],
    // Con el enlace a Desbloquear la unica frase y la unica accion ya lo dicen todo: sin pista repetida.
    hint: sheet || code === "encrypted" ? undefined : hints[code],
  };
}

/** «{action} se activa cuando…»: el motivo nombra el boton REAL de la herramienta («Procesar», «Revisar documento»…). */
export function blockedRunText(t: Dictionary, action: string): string {
  return t.tool.blockedRun.replace("{action}", action);
}

/**
 * Acciones del banner para un error. `offline` (un componente de la aplicacion no se pudo descargar y el empaquetador
 * cachea el `import()` fallido) solo se arregla recargando la pagina: el boton lo hace. Otros codigos no llevan accion.
 */
export function errorActions(t: Dictionary, code: PdfErrorCode | null | undefined): ErrorBannerAction[] | undefined {
  if (code !== "offline") return undefined;
  return [{ id: "reload", label: t.tool.errors.reloadAction, onClick: reloadPage, primary: true }];
}
