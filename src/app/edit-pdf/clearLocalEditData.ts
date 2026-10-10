import { clearAllEditDrafts } from "@/app/edit-pdf/editDrafts";

/** Que almacen asincrono (IndexedDB) del editor NO se pudo vaciar. */
export type EditClearFailure = "drafts";

/**
 * Vacia los borradores del editor (`optimuspdf-edit-drafts`) y devuelve cuales
 * fallaron; lista vacia = todo borrado. Sin IndexedDB no hay nada guardado, asi
 * que tampoco cuenta como fallo. Quien llama solo puede decir «Datos borrados»
 * con la lista vacia: afirmarlo con la base bloqueada por otra pestana
 * mentiria (el borrador seguiria ahi). Mismo contrato que `clearLocalSignData`.
 */
export async function clearLocalEditData(): Promise<EditClearFailure[]> {
  const drafts = await clearAllEditDrafts();
  return drafts.ok ? [] : ["drafts"];
}
