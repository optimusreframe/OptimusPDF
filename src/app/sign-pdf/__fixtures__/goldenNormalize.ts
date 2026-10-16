import type { SignSession } from "@/app/sign-pdf/signSession";

/*
 * Normalizacion para comparar lo que `restoreSession` devuelve con un archivo «dorado»: los `DocId` vivos (`doc-N`)
 * dependen de un contador de modulo, asi que se sustituyen por su POSICION en la cola (`doc[0]`, `doc[1]`...).
 * Los `bk-N` de los bloques restaurados vienen del borrador y son estables.
 */
export function normalizeRestoredPatch(
  patch: Partial<SignSession>,
  liveIds: readonly string[],
): unknown {
  const name = (id: string) => {
    const index = liveIds.indexOf(id);
    return index === -1 ? id : `doc[${index}]`;
  };
  const rename = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rename);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [name(key), rename(inner)]),
      );
    }
    return typeof value === "string" ? name(value) : value;
  };
  return rename(JSON.parse(JSON.stringify(patch)));
}
