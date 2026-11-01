import { clearAllDrafts } from "@/app/sign-pdf/signDrafts";
import { clearVault, vaultSupported } from "@/app/sign-pdf/signVault";
import { clearClientProfiles } from "@/lib/clientProfile/store";

/** Que almacen NO se pudo vaciar (los dos primeros son de IndexedDB; los perfiles de cliente, de `localStorage`). */
export type ClearFailure = "vault" | "drafts" | "clientProfiles";

/**
 * Vacia los almacenes de Sign PDF (borradores y baul de firmas en IndexedDB; el
 * baul se borra SIEMPRE, este o no activo su flag; y los perfiles de cliente del
 * autorrelleno, en `localStorage`) y devuelve cuales fallaron. Lista vacia = todo borrado. Sin IndexedDB en el navegador no hay
 * nada guardado, asi que tampoco cuenta como fallo.
 *
 * Quien llama solo puede decir «Datos borrados» con la lista vacia: afirmarlo
 * con un baul bloqueado por otra pestaña mentiria (las firmas seguirian ahi).
 */
export async function clearLocalSignData(): Promise<ClearFailure[]> {
  const profilesCleared = clearClientProfiles();
  const [drafts, vault] = await Promise.all([clearAllDrafts(), clearVault()]);
  const failed: ClearFailure[] = [];
  if (!profilesCleared) failed.push("clientProfiles");
  if (!drafts.ok) failed.push("drafts");
  if (!vault.ok && vaultSupported()) failed.push("vault");
  return failed;
}
