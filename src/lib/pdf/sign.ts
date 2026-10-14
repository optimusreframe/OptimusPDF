import { degrees, type PDFDocument, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";
import {
  PdfError,
  getPageGeometry,
  hexToPdfColor,
  loadPdf,
  originForCenter,
  savePdfToBlob,
  scaleProgress,
  sha256Hex,
  slugify,
  standardFontFor,
  toPdfError,
  viewPointToUser,
  type PageGeometry,
  type NormalizedRect,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  LINE_HEIGHT_FACTOR,
  MIN_FONT_SIZE,
  wrapText,
} from "@/lib/pdf/editPdf";

/**
 * Motor de firma: empotra la firma (siempre un PNG generado en el
 * navegador a partir del trazo, del texto o de la imagen que sube el
 * usuario) en la posicion elegida sobre la vista previa.
 *
 * IMPORTANTE: esto NO es una firma electronica cualificada. Es una firma
 * visual (una imagen colocada sobre la pagina), que es lo que se puede
 * hacer con honestidad sin certificados ni servidor.
 */

export type SignaturePlacement = {
  pageIndex: number;
  /** Rectangulo 0..1 sobre la vista, origen arriba-izquierda del DOM. */
  rect: NormalizedRect;
};

export type SignOptions = {
  /** PNG en data URL producido por el compositor de firma. */
  signaturePng: string;
  placement: SignaturePlacement;
};

/* ------------------------------------------------------------------ *
 * Firma con varios firmantes
 * ------------------------------------------------------------------ */

export type SignatureFieldType = "signature" | "initials";

export const SIGNATURE_FIELD_TYPES: readonly SignatureFieldType[] = [
  "signature",
  "initials",
] as const;

export type Signer = {
  /** Identificador estable para React keys y para enlazar los campos. */
  id: string;
  name: string;
  /** Hexadecimal de `SIGNER_COLORS`. */
  color: string;
};

/** Hueco reservado en el documento para un firmante concreto. */
export type SignatureField = {
  id: string;
  signerId: string;
  pageIndex: number;
  type: SignatureFieldType;
  /** Rectangulo 0..1 sobre la vista, origen arriba-izquierda del DOM. */
  rect: NormalizedRect;
};

/**
 * Paleta fija con la que se distinguen los campos de cada firmante sobre
 * la vista previa. No son tokens del tema: son datos que viajan en el
 * estado y se pintan en linea, igual que `INK_COLORS`.
 */
export const SIGNER_COLORS = [
  "#0d4bff",
  "#0f9d68",
  "#e11d48",
  "#f59e0b",
  "#8b5cf6",
  "#0ea5e9",
] as const;

export function signerColorAt(index: number): string {
  const size = SIGNER_COLORS.length;
  return SIGNER_COLORS[((index % size) + size) % size];
}

/**
 * Nombre a mostrar para un firmante: el propio nombre si escribio algo, o
 * el generico ("Firmante N") si el campo esta vacio (ahora es el estado
 * inicial real, no solo un valor precargado que el usuario tenia que
 * borrar). Centraliza el fallback `name || defaultSignerName(...)` que
 * antes se repetia en cada sitio que mostraba el nombre.
 */
export function signerDisplayName(
  name: string,
  index: number,
  defaultSignerName: (position: number) => string,
): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : defaultSignerName(index + 1);
}

/** Marcas diacriticas combinantes U+0300..U+036F (igual que `core.ts:slugify`). */
const FIELD_LABEL_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

/**
 * Clave de indexado para el historial de valores e reutilizacion entre
 * documentos: "Cliente/Asegurado:" -> "cliente asegurado". Dos campos con
 * la misma etiqueta (en distintos documentos) comparten la misma clave
 * aunque difieran en mayusculas, acentos o puntuacion.
 */
