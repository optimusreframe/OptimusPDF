import { loadPdf } from "@/lib/pdf/core";
import { computeFingerprint } from "@/lib/docLibrary/fingerprint";
import { compareFingerprints, sameSize } from "@/lib/docLibrary/match";
import { listDocuments } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import type { DocTemplate, Variant } from "@/lib/docLibrary/templateTypes";
import type { DocumentEntry, Fingerprint, MatchLevel, MatchResult } from "@/lib/docLibrary/types";
import type { TemplateUse } from "@/app/sign-pdf/templateUse";

/*
 * Que plantillas de «Mis documentos» ve la hoja «Plantillas» de Firmar y como se parecen al PDF cargado (W3-A2). Logica pura
 * (`buildRows`, `rankRows`, `explainMatch`, `summarizeTemplate`) mas dos lecturas asincronas de la biblioteca y la huella del
 * archivo con memoria (la misma que usa la aplicacion automatica al cargar, para no calcularla dos veces).
 */

/* ------------------------------------------------------------------ *
 * Huella del archivo cargado (con memoria)
 * ------------------------------------------------------------------ */

const fingerprints = new WeakMap<File, Fingerprint>();

/**
 * Huella del `File` (en el worker, sin bloquear la pantalla). Se recuerda por objeto `File`: la aplicacion automatica y la hoja
 * «Plantillas» comparten el calculo. Solo se recuerdan los exitos: un error o una cancelacion se vuelven a intentar.
 */
export async function fingerprintOfFile(file: File, signal?: AbortSignal): Promise<Fingerprint> {
  const known = fingerprints.get(file);
  if (known) return known;
  const fingerprint = await computeFingerprint(file, { signal });
  fingerprints.set(file, fingerprint);
  return fingerprint;
}

/** Paginas de un PDF cuando no se pudo calcular su huella (cifrado, dañado a medias): la plantilla se aplica por numero de pagina. */
export async function pageCountOfFile(file: File): Promise<number> {
  const known = fingerprints.get(file);
  if (known) return known.pageCount;
  return (await loadPdf(file)).getPageCount();
}

/* ------------------------------------------------------------------ *
 * Resumen de una plantilla
 * ------------------------------------------------------------------ */

export type VariantSummary = { signatures: number; initials: number; text: number };

export type TemplateSummary = {
  one: VariantSummary;
  two: VariantSummary;
  /** Variantes con firmas o iniciales. */
  hasOne: boolean;
  hasTwo: boolean;
  /** La variante mas completa (la de 2 firmantes si tiene firmas, si no la de 1): la que cuenta el resumen. */
  main: VariantSummary;
  mainSigners: 1 | 2 | 0;
  /** Cuantas paginas distintas tienen algun campo, en cualquiera de las variantes. */
  pagesWithFields: number;
};

function summarizeVariant(variant: Variant): VariantSummary {
  return {
    signatures: variant.fields.filter((field) => field.type === "signature").length,
    initials: variant.fields.filter((field) => field.type === "initials").length,
    text: variant.textFields.length,
  };
}

export function summarizeTemplate(template: Pick<DocTemplate, "variants">): TemplateSummary {
  const one = summarizeVariant(template.variants["1"]);
  const two = summarizeVariant(template.variants["2"]);
  const hasOne = one.signatures + one.initials > 0;
  const hasTwo = two.signatures + two.initials > 0;
  const pages = new Set<number>();
  for (const key of ["1", "2"] as const) {
    for (const field of template.variants[key].fields) pages.add(field.pageIndex);
    for (const field of template.variants[key].textFields) pages.add(field.pageIndex);
  }
  const mainSigners = hasTwo ? 2 : hasOne ? 1 : 0;
  // Sin firmas en ninguna variante (solo campos de texto): se cuenta la que tenga mas campos.
  const main = hasTwo ? two : hasOne ? one : one.text >= two.text ? one : two;
  return { one, two, hasOne, hasTwo, main, mainSigners, pagesWithFields: pages.size };
}

/* ------------------------------------------------------------------ *
 * Filas de la hoja
 * ------------------------------------------------------------------ */

/** `unknown`: no se puede comparar (la plantilla no tiene documento de origen en la biblioteca, o el PDF cargado no se pudo huellar). */
export type RowLevel = MatchLevel | "unknown";

