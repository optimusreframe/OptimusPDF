import { pendingSigners } from "@/app/sign-pdf/captures";
import { docIdsOf, docStateOf, type DocId } from "@/app/sign-pdf/docSet";
import { pendingBlockSigners } from "@/app/sign-pdf/blockModel";
import { hasSessionProgress } from "@/app/sign-pdf/sessionDraft";
import { activeDocOf, viewOf, type SignSession } from "@/app/sign-pdf/signSession";
import type { SignToolOptions } from "@/app/sign-pdf/SignToolClient";
import { hasTextEdits, stampKeyOf } from "@/app/sign-pdf/textEdits";
import { isDecryptedCopy } from "@/lib/pdf/inputGuard";

/*
 * Lo que la guarda de salida (`useLeaveGuard`) necesita saber del espacio de trabajo de Firmar (Fase 0 «Firma agil», U0.3):
 * si hay trabajo que proteger y si la ronda de firmas esta a medias. Funciones puras, sin React.
 */

/**
 * Hay progreso en UN documento: la misma regla que el autoguardado de un documento suelto (`MultiFlow`): algun firmante,
 * hueco, campo de texto, valor escrito o texto editado.
 */
export function singleDocProgress(
  options: Pick<SignToolOptions, "signers" | "fields" | "textFields" | "textValues" | "textEdits">,
): boolean {
  return (
    options.signers.length > 0 ||
    options.fields.length > 0 ||
    options.textFields.length > 0 ||
    Object.keys(options.textValues).length > 0 ||
    hasTextEdits(options.textEdits)
  );
}

/**
 * ¿Hay trabajo GUARDADO (o a punto de guardarse) que proteger? Solo «Varios firmantes» guarda borrador: «Solo yo» no lo
 * guarda por diseno (ver `SessionDraftAutosave`), asi que no cuenta como progreso aqui. Una copia abierta con contrasena
 * tampoco se guarda nunca. Con varios documentos manda la regla de la sesion; con uno, la del documento suelto.
 */
export function hasSavedProgress(
  files: readonly File[],
  session: Pick<SignSession, "mode" | "signers" | "docs">,
  options: Pick<SignToolOptions, "signers" | "fields" | "textFields" | "textValues" | "textEdits">,
): boolean {
  if (session.mode !== "multi") return false;
  if (files.some((file) => isDecryptedCopy(file))) return false;
  if (files.length >= 2) return hasSessionProgress(session, docIdsOf(files));
  return singleDocProgress(options);
}

/**
 * Valor que ocupa `?s=` en «Solo yo» (F0-fix, D2): ese modo NO guarda borrador y por eso no hay id que poner, pero la guarda
 * de salida necesita la entrada de historial para que el «Atras» del navegador no se lleve el trabajo de vista. No es un id
 * valido (`sessionTargetOf` lo rechaza): recargar con el no restaura nada y la direccion se limpia sola.
 */
export const SOLO_GUARD_ID = "solo";

/**
 * «Solo yo» no guarda borrador (ver `SessionDraftAutosave`), asi que lo que se hace ahi -- crear la firma, escribir en los
 * campos, editar texto -- no tiene red: salir lo pierde. ¿Hay algo hecho que perder? Subir el PDF sin tocar nada no cuenta.
 * Una copia abierta con contraseña tampoco se guarda nunca, pero su flujo ya avisa por su cuenta: aqui no se mira.
 */
export function hasSoloWork(
  files: readonly File[],
  session: Pick<SignSession, "mode" | "signaturePng" | "docs">,
): boolean {
  if (session.mode !== "single" || files.length === 0) return false;
  if (session.signaturePng !== "") return true;
  return docIdsOf(files).some((id) => {
    const doc = docStateOf(session.docs, id);
    return Object.keys(doc.textValues).length > 0 || hasTextEdits(doc.textEdits);
  });
}

/**
 * Ronda de firmas a medias: ya se recogio algun trazo y todavia falta algun firmante. Con varios documentos se mide con
 * los bloques (las huellas con las ediciones de texto, como la ceremonia); con uno, con sus capturas. Sin huella aun
 * (calculandose) se cuenta como pendiente: ante la duda, se avisa.
 */
export function isRoundOpen(args: {
  files: readonly File[];
  session: Pick<SignSession, "signers" | "docs" | "blocks">;
  options: Pick<SignToolOptions, "signers" | "fields" | "captures" | "signature" | "textEdits">;
  keys: Readonly<Record<DocId, string | null>>;
}): boolean {
  const { files, session, options, keys } = args;
  if (files.length >= 2) {
    const docIds = docIdsOf(files);
    const collected = session.blocks.some((block) => block.signature !== null || block.initials !== null);
    if (!collected) return false;
    const stampKeys: Record<DocId, string | null> = {};
    for (const id of docIds) {
      stampKeys[id] = stampKeyOf(keys[id] ?? null, docStateOf(session.docs, id).textEdits) ?? null;
    }
    return (
      pendingBlockSigners(
        session.blocks,
        { signers: session.signers, docs: session.docs, keys: stampKeys },
        docIds,
      ).length > 0
    );
  }
  const collected = Object.values(options.captures).some(
    (capture) => capture.signature !== null || capture.initials !== null,
  );
  if (!collected) return false;
  return (
    pendingSigners(
      options.signers,
      options.fields,
      options.captures,
      stampKeyOf(options.signature, options.textEdits) || null,
    ).length > 0
  );
}

/** Lo mismo que `hasSavedProgress`, a partir de la sesion canonica (la que guarda el puente): el documento activo sale de ella. */
export function sessionHasSavedProgress(files: readonly File[], session: SignSession): boolean {
  const order = docIdsOf(files);
  const active = activeDocOf(session, order) ?? order[0] ?? "";
  return hasSavedProgress(files, session, viewOf(session, active));
}
