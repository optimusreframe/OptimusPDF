import { compareFingerprints } from "./match";
import type { Fingerprint, MatchLevel } from "./types";

/**
 * ¿Sigue valiendo la plantilla de un documento después de reemplazar su PDF? (F2-fix · MAYOR 3)
 *
 * Se compara el PDF NUEVO con la huella del PDF sobre el que se configuró la plantilla (`base`). Vale solo si es el mismo
 * contenido (`exact`) o `match` SIN páginas por revisar. Cualquier otra cosa (páginas distintas, «Parece», otro contrato)
 * la deja «desactualizada»: la plantilla se conserva (es trabajo de la persona) pero ya no se aplica a ciegas.
 */
export type StaleVerdict = { stale: false } | { stale: true; level: MatchLevel; percent: number };

export function staleVerdict(base: Fingerprint, next: Fingerprint): StaleVerdict {
  const result = compareFingerprints(next, base);
  if (result.level === "exact") return { stale: false };
  if (result.level === "match" && result.reviewPages.length === 0) return { stale: false };
  return { stale: true, level: result.level, percent: result.percent };
}
