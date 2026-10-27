import type { Dictionary } from "@/lib/locales/es";
import type { PdfErrorCode } from "@/lib/pdf/core";
import {
  EXTRACT_LIMITS,
  type AssetFormat,
  type AssetKind,
  type AssetSource,
  type ExtractResult,
  type ExtractWarning,
  type ExtractedAsset,
} from "@/lib/pdf/extractAssets/types";

/**
 * Logica PURA de la herramienta «Extraer elementos» (F7 · U7.4): filtros y recuentos, orden, nombres accesibles
 * («Firma probable, página 3, 420 × 140 px»), nombres de archivo (`p03-firma-01.png`), formato de descarga, seleccion y
 * avisos. Sin DOM ni React ni motor, para probarla (y mutarla) aparte de la interfaz.
 */

export type ExtractStrings = Dictionary["extract"];

/** Anotaciones que revisa el motor por pagina: el tope de `annotations.ts` (se dice en el aviso). */
export const MAX_ANNOTATIONS_REVIEWED = EXTRACT_LIMITS.maxAnnotationsPerPage;

/** Sustituye `{clave}` por su valor (las claves que no estan se dejan tal cual). */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Tipos y filtros                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

export type FilterId = "all" | "signature" | "initials" | "image" | "logo" | "stamp" | "watermark" | "other";
export const FILTER_ORDER: readonly FilterId[] = ["all", "signature", "initials", "image", "logo", "stamp", "watermark", "other"];

/** Filtro al que pertenece cada tipo: las fotos van con las imagenes y los dibujos con «Otros». */
export function filterOfKind(kind: AssetKind): Exclude<FilterId, "all"> {
  switch (kind) {
    case "signature":
      return "signature";
    case "initials":
      return "initials";
    case "image":
    case "photo":
      return "image";
    case "logo":
      return "logo";
    case "stamp":
      return "stamp";
    case "watermark":
      return "watermark";
    default:
      return "other";
  }
}

export function countByFilter(assets: readonly ExtractedAsset[]): Record<FilterId, number> {
  const counts: Record<FilterId, number> = { all: assets.length, signature: 0, initials: 0, image: 0, logo: 0, stamp: 0, watermark: 0, other: 0 };
  for (const asset of assets) counts[filterOfKind(asset.kind)] += 1;
  return counts;
}

export function filterAssets(assets: readonly ExtractedAsset[], filter: FilterId): ExtractedAsset[] {
  return filter === "all" ? [...assets] : assets.filter((asset) => filterOfKind(asset.kind) === filter);
}

/** Un elemento sin ningun formato que descargar (un campo de firma vacio, o firmado sin apariencia visible): no hay nada que extraer. */
export function hasNothingToExtract(asset: ExtractedAsset): boolean {
  return asset.formats.length === 0;
}

/** Separa lo que se puede ofrecer de lo que no tiene nada que extraer (se cuenta aparte y se avisa en una linea). */
export function splitExtractable(assets: readonly ExtractedAsset[]): { usable: ExtractedAsset[]; empty: ExtractedAsset[] } {
  const usable: ExtractedAsset[] = [];
  const empty: ExtractedAsset[] = [];
  for (const asset of assets) (hasNothingToExtract(asset) ? empty : usable).push(asset);
  return { usable, empty };
}

/** Primera pagina (0-based) donde aparece; `Infinity` si el motor no la dio. */
function firstPage(asset: ExtractedAsset): number {
  let first = Infinity;
  for (const occurrence of asset.occurrences) if (occurrence.pageIndex < first) first = occurrence.pageIndex;
  return first;
}

function firstRect(asset: ExtractedAsset): { x: number; y: number } {
  const target = firstPage(asset);
  const found = asset.occurrences.find((occurrence) => occurrence.pageIndex === target);
  return { x: found?.rect.x ?? 0, y: found?.rect.y ?? 0 };
}

