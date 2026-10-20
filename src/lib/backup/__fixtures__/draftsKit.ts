import { PDFDocument } from "@cantoo/pdf-lib";
import {
  EMPTY_DOC_STATE,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import { captureStamp } from "@/app/sign-pdf/captures";
import {
  clearAllDrafts,
  saveDraft,
  saveSessionDraft,
  type SaveSessionParams,
} from "@/app/sign-pdf/signDrafts";
import {
  clearAllEditDrafts,
  fingerprintPdfBytes,
  saveEditDraft,
} from "@/app/edit-pdf/editDrafts";
import {
  applyOp,
  createEditSession,
  imageAddOp,
  newTextEdit,
  textItem,
  type EditSession,
} from "@/app/edit-pdf/editSession";
import { clearAllProDrafts, saveProDraft } from "@/app/pdf-pro/proDrafts";
import { sha256Hex } from "@/lib/crypto/sha256";
import { dataUrlFromPng } from "@/lib/backup/modules/draftsPng";
import { makeRealPng } from "@/lib/backup/__fixtures__/pngFactory";
import type { ImageElement } from "@/lib/pdf/editPdf";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * Borradores de PRUEBA para el modulo «Borradores» del respaldo: se guardan con las funciones REALES de cada almacen
 * (`saveDraft`, `saveSessionDraft`, `saveEditDraft`, `saveProDraft`) sobre `fake-indexeddb`, con PDF de verdad (`pdf-lib`,
 * sin metadatos de fecha: mismos bytes en cada ejecucion) y trazos PNG reales. Solo lo usan las pruebas.
 */

export const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
export const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };

/** Un PDF real de `pages` paginas, determinista (sin fechas). */
export async function realPdf(label: string, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([300, 400]);
    page.drawText(`${label} ${index + 1}`, { x: 30, y: 350, size: 16 });
  }
  return doc.save({ useObjectStreams: false });
}

/** Trazo de firma con un PNG REAL (de `seed`), como lo deja el compositor: `data:` URL + proporcion. */
export function stroke(seed: number, width = 60, height = 24): { dataUrl: string; ratio: number } {
  return { dataUrl: dataUrlFromPng(makeRealPng({ width, height, seed })), ratio: height / width };
}

export function slot(signerId: string, id: string, type: "signature" | "initials" = "signature"): SignatureField {
  return { id, signerId, pageIndex: 0, type, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } };
}

export async function clearAllLocalDrafts(): Promise<void> {
  await clearAllDrafts();
  await clearAllEditDrafts();
  await clearAllProDrafts();
}

export const sessionIdOf = (tag: string) => `s-mgl1${tag}-1k3v9x2a`;

/** Guarda un borrador de UN documento (con su huella real) y devuelve `{ id, bytes, fingerprint }`. */
export async function seedSignDocument(
  args: { label?: string; strokes?: boolean; keepSignatures?: boolean; signers?: Signer[]; textValues?: Record<string, string> } = {},
): Promise<{ id: string; bytes: Uint8Array; fingerprint: string }> {
  const label = args.label ?? "Poliza";
  const bytes = await realPdf(label);
  const fingerprint = await sha256Hex(bytes);
  const id = `${fingerprint.slice(0, 32)}${"ab".repeat(16)}`;
  const signers = args.signers ?? [ANA, LUIS];
  const fields = signers.map((signer) => slot(signer.id, `fld-${signer.id}`));
  const captures = args.strokes
    ? {
        [ANA.id]: {
          signature: stroke(11),
          initials: stroke(12, 24, 24),
          stamp: captureStamp(fingerprint, fields, ANA.id),
        },
      }
    : {};
  const result = await saveDraft({
    id,
    fingerprint,
    fileBytes: bytes,
    fileName: `${label}.pdf`,
    manifest: {
      mode: "multi",
      signers,
      fields,
      textFields: [],
      textValues: args.textValues ?? { nombre: "Ana Perez" },
    },
    step: "sign",
    captures,
    textFieldsDetectedFor: fingerprint,
    ...(args.keepSignatures !== undefined ? { keepSignatures: args.keepSignatures } : {}),
  });
  if (!result.ok) throw new Error("seedSignDocument: no se pudo guardar");
  return { id, bytes, fingerprint };
}

