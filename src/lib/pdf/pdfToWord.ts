import {
  Document,
  HeadingLevel,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import {
  MAX_TABLE_CELLS,
  PdfError,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
  extractDocumentBlocks,
  type DocBlock,
} from "@/lib/pdf/pdfToMarkdown";

/**
 * Motor "PDF -> Word (DOCX)".
 *
 * A diferencia de `wordToPdf.ts` (que dibuja un PDF con pdfmake a partir
 * de tamano de pagina/orientacion/margen explicitos), aqui Word reflowea
 * el contenido el mismo al abrir el documento: no hay ningun parametro de
 * pagina que configurar, asi que `PdfToWordOptions` esta deliberadamente
 * vacio (mismo patron que `repair-pdf` usa para su `ToolShell<Record<string,
 * never>>` cuando una herramienta no tiene opciones reales).
 *
 * La extraccion reutiliza `extractDocumentBlocks` de `pdfToMarkdown.ts`
 * (fundacion ya cerrada de este workstream): da los mismos `DocBlock[]`
 * que consumiria un renderer Markdown, pero sin pasar por texto plano, asi
 * que aqui solo hace falta mapear cada bloque a los nodos de `docx`
 * equivalentes.
 */

export type PdfToWordOptions = Record<string, never>;

export const DEFAULT_PDF_TO_WORD_OPTIONS: PdfToWordOptions = {};

/**
 * Sangria por nivel de lista, en veinteavos de punto (unidad nativa de
 * `indent` en `docx`): 720 = media pulgada, mismo valor que documenta el
 * spec de este workstream.
 */
const LIST_INDENT_UNIT = 720;

const HEADING_LEVELS: Record<1 | 2 | 3, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
};

/**
 * Tope de caracteres totales (suma de heading.text + paragraph.text + cada
 * item.text de list + cada celda de table + cada linea de codeBlock) que
 * esta app esta dispuesta a materializar en un arbol de nodos `docx` antes
 * de rechazar la conversion con `PdfError("tooLarge")`.
 *
 * 5.000.000 de caracteres es varias veces el volumen de texto de un
 * documento de oficina real grande (un libro completo ronda 1-2 millones
 * de caracteres), asi que no estorba a ningun caso legitimo, pero corta un
 * PDF patologico con paginas de texto denso repetidas antes de que
 * `docx`/`Packer.toBlob` intenten construir y empaquetar el arbol completo
 * en memoria -- esta app es 100% client-side, sin backend que absorba el
 * pico.
 */
const MAX_DOCUMENT_CHARACTERS = 5_000_000;

/**
 * Limites de code UNIT (no code POINT) usados por `sanitizeXmlText` para
 * decidir si un caracter esta directamente prohibido por XML 1.0 en
 * contenido. Se expresan como literales hex planos (`0x09`, nunca un
 * escape `\u`/caracter de control literal en el codigo fuente): son
 * justo el tipo de byte que esta funcion existe para eliminar del
 * documento generado, asi que no deben aparecer crudos aqui tampoco.
 */
const TAB_CODE = 0x09;
const LF_CODE = 0x0a;
const CR_CODE = 0x0d;
const C0_MAX_CODE = 0x1f;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;
/**
 * XML 1.0 excluye expresamente estos dos "noncharacters" de su produccion
 * `Char` (ademas de los controles C0 y los surrogates sueltos que ya
 * cubre `isDisallowedControlOrDel`/`isHighSurrogate`/`isLowSurrogate`) --
 * ver W3C XML 1.0 #2.2. DEL (0x7F) NO va en esta lista: XML 1.0 si lo
 * permite (esta dentro del rango [#x20-#xD7FF]), a diferencia de lo que
 * una version anterior de este saneador asumia por error.
 */
const NONCHARACTER_FFFE = 0xfffe;
const NONCHARACTER_FFFF = 0xffff;

