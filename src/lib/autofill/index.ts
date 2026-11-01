/**
 * Autorrelleno desde documentos (F3) — motor. Puro (sin React), local, probado en Node y en el navegador.
 *
 *   import { extract, planFill } from "@/lib/autofill";
 *   const result = await extract(sources, { locale: "es", signal, onProgress });
 *   const proposals = planFill(targets, acceptedValues);
 *
 * Para el OCR (fotos y paginas escaneadas) el modelo de lectura debe estar ya en el dispositivo: la interfaz lo comprueba con
 * `ocrModelAvailable()` y lo descarga, con permiso, con `prepareOcrModel()` (ambos en `@/lib/scan/ocr`). Sin el modelo, `extract` no
 * bloquea: devuelve el aviso `ocr-unavailable`.
 */

export { extract, createExtract, browserDeps, DEFAULT_MAX_PAGES, OCR_TIMEOUT_MS, PASTE_MAX_CHARS } from "@/lib/autofill/engine";
export type { EngineDeps, RecognizeOptions } from "@/lib/autofill/engine";
export { planFill } from "@/lib/autofill/planFill";
export type { PlanFillOptions } from "@/lib/autofill/planFill";
export { HIGH_CONFIDENCE } from "@/lib/autofill/resolve";
export type {
  AutofillOrigin,
  AutofillSource,
  ClientProfile,
  ClientProfileValue,
  ExtractEngine,
  ExtractOptions,
  ExtractResult,
  ExtractWarning,
  ExtractWarningCode,
  ExtractedValue,
  FillProposal,
  FillTarget,
} from "@/lib/autofill/types";
