import type { Language } from "@/lib/i18n";
import { getExportStore } from "@/app/pdf-pro/export/exportStore";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

/**
 * Cerrar el documento o abrir otro con una exportacion EN CURSO (Wave 9): cuenta como razon para confirmar (igual que
 * los cambios sin descargar y los pasos en vuelo), con un texto que lo dice, y al confirmar la exportacion se cancela
 * y se limpia antes de que el documento cambie (nunca queda un motor huerfano ni una descarga del documento anterior).
 *
 * `baseBody` es el texto habitual de esa confirmacion (el que habla de los cambios sin descargar). Devuelve si hace
 * falta confirmar y con que texto: solo el de la exportacion, o el habitual + el de la exportacion si ademas hay cambios.
 */
export function leaveConfirmation(
  doc: ProWorkingDoc,
  language: Language,
  kind: "close" | "replace",
  baseBody: string,
): { needed: boolean; body: string } {
  const state = doc.getState();
  const changes = !!state.document && (state.dirty || state.stepInFlight);
  const job = getExportStore(doc).runningJob;
  if (!job) return { needed: changes, body: baseBody };
  const notices = getExportStrings(language).notices;
  const format = getExportStrings(language).formatsShort[job.formatId];
  if (!changes) return { needed: true, body: kind === "close" ? notices.closeOnly(format) : notices.replaceOnly(format) };
  return { needed: true, body: `${baseBody} ${notices.also(format)}` };
}

/** Cancela y limpia la exportacion en curso (sin anunciar nada: el cierre/cambio de documento ya se anuncia). */
export function discardExportBeforeLeaving(doc: ProWorkingDoc): void {
  getExportStore(doc).discard();
}
