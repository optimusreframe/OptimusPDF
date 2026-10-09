import {
  dataUrlToVaultImage,
  saveVaultEntry,
  type SaveVaultResult,
  type VaultEntryInput,
} from "@/app/sign-pdf/signVault";
import type { ImportVaultReason } from "@/app/sign-pdf/signVaultFile";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";

/** Mensaje humano de un resultado de `saveVaultEntry` (exito o motivo del fallo). */
export function saveResultMessage(
  strings: SignStrings,
  result: SaveVaultResult,
  /** Que acaba de crear quien guarda: el texto de exito habla de «firma» o de «iniciales». */
  kind: "signature" | "initials" = "signature",
): string {
  if (result.ok) {
    if (kind === "initials") {
      return result.duplicate
        ? strings.vaultSavedDuplicateInitials
        : strings.vaultSavedInitials;
    }
    return result.duplicate ? strings.vaultSavedDuplicate : strings.vaultSaved;
  }
  switch (result.reason) {
    case "limit":
      return strings.vaultSaveLimit;
    case "tooLarge":
      return strings.vaultSaveTooLarge;
    case "invalid":
      return strings.vaultSaveInvalid;
    default:
      return strings.vaultSaveUnavailable;
  }
}

/** Mensaje humano de cada motivo de fallo de `importVaultFile`. */
export function importReasonMessage(
  strings: SignStrings,
  reason: ImportVaultReason,
): string {
  switch (reason) {
    case "tooLarge":
      return strings.vaultImportTooLarge;
    case "wrongPassword":
      return strings.vaultImportWrongPassword;
    case "unsupportedVersion":
      return strings.vaultImportUnsupportedVersion;
    case "encryptionUnavailable":
      return strings.vaultImportNoEncryption;
    // "needsPassword" lo resuelve la interfaz pidiendo la contraseña; si
    // llegara aqui, lo mas honesto es el mensaje generico.
    default:
      return strings.vaultImportInvalid;
  }
}

/**
 * Texto para un `role=status` y su tono: exito, informativo (p. ej. una
 * captura parcial: no es un error) o problema.
 */
export type VaultNotice = {
  text: string;
  tone: "success" | "info" | "error";
};

/**
 * Guarda en el baul lo que acaba de crear el compositor (firma y/o
 * iniciales) y devuelve el aviso para el `role=status` del que llama. Nunca
 * lanza: `saveVaultEntry` tampoco.
 */
export async function rememberDrafts(
  strings: SignStrings,
  params: {
    signerName: string;
    sourceDocument: string;
    signature: SignatureDraft | null;
    initials: SignatureDraft | null;
    /** Lo que se acaba de crear (decide el texto del aviso). Por defecto, la firma. */
    created?: "signature" | "initials";
  },
): Promise<VaultNotice> {
  const signature = params.signature
    ? dataUrlToVaultImage(params.signature.dataUrl, params.signature.ratio)
    : null;
  const initials = params.initials
    ? dataUrlToVaultImage(params.initials.dataUrl, params.initials.ratio)
    : null;
  // Un PNG que no se pudo leer no se guarda a medias.
  if (
    (params.signature && !signature) ||
    (params.initials && !initials)
  ) {
    return { text: strings.vaultSaveInvalid, tone: "error" };
  }
  const input: VaultEntryInput = {
    signerName: params.signerName,
    sourceDocument: params.sourceDocument,
    signature,
    initials,
  };
  const result = await saveVaultEntry(input);
  return {
    text: saveResultMessage(strings, result, params.created),
    tone: result.ok ? "success" : "error",
  };
}
