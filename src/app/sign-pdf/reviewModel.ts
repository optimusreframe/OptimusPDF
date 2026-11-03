import { resolveBlock, docStateOf, liveFields, type DocId, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { visibleDraft, type BlockContext } from "@/app/sign-pdf/blockModel";
import { isFieldFilled, isSuggestionOnly } from "@/lib/pdf/detectFields";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import type { SignatureFieldType, Signer } from "@/lib/pdf/sign";

/*
 * Datos de «Revisar antes de descargar» (Firma agil · Fase 1 · U1.3). Puro: de la sesion saca, por documento, las
 * paginas que llevan firma, iniciales o texto (con cada marca y si ya esta hecha) y los contadores («Iniciales: 8 de 8 ·
 * Firmas: 2 de 2»). Sin React ni textos.
 *
 * Iniciales esperadas: un firmante que pone iniciales en MAS de una pagina las esta repitiendo por el cuerpo del
 * documento, y se espera que esten en todas las paginas del cuerpo (las del documento menos las que solo llevan su
 * firma). Si faltan en alguna, el contador sale partido («7 de 8») y se avisa de que paginas. Sin el numero de paginas
 * (aun no contado) se espera exactamente lo colocado.
 */

export type MarkKind = "signature" | "initials" | "text";

export type ReviewMark = {
  id: string;
  kind: MarkKind;
  signerId: string | null;
  /** La marca ya esta hecha: trazo vigente (firma, iniciales) o texto escrito. */
  done: boolean;
  rect: NormalizedRect;
};

export type ReviewPageMarks = { pageIndex: number; marks: ReviewMark[] };

export type InitialsGap = { signerId: string; pages: number[] };

export type ReviewDoc = {
  docId: DocId;
  /** Paginas con alguna marca, por orden. */
  pages: ReviewPageMarks[];
  initials: { done: number; expected: number };
  signatures: { done: number; total: number };
  text: { done: number; total: number };
  /** Paginas del cuerpo donde a un firmante que repite iniciales le faltan (nunca se avisa sin saber las paginas). */
  initialsGaps: InitialsGap[];
};

export type ReviewInput = {
  docId: DocId;
  state: DocState;
  signers: readonly Signer[];
  blocks: readonly SignerBlock[];
  ctx: BlockContext;
  /** Paginas del documento; `undefined` = aun no se sabe. */
  pageCount?: number;
};

function strokeDone(
  blocks: readonly SignerBlock[],
  ctx: BlockContext,
  signerId: string,
  docId: DocId,
  type: SignatureFieldType,
): boolean {
  const block = resolveBlock(blocks, signerId, docId).block;
  return block !== null && visibleDraft(block, type, ctx) !== null;
}

export function reviewDocument(input: ReviewInput): ReviewDoc {
  const { docId, state, signers, blocks, ctx, pageCount } = input;
  const byPage = new Map<number, ReviewMark[]>();
  const push = (pageIndex: number, mark: ReviewMark) => {
    const list = byPage.get(pageIndex);
    if (list) list.push(mark);
    else byPage.set(pageIndex, [mark]);
  };

  const slots = liveFields(state, signers);
  let signaturesDone = 0;
  let signaturesTotal = 0;
  for (const field of slots) {
    const done = strokeDone(blocks, ctx, field.signerId, docId, field.type);
    push(field.pageIndex, { id: field.id, kind: field.type, signerId: field.signerId, done, rect: field.rect });
    if (field.type === "signature") {
      signaturesTotal += 1;
      if (done) signaturesDone += 1;
    }
  }

  let textDone = 0;
  let textTotal = 0;
  for (const field of state.textFields) {
    const value = state.textValues[field.id];
    if (isSuggestionOnly(field, value)) continue;
    // Un campo opcional (modo «Editar campos») puede quedar vacio: cuenta como hecho.
    const done = isFieldFilled(field, value) || field.optional === true;
    // Una casilla sin marcar es una respuesta valida: cuenta como hecha (`isFieldFilled`).
    push(field.pageIndex, { id: field.id, kind: "text", signerId: null, done, rect: field.rect });
    textTotal += 1;
    if (done) textDone += 1;
  }

  // Iniciales por firmante: colocadas, hechas y cuantas se esperan.
  let initialsDone = 0;
  let initialsExpected = 0;
  const initialsGaps: InitialsGap[] = [];
  for (const signer of signers) {
    const own = slots.filter((field) => field.signerId === signer.id && field.type === "initials");
    if (own.length === 0) continue;
    // El trazo de iniciales es uno por grupo: vale para todas las paginas donde el firmante las pone.
    if (strokeDone(blocks, ctx, signer.id, docId, "initials")) initialsDone += own.length;
    let expected = own.length;
    if (own.length >= 2 && pageCount !== undefined && pageCount > 0) {
      const withInitials = new Set(own.map((field) => field.pageIndex));
      const signatureOnly = new Set(
        slots
          .filter((field) => field.signerId === signer.id && field.type === "signature")
          .map((field) => field.pageIndex)
          .filter((page) => !withInitials.has(page)),
      );
      const body: number[] = [];
      for (let page = 0; page < pageCount; page += 1) if (!signatureOnly.has(page)) body.push(page);
      const missing = body.filter((page) => !withInitials.has(page));
      expected = Math.max(own.length, body.length);
      if (missing.length > 0) initialsGaps.push({ signerId: signer.id, pages: missing });
    }
    initialsExpected += expected;
  }

  const pages = [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([pageIndex, marks]) => ({ pageIndex, marks }));
  return {
    docId,
    pages,
    initials: { done: initialsDone, expected: initialsExpected },
    signatures: { done: signaturesDone, total: signaturesTotal },
    text: { done: textDone, total: textTotal },
    initialsGaps,
  };
}

/** Todos los documentos de la cola. */
export function reviewSession(args: {
  docIds: readonly DocId[];
  docs: Readonly<Record<DocId, DocState>>;
  signers: readonly Signer[];
  blocks: readonly SignerBlock[];
  ctx: BlockContext;
  pageCounts: Readonly<Record<DocId, number | undefined>>;
}): ReviewDoc[] {
  return args.docIds.map((docId) =>
    reviewDocument({
      docId,
      state: docStateOf(args.docs, docId),
      signers: args.signers,
      blocks: args.blocks,
      ctx: args.ctx,
      pageCount: args.pageCounts[docId],
    }),
  );
}
