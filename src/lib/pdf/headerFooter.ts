import { degrees } from "@cantoo/pdf-lib";
import {
  PdfError,
  getPageGeometry,
  hexToPdfColor,
  loadPdf,
  originForCenter,
  pdfBytesToBlob,
  savePdfToBytes,
  standardFontFor,
  toPdfError,
  toWinAnsiSafe,
  viewPointToUser,
  type PdfFontFamily,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { MARGIN_POINTS, type PageNumberMargin } from "@/lib/pdf/pageNumbers";

/**
 * Motor de encabezado, pie de pagina y numeracion Bates (Wave 7 · U5). Reutiliza la geometria de
 * `pageNumbers.ts` (margenes y colocacion respecto a la pagina VISIBLE, tambien en paginas giradas)
 * pero con hasta seis textos por pagina: izquierda / centro / derecha en el encabezado y en el pie.
 *
 * Marcadores (se sustituyen en cada pagina; cualquier otro texto se respeta):
 *  - `{n}`  numero de la pagina (empieza en `firstNumber`);
 *  - `{p}`  ultimo numero asignado (igual que en `pageNumbers.ts`: «3 de 10» sigue siendo cierto si
 *           se numera solo una parte);
 *  - `{fecha}` / `{date}`  fecha de hoy (`options.date`, formato local);
 *  - `{nombre}` / `{name}` nombre del archivo sin extension;
 *  - `{bates}` prefijo + contador con ceros a la izquierda (`bates`): un numero unico por pagina del rango.
 */

export type HeaderFooterSlots = { left: string; center: string; right: string };

export type BatesOptions = {
  prefix: string;
  /** Primer numero (>= 0). */
  start: number;
  /** Cifras minimas, con ceros a la izquierda (1..12). */
  digits: number;
};

export type HeaderFooterOptions = {
  header: HeaderFooterSlots;
  footer: HeaderFooterSlots;
  margin: PageNumberMargin;
  fontFamily: PdfFontFamily;
  fontSize: number;
  color: string;
  /** Numero impreso en la primera pagina del rango. */
  firstNumber: number;
  /** Rango 1..N inclusive; 0 en `toPage` = hasta el final. */
  fromPage: number;
  toPage: number;
  /** Nombre del documento para `{nombre}` (con o sin extension). */
  documentName: string;
  /** Fecha para `{fecha}`; por defecto, hoy. */
  date?: Date;
  /** Etiqueta regional para formatear `{fecha}`. */
  locale?: string;
  bates?: BatesOptions | null;
};

export const EMPTY_SLOTS: HeaderFooterSlots = { left: "", center: "", right: "" };

export const DEFAULT_HEADER_FOOTER_OPTIONS: HeaderFooterOptions = {
  header: { ...EMPTY_SLOTS },
  footer: { ...EMPTY_SLOTS },
  margin: "recommended",
  fontFamily: "helvetica",
  fontSize: 10,
  color: "#000000",
  firstNumber: 1,
  fromPage: 1,
  toPage: 0,
  documentName: "",
  bates: null,
};

export const MAX_BATES_DIGITS = 12;

/** Hay al menos un texto no vacio (o un Bates) que estampar. */
export function hasHeaderFooterContent(options: HeaderFooterOptions): boolean {
  const slots = [...Object.values(options.header), ...Object.values(options.footer)];
  return slots.some((text) => text.trim().length > 0);
}

/** `report.pdf` → `report`. */
export function documentBaseName(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

export function formatBatesLabel(bates: BatesOptions, value: number): string {
  const digits = Math.min(MAX_BATES_DIGITS, Math.max(1, Math.floor(bates.digits) || 1));
  return `${bates.prefix}${String(Math.max(0, Math.floor(value))).padStart(digits, "0")}`;
}

export type TokenContext = {
  current: number;
  total: number;
  name: string;
  dateLabel: string;
  bates: string;
};

/** Sustituye los marcadores de una plantilla. */
export function expandHeaderFooterTokens(template: string, ctx: TokenContext): string {
  return template
    .replaceAll("{n}", String(ctx.current))
    .replaceAll("{p}", String(ctx.total))
    .replaceAll("{fecha}", ctx.dateLabel)
    .replaceAll("{date}", ctx.dateLabel)
    .replaceAll("{nombre}", ctx.name)
    .replaceAll("{name}", ctx.name)
    .replaceAll("{bates}", ctx.bates);
}

function formatDate(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

type Slot = { vertical: "top" | "bottom"; horizontal: "left" | "center" | "right"; template: string };

function slotsOf(options: HeaderFooterOptions): Slot[] {
  const slots: Slot[] = [];
  for (const horizontal of ["left", "center", "right"] as const) {
    slots.push({ vertical: "top", horizontal, template: options.header[horizontal] });
  }
  for (const horizontal of ["left", "center", "right"] as const) {
    slots.push({ vertical: "bottom", horizontal, template: options.footer[horizontal] });
  }
  return slots.filter((slot) => slot.template.trim().length > 0);
}

export async function addHeaderFooter(
  file: File | Blob,
  options: HeaderFooterOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  return pdfBytesToBlob(await addHeaderFooterToBytes(file, options, onProgress));
}

/**
 * Igual que `addHeaderFooter`, pero devuelve los BYTES del PDF resultante (`Uint8Array`) sin pasar por un `Blob`: para quien sigue
 * trabajando con bytes (PDF Pro). Mismos bytes que el `Blob` de `addHeaderFooter`.
 */
export async function addHeaderFooterToBytes(
  file: File | Blob,
  options: HeaderFooterOptions,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  try {
    const slots = slotsOf(options);
    if (slots.length === 0) throw new PdfError("nothingSelected");

    const document = await loadPdf(file);
    onProgress?.(0.15);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    const from = Math.min(Math.max(1, Math.floor(options.fromPage) || 1), pages.length);
    const rawTo = Math.floor(options.toPage) || pages.length;
    const to = Math.min(Math.max(from, rawTo), pages.length);

    const font = await document.embedFont(standardFontFor(options.fontFamily, false, false));
    const color = hexToPdfColor(options.color);
    const size = Math.min(96, Math.max(5, options.fontSize));
    const margin = MARGIN_POINTS[options.margin];
    const start = Math.max(0, Math.floor(options.firstNumber));
    const count = to - from + 1;
    const total = start + count - 1;
    const name = documentBaseName(options.documentName);
    const dateLabel = formatDate(options.date ?? new Date(), options.locale ?? "es-ES");

    onProgress?.(0.25);

    for (let index = from - 1; index <= to - 1; index += 1) {
      const page = pages[index];
      const geometry = getPageGeometry(page);
      const offset = index - (from - 1);
      const context: TokenContext = {
        current: start + offset,
        total,
        name,
        dateLabel,
        bates: options.bates ? formatBatesLabel(options.bates, options.bates.start + offset) : "",
      };

      for (const slot of slots) {
        const label = toWinAnsiSafe(expandHeaderFooterTokens(slot.template, context));
        if (label.trim().length === 0) continue;

        const width = font.widthOfTextAtSize(label, size);
        const height = font.heightAtSize(size);
        const baselineOffset = height - font.heightAtSize(size, { descender: false });

        let vx: number;
        if (slot.horizontal === "left") vx = margin + width / 2;
        else if (slot.horizontal === "right") vx = geometry.viewWidth - margin - width / 2;
        else vx = geometry.viewWidth / 2;

        const vy = slot.vertical === "top" ? geometry.viewHeight - margin - height / 2 : margin + height / 2;

        const center = viewPointToUser(geometry, vx, vy);
        const origin = originForCenter(center.x, center.y, width, height, baselineOffset, geometry.rotation);
        page.drawText(label, {
          x: origin.x,
          y: origin.y,
          size,
          font,
          color,
          rotate: degrees(geometry.rotation),
        });
      }

      onProgress?.(0.25 + ((offset + 1) / count) * 0.7);
    }

    const bytes = await savePdfToBytes(document);
    onProgress?.(1);
    return bytes;
  } catch (error) {
    throw toPdfError(error);
  }
}
