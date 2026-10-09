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
 * Huella de lo que un firmante llego a ver: el documento cargado y sus
 * huecos, con posicion, pagina y tipo. Es lo que ata el trazo a un estado
 * concreto del documento; si cambia, la captura ya no describe lo que esa
 * persona aprobo.
 */
export function captureStamp(
  documentKey: string,
  fields: readonly SignatureField[],
  signerId: string,
): string {
  const own = fields
    .filter((field) => field.signerId === signerId)
    .map((field) => {
      const { x, y, width, height } = field.rect;
      return `${field.id}|${field.pageIndex}|${field.type}|${x}|${y}|${width}|${height}`;
    })
    .sort();
  return [documentKey, ...own].join("~");
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
  return stored.stamp === captureStamp(documentKey, fields, signerId)
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
