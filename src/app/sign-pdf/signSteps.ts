import type {
  LegacyMultiStep,
  MultiStep,
} from "@/app/sign-pdf/SignToolClient";

/**
 * Normaliza un paso persistido (posiblemente anterior a W2-A) al modelo
 * vigente, sin perder nada. Vive aparte de `SignToolClient` para que los
 * modulos de datos (borradores de sesion) puedan usarlo sin un ciclo de
 * importacion; `SignToolClient` lo re-exporta con el mismo nombre.
 */
export function migrateStep(
  step: LegacyMultiStep | string | undefined,
): MultiStep {
  if (step === "signers" || step === "document" || step === "sign") return step;
  if (step === "fields" || step === "text") return "document";
  return "signers";
}

/**
 * Paso con el que arranca una ronda de documentos NUEVA (W3-B2). Los firmantes sobreviven a una ronda nueva (`FRESH_ROUND`): si la
 * persona ya tiene firmantes en «Varios firmantes», quienes firman ya esta decidido y no hace falta pasar otra vez por «Firmantes»;
 * se empieza en «Documento». El paso «Firmantes» sigue a un toque (la barra de pasos y «Cambiar» en el resumen de firmantes del
 * paso Documento), asi que nada queda escondido. Sin firmantes, o en «Solo yo», todo empieza como siempre.
 */
export function initialStepFor(session: { mode: string; signers: readonly unknown[] }): MultiStep {
  return session.mode === "multi" && session.signers.length > 0 ? "document" : "signers";
}
