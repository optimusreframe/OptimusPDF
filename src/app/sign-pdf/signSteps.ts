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