export type LibraryTemplateRow = {
  template: DocTemplate;
  /** Documento de la biblioteca al que esta adjunta (su PDF base), o `null`. */
  document: DocumentEntry | null;
  /** Comparacion del PDF cargado con la huella del documento de origen; `null` si no es comparable. */
  match: MatchResult | null;
  level: RowLevel;
  /** 0..100 (con «Parece»/«Distinto» nunca 100); `null` si no es comparable. */
  percent: number | null;
  /** El PDF base se reemplazo y ya no coincide con la plantilla: se compara con la huella del PDF sobre el que se configuro. */
  stale: boolean;
  /** ISO de la ultima vez que se uso en este navegador. */
  lastUsedAt: string | null;
  summary: TemplateSummary;
};

export type BuildRowsInput = {
  templates: readonly DocTemplate[];
  documents: readonly DocumentEntry[];
  /** Huella del PDF cargado; `null` si no se pudo calcular. */
  fingerprint: Fingerprint | null;
  use: TemplateUse;
};

/** Huella con la que se compara una plantilla: la del PDF sobre el que se CONFIGURO (igual que `findTemplateForFingerprint`). */
export function basisOf(document: DocumentEntry): Fingerprint {
  return document.templateStale?.base ?? document.fingerprint;
}

export function buildRows(input: BuildRowsInput): LibraryTemplateRow[] {
  const byId = new Map(input.documents.map((document) => [document.id, document]));
  const comparisons = new Map<string, MatchResult>();
  const rows = input.templates.map((template): LibraryTemplateRow => {
    const document = template.documentId !== null ? (byId.get(template.documentId) ?? null) : null;
    let match: MatchResult | null = null;
    if (document && input.fingerprint) {
      match = comparisons.get(document.id) ?? null;
      if (!match) {
        match = compareFingerprints(input.fingerprint, basisOf(document));
        comparisons.set(document.id, match);
      }
    }
    return {
      template,
      document,
      match,
      level: match ? match.level : "unknown",
      percent: match ? match.percent : null,
      stale: Boolean(document?.templateStale),
      lastUsedAt: input.use[template.id] ?? null,
      summary: summarizeTemplate(template),
    };
  });
  return rankRows(rows);
}

const ROW_RANK: Record<RowLevel, number> = { exact: 4, match: 3, similar: 2, none: 1, unknown: 0 };

