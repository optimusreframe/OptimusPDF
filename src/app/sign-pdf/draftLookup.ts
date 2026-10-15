import { isSignerComplete, signingQueue } from "@/app/sign-pdf/captures";
import { ceremonyQueue, isSignerDone, type BlockContext } from "@/app/sign-pdf/blockModel";
import { draftFingerprint, type DraftEntry } from "@/app/sign-pdf/signDrafts";
import { stampKeyOf } from "@/app/sign-pdf/textEdits";
import { isValidResumeId } from "@/lib/resumeLinks";

/*
 * Busqueda y resumen de borradores de Firmar (Fase 0 «Firma agil», U0.3), sin React ni IndexedDB: la lectura real vive en
 * `useRecoverableDrafts` / `useUploadOffer`. Sirve a dos preguntas distintas:
 *
 *  - «¿que tengo sin terminar?» (`recoverableDrafts` + `summarizeDraft`): la tarjeta «Tienes una firma sin terminar»;
 *  - «¿estos PDF que acabo de subir ya tienen un borrador?» (`findDraftForUpload`): la oferta «Retomar lo que tenias»,
 *    por la HUELLA de contenido de cada PDF (la misma que el resto de la herramienta), no por el nombre ni el tamano.
 */

/**
 * Borradores que la herramienta sabria retomar: los que pasaron por `isValidResumeId` (el mismo filtro que `?resume=` y
 * `?s=`) y, en una sesion, los que conservan al menos un documento. Mismo orden que `listAllDrafts` (el mas reciente primero).
 */
export function recoverableDrafts(entries: readonly DraftEntry[]): DraftEntry[] {
  return entries.filter((entry) =>
    entry.kind === "session"
      ? isValidResumeId("session", entry.meta.id) && entry.meta.documents.length > 0
      : isValidResumeId("sign", entry.meta.id),
  );
}

/** Un firmante de la ronda y si ya dejo sus trazos (`index`: su posicion, para el nombre por defecto si no tiene). */
export type DraftSigner = { index: number; name: string; collected: boolean };

export type DraftSummary = {
  /** `<tipo>:<id>`: clave estable. */
  key: string;
  entry: DraftEntry;
  /** Nombres de los documentos, en el orden de la cola. */
  documents: string[];
  /** Todos los firmantes dados de alta. */
  signers: DraftSigner[];
  /** Los que tienen huecos (los que de verdad firman), con su estado; vacio si aun no hay huecos. */
  collection: DraftSigner[];
  savedAt: string;
  /**
   * El borrador se guardo SIN las firmas (el ajuste «guardar las firmas» estaba apagado y habia trazos que dejar fuera,
   * U0.4): al retomarlo se piden de nuevo, y la tarjeta lo dice en lugar de afirmar que «nadie ha firmado».
   */
  signaturesAsked: boolean;
};

function trimmedName(name: unknown): string {
  return typeof name === "string" ? name.trim() : "";
}

/**
 * Lo que la tarjeta cuenta de un borrador: documentos, firmantes y quien ya firmo («Ana ✓, Luis pendiente»). Una sesion lo
 * calcula con el mismo modelo de bloques que la ceremonia (`isSignerDone`), con las huellas y sellos guardados; un
 * documento suelto, con sus capturas. Un borrador roto no lanza: sus firmantes cuentan como pendientes.
 */
export function summarizeDraft(entry: DraftEntry): DraftSummary {
  if (entry.kind === "document") {
    const meta = entry.meta;
    const signers = Array.isArray(meta.signers) ? meta.signers : [];
    const fields = Array.isArray(meta.fields) ? meta.fields : [];
    // La huella del PDF (desde F0-fix el `id` ya no lo es; un borrador anterior si): es lo que sello las firmas.
    const stamp = stampKeyOf(draftFingerprint(meta), meta.textEdits);
    const collected = (signerId: string): boolean => {
      try {
        return isSignerComplete(fields, meta.captures ?? {}, signerId, stamp);
      } catch {
        return false;
      }
    };
    const all: DraftSigner[] = signers.map((signer, index) => ({
      index,
      name: trimmedName(signer.name),
      collected: collected(signer.id),
    }));
    const withSlots = new Set(signingQueue(signers, fields).map((signer) => signer.id));
    return {
      key: `sign:${meta.id}`,
      entry,
      documents: [meta.fileName],
      signers: all,
      collection: all.filter((_, index) => withSlots.has(signers[index].id)),
      savedAt: meta.savedAt,
      signaturesAsked: meta.signaturesOmitted === true,
    };
  }

  const meta = entry.meta;
  const signers = Array.isArray(meta.signers) ? meta.signers : [];
  const docIds = meta.documents.map((doc) => doc.id);
  const docStates = meta.docStates ?? {};
  const context: BlockContext = {
    signers,
    docs: docStates,
    keys: Object.fromEntries(
      docIds.map((id) => {
        const state = docStates[id];
        const sealed = state && typeof state.sealedKey === "string" && state.sealedKey !== "" ? state.sealedKey : null;
        // La ceremonia sella los trazos con la huella MAS las ediciones de texto: el resumen usa la misma clave.
        return [id, sealed === null ? null : stampKeyOf(sealed, state?.textEdits)];
      }),
    ),
  };
  const blocks = Array.isArray(meta.blocks) ? meta.blocks : [];
  const withSlots = new Set(ceremonyQueue(context, docIds).map((signer) => signer.id));
  const collected = (signerId: string): boolean => {
    try {
      return isSignerDone(blocks, signerId, context);
    } catch {
      return false;
    }
  };
  const all: DraftSigner[] = signers.map((signer, index) => ({
    index,
    name: trimmedName(signer.name),
    collected: collected(signer.id),
  }));
  return {
    key: `session:${meta.id}`,
    entry,
    documents: meta.documents.map((doc) => doc.fileName),
    signers: all,
    collection: all.filter((_, index) => withSlots.has(signers[index].id)),
    savedAt: meta.savedAt,
    signaturesAsked: meta.signaturesOmitted === true,
  };
}

