import { captureStamp } from "@/app/sign-pdf/captures";
import { EMPTY_DOC_STATE, type SignerBlock } from "@/app/sign-pdf/docSet";
import type { MultiStep } from "@/app/sign-pdf/SignToolClient";
import { saveDraft, saveSessionDraft } from "@/app/sign-pdf/signDrafts";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/*
 * Borradores de prueba (sobre `fake-indexeddb`) para los tests de «retomar sin buscar» (U0.3): una sesion de varios
 * documentos o un documento suelto, con la huella que se les diga (la que luego busca la oferta al subir los mismos PDF).
 */

export const HASH = (letter: string): string => letter.repeat(64);
export const SESSION_ID = (tag: string): string => `s-mgl1${tag}-1k3v9x2a`;

export const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
export const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };

const STROKE = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };

function slot(signerId: string, id: string): SignatureField {
  return { id, signerId, pageIndex: 0, type: "signature", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } };
}

/**
 * Guarda una sesion de dos documentos; devuelve su id. Con `signed` (ids de firmantes) la sesion lleva un hueco de firma
 * por firmante y documento y los trazos VIGENTES de esos firmantes (con el sello de la huella de cada documento): asi la
 * ronda esta «a medias» si firmo uno y no el otro.
 */
export async function seedSession(
  args: {
    id?: string;
    keys?: [string, string];
    names?: [string, string];
    signers?: Signer[];
    step?: MultiStep;
    signed?: string[];
  } = {},
): Promise<string> {
  const id = args.id ?? SESSION_ID("a");
  const keys = args.keys ?? [HASH("a"), HASH("b")];
  const names = args.names ?? ["Contrato A.pdf", "Anexo B.pdf"];
  const signers = args.signers ?? [ANA, LUIS];
  const withRound = args.signed !== undefined;
  const docIds = ["d1", "d2"];
  const fieldsOf = (index: number): SignatureField[] =>
    withRound ? signers.map((signer) => slot(signer.id, `fld-${signer.id}-${index}`)) : [];
  const blocks: SignerBlock[] = withRound
    ? signers.map((signer, position) => {
        const done = (args.signed ?? []).includes(signer.id);
        return {
          id: `bk-${position + 1}`,
          signerId: signer.id,
          appliesTo: docIds,
          signature: done ? STROKE : null,
          initials: null,
          stamps: done
            ? Object.fromEntries(docIds.map((docId, index) => [docId, captureStamp(keys[index], fieldsOf(index), signer.id)]))
            : {},
          auto: true,
        };
      })
    : [];
  const result = await saveSessionDraft({
    id,
    mode: "multi",
    signMode: "same",
    signers,
    blocks,
    documents: [0, 1].map((index) => ({
      id: docIds[index],
      fileName: names[index],
      size: 5,
      state: { ...EMPTY_DOC_STATE, sealedKey: keys[index], fields: fieldsOf(index) },
      getBytes: async () => new Uint8Array([37, 80, 68, 70, index + 1]),
    })),
    activeDocId: "d1",
    step: args.step ?? "signers",
  });
  if (!result.ok) throw new Error(`no se pudo guardar la sesion de prueba: ${result.reason}`);
  return id;
}

/**
 * Guarda un borrador de UN documento; devuelve su id. Por defecto, como los borradores anteriores a F0-fix: su id ES la huella
 * del PDF. Con `id` (distinto de la huella) es un borrador de una sesion de trabajo propia, como los de ahora: la huella
 * (`key`) viaja aparte (D3).
 */
export async function seedDocument(
  args: { key?: string; id?: string; name?: string; signers?: Signer[] } = {},
): Promise<string> {
  const key = args.key ?? HASH("c");
  const id = args.id ?? key;
  await saveDraft({
    id,
    ...(args.id ? { fingerprint: key } : {}),
    fileBytes: new Uint8Array([37, 80, 68, 70, 9]),
    fileName: args.name ?? "Poliza.pdf",
    manifest: {
      mode: "multi",
      signers: args.signers ?? [ANA],
      fields: [],
      textFields: [],
      textValues: {},
    },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
  });
  return id;
}
