import { isSuggestionOnly, fieldTypeOf, type DetectedField } from "@/lib/pdf/detectFields";
import type { SignatureField, SignatureFieldType } from "@/lib/pdf/sign";
import type { SavedDrafts } from "@/app/sign-pdf/blockModel";
import { normalizeSignerKey, vaultImageToDataUrl, type VaultEntry } from "@/app/sign-pdf/signVault";

/*
 * «Firmar todo con mi firma guardada» (W3-B2): lo que decide QUE firma guardada se propone a un firmante y cuantos huecos y
 * campos tiene delante. Funciones puras, sin React: la propuesta no escribe nada; solo la persona, con un toque, la aplica.
 */

export type QuickProposal = {
  entry: VaultEntry;
  /** El nombre de la entrada es el del firmante (sin acentos ni mayusculas). Si no, es la mas reciente que no usa otro firmante. */
  exact: boolean;
  /** Otras entradas del baul que tambien servirian (para ofrecer «Elegir otra»). */
  alternatives: number;
  /** Tipos que el firmante necesita y esta entrada NO trae (se piden aparte; solo eso). */
  missing: SignatureFieldType[];
};

/**
 * La firma guardada que se propone a `signerName`:
 *  1. solo entradas que traigan algo de lo que hace falta (`need`);
 *  2. primero la del mismo nombre; despues la que lo trae TODO; despues las que no usa ya otro firmante de la ronda (`excludeIds`);
 *     y, a igualdad, la usada hace menos.
 * Sin nada que necesitar o sin entradas utiles, `null` (no se ofrece el boton).
 */
export function pickVaultEntry(
  entries: readonly VaultEntry[],
  signerName: string,
  need: readonly SignatureFieldType[],
  excludeIds: ReadonlySet<string> = new Set(),
): QuickProposal | null {
  if (need.length === 0) return null;
  const key = normalizeSignerKey(signerName);
  const usable = entries.filter((entry) => need.some((type) => entry[type] !== null));
  if (usable.length === 0) return null;
  const exactOf = (entry: VaultEntry) => key !== "" && entry.signerKey === key;
  const coversAll = (entry: VaultEntry) => need.every((type) => entry[type] !== null);
  const free = (entry: VaultEntry) => exactOf(entry) || !excludeIds.has(entry.id);
  const ranked = [...usable].sort(
    (a, b) =>
      Number(exactOf(b)) - Number(exactOf(a)) ||
      Number(free(b)) - Number(free(a)) ||
      Number(coversAll(b)) - Number(coversAll(a)) ||
      b.lastUsedAt.localeCompare(a.lastUsedAt),
  );
  const entry = ranked[0];
  // Una entrada que ya usa otro firmante y no es la de este nombre no se propone: dos personas no comparten trazo por accidente.
  if (!free(entry)) return null;
  return {
    entry,
    exact: exactOf(entry),
    alternatives: ranked.filter((candidate) => candidate.id !== entry.id && free(candidate)).length,
    missing: need.filter((type) => entry[type] === null),
  };
}

/** La entrada como borradores listos para guardar en la sesion (las dos imagenes; lo que no trae queda `null`). */
export function savedDraftsOf(entry: VaultEntry): SavedDrafts {
  return {
    signature: entry.signature ? { dataUrl: vaultImageToDataUrl(entry.signature), ratio: entry.signature.ratio } : null,
    initials: entry.initials ? { dataUrl: vaultImageToDataUrl(entry.initials), ratio: entry.initials.ratio } : null,
  };
}

export type SlotCounts = { signatures: number; initials: number };

/** Cuantos huecos de firma y de iniciales tiene `signerId` en todos los documentos que se le dan. */
export function signerSlotCounts(fieldsPerDoc: readonly (readonly SignatureField[])[], signerId: string): SlotCounts {
  let signatures = 0;
  let initials = 0;
  for (const fields of fieldsPerDoc) {
    for (const field of fields) {
      if (field.signerId !== signerId) continue;
      if (field.type === "signature") signatures += 1;
      else initials += 1;
    }
  }
  return { signatures, initials };
}

/** Campos de texto con algo escrito (una casilla cuenta si esta marcada) en todos los documentos. La sugerencia sin tocar no cuenta. */
export function filledFieldCount(
  docs: readonly { textFields: readonly DetectedField[]; textValues: Readonly<Record<string, string>> }[],
): number {
  let count = 0;
  for (const doc of docs) {
    for (const field of doc.textFields) {
      const value = doc.textValues[field.id] ?? "";
      if (isSuggestionOnly(field, value)) continue;
      if (fieldTypeOf(field) === "checkbox" ? value !== "" : value.trim() !== "") count += 1;
    }
  }
  return count;
}