function isDisallowedControl(code: number): boolean {
  if (code === TAB_CODE || code === LF_CODE || code === CR_CODE) return false;
  if (code <= C0_MAX_CODE) return true;
  return code === NONCHARACTER_FFFE || code === NONCHARACTER_FFFF;
}

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/**
 * Elimina de `text` los caracteres que XML 1.0 no permite incluir crudos en
 * un documento. `docx` ya escapa `<`, `>` y `&` por su cuenta (metacaracteres
 * XML), pero eso no basta: NUL, la mayoria de controles C0, DEL, y
 * surrogates UTF-16 sueltos siguen siendo bytes ilegales dentro de
 * `word/document.xml` aunque esten escapados de otra forma, y algunos
 * lectores (Word incluido) reparan o rechazan el archivo al encontrarlos:
 * NUL y los demas controles C0 (salvo tab/LF/CR), surrogates UTF-16
 * sueltos, y los "noncharacters" U+FFFE/U+FFFF. DEL (U+007F) SI esta
 * permitido por XML 1.0 (dentro de [#x20-#xD7FF]) y no se elimina.
 *
 * Recorre `text` por code UNIT (no por code point, `Array.from` habria
 * agrupado surrogates sueltos de forma impredecible) para poder distinguir
 * un surrogate suelto (invalido, se elimina) de un par high+low consecutivo
 * valido (un emoji, CJK extendido, etc. -- se preserva intacto tal cual):
 * un high surrogate solo sobrevive si el siguiente code unit es su low
 * surrogate correspondiente; un low surrogate que aparece sin haber sido ya
 * consumido como pareja de un high anterior esta, por definicion, suelto.
 *
 * Se aplica a TODO el texto de un `DocBlock` antes de construir cualquier
 * nodo `docx` (heading/paragraph/list/table/codeBlock) -- ver cada sitio de
 * uso en `blockToDocxNodes`.
 */
function sanitizeXmlText(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    if (isDisallowedControl(code)) continue;

    if (isHighSurrogate(code)) {
      const nextCode = i + 1 < text.length ? text.charCodeAt(i + 1) : undefined;
      if (nextCode !== undefined && isLowSurrogate(nextCode)) {
        result += text[i] + text[i + 1];
        i++; // Ya se consumio la pareja: no volver a evaluarla suelta.
        continue;
      }
      // Sin pareja valida: high surrogate suelto, se descarta.
      continue;
    }

    if (isLowSurrogate(code)) {
      // Un low surrogate que forma parte de un par valido ya se consumio
      // arriba junto a su high surrogate. Llegar aqui significa que esta
      // suelto (sin high surrogate precedente), asi que se descarta.
      continue;
    }

    result += text[i];
  }
  return result;
}

/**
 * Suma la longitud de texto de UN `DocBlock` (heading.text + paragraph.text
 * + cada item.text de list + cada celda de table + cada linea de
 * codeBlock). La usa `blocksToDocxChildren` para el presupuesto
 * `MAX_DOCUMENT_CHARACTERS` -- ver ahi.
 */
function blockTextLength(block: DocBlock): number {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return block.text.length;
    case "list":
      return block.items.reduce((sum, item) => sum + item.text.length, 0);
    case "table":
      return block.rows.reduce(
        (sum, row) => sum + row.reduce((rowSum, cell) => rowSum + cell.length, 0),
        0,
      );
    case "codeBlock":
      return block.lines.reduce((sum, line) => sum + line.length, 0);
    case "pageBreak":
      return 0;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

/**
 * Mapea UN `DocBlock` a los nodos de `docx` equivalentes. La mayoria de
 * bloques producen un unico nodo, pero `list` produce un `Paragraph` por
 * item y `codeBlock` un `Paragraph` por linea -- de ahi que la funcion
 * devuelva siempre un array, nunca un nodo suelto.
 *
 * `pageBreak` se traduce SIEMPRE a su propio `Paragraph` dedicado con
 * `PageBreak` como hijo, nunca a `pageBreakBefore` en el bloque siguiente:
 * si la pagina siguiente empieza con una tabla, `docx`'s `Table` no admite
 * esa propiedad, asi que ese atajo se rompe justo en el caso que mas
 * importa preservar.
 *
 * Todo el texto crudo del bloque pasa por `sanitizeXmlText` antes de
 * envolverse en un nodo `docx`: ver el comentario de esa funcion para el
 * porque (XML 1.0 prohibe ciertos caracteres que `docx` no filtra).
 */
function blockToDocxNodes(block: DocBlock): (Paragraph | Table)[] {
  switch (block.type) {
    case "heading":
      return [
        new Paragraph({
          heading: HEADING_LEVELS[block.level],
          children: [new TextRun(sanitizeXmlText(block.text))],
        }),
      ];

    case "paragraph":
      return [
        new Paragraph({
          children: [
            new TextRun({ text: sanitizeXmlText(block.text), bold: block.bold }),
          ],
        }),
      ];

    case "list":
      return block.items.map((item) => {
        const text = sanitizeXmlText(item.text);
        return item.ordered
          ? new Paragraph({
              children: [new TextRun(`${item.number}. ${text}`)],
              indent: { left: item.level * LIST_INDENT_UNIT },
            })
          : new Paragraph({
              text,
              bullet: { level: item.level },
              indent: { left: item.level * LIST_INDENT_UNIT },
            });
      });

    case "table":
      return [
        new Table({
          rows: block.rows.map(
            (row) =>
              new TableRow({
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: [new Paragraph(sanitizeXmlText(cell))],
                    }),
                ),
              }),
          ),
        }),
      ];

    case "codeBlock":
      // La sangria ya viene como espacios literales en cada linea (ver
      // `codeBlockLines` en `pdfToMarkdown.ts`): no se reprocesa aqui.
      return block.lines.map(
        (line) =>
          new Paragraph({
            children: [
              new TextRun({ text: sanitizeXmlText(line), font: "Consolas" }),
            ],
          }),
      );

    case "pageBreak":
      return [new Paragraph({ children: [new PageBreak()] })];

    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

