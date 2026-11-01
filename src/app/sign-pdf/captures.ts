import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import type {
  SignatureField,
  SignatureFieldType,
  Signer,
} from "@/lib/pdf/sign";

/*
 * Capturas de la ronda por turnos: lo que cada firmante creo y la huella que
 * lo ata al documento y a sus huecos. Son funciones puras, sin React: viven
 * aqui (extraidas de `SigningCeremony.tsx`, que las re-exporta con las mismas
 * firmas) para que `docSet.ts` y los tests las usen sin arrastrar el arbol
 * de la ceremonia.
 */

/** Lo que cada firmante ha creado en su turno. */
export type SignerCapture = {
  signature: SignatureDraft | null;
  initials: SignatureDraft | null;
  /** Huella de `{ documento + huecos propios }` en el momento de crearlo. */
  stamp: string;
};

export const EMPTY_CAPTURE: SignerCapture = {
  signature: null,
  initials: null,
  stamp: "",
};

export type CaptureMap = Record<string, SignerCapture>;

/**
 * Huella de lo que un firmante aprobo: SOLO el documento cargado (archivo + ediciones de texto). Los huecos de firma ya NO
 * entran: mover, redimensionar, cambiar de pagina, anadir o quitar un hueco no hace perder la firma ni las iniciales ya
 * recogidas (la persona firma su trazo, no una coordenada). Que falte un TIPO de trazo para un hueco nuevo lo resuelve
 * `isSignerComplete`/`requiredCaptureTypes`: solo se pide lo que falta, nunca se tira lo que ya hay.
 *
 * Los parametros `fields` y `signerId` se conservan por compatibilidad con los llamadores. Las huellas antiguas
 * (`huella~hueco~hueco...`, guardadas en borradores y respaldos) se leen igual con `sameStamp`, que solo mira la huella del documento.
 */
export function captureStamp(
  documentKey: string,
  fields?: readonly SignatureField[],
  signerId?: string,
): string {
  void fields;
  void signerId;
  return documentKey;
}

/** Huella del documento dentro de un sello (los sellos antiguos llevan tras `~` los huecos, que ya no cuentan). */
export function stampDocumentKey(stamp: string): string {
  return stamp.split("~")[0];
}

/** `true` si los dos sellos describen el mismo documento (mismo archivo y mismas ediciones de texto). Vacio nunca coincide. */
export function sameStamp(stored: string, current: string): boolean {
  return stored !== "" && current !== "" && stampDocumentKey(stored) === stampDocumentKey(current);
}

/**
 * Por que una firma ya hecha dejo de valer (F0-fix, D7): cambio el texto del documento o el documento. `"fields"` (huecos) ya no
 * se produce: mover los huecos no invalida nada; el tipo se conserva solo por los textos de la interfaz.
 */
export type StaleReason = "text" | "fields" | "document";

/**
 * Por que un sello guardado ya no vale frente al de ahora (`null` = sigue valiendo, o no habia sello que comparar).
 * El sello es `huella~hueco~hueco...` (ver `captureStamp`) y la huella es `archivo` o `archivo+t<ediciones>` (`stampKeyOf`):
 * misma huella y otros huecos = «huecos»; mismo archivo y otras ediciones de texto = «texto»; otro archivo = «documento».
 */
export function staleReason(storedStamp: string, currentStamp: string): StaleReason | null {
  if (storedStamp === "" || sameStamp(storedStamp, currentStamp)) return null;
  const storedKey = stampDocumentKey(storedStamp);
  const currentKey = stampDocumentKey(currentStamp);
  const fileOf = (key: string) => key.split("+t")[0];
  return fileOf(storedKey) === fileOf(currentKey) ? "text" : "document";
}

/** El trazo de este firmante YA estaba hecho (firma o iniciales) pero su sello ya no vale: por que. `null` = no es el caso. */
export function staleCaptureReason(
  captures: CaptureMap,
  fields: readonly SignatureField[],
  signerId: string,
  documentKey: string | null,
): StaleReason | null {
  const stored = captures[signerId];
  if (!documentKey || !stored || (!stored.signature && !stored.initials)) return null;
  return staleReason(stored.stamp, captureStamp(documentKey, fields, signerId));
}

/**
 * La captura guardada solo vale si su huella coincide con la de ahora.
 * Ante cualquier duda se devuelve vacia: reaplicar una firma antigua en un
 * hueco que su dueño no vio seria falsificarla. Sin identidad del
 * documento (`null`: aun calculandose o imposible de calcular) tampoco
 * vale nada, por el mismo motivo.
 */
export function validCapture(
  captures: CaptureMap,
  fields: readonly SignatureField[],
  signerId: string,
  documentKey: string | null,
): SignerCapture {
  if (!documentKey) return EMPTY_CAPTURE;
  const stored = captures[signerId] ?? EMPTY_CAPTURE;
  return sameStamp(stored.stamp, captureStamp(documentKey, fields, signerId))
    ? stored
    : EMPTY_CAPTURE;
}

/** Tipos de trazo que un firmante tiene que crear, segun sus huecos. */
export function requiredCaptureTypes(
  fields: readonly SignatureField[],
  signerId: string,
): SignatureFieldType[] {
  const types: SignatureFieldType[] = [];
  for (const field of fields) {
    if (field.signerId !== signerId) continue;
    if (!types.includes(field.type)) types.push(field.type);
  }
  return types;
}

export function isSignerComplete(
  fields: readonly SignatureField[],
  captures: CaptureMap,
  signerId: string,
  documentKey: string | null,
): boolean {
  const required = requiredCaptureTypes(fields, signerId);
  if (required.length === 0) return true;
  const capture = validCapture(captures, fields, signerId, documentKey);
  return required.every((type) => capture[type] !== null);
}

/** Firmantes con huecos asignados, en el orden en que les toca. */
export function signingQueue(
  signers: readonly Signer[],
  fields: readonly SignatureField[],
): Signer[] {
  return signers.filter((signer) =>
    fields.some((field) => field.signerId === signer.id),
  );
}

/** Quienes tienen huecos y todavia no han dejado su trazo. */
export function pendingSigners(
  signers: readonly Signer[],
  fields: readonly SignatureField[],
  captures: CaptureMap,
  documentKey: string | null,
): Signer[] {
  return signingQueue(signers, fields).filter(
    (signer) => !isSignerComplete(fields, captures, signer.id, documentKey),
  );
}