/** Guarda una sesion de dos documentos con trazos (si se pide) y devuelve su id y los PDF. */
export async function seedSignSession(
  args: { tag?: string; strokes?: boolean; keepSignatures?: boolean; names?: [string, string]; ceremony?: boolean } = {},
): Promise<{ id: string; pdfs: Uint8Array[]; keys: string[] }> {
  const tag = args.tag ?? "a";
  const names = args.names ?? ["Contrato A.pdf", "Anexo B.pdf"];
  const pdfs = [await realPdf(`${tag}-${names[0]}`), await realPdf(`${tag}-${names[1]}`, 2)];
  const keys = await Promise.all(pdfs.map((pdf) => sha256Hex(pdf)));
  const docIds = ["doc-1", "doc-2"];
  const signers = [ANA, LUIS];
  const fieldsOf = (index: number): SignatureField[] => signers.map((s) => slot(s.id, `fld-${s.id}-${index}`));
  const blocks: SignerBlock[] = signers.map((signer, position) => {
    const signed = args.strokes === true && signer.id === ANA.id;
    return {
      id: `bk-${position + 1}`,
      signerId: signer.id,
      appliesTo: docIds,
      signature: signed ? stroke(21 + position) : null,
      initials: signed ? stroke(31 + position, 24, 24) : null,
      stamps: signed ? Object.fromEntries(docIds.map((docId, index) => [docId, captureStamp(keys[index], fieldsOf(index), signer.id)])) : {},
      auto: true,
    };
  });
  const params: SaveSessionParams = {
    id: sessionIdOf(tag),
    mode: "multi",
    signMode: "same",
    signers,
    blocks,
    documents: docIds.map((docId, index) => ({
      id: docId,
      fileName: names[index],
      size: pdfs[index].byteLength,
      state: { ...EMPTY_DOC_STATE, sealedKey: keys[index], fields: fieldsOf(index), textValues: { campo: `valor ${index}` } },
      getBytes: async () => pdfs[index],
    })),
    activeDocId: "doc-1",
    step: "sign",
    ...(args.ceremony ? { ceremony: { signerId: LUIS.id, stage: "capture" as const } } : {}),
    ...(args.keepSignatures !== undefined ? { keepSignatures: args.keepSignatures } : {}),
  };
  const result = await saveSessionDraft(params);
  if (!result.ok) throw new Error(`seedSignSession: ${result.reason}`);
  return { id: params.id, pdfs, keys };
}

/** Imagen anadida en un borrador de Editar: un PNG REAL (la importacion decodifica de verdad en el navegador). */
const EDIT_IMAGE = makeRealPng({ width: 16, height: 16, seed: 5 });

export function editSessionWith(text = "Hola", withImage = false): EditSession {
  let session = applyOp(
    createEditSession(),
    {
      type: "add",
      item: textItem(
        newTextEdit({
          id: "t1",
          pageIndex: 0,
          box: { x: 10, y: 10, width: 100, height: 20 },
          fontKey: "helvetica",
          text,
        }),
      ),
    },
    0,
  );
  if (withImage) {
    const image: ImageElement = {
      type: "image",
      id: "im1",
      pageIndex: 0,
      x: 0.2,
      y: 0.2,
      width: 0.3,
      height: 0.3,
      bytes: EDIT_IMAGE,
      previewUrl: dataUrlFromPng(EDIT_IMAGE),
      ratio: 1,
    };
    session = applyOp(session, imageAddOp(image), 10_000);
  }
  return session;
}

/** Guarda un borrador de Editar (id = huella real del PDF) y devuelve `{ id, bytes }`. */
export async function seedEditDraft(
  args: { label?: string; text?: string; withImage?: boolean } = {},
): Promise<{ id: string; bytes: Uint8Array }> {
  const bytes = await realPdf(args.label ?? "Informe", 2);
  const id = (await fingerprintPdfBytes(bytes)) as string;
  const result = await saveEditDraft({
    id,
    fileName: `${args.label ?? "Informe"}.pdf`,
    fileBytes: bytes,
    session: editSessionWith(args.text ?? "Hola", args.withImage ?? false),
    pageCount: 2,
    currentPage: 1,
  });
  if (!result.ok) throw new Error(`seedEditDraft: ${result.reason}`);
  return { id, bytes };
}

/** Guarda un borrador de PDF Pro y devuelve `{ id, bytes }` (el id es la huella del ORIGINAL, que aqui es otro texto). */
export async function seedProDraft(
  args: { label?: string; tag?: string } = {},
): Promise<{ id: string; bytes: Uint8Array }> {
  const bytes = await realPdf(args.label ?? "Pro", 3);
  const id = await sha256Hex(new TextEncoder().encode(`original-${args.tag ?? "a"}`));
  const result = await saveProDraft({
    id,
    fileName: `${args.label ?? "Pro"}.pdf`,
    bytes,
    snapshotId: `snap-${args.tag ?? "a"}`,
    history: [
      { label: "Original", createdAt: 1, source: "open" },
      { label: "Rotar todas las páginas 90°", createdAt: 2, source: "operation", opId: "rotate-all" },
    ],
    pageCount: 3,
    currentPage: 2,
  });
  if (!result.ok) throw new Error(`seedProDraft: ${result.reason}`);
  return { id, bytes };
}