/** Por parecido (nivel y luego %), luego por uso reciente, luego la plantilla editada mas recientemente y por ultimo el nombre. */
export function rankRows(rows: readonly LibraryTemplateRow[]): LibraryTemplateRow[] {
  return [...rows].sort((a, b) => {
    const level = ROW_RANK[b.level] - ROW_RANK[a.level];
    if (level !== 0) return level;
    const similarity = (b.match?.similarity ?? 0) - (a.match?.similarity ?? 0);
    if (similarity !== 0) return similarity;
    const used = (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
    if (used !== 0) return used;
    const edited = b.template.updatedAt.localeCompare(a.template.updatedAt);
    if (edited !== 0) return edited;
    return a.template.name.localeCompare(b.template.name);
  });
}

/** `exact`/`match` se muestran los dos como «Coincide». */
export function displayLevel(level: RowLevel): "match" | "similar" | "none" | "unknown" {
  return level === "exact" || level === "match" ? "match" : level;
}

/* ------------------------------------------------------------------ *
 * Lecturas de la biblioteca
 * ------------------------------------------------------------------ */

export type LibrarySnapshot = { available: boolean; templates: DocTemplate[]; documents: DocumentEntry[] };

export async function loadLibrarySnapshot(): Promise<LibrarySnapshot> {
  const [templates, documents] = await Promise.all([listTemplates(), listDocuments()]);
  return { available: templates.available, templates: templates.templates, documents: documents.documents };
}

/** Plantillas con algun campo (las que tienen sentido ofrecer). */
export function isUsableTemplate(template: Pick<DocTemplate, "variants">): boolean {
  const summary = summarizeTemplate(template);
  return summary.one.signatures + summary.one.initials + summary.one.text + summary.two.signatures + summary.two.initials + summary.two.text > 0;
}

/** Cuantas plantillas utilizables hay en la biblioteca (0 si no hay IndexedDB). Nunca lanza. */
export async function countUsableTemplates(): Promise<number> {
  try {
    const { templates } = await listTemplates();
    return templates.filter(isUsableTemplate).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Por que no coincidio
 * ------------------------------------------------------------------ */

/** Veredicto de una pagina de la plantilla frente al documento, en palabras que la interfaz traduce. */
export type PageVerdict =
  /** El texto es identico. */
  | "identical"
  /** Texto casi igual (coincide). */
  | "same"
  /** Todo el texto de la plantilla esta en la pagina, que ademas trae mas (datos rellenados). */
  | "contained"
  /** Se parece pero cambio algo: se revisa. */
  | "changed"
  /** Pagina escaneada, comparada por imagen (menos fiable). */
  | "scan"
  /** El documento tiene paginas, pero ninguna se parece a esta. */
  | "notFound"
  /** La pagina de la misma posicion tiene otro tamaño. */
  | "differentSize"
  /** El documento no llega a tener esta pagina. */
  | "missing";

export type ExplainPage = {
  templatePage: number;
  documentPage: number | null;
  /** 0..100 */
  percent: number;
  /** `null` = no hay pagina del documento con la que comparar tamaños. */
  sameSize: boolean | null;
  kind: "text" | "image" | "none";
  verdict: PageVerdict;
  /** No se aplica sola. */
  review: boolean;
};

export type ExplainHeadline = "same" | "similar" | "differentPages" | "differentText" | "partial" | "empty" | "version" | "noOrigin" | "unreadable";

export type Explanation = {
  headline: ExplainHeadline;
  templatePages: number;
  documentPages: number;
  pages: ExplainPage[];
  /** Paginas del documento (0-based) que no corresponden a ninguna de la plantilla (paginas nuevas). */
  extraDocumentPages: number[];
};

/**
 * Explica una comparacion pagina a pagina. `document` es la huella del PDF cargado; `template` la del documento de origen.
 * `match` es `compareFingerprints(document, template)`.
 */
export function explainMatch(args: { match: MatchResult; document: Fingerprint; template: Fingerprint }): Explanation {
  const { match, document, template } = args;
  const pages = match.pageMatches.map((page): ExplainPage => {
    const templateSize = template.pageSizes[page.templatePage];
    // Una pagina sin pareja se mira contra la de su misma posicion, para poder decir si es cuestion de tamaño.
    const compared = page.documentPage ?? (page.templatePage < document.pageCount ? page.templatePage : null);
    const documentSize = compared !== null ? document.pageSizes[compared] : undefined;
    const same = templateSize && documentSize ? sameSize(documentSize, templateSize) : null;
    let verdict: PageVerdict;
    if (page.documentPage === null) {
      verdict = compared === null ? "missing" : same === false ? "differentSize" : "notFound";
    } else if (page.identical) {
      verdict = "identical";
    } else if (page.kind === "image") {
      verdict = "scan";
    } else if (page.contained) {
      verdict = "contained";
    } else if (page.level === "match" || page.level === "exact") {
      verdict = "same";
    } else {
      verdict = "changed";
    }
    return {
      templatePage: page.templatePage,
      documentPage: page.documentPage,
      percent: Math.round(page.similarity * 100),
      sameSize: page.documentPage !== null ? true : same,
      kind: page.kind,
      verdict,
      review: page.review,
    };
  });
  const mapped = new Set(match.mappedPages.filter((target): target is number => typeof target === "number"));
  const extraDocumentPages = Array.from({ length: document.pageCount }, (_, index) => index).filter((index) => !mapped.has(index));
  let headline: ExplainHeadline;
  if (match.level === "exact" || match.level === "match") headline = "same";
  else if (match.level === "similar") headline = "similar";
  else if (match.reason === "partial") headline = "partial";
  else if (match.reason === "empty") headline = "empty";
  else if (match.reason === "version") headline = "version";
  else if (document.pageCount !== template.pageCount) headline = "differentPages";
  else headline = "differentText";
  return { headline, templatePages: template.pageCount, documentPages: document.pageCount, pages, extraDocumentPages };
}
