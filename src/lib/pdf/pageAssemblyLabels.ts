import { PDFHexString, PDFName, PDFNumber, type PDFContext, type PDFDict, type PDFObject } from "@cantoo/pdf-lib";
import {
  KEY,
  asArray,
  asDict,
  nameValue,
  numberValue,
  textValue,
} from "@/lib/pdf/pageAssemblyStructure";

/**
 * Etiquetas de pagina (`/PageLabels`: «i, ii, iii, 1, 2, A-1...») para el motor de paginas. Modulo
 * puro (sin React).
 *
 * MODELO. La etiqueta SIGUE A LA PAGINA: la pagina que en el documento original se mostraba como «iii»
 * sigue mostrandose «iii» aunque ahora sea la 7.ª (asi la etiqueta del visor coincide con el numero
 * impreso en la hoja). Por eso, ante un plan de paginas, se calcula la etiqueta de cada pagina de
 * origen y se reconstruyen los tramos para el orden nuevo. Las paginas que no vienen de ningun
 * documento (en blanco, de imagen) no llevan numero: etiqueta vacia.
 */

/** Numeracion de una pagina: estilo (`D`, `R`, `r`, `A`, `a` o ninguno), prefijo y numero. */
export type PageLabel = { style: string | undefined; prefix: string; value: number };

/** Un tramo de `/PageLabels`: desde la pagina `start` (0-based), con su estilo, prefijo y numero inicial. */
export type LabelRange = { start: number; style: string | undefined; prefix: string; first: number };

export type LabelsRead =
  /** Sin `/PageLabels` (o vacio): las paginas se numeran 1, 2, 3... */
  | { kind: "none" }
  /** Hay `/PageLabels` pero no se pudo leer con seguridad (arbol roto, claves no numericas, demasiado grande). */
  | { kind: "unreadable" }
  | { kind: "ranges"; ranges: LabelRange[] };

/** Sin etiqueta propia (paginas nuevas): ni numero ni prefijo. */
export const EMPTY_LABEL: PageLabel = { style: undefined, prefix: "", value: 0 };

const N_ST = PDFName.of("St");
const N_NUMS = PDFName.of("Nums");
const MAX_NODES = 5_000;
const MAX_ENTRIES = 200_000;

function rangeFromDict(context: PDFContext, start: number, dict: PDFDict): LabelRange {
  const style = nameValue(context, dict.get(KEY.S));
  const prefix = textValue(context, dict.get(KEY.P)) ?? "";
  const given = numberValue(context, dict.get(N_ST));
  const first = given !== undefined && Number.isInteger(given) && given >= 1 ? given : 1;
  return { start, style, prefix, first: style === undefined ? 1 : first };
}

/** Lee `/PageLabels` del catalogo (arbol de numeros). */
export function readPageLabels(context: PDFContext, catalog: PDFDict): LabelsRead {
  const raw = catalog.get(KEY.PageLabels);
  if (!raw) return { kind: "none" };
  const root = asDict(context, raw);
  if (!root) return { kind: "unreadable" };

  const found = new Map<number, LabelRange>();
  const seen = new Set<PDFDict>();
  let nodes = 0;
  let ok = true;
  const visit = (node: PDFDict, depth: number) => {
    if (!ok) return;
    if (seen.has(node) || depth > 64 || nodes >= MAX_NODES) {
      ok = false;
      return;
    }
    seen.add(node);
    nodes += 1;
    const nums = asArray(context, node.get(N_NUMS));
    if (nums) {
      for (let index = 0; index + 1 < nums.size(); index += 2) {
        const key = numberValue(context, nums.get(index));
        const value = asDict(context, nums.get(index + 1));
        if (key === undefined || !Number.isInteger(key) || key < 0 || !value || found.size >= MAX_ENTRIES) {
          ok = false;
          return;
        }
        found.set(key, rangeFromDict(context, key, value));
      }
    }
    const kids = asArray(context, node.get(KEY.Kids));
    if (kids) {
      for (let index = 0; index < kids.size(); index += 1) {
        const child = asDict(context, kids.get(index));
        if (!child) {
          ok = false;
          return;
        }
        visit(child, depth + 1);
      }
    }
  };
  visit(root, 0);
  if (!ok) return { kind: "unreadable" };
  if (found.size === 0) return { kind: "none" };
  return { kind: "ranges", ranges: [...found.values()].sort((a, b) => a.start - b.start) };
}

/** Numeracion por defecto de un documento sin etiquetas: decimal desde 1. */
export function defaultLabel(index: number): PageLabel {
  return { style: "D", prefix: "", value: index + 1 };
}

/** Etiqueta de la pagina `index` (0-based) segun los tramos. Antes del primer tramo, la numeracion por defecto. */
export function labelAt(ranges: readonly LabelRange[], index: number): PageLabel {
  let low = 0;
  let high = ranges.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ranges[mid].start <= index) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0) return defaultLabel(index);
  const range = ranges[found];
  return { style: range.style, prefix: range.prefix, value: range.first + (index - range.start) };
}

/** `next` sigue a `prev` dentro del mismo tramo (mismo estilo y prefijo, y el numero siguiente). */
function continues(prev: PageLabel, next: PageLabel): boolean {
  if (prev.style !== next.style || prev.prefix !== next.prefix) return false;
  return prev.style === undefined || next.value === prev.value + 1;
}

/** Tramos minimos que producen exactamente esas etiquetas, pagina a pagina. */
export function compressLabels(labels: readonly PageLabel[]): LabelRange[] {
  const ranges: LabelRange[] = [];
  labels.forEach((label, index) => {
    if (index > 0 && continues(labels[index - 1], label)) return;
    ranges.push({
      start: index,
      style: label.style,
      prefix: label.prefix,
      first: label.style === undefined ? 1 : label.value,
    });
  });
  return ranges;
}

/** Los dos juegos de tramos numeran igual (el numero inicial no cuenta si no hay estilo). */
export function sameRanges(a: readonly LabelRange[], b: readonly LabelRange[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (range, index) =>
        range.start === b[index].start &&
        range.style === b[index].style &&
        range.prefix === b[index].prefix &&
        (range.style === undefined || range.first === b[index].first),
    )
  );
}

/** Escribe `/PageLabels` como un solo nodo `/Nums` (sustituye al arbol anterior). */
export function writePageLabels(context: PDFContext, catalog: PDFDict, ranges: readonly LabelRange[]): void {
  const nums: PDFObject[] = [];
  for (const range of ranges) {
    const dict = context.obj({});
    if (range.style !== undefined) dict.set(KEY.S, PDFName.of(range.style));
    if (range.prefix !== "") dict.set(KEY.P, PDFHexString.fromText(range.prefix));
    if (range.style !== undefined && range.first !== 1) dict.set(N_ST, PDFNumber.of(range.first));
    nums.push(PDFNumber.of(range.start), dict);
  }
  catalog.set(KEY.PageLabels, context.obj({ Nums: nums }));
}
