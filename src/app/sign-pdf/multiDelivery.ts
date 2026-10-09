import { isSignerComplete } from "@/app/sign-pdf/captures";
import { docLabel, signerLabel } from "@/app/sign-pdf/blockModel";
import {
  coverageIssues,
  docStateOf,
  liveFields,
  projectCaptures,
  resolveBlock,
  type DocId,
} from "@/app/sign-pdf/docSet";
import type { SignSession } from "@/app/sign-pdf/signSession";
import { hasFilledField, hasPlacedSignature } from "@/app/sign-pdf/soloSignature";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { Signer } from "@/lib/pdf/sign";

/*
 * Que firma cada documento y que impide descargar, con VARIOS documentos
 * (Wave 4 · U3). Puro: lo usan `process()`, `canRun`, el panel de opciones y
 * los tests.
 */

/**
 * Firmantes que firman ESTE documento, en el orden de la lista: los que
 * tienen un bloque que lo cubre Y huecos de firma en el. Es la lista que
 * alimenta a la vez `certificate.signerNames` y el prefijo del nombre del
 * archivo: un firmante que solo aplica a otro documento no aparece en este.
 */
export function signersForDoc(
  session: Pick<SignSession, "signers" | "blocks" | "docs">,
  docId: DocId,
): Signer[] {
  const fields = liveFields(docStateOf(session.docs, docId), session.signers);
  return session.signers.filter(
    (signer) =>
      resolveBlock(session.blocks, signer.id, docId).block !== null &&
      fields.some((field) => field.signerId === signer.id),
  );
}

/** Lo que impide descargar la ronda. Todos son bloqueantes. */
export type DeliveryBlocker =
  /** «Solo yo»: aun no hay firma creada. */
  | { kind: "noSignature" }
  /** «Solo yo»: este documento no tiene la firma colocada. */
  | { kind: "soloUnplaced"; docId: DocId }
  /** «Varios»: el firmante tiene huecos en este documento y ningun bloque lo cubre. */
  | { kind: "coverage"; signerId: string; docId: DocId }
  /** «Varios»: al firmante le quedan bloques por firmar. */
  | { kind: "pending"; signerId: string; count: number }
  /** «Varios»: no hay nada que aplicar en este documento (ni huecos ni campos rellenos). */
  | { kind: "empty"; docId: DocId }
  /** La huella de algun documento aun no ha llegado (o no se puede calcular). */
  | { kind: "keys" };

/**
 * Bloqueos de la entrega conjunta, en el orden en que conviene resolverlos.
 * Vacio = se puede descargar. Las huellas salen de `docs[].sealedKey` (el
 * anfitrion sella la de cada documento al llegar), para que reaccione solo a
 * la sesion.
 */
export function deliveryBlockers(
  session: SignSession,
  docOrder: readonly DocId[],
): DeliveryBlocker[] {
  const out: DeliveryBlocker[] = [];

  if (session.mode === "single") {
    if (session.signaturePng === "") out.push({ kind: "noSignature" });
    else {
      for (const docId of docOrder) {
        const doc = docStateOf(session.docs, docId);
        if (!hasPlacedSignature({ signaturePng: session.signaturePng, rect: doc.rect })) {
          out.push({ kind: "soloUnplaced", docId });
        }
      }
    }
    return out;
  }

  for (const issue of coverageIssues(
    session.signers,
    docOrder,
    // `coverageIssues` mira los huecos de cada documento: solo los vivos.
    Object.fromEntries(
      docOrder.map((docId) => [
        docId,
        { fields: liveFields(docStateOf(session.docs, docId), session.signers) },
      ]),
    ),
    session.blocks,
  )) {
    out.push({ kind: "coverage", signerId: issue.signerId, docId: issue.docId });
  }

  const missingKey = docOrder.some((docId) => !docStateOf(session.docs, docId).sealedKey);
  const hasAnySlot = docOrder.some(
    (docId) => liveFields(docStateOf(session.docs, docId), session.signers).length > 0,
  );
  const waitingForKeys = hasAnySlot && missingKey;
  if (waitingForKeys) out.push({ kind: "keys" });

  // Sin huellas todo estaria «pendiente» por una razon que no es de la persona.
  for (const signer of waitingForKeys ? [] : session.signers) {
    // Se cuentan BLOQUES por firmar (no documentos): un bloque que cubre
    // tres documentos y esta sin firmar es uno solo.
    const pendingBlocks = new Set<string>();
    for (const docId of docOrder) {
      const doc = docStateOf(session.docs, docId);
      const fields = liveFields(doc, session.signers);
      if (!fields.some((field) => field.signerId === signer.id)) continue;
      // Bloque sin cubrir: ya consta como cobertura, no como pendiente.
      const { block } = resolveBlock(session.blocks, signer.id, docId);
      if (!block) continue;
      const complete = isSignerComplete(
        fields,
        projectCaptures(session.blocks, docId),
        signer.id,
        doc.sealedKey || null,
      );
      if (!complete) pendingBlocks.add(block.id);
    }
    const count = pendingBlocks.size;
    if (count > 0) out.push({ kind: "pending", signerId: signer.id, count });
  }

  for (const docId of docOrder) {
    const doc = docStateOf(session.docs, docId);
    const fields = liveFields(doc, session.signers);
    if (fields.length === 0 && !hasFilledField(doc.textFields, doc.textValues)) {
      out.push({ kind: "empty", docId });
    }
  }
  return out;
}

/** Frases para el panel y el aviso de la ceremonia, ya traducidas. */
export function blockerMessages(
  blockers: readonly DeliveryBlocker[],
  context: {
    signers: readonly Signer[];
    docs: readonly { id: DocId; name: string }[];
  },
  strings: SignStrings,
): string[] {
  const docName = (docId: DocId) =>
    docLabel(context.docs.find((doc) => doc.id === docId)?.name ?? docId);
  return blockers.map((blocker) => {
    switch (blocker.kind) {
      case "noSignature":
        return strings.noSignature;
      case "soloUnplaced":
        return strings.batchSoloUnplaced(docName(blocker.docId));
      case "coverage":
        return strings.coverageMissing(
          signerLabel(context.signers, blocker.signerId, strings),
          docName(blocker.docId),
        );
      case "pending":
        return strings.batchPendingBlocks(
          signerLabel(context.signers, blocker.signerId, strings),
          blocker.count,
        );
      case "empty":
        return strings.batchDocEmpty(docName(blocker.docId));
      case "keys":
        return strings.checkingDocument;
    }
  });
}