/**
 * Huellas de contenido de los documentos de un borrador, en el orden de la cola; `null` si alguna no esta disponible
 * (un documento cuya huella aun no habia llegado al guardar): sin huella no se puede afirmar que sea el mismo PDF.
 */
export function draftDocumentKeys(entry: DraftEntry): string[] | null {
  if (entry.kind === "document") return [draftFingerprint(entry.meta)];
  const keys: string[] = [];
  for (const doc of entry.meta.documents) {
    const sealed = entry.meta.docStates?.[doc.id]?.sealedKey;
    if (typeof sealed !== "string" || sealed === "") return null;
    keys.push(sealed);
  }
  return keys;
}

/** Mismas huellas, sin importar el orden (se cuentan, no se comparan por posicion: dos copias identicas son dos). */
function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((key, index) => key === right[index]);
}

/**
 * TODOS los borradores de ESTOS documentos, del mas reciente al mas antiguo: los que tienen un conjunto de huellas que
 * coincide EXACTAMENTE con el de los archivos subidos. Puede haber varios (la misma plantilla para clientes distintos, cada
 * uno con su borrador, F0-fix D3). Con una huella pendiente (`null`) o ningun archivo no hay ninguno. Ni un subconjunto ni
 * un superconjunto sirven: ofrecer el borrador de otra ronda en lugar de la de ahora seria mezclar trabajos. `entries` va
 * del mas reciente al mas antiguo (como `listAllDrafts`).
 */
export function findDraftsForUpload(
  entries: readonly DraftEntry[],
  uploadKeys: readonly (string | null)[],
): DraftEntry[] {
  if (uploadKeys.length === 0) return [];
  const keys: string[] = [];
  for (const key of uploadKeys) {
    if (!key) return [];
    keys.push(key);
  }
  return entries.filter((entry) => {
    const stored = draftDocumentKeys(entry);
    return stored !== null && sameKeys(stored, keys);
  });
}

/** El borrador de ESTOS documentos que se ofrece: el mas reciente de `findDraftsForUpload`. */
export function findDraftForUpload(
  entries: readonly DraftEntry[],
  uploadKeys: readonly (string | null)[],
): DraftEntry | null {
  return findDraftsForUpload(entries, uploadKeys)[0] ?? null;
}

/** Clave de un conjunto de huellas, para recordar que la persona ya rechazo la oferta de estos archivos. */
export function uploadSetKey(uploadKeys: readonly (string | null)[]): string {
  return uploadKeys.map((key) => key ?? "?").sort().join("|");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * «hace 5 minutos» / «5 minutes ago»: cuando se guardo el borrador, en lenguaje llano. Menos de un minuto = «ahora mismo» /
 * «just now» (`justNow`, que pone quien llama en su idioma). Una fecha ilegible da `""`.
 */
export function formatSavedAgo(iso: string, locale: string, justNow: string, now: number = Date.now()): string {
  const saved = new Date(iso).getTime();
  if (Number.isNaN(saved)) return "";
  const elapsed = Math.max(0, now - saved);
  if (elapsed < MINUTE) return justNow;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
    if (elapsed < HOUR) return rtf.format(-Math.floor(elapsed / MINUTE), "minute");
    if (elapsed < DAY) return rtf.format(-Math.floor(elapsed / HOUR), "hour");
    return rtf.format(-Math.floor(elapsed / DAY), "day");
  } catch {
    return "";
  }
}
