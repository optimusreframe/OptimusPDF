import type { MutableRefObject } from "react";
import type { DocId } from "@/app/sign-pdf/docSet";
import { newDocumentDraftId } from "@/app/sign-pdf/draftIds";

/*
 * El borrador de UN documento suelto es UNO POR SESION DE TRABAJO (F0-fix, D3), no uno por PDF.
 *
 * Antes su id era la huella del PDF: dos clientes con la MISMA plantilla compartian id y el autoguardado del segundo pisaba
 * el borrador del primero, firmas incluidas. Ahora cada sesion de trabajo estrena un id (`huella + nonce`) la primera vez
 * que hay algo que guardar, y lo conserva mientras siga siendo ese documento. Lo guarda quien monta la herramienta (no el
 * componente del flujo): sobrevive a que `ToolShell` desmonte el espacio de trabajo mientras procesa. Retomar un borrador lo
 * fija a su id (un borrador anterior, con el id = la huella, sigue siendo el mismo borrador).
 */
export type SingleDraftIdentity = {
  /** El documento vivo (`docIdOf(file)`): otro archivo, aunque sea el mismo PDF, es otra sesion de trabajo. */
  docId: DocId;
  /** Huella SHA-256 del PDF. */
  fingerprint: string;
  /** Id del borrador guardado. */
  id: string;
};

export type SingleDraftRef = MutableRefObject<SingleDraftIdentity | null>;

/** La identidad vigente de ESTE documento (`null` si aun no tiene: no hay nada guardado ni por guardar). */
export function currentSingleDraft(ref: SingleDraftRef, docId: DocId, fingerprint: string): SingleDraftIdentity | null {
  const current = ref.current;
  return current && current.docId === docId && current.fingerprint === fingerprint ? current : null;
}

/** La identidad de este documento; si es otro (o ninguno) se estrena una con id nuevo. Idempotente. */
export function ensureSingleDraft(
  ref: SingleDraftRef,
  docId: DocId,
  fingerprint: string,
  mint: (fingerprint: string) => string = newDocumentDraftId,
): SingleDraftIdentity {
  const known = currentSingleDraft(ref, docId, fingerprint);
  if (known) return known;
  const next: SingleDraftIdentity = { docId, fingerprint, id: mint(fingerprint) };
  ref.current = next;
  return next;
}