export function normalizeFieldLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(FIELD_LABEL_DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Prefijo de nombre de archivo a partir de los nombres de los firmantes,
 * p.ej. `["Ana Perez", "Luis Gomez"]` -> `"ana-perez_and_luis-gomez"`. Un
 * firmante sin nombre (o solo espacios) se OMITE del prefijo en vez de
 * rellenarse con un generico "firmante-N" -- un nombre de archivo con un
 * marcador feo es peor que uno mas corto. Si no queda ningun nombre
 * usable devuelve `null`: quien llama no debe ofrecer el prefijo en ese
 * caso. Cada nombre pasa por `slugify()` (guiones, sin acentos); varios
 * nombres se unen con "_and_" para que el separador entre PERSONAS se
 * distinga del separador entre PALABRAS de un mismo nombre.
 */
export function buildSignerFilenamePrefix(
  names: readonly string[],
): string | null {
  const slugs = names
    .map((name) => slugify(name))
    .filter((slug) => slug.length > 0);
  if (slugs.length === 0) return null;
  if (slugs.length === 1) return slugs[0];
  const last = slugs[slugs.length - 1];
  const rest = slugs.slice(0, -1);
  return `${rest.join("_")}_and_${last}`;
}

/** Hueco reservado para una firma/inicial (imagen) empotrada por `signPdfMulti`. */
export type ImageSignPlacement = {
  kind: "image";
  /** PNG ya decodificado; el motor no toca `window`. */
  png: Uint8Array;
  pageIndex: number;
  /** Rectangulo 0..1 sobre la vista, origen arriba-izquierda del DOM. */
  rect: NormalizedRect;
};

/**
 * Hueco reservado para un campo de texto (nombre, fecha, numero de
 * poliza...). A diferencia de la imagen, el valor es un string propio de
 * cada hueco: no encaja en `CaptureMap` (un trazo por firmante reusado en
 * todos sus huecos del mismo tipo), por eso vive en su propio mapa
 * `Record<fieldId, string>` en la interfaz (ver `DocumentCanvas.tsx`).
 */
export type TextSignPlacement = {
  kind: "text";
  value: string;
  pageIndex: number;
  /** Rectangulo 0..1 sobre la vista, origen arriba-izquierda del DOM. */
  rect: NormalizedRect;
  /** Ausente = "left" (comportamiento de siempre). "center" es para una casilla marcada ("X"), que se veria pegada al borde si no. */
  align?: "left" | "center";
};

export type SignPlacement = ImageSignPlacement | TextSignPlacement;

/**
 * Pagina final OPCIONAL «Registro de firmas» (apagada por defecto: sin ella el PDF firmado tiene exactamente las
 * paginas del original). Lleva el hash del documento YA firmado (todos los `placements` aplicados, pero antes de
 * anadir esta misma pagina -- poner el hash de una pagina que se incluye a si misma no tendria sentido), la fecha y la
 * lista de firmantes. Trazabilidad informal (se puede volver a calcular el hash y compararlo a mano), NUNCA una firma
 * electronica certificada -- por eso el texto lo deja explicito (`labels.notice` y `labels.disclaimer`).
 *
 * Los textos llegan ya resueltos en el idioma activo: este motor no
 * importa `strings.ts` (es UI), igual que el resto de `sign.ts`.
 */
export type SignCertificateInfo = {
  signerNames: readonly string[];
  labels: {
    title: string;
    /** Frase bajo el titulo: «No es una firma certificada: solo registra quien firmo y cuando». */
    notice?: string;
    hashLabel: string;
    timestampLabel: string;
    signersLabel: string;
    noSignerName: string;
    disclaimer: string;
  };
};

export type SignMultiOptions = {
  placements: readonly SignPlacement[];
  certificate?: SignCertificateInfo;
};

/** Productor y palabra clave que dejan los PDF firmados (sin nombres de firmantes ni ningun dato personal). */
export const SIGNED_PDF_PRODUCER = "OptimusPDF";
export const SIGNED_PDF_KEYWORD = "optimuspdf-signed";

/**
 * Metadatos del PDF firmado: `Producer`, `ModDate` (ahora) y la palabra clave `optimuspdf-signed` cuando se estampo
 * alguna firma (imagen). Sustituye a la hoja de certificado como rastro por defecto: nada de nombres ni de datos
 * personales, solo que OptimusPDF toco el archivo y cuando. Las palabras clave que ya traia el PDF se conservan.
 */
function stampSignedMetadata(document: PDFDocument, signed: boolean): void {
  document.setProducer(SIGNED_PDF_PRODUCER);
  document.setModificationDate(new Date());
  if (!signed) return;
  const existing = (document.getKeywords() ?? "").trim();
  const tokens = existing.split(/[\s,;]+/).filter(Boolean);
  if (tokens.includes(SIGNED_PDF_KEYWORD)) return;
  document.setKeywords(existing === "" ? [SIGNED_PDF_KEYWORD] : [existing, SIGNED_PDF_KEYWORD]);
}

/** Cuerpo maximo de letra para un campo de texto, antes de encajar. */
const MAX_TEXT_FIELD_FONT_SIZE = 24;

/**
 * Encaja `value` dentro de `maxWidth`x`maxHeight` (puntos PDF), encogiendo
 * el cuerpo de letra hasta que quepa. Reusa `wrapText` de `editPdf.ts`
 * (el mismo reparto en lineas que ya usa el editor) en vez de inventar
 * otra medida de texto: aqui solo se anade la busqueda del cuerpo que
 * hace caber el bloque completo en el alto disponible.
 */
function fitTextToRect(
  font: PDFFont,
  value: string,
  maxWidth: number,
  maxHeight: number,
): { size: number; lines: string[] } {
  let size = Math.min(
    MAX_TEXT_FIELD_FONT_SIZE,
    Math.max(MIN_FONT_SIZE, maxHeight / LINE_HEIGHT_FACTOR),
  );
  let lines = wrapText(font, value, size, maxWidth);

  while (
    lines.length * size * LINE_HEIGHT_FACTOR > maxHeight &&
    size > MIN_FONT_SIZE
  ) {
    size = Math.max(MIN_FONT_SIZE, size - 1);
    lines = wrapText(font, value, size, maxWidth);
  }

  // Ni con el cuerpo minimo cabe todo: se recorta el bloque en vez de
  // desbordar la pagina, para que un valor demasiado largo nunca
  // corrompa el resto del contenido.
  const maxLines = Math.max(1, Math.floor(maxHeight / (size * LINE_HEIGHT_FACTOR)));
  return { size, lines: lines.slice(0, maxLines) };
}

/** Empotra un campo de texto encajado en su hueco, centrado en vertical. */
function drawTextPlacement(
  page: PDFPage,
  geometry: PageGeometry,
  placement: TextSignPlacement,
  font: PDFFont,
): void {
  const rect = placement.rect;
  const maxWidth = Math.max(1, rect.width * geometry.viewWidth);
  const maxHeight = Math.max(1, rect.height * geometry.viewHeight);
  const value = placement.value.trim();
  if (value.length === 0) return;

  const { size, lines } = fitTextToRect(font, value, maxWidth, maxHeight);
  if (lines.length === 0 || lines.every((line) => line.length === 0)) return;

  const lineHeight = size * LINE_HEIGHT_FACTOR;
  const blockHeight = lines.length * lineHeight;
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = Math.max(0, font.heightAtSize(size) - ascent);
  const baselineFromLineTop = (lineHeight - (ascent + descent)) / 2 + ascent;

  const color = hexToPdfColor("#000000");
  const angle = geometry.rotation;
  const left = rect.x * geometry.viewWidth;
  // Bloque centrado en vertical dentro del hueco, igual que la firma en imagen.
  const top = rect.y * geometry.viewHeight + (maxHeight - blockHeight) / 2;

  lines.forEach((line, index) => {
    if (line.length === 0) return;
    const fromTop = top + index * lineHeight + baselineFromLineTop;
    const lineLeft =
      placement.align === "center"
        ? rect.x * geometry.viewWidth +
          (maxWidth - font.widthOfTextAtSize(line, size)) / 2
        : left;
    const origin = viewPointToUser(geometry, lineLeft, geometry.viewHeight - fromTop);
    page.drawText(line, {
      x: origin.x,
      y: origin.y,
      size,
      font,
      color,
      rotate: degrees(angle),
    });
  });
}

/**
 * Anade la pagina final «Registro de firmas» con el hash del documento (ya
 * firmado, sin contar esta pagina), la fecha y los firmantes. Mismo tamaño
 * que la ultima pagina del documento, para que no desentone.
 */
async function appendCertificatePage(
  document: PDFDocument,
  info: SignCertificateInfo,
  hash: string,
): Promise<void> {
  const pages = document.getPages();
  const { width, height } =
    pages.length > 0 ? pages[pages.length - 1].getSize() : { width: 612, height: 792 };
  const page = document.addPage([width, height]);

  const titleFont = await document.embedFont(
    standardFontFor("helvetica", true, false),
  );
  const bodyFont = await document.embedFont(
    standardFontFor("helvetica", false, false),
  );
  const monoFont = await document.embedFont(
    standardFontFor("courier", false, false),
  );

  const margin = Math.min(72, width * 0.1);
  const maxWidth = width - margin * 2;
  const black = hexToPdfColor("#000000");
  const gray = hexToPdfColor("#555555");

  let cursorY = height - margin;
  const drawLine = (
    text: string,
    font: PDFFont,
    size: number,
    color = black,
    gap = size * 1.4,
  ) => {
    page.drawText(text, { x: margin, y: cursorY - size, size, font, color });
    cursorY -= gap;
  };

  drawLine(info.labels.title, titleFont, 18, black, info.labels.notice ? 26 : 34);
  if (info.labels.notice) {
    for (const line of wrapText(bodyFont, info.labels.notice, 11, maxWidth)) {
      drawLine(line, bodyFont, 11, gray, 16);
    }
    cursorY -= 8;
  }
  cursorY -= 10;

  drawLine(info.labels.timestampLabel, bodyFont, 11, gray, 16);
  drawLine(new Date().toLocaleString(), bodyFont, 12, black, 26);

  drawLine(info.labels.hashLabel, bodyFont, 11, gray, 16);
  for (const line of wrapText(monoFont, hash, 10, maxWidth)) {
    drawLine(line, monoFont, 10, black, 14);
  }
  cursorY -= 12;

  drawLine(info.labels.signersLabel, bodyFont, 11, gray, 16);
  const names =
    info.signerNames.length > 0 ? info.signerNames : [info.labels.noSignerName];
  for (const name of names) {
    drawLine(`• ${name.trim() || info.labels.noSignerName}`, bodyFont, 12, black, 18);
  }
  cursorY -= 16;

  for (const line of wrapText(bodyFont, info.labels.disclaimer, 9, maxWidth)) {
    drawLine(line, bodyFont, 9, gray, 13);
  }
}

/** Convierte un data URL base64 en bytes, sin pasar por la red. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.startsWith("data:")) {
    throw new PdfError("invalidType");
  }
  const binary = window.atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Empotra una firma por cada colocacion recibida. La geometria es la
 * misma que comparten `editPdf.ts`, `crop.ts` y `watermark.ts`: aqui solo
 * se itera.
 */
export async function signPdfMulti(
  file: File,
  params: SignMultiOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  try {
    const placements = params.placements;
    if (placements.length === 0) throw new PdfError("empty");

    const document = await loadPdf(file);
    onProgress?.(0.15);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    // Solo se empotra si de verdad hace falta: la ronda de solo-imagenes
    // (la de siempre) no paga el coste de una fuente que no usa.
    let textFont: PDFFont | null = null;

    for (let position = 0; position < placements.length; position += 1) {
      const placement = placements[position];
      const index = Math.min(
        Math.max(0, placement.pageIndex),
        pages.length - 1,
      );
      const page = pages[index];
      const geometry = getPageGeometry(page);

      if (placement.kind === "text") {
        if (!textFont) {
          textFont = await document.embedFont(
            standardFontFor("helvetica", false, false),
          );
        }
        drawTextPlacement(page, geometry, placement, textFont);
        onProgress?.(
          scaleProgress((position + 1) / placements.length, 0.15, 0.85),
        );
        continue;
      }

      const image = await document.embedPng(placement.png);

      const rect = placement.rect;
      const maxWidth = Math.max(4, rect.width * geometry.viewWidth);
      const maxHeight = Math.max(4, rect.height * geometry.viewHeight);
      // El hueco reservado no tiene por que tener la proporcion del trazo
      // que acaba dentro: se encaja centrado en vez de deformarlo.
      const fit = Math.min(maxWidth / image.width, maxHeight / image.height);
      const width = image.width * fit;
      const height = image.height * fit;

      // El DOM mide desde arriba; el espacio de vista, desde abajo.
      const vx = (rect.x + rect.width / 2) * geometry.viewWidth;
      const vy =
        geometry.viewHeight - (rect.y + rect.height / 2) * geometry.viewHeight;

      const center = viewPointToUser(geometry, vx, vy);
      // Se compensa el `/Rotate` para que la firma se vea recta en pantalla.
      const angle = geometry.rotation;
      const origin = originForCenter(
        center.x,
        center.y,
        width,
        height,
        0,
        angle,
      );

      page.drawImage(image, {
        x: origin.x,
        y: origin.y,
        width,
        height,
        rotate: degrees(angle),
      });
      onProgress?.(
        scaleProgress((position + 1) / placements.length, 0.15, 0.85),
      );
    }

    // Rastro por defecto: solo metadatos, antes del hash para que el documento que se resume sea el definitivo.
    stampSignedMetadata(
      document,
      placements.some((placement) => placement.kind === "image"),
    );

    if (params.certificate) {
      // El hash es del documento YA firmado (placements aplicados), pero
      // ANTES de anadir esta misma pagina -- certificar el hash de una
      // pagina que se certifica a si misma no tendria sentido.
      const signedBytes = await document.save({ useObjectStreams: true });
      const hash = await sha256Hex(signedBytes);
      await appendCertificatePage(document, params.certificate, hash);
    }

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}

export async function signPdf(
  file: File,
  options: SignOptions,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (!options.signaturePng) throw new PdfError("empty");
  return signPdfMulti(
    file,
    {
      placements: [
        {
          kind: "image",
          png: dataUrlToBytes(options.signaturePng),
          pageIndex: options.placement.pageIndex,
          rect: options.placement.rect,
        },
      ],
    },
    onProgress,
  );
}