/**
 * Mapea el documento entero (`DocBlock[]`) a la lista de hijos que espera
 * la seccion de un `Document` de `docx`.
 *
 * Dos presupuestos se aplican de forma ACUMULATIVA sobre TODO el documento
 * ANTES de mapear ningun bloque: sumar primero y lanzar
 * `PdfError("tooLarge")` si alguno excede evita construir el arbol de
 * nodos de `docx` a medias cuando el documento va a rechazarse de todas
 * formas.
 *
 *  - `MAX_TABLE_CELLS`: solo celdas de tabla (importado de `core.ts`,
 *    compartido con `wordToPdf.ts`/`excelToPdf.ts`).
 *  - `MAX_DOCUMENT_CHARACTERS`: TODO el texto del documento (heading +
 *    paragraph + items de list + celdas de table + lineas de codeBlock),
 *    para acotar tambien el volumen fuera de tablas -- parrafos/listas/
 *    codeBlocks no tenian ningun tope antes de este chequeo.
 *
 * Se exporta por separado de `pdfToWord` para poder probar el mapeo en
 * aislamiento (fixtures de `DocBlock[]` construidas a mano, sin pasar por
 * la extraccion real de un PDF).
 */
export function blocksToDocxChildren(blocks: DocBlock[]): (Paragraph | Table)[] {
  let totalCells = 0;
  let totalCharacters = 0;
  for (const block of blocks) {
    if (block.type === "table") {
      totalCells += block.rows.reduce((sum, row) => sum + row.length, 0);
    }
    totalCharacters += blockTextLength(block);
  }
  if (totalCells > MAX_TABLE_CELLS) throw new PdfError("tooLarge");
  if (totalCharacters > MAX_DOCUMENT_CHARACTERS) throw new PdfError("tooLarge");

  return blocks.flatMap(blockToDocxNodes);
}

/**
 * Convierte un PDF en un documento DOCX editable.
 *
 * Word reflowea el contenido: no hay tamano de pagina, orientacion ni
 * margen que preservar como en `wordToPdf.ts`, asi que `options` no tiene
 * campos reales hoy (ver `PdfToWordOptions`). Tampoco hace falta la
 * comprobacion de glifos de `findUnsupportedGlyph`/Roboto que usan
 * `wordToPdf.ts`/`excelToPdf.ts`: esa limitacion es propia del pipeline
 * `pdfmake` (direccion Office -> PDF); `docx` no incrusta fuentes propias,
 * Word dibuja con las fuentes del sistema al abrir el documento.
 */
export async function pdfToWord(
  file: File,
  options: PdfToWordOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  /** Aviso de una pagina cuyo OCR fallo, ya traducido al idioma de la interfaz. */
  ocrFailureMarker?: string,
): Promise<Blob> {
  try {
    throwIfAborted(signal);

    const { blocks } = await extractDocumentBlocks(
      file,
      DEFAULT_PDF_TO_MARKDOWN_OPTIONS,
      (value) => onProgress?.(value * 0.9),
      signal,
      ocrFailureMarker,
    );
    throwIfAborted(signal);

    const children = blocksToDocxChildren(blocks);
    const document = new Document({ sections: [{ children }] });

    // `Packer.toBlob` no es cancelable a mitad de camino: es una unica
    // llamada asincrona que serializa el documento completo de una vez.
    // Se comprueba `signal` justo antes de lanzarla (mejor esfuerzo), pero
    // una cancelacion durante el empaquetado en si no se puede abortar --
    // mismo criterio que ya usa este repo para `pdfMake.createPdf(...)
    // .getBlob()` en `wordToPdf.ts`.
    throwIfAborted(signal);
    const blob = await Packer.toBlob(document);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
