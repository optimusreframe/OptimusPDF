import type { MatchLevel, MatchResult } from "@/lib/docLibrary/types";

/*
 * Aplicar A MANO una plantilla de «Mis documentos» (W3-A2). Todo PURO.
 *
 * Al cargar un PDF, la aplicacion automatica solo actua con «Coincide» (y pregunta con «Parece»). Aqui la persona ELIGE la
 * plantilla, sea cual sea su parecido, y decide como se colocan los campos cuando el PDF no es identico:
 *   - `matching`: solo las paginas que coinciden (lo mismo que haria «Parece»: el resto queda en «Revisar», sin colocar);
 *   - `all`: TODAS por posicion. Las paginas que la comparacion ya emparejo (aunque con dudas) siguen su emparejamiento;
 *     las demas se colocan en la pagina con el mismo numero, si existe y esta libre. Todo lo colocado en una pagina que no
 *     coincide del todo queda MARCADO para revisar (`flaggedPages`), nunca aplicado en silencio.
 */

export type PageScope = "matching" | "all";

/** Lo que `planTemplateApplication` necesita de una comparacion. */
export type ManualMatch = Pick<MatchResult, "mappedPages" | "reviewPages" | "level" | "percent">;

export type ManualPlan = {
  /** `null` = sin comparacion (la plantilla no tiene documento de origen o el PDF no se pudo huellar): identidad por nº de pagina. */
  match: ManualMatch | null;
  /** Paginas del DOCUMENTO (0-based) con campos colocados que la comparacion no avala: se avisan para revisarlas. */
  flaggedPages: number[];
};

/** «Coincide» o idéntico: se aplica sin preguntas ni páginas marcadas. */
export function isSafeLevel(level: MatchLevel): boolean {
  return level === "exact" || level === "match";
}

/** Páginas de la plantilla que se aplicarían solas (emparejadas y sin dudas). */
export function matchingPageCount(match: Pick<MatchResult, "pageMatches"> | null): number {
  return match ? match.pageMatches.filter((page) => page.documentPage !== null && !page.review).length : 0;
}

export function planManualMatch(args: { match: MatchResult | null; scope: PageScope; docPageCount: number }): ManualPlan {
  const { match, scope, docPageCount } = args;
  if (!match) return { match: null, flaggedPages: [] };
  // Sin dudas: tal cual lo diria la comparacion.
  if (isSafeLevel(match.level) || scope === "matching") {
    return { match: { mappedPages: match.mappedPages, reviewPages: match.reviewPages, level: match.level, percent: match.percent }, flaggedPages: [] };
  }
  const review = new Set(match.reviewPages);
  const used = new Set<number>();
  for (const target of match.mappedPages) if (typeof target === "number") used.add(target);
  const flagged = new Set<number>();
  const mapped = match.mappedPages.map((target, templatePage): number | null => {
    if (typeof target === "number") {
      if (review.has(templatePage)) flagged.add(target);
      return target;
    }
    // Sin pagina parecida: por posicion, si el documento tiene esa pagina y nadie mas la usa.
    if (templatePage < docPageCount && !used.has(templatePage)) {
      used.add(templatePage);
      flagged.add(templatePage);
      return templatePage;
    }
    return null;
  });
  return {
    // `reviewPages` vacio: lo emparejado a la fuerza SI se coloca (es lo que la persona pidio) y se avisa aparte.
    match: { mappedPages: mapped, reviewPages: [], level: match.level, percent: match.percent },
    flaggedPages: [...flagged].sort((a, b) => a - b),
  };
}