/** Orden de lectura: por pagina, de arriba abajo y de izquierda a derecha; el resto, estable por `id`. */
export function sortAssets(assets: readonly ExtractedAsset[]): ExtractedAsset[] {
  return [...assets].sort((a, b) => {
    const pageA = firstPage(a);
    const pageB = firstPage(b);
    if (pageA !== pageB) return pageA < pageB ? -1 : 1;
    const rectA = firstRect(a);
    const rectB = firstRect(b);
    if (rectA.y !== rectB.y) return rectA.y - rectB.y;
    if (rectA.x !== rectB.x) return rectA.x - rectB.x;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Textos de cada elemento                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/** Por debajo de esta confianza, un tipo que CLASIFICA el motor (firma, sello, logo...) se dice «probable». */
export const PROBABLE_BELOW = 0.9;

/** Las imagenes y fotos son estructura del PDF (certeza alta): no llevan «probable». */
export function isProbable(asset: ExtractedAsset): boolean {
  if (asset.kind === "image" || asset.kind === "photo") return false;
  return asset.confidence < PROBABLE_BELOW;
}

const KIND_KEY: Record<AssetKind, [keyof ExtractStrings, keyof ExtractStrings, keyof ExtractStrings]> = {
  signature: ["kindSignature", "probableSignature", "nameSignature"],
  initials: ["kindInitials", "probableInitials", "nameInitials"],
  image: ["kindImage", "probableImage", "nameImage"],
  logo: ["kindLogo", "probableLogo", "nameLogo"],
  stamp: ["kindStamp", "probableStamp", "nameStamp"],
  watermark: ["kindWatermark", "probableWatermark", "nameWatermark"],
  drawing: ["kindDrawing", "probableDrawing", "nameDrawing"],
  photo: ["kindPhoto", "probablePhoto", "namePhoto"],
};

export function kindName(strings: ExtractStrings, kind: AssetKind): string {
  return strings[KIND_KEY[kind][0]];
}

/** «Firma probable» / «Firma» (el chip de tipo). */
export function typeLabel(strings: ExtractStrings, asset: ExtractedAsset): string {
  return strings[KIND_KEY[asset.kind][isProbable(asset) ? 1 : 0]];
}

/** Paginas (1-based, sin repetir y ordenadas) donde aparece. */
export function assetPages(asset: ExtractedAsset): number[] {
  return [...new Set(asset.occurrences.map((occurrence) => occurrence.pageIndex + 1))].sort((a, b) => a - b);
}

/** «3», «1, 2 y 5»… hasta 3 paginas; mas, «6 páginas». */
export function pagesText(strings: ExtractStrings, pages: readonly number[]): string {
  if (pages.length === 0) return "";
  if (pages.length > 3) return fill(strings.labelPagesMany, { n: pages.length });
  return fill(pages.length === 1 ? strings.labelPage : strings.labelPages, { pages: pages.join(", ") });
}

/** «420 × 140 px», «solo texto» o «vectorial». */
export function sizeText(strings: ExtractStrings, asset: ExtractedAsset): string {
  if (asset.pixel) return fill(strings.labelSize, { w: asset.pixel.width, h: asset.pixel.height });
  return asset.source === "text" ? strings.labelText : strings.labelVector;
}

/** Posicion de un elemento entre los que se llaman igual («1 de 2»). */
export type Ordinal = { n: number; total: number };

/** Nombre accesible: «Firma probable, página 3, 420 × 140 px»; con otro igual en la misma pagina, «Firma probable 1 de 2, página 3, 420 × 140 px». */
export function assetLabel(strings: ExtractStrings, asset: ExtractedAsset, ordinal?: Ordinal): string {
  const type = typeLabel(strings, asset);
  return [ordinal ? fill(strings.ordinalOf, { label: type, n: ordinal.n, total: ordinal.total }) : type, pagesText(strings, assetPages(asset)), sizeText(strings, asset)].filter(Boolean).join(", ");
}

/**
 * Ordinales de los elementos que tendrian el MISMO nombre accesible (mismo tipo, paginas y tamano: dos firmas de una pagina), en el
 * orden dado. Un lector de pantalla no los distinguiria; los que tienen un nombre unico no aparecen en el mapa.
 */
export function ordinalsFor(strings: ExtractStrings, assets: readonly ExtractedAsset[]): Map<string, Ordinal> {
  const groups = new Map<string, ExtractedAsset[]>();
  for (const asset of assets) {
    const key = assetLabel(strings, asset);
    const list = groups.get(key);
    if (list) list.push(asset);
    else groups.set(key, [asset]);
  }
  const out = new Map<string, Ordinal>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.forEach((asset, index) => out.set(asset.id, { n: index + 1, total: list.length }));
  }
  return out;
}

export function confidencePercent(asset: ExtractedAsset): number {
  return Math.round(Math.min(1, Math.max(0, asset.confidence)) * 100);
}

const SOURCE_KEY: Record<AssetSource, keyof ExtractStrings> = {
  xobject: "sourceXobject",
  inline: "sourceInline",
  mask: "sourceMask",
  form: "sourceForm",
  "ink-annot": "sourceInkAnnot",
  "stamp-annot": "sourceStampAnnot",
  "sig-widget": "sourceSigWidget",
  ocg: "sourceOcg",
  text: "sourceText",
  vector: "sourceVector",
  region: "sourceRegion",
};

export function sourceName(strings: ExtractStrings, source: AssetSource): string {
  return strings[SOURCE_KEY[source]];
}

const FORMAT_KEY: Record<AssetFormat, keyof ExtractStrings> = {
  png: "formatPngName",
  "jpg-original": "formatJpgOriginalName",
  jpg: "formatJpgName",
  svg: "formatSvgName",
  txt: "formatTxtName",
};

export function formatName(strings: ExtractStrings, format: AssetFormat): string {
  return strings[FORMAT_KEY[format]];
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Descarga: formato y nombres                                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

export type FormatPreference = "png" | "original";

/** Formato por defecto del elemento (el primero que anuncia el motor). */
export function defaultFormat(asset: ExtractedAsset): AssetFormat {
  return asset.formats[0] ?? "png";
}

/**
 * Formato para una descarga segun la preferencia global: `png` pide PNG si el elemento lo ofrece; `original` pide el JPG
 * original, si no el SVG, si no el texto; lo que no pueda dar cae al formato por defecto del elemento.
 */
export function resolveFormat(asset: ExtractedAsset, preference: FormatPreference): AssetFormat {
  if (preference === "png") return asset.formats.includes("png") ? "png" : defaultFormat(asset);
  // Un elemento solo de texto (marca de agua) se entrega como su texto; un SVG sigue siendo el original de un trazo.
  if (asset.pixel === null && asset.formats.includes("txt")) return "txt";
  for (const candidate of ["jpg-original", "svg", "txt"] as const) if (asset.formats.includes(candidate)) return candidate;
  return defaultFormat(asset);
}

/** Origenes cuya imagen es la INCRUSTADA tal cual (con margenes y, si es un JPEG, fondo opaco): hay que limpiarla para entregarla como firma. */
const EMBEDDED_RASTER_SOURCES: ReadonlySet<AssetSource> = new Set<AssetSource>(["xobject", "inline", "mask"]);

/**
 * Las firmas e iniciales que salen de una imagen incrustada se entregan LIMPIAS al descargar (fondo transparente, tinta completa,
 * recorte ajustado con un margen pequeno: `inkExtract`, igual que «Guardar»). Las demas clases conservan la imagen original, y los
 * trazos, campos de firma y recortes de region ya salen limpios del motor.
 */
export function needsClean(asset: ExtractedAsset): boolean {
  return (asset.kind === "signature" || asset.kind === "initials") && EMBEDDED_RASTER_SOURCES.has(asset.source) && asset.formats.includes("png") && asset.pixel !== null;
}

/** Que se pide al motor y si el resultado se limpia con `inkExtract` antes de entregarlo. */
export type DownloadChoice = { format: AssetFormat; clean: boolean };

/** Eleccion segun la preferencia global: «PNG» = firma limpia (o el PNG de siempre); «Original» = la imagen incrustada tal cual. */
export function resolveChoice(asset: ExtractedAsset, preference: FormatPreference): DownloadChoice {
  if (needsClean(asset)) {
    if (preference === "png") return { format: "png", clean: true };
    return { format: asset.formats.includes("jpg-original") ? "jpg-original" : "png", clean: false };
  }
  return { format: resolveFormat(asset, preference), clean: false };
}

export type ChoiceOption = { id: string; choice: DownloadChoice; label: keyof ExtractStrings };

/** Botones de descarga del detalle: en una firma limpiable, el PNG limpio primero y el «Original» claramente rotulado. */
export function choiceOptions(asset: ExtractedAsset): ChoiceOption[] {
  if (!needsClean(asset)) return asset.formats.map((format) => ({ id: format, choice: { format, clean: false }, label: FORMAT_KEY[format] }));
  const options: ChoiceOption[] = [{ id: "clean", choice: { format: "png", clean: true }, label: "formatPngCleanName" }];
  if (!asset.formats.includes("jpg-original")) options.push({ id: "original", choice: { format: "png", clean: false }, label: "formatOriginalImageName" });
  for (const format of asset.formats) if (format !== "png") options.push({ id: format, choice: { format, clean: false }, label: format === "jpg-original" ? "formatOriginalImageName" : FORMAT_KEY[format] });
  return options;
}

/** `true` si algun elemento ofrece algo distinto del PNG de siempre: un formato original, o una firma limpiable (su «Original» es otra imagen). */
export function offersOriginal(assets: readonly ExtractedAsset[]): boolean {
  return assets.some((asset) => needsClean(asset) || asset.formats.some((format) => format !== "png"));
}

export function fileExtension(format: AssetFormat): string {
  switch (format) {
    case "jpg-original":
    case "jpg":
      return "jpg";
    case "svg":
      return "svg";
    case "txt":
      return "txt";
    default:
      return "png";
  }
}

/** Relleno a 2 cifras (3 si el documento pasa de 99 paginas, para que el orden alfabetico no se rompa). */
function padPage(page: number, width: number): string {
  return String(page).padStart(width, "0");
}

/**
 * Nombre BASE (sin extension) de cada elemento: `p03-firma-01`: pagina de su primera aparicion, tipo y un contador por
 * pagina y tipo, en el orden dado. Es estable: no depende de lo seleccionado ni del formato. Sin pagina: `documento-...`.
 */
export function planBaseNames(assets: readonly ExtractedAsset[], strings: ExtractStrings): Map<string, string> {
  const maxPage = assets.reduce((max, asset) => Math.max(max, ...asset.occurrences.map((o) => o.pageIndex + 1), 0), 0);
  const width = maxPage > 99 ? 3 : 2;
  const counters = new Map<string, number>();
  const names = new Map<string, string>();
  for (const asset of assets) {
    const page = firstPage(asset);
    const prefix = Number.isFinite(page) ? `p${padPage(page + 1, width)}` : strings.nameDocument;
    const slug = strings[KIND_KEY[asset.kind][2]];
    const key = `${prefix}|${slug}`;
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    names.set(asset.id, `${prefix}-${slug}-${String(count).padStart(2, "0")}`);
  }
  return names;
}

export function withExtension(baseName: string, format: AssetFormat): string {
  return `${baseName}.${fileExtension(format)}`;
}

/** Nombre del archivo de una descarga: el PNG sin limpiar de una firma lleva `-original` (no se confunde con el limpio). */
export function choiceFileName(baseName: string, asset: ExtractedAsset, choice: DownloadChoice): string {
  const untouched = needsClean(asset) && !choice.clean && choice.format === "png";
  return withExtension(untouched ? `${baseName}-original` : baseName, choice.format);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Guardar en «Firmas guardadas»                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** Cualquier elemento con pixeles se puede guardar (el usuario decide si es firma o iniciales). */
export function canSaveToVault(asset: ExtractedAsset): boolean {
  return asset.pixel !== null;
}

export function defaultVaultKind(asset: ExtractedAsset): "signature" | "initials" {
  return asset.kind === "initials" ? "initials" : "signature";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Seleccion                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** `true` si todos los visibles estan marcados (y hay alguno). */
export function allVisibleSelected(selected: ReadonlySet<string>, visible: readonly ExtractedAsset[]): boolean {
  return visible.length > 0 && visible.every((asset) => selected.has(asset.id));
}

/** «Seleccionar todo» sobre lo visible: marca todos; si ya lo estaban, los desmarca. Lo oculto por el filtro no cambia. */
export function toggleAllVisible(selected: ReadonlySet<string>, visible: readonly ExtractedAsset[]): Set<string> {
  const next = new Set(selected);
  if (allVisibleSelected(selected, visible)) for (const asset of visible) next.delete(asset.id);
  else for (const asset of visible) next.add(asset.id);
  return next;
}

/** Deja solo lo que sigue existiendo (tras volver a buscar). */
export function pruneSelection(selected: ReadonlySet<string>, assets: readonly ExtractedAsset[]): Set<string> {
  const ids = new Set(assets.map((asset) => asset.id));
  return new Set([...selected].filter((id) => ids.has(id)));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Textos de estado y avisos                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

export function pagesCountText(strings: ExtractStrings, count: number): string {
  return count === 1 ? strings.pagesOne : fill(strings.pagesMany, { n: count });
}

export function selectedText(strings: ExtractStrings, count: number): string {
  if (count === 0) return strings.selectionNone;
  return count === 1 ? strings.selectedOne : fill(strings.selectedMany, { n: count });
}

/** Resumen del resultado para la region viva y el encabezado. */
export function summaryText(strings: ExtractStrings, result: ExtractResult, analyzedPages: number): string {
  const total = result.assets.length;
  if (total === 0) return strings.foundNone;
  const pages = pagesCountText(strings, analyzedPages);
  return total === 1 ? fill(strings.foundOne, { pages }) : fill(strings.foundMany, { n: total, pages });
}

export type ExtractNotice = { id: string; code: ExtractWarning["code"] | "empty-sig-field"; text: string; action?: "region" | "range" };

function pageList(pages: readonly number[]): string {
  return pages.length > 6 ? `${pages.slice(0, 6).join(", ")}…` : pages.join(", ");
}

/**
 * Avisos del motor como frases (agrupados: una sola linea por tipo). `range` es el rango analizado (1-based, inclusivo).
 */
export function noticesFor(
  strings: ExtractStrings,
  result: ExtractResult,
  range: { from: number; to: number },
): ExtractNotice[] {
  const notices: ExtractNotice[] = [];
  const byCode = (code: ExtractWarning["code"]): ExtractWarning[] => result.warnings.filter((warning) => warning.code === code);
  const scanned = [...new Set([...result.scannedPages, ...byCode("scanned-page").flatMap((w) => (w.pageIndex === undefined ? [] : [w.pageIndex]))])].sort((a, b) => a - b);
  if (scanned.length > 0) {
    const pages = scanned.map((page) => page + 1);
    notices.push({
      id: "scanned",
      code: "scanned-page",
      text: fill(pages.length === 1 ? strings.warnScannedOne : strings.warnScanned, { pages: pageList(pages) }),
      action: "region",
    });
  }
  if (byCode("too-many-pages").length > 0) {
    notices.push({
      id: "too-many-pages",
      code: "too-many-pages",
      text: fill(strings.warnTooManyPages, { total: result.pageCount, from: range.from, to: range.to }),
      action: "range",
    });
  }
  if (byCode("too-many-assets").length > 0) {
    notices.push({ id: "too-many-assets", code: "too-many-assets", text: fill(strings.warnTooManyAssets, { n: result.assets.length }), action: "range" });
  }
  for (const warning of byCode("too-many-annotations")) {
    notices.push({
      id: `annotations-${warning.pageIndex ?? "x"}`,
      code: "too-many-annotations",
      text: fill(strings.warnTooManyAnnotations, { page: (warning.pageIndex ?? 0) + 1, n: warning.detail ?? "", max: MAX_ANNOTATIONS_REVIEWED }),
    });
  }
  const emptyFields = result.assets.filter(hasNothingToExtract).length;
  if (emptyFields > 0) {
    notices.push({
      id: "empty-sig-field",
      code: "empty-sig-field",
      text: emptyFields === 1 ? strings.warnEmptySigFieldOne : fill(strings.warnEmptySigFieldMany, { n: emptyFields }),
    });
  }
  for (const warning of byCode("digital-signature")) {
    notices.push({
      id: `digital-${warning.pageIndex ?? "x"}`,
      code: "digital-signature",
      text: fill(strings.warnDigitalSignature, { page: (warning.pageIndex ?? 0) + 1 }),
    });
  }
  for (const warning of byCode("image-too-large")) {
    notices.push({
      id: `large-${warning.pageIndex ?? "x"}`,
      code: "image-too-large",
      text: fill(strings.warnImageTooLarge, { page: (warning.pageIndex ?? 0) + 1 }),
    });
  }
  for (const warning of byCode("decode-failed")) {
    notices.push({
      id: `decode-${warning.pageIndex ?? "x"}`,
      code: "decode-failed",
      text: warning.pageIndex === undefined ? strings.warnDecodeNoPage : fill(strings.warnDecode, { page: warning.pageIndex + 1 }),
    });
  }
  if (byCode("encrypted").length > 0) notices.push({ id: "encrypted", code: "encrypted", text: strings.warnEncrypted });
  if (byCode("cancelled").length > 0) notices.push({ id: "cancelled", code: "cancelled", text: strings.warnCancelled });
  return notices;
}

/** Rango analizado (1-based) segun lo pedido y el tope de paginas. */
export function analyzedRange(
  pageCount: number,
  requested: { from: number; to: number } | undefined,
  maxPages: number,
): { from: number; to: number } {
  const from = Math.max(0, Math.min(pageCount - 1, requested?.from ?? 0));
  const to = Math.max(from, Math.min(pageCount - 1, requested?.to ?? pageCount - 1, from + maxPages - 1));
  return { from: from + 1, to: to + 1 };
}

/**
 * Codigo de error de un fallo del motor. Un `PdfError` se reconoce por su nombre y su `code` (no por `instanceof`): asi
 * tambien vale el de un motor empaquetado aparte (el motor falso de las pruebas E2E) y llega el mismo mensaje al usuario.
 */
export function errorCodeOf(error: unknown, fallback: (error: unknown) => PdfErrorCode): PdfErrorCode {
  if (error instanceof Error && error.name === "PdfError") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code as PdfErrorCode;
  }
  return fallback(error);
}

/** `true` si el error es una cancelacion (el usuario o el motor pararon): no es un fallo. */
export function isCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return error.name === "AbortError" || code === "aborted" || code === "cancelled";
}
