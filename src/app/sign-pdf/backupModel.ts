import type { SignatureDecision, SignatureImportItem, SignatureItemStatus } from "@/lib/backup/modules/signatures";
import type { ExportFailure } from "@/app/sign-pdf/backupFlow";

/**
 * Decisiones de pantalla de «Exportar / Importar firmas» que NO dependen de React: que opciones ofrece cada estado de
 * la vista previa, a que mensaje corresponde cada fallo. Aparte de la interfaz para probarlas (y mutarlas) con precision.
 */

/**
 * Lo que el usuario puede elegir para un elemento segun su estado (idéntico e invalido: nada, se omiten).
 * Con «distinto»: si la entrada del baul es de OTRA persona no se ofrece «Reemplazar» (borraria su firma); si son los
 * MISMOS dibujos con otros datos, «Conservar ambos» no aporta nada (duplicaria los dibujos): solo reemplazar u omitir.
 */
export function decisionOptions(
  status: SignatureItemStatus,
  item: Pick<SignatureImportItem, "difference" | "canReplace"> = {},
): SignatureDecision[] {
  if (status === "new") return ["import", "omit"];
  if (status === "different") {
    if (item.canReplace === false) return ["keepBoth", "omit"];
    if (item.difference === "data") return ["replace", "omit"];
    return ["replace", "keepBoth", "omit"];
  }
  return [];
}

export type ApplyFailureKey = "limit" | "unavailable" | "invalid" | "changed";

/** `blocked` (el plan no era importable) se cuenta como «no valido»: nada se escribio. */
export function describeApplyFailure(
  reason: "limit" | "unavailable" | "invalid" | "blocked" | "changed",
): ApplyFailureKey {
  if (reason === "limit") return "limit";
  if (reason === "unavailable") return "unavailable";
  if (reason === "changed") return "changed";
  return "invalid";
}

export type ExportErrorKey = "exportEmpty" | "encryptionUnavailable" | "exportUnavailable" | "exportTooLarge" | "exportFailed";

export function exportErrorKey(reason: ExportFailure): ExportErrorKey {
  switch (reason) {
    case "empty":
      return "exportEmpty";
    case "encryptionUnavailable":
      return "encryptionUnavailable";
    case "unavailable":
      return "exportUnavailable";
    case "tooLarge":
      return "exportTooLarge";
    default:
      return "exportFailed";
  }
}
