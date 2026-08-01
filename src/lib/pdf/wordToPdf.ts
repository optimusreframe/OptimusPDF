import type { Content } from "pdfmake";
import {
  MAX_DECOMPRESSED_OFFICE_BYTES,
  PdfError,
  estimateZipUncompressedBytes,
  findUnsupportedGlyph,
  isLegacyOleOfficeFile,
  isOoxmlZipFile,
  loadPdfMake,
  looksLikeEncryptedOoxml,
  readFileBytes,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor "Word (DOCX) -> PDF".
 *
 * A diferencia de `htmlToPdf.ts` (que rasteriza una captura visual), aqui
 * el PDF final lleva texto real y seleccionable. La cadena es:
 *
 *   1. `mammoth`         - DOCX -> HTML semantico.
 *   2. `html-to-pdfmake` - HTML -> arbol de contenido que entiende pdfmake
 *                          (parrafos, negritas, listas...), no imagenes.
 *   3. `pdfmake`         - arbol de contenido -> PDF.
 *
 * Las tres librerias se cargan con `import()` dentro de la funcion, igual
 * que `htmlToPdf.ts` hace con `html2canvas`/`jspdf`: son pesadas y solo
 * hace falta bajarlas cuando el usuario realmente convierte un archivo.
 * Todo ocurre en el navegador: ningun byte del documento sale del
 * dispositivo.
 *
 * `html-to-pdfmake` no trae tipos publicados en npm y `node_modules/html-
 * to-pdfmake` ya resuelve a un modulo JS real (sin `.d.ts`): TypeScript no
 * deja "aumentarlo" con `declare module "html-to-pdfmake" { ... }` (error
 * TS2665, reservado para modulos realmente ausentes). Se tipa en el sitio
 * de uso con una unica aserccion en vez de anadir un `.d.ts` nuevo al repo.
 */
type HtmlToPdfmakeFn = (
  html: string,
  options?: { window: Window },
) => Content;

export type WordPageSize = "a4" | "letter";
export type WordOrientation = "portrait" | "landscape";
export type WordMargin = "none" | "small" | "large";

export type WordToPdfOptions = {
  pageSize: WordPageSize;
  orientation: WordOrientation;
  margin: WordMargin;
};

export const DEFAULT_WORD_TO_PDF_OPTIONS: WordToPdfOptions = {
  pageSize: "a4",
  orientation: "portrait",
  margin: "small",
};

/** Mismos nombres que espera `pdfmake` para los tamanos estandar. */
const PAGE_SIZE_NAMES: Record<WordPageSize, "A4" | "LETTER"> = {
  a4: "A4",
  letter: "LETTER",
};

/**
 * Mismos valores en puntos que `MARGINS_PT` en `htmlToPdf.ts`, para que
 * "sin margen"/"pequeno"/"grande" signifiquen lo mismo en toda la app.
 */
const MARGINS_PT: Record<WordMargin, number> = {
  none: 0,
  small: 36,
  large: 64,
};

/** Placeholder para una imagen que pdfmake no puede dibujar (ver mas abajo). */
const UNSUPPORTED_IMAGE_PLACEHOLDER = {
  text: "[Imagen no compatible omitida]",
  italics: true,
  color: "#888888",
} as const;

/** Tipos MIME de imagen que `pdfmake` sabe dibujar (ver `DocMeasure.js`). */
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Tope de columnas que una sola fila puede declarar. Una tabla de Word
 * hecha a mano por una persona nunca se acerca a esto; existe para atajar
 * un `<w:gridSpan w:val="...">` (o `colspan` equivalente) manipulado a
 * mano en el XML, que `mammoth` vuelca sin validar y `html-to-pdfmake`
 * expande a un objeto-marcador de posicion POR CADA COLUMNA abarcada
 * antes de que este archivo vea el resultado (ver `MAX_TABLE_CELLS` mas
 * abajo para el porque de fondo).
 */
const MAX_TABLE_ROW_CELLS = 500;

/**
 * Tope del total de celdas (filas x columna mas ancha) de una sola
 * tabla, mismo orden de magnitud que `MAX_TABLE_CELLS` en el
 * `excelToPdf.ts` hermano (constante local, no compartida: solo esta
 * ruta de conversion necesita este calculo hoy). Un `gridSpan` con un
 * valor absurdo (decenas de miles, sin limite superior real dado que un
 * XML de unos pocos KB puede declararlo) hace que `html-to-pdfmake`
 * materialice esa misma cantidad de celdas en una sola fila ANTES de que
 * `padRaggedTableBody` (mas abajo) llegue a rellenar filas desiguales:
 * confirmado que un .docx de ~26 KB con un span de 50.000 basta para
 * producir una fila de pdfmake con 50.000 celdas, forzando una
 * asignacion sincrona masiva capaz de congelar o tumbar la pestana antes
 * de que `pdfmake.createPdf()` llegue siquiera a intentarlo. Se rechaza
 * aqui con un `PdfError("tooLarge")` limpio en vez de dejar que ese
 * costo se materialice.
 */
const MAX_TABLE_CELLS = 200_000;

/** Extrae el tipo MIME de un `data:` URI, o `null` si no tiene esa forma. */
function dataUriMimeType(uri: string): string | null {
  const match = /^data:([^;,]+)/i.exec(uri);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Rellena con celdas vacias cualquier fila mas corta que la mas ancha de
 * la tabla. Devuelve `null` si la tabla no tiene ninguna fila utilizable
 * (cuerpo vacio o ausente): quien llama debe omitir el nodo entero en ese
 * caso en vez de dejarlo pasar a pdfmake.
 *
 * `html-to-pdfmake` no rellena filas desiguales por su cuenta, y el
 * renderizador de tablas de pdfmake exige que todas las filas tengan el
 * mismo numero de celdas ("Malformed table row, a cell is undefined."),
 * lo que aborta la conversion ENTERA aunque el resto del documento este
 * bien -- tipico de tablas de Word con celdas combinadas/divididas.
 */
function padRaggedTableBody(body: unknown): unknown[][] | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const rows = body.map((row) => (Array.isArray(row) ? row : []));

  // Ancho de la fila mas ancha, calculado con un bucle manual en vez de
  // `Math.max(...rows.map((row) => row.length))`: repartir un array como
  // argumentos individuales de una funcion tiene un limite de la pila de
  // llamadas del motor de JS, y una tabla de Word con ~125.000 filas o
  // mas (confirmado empiricamente contra la version anterior de esta
  // misma linea) lo excede con un "RangeError: Maximum call stack size
  // exceeded" -- un documento por lo demas valido terminaria como un
  // `PdfError("unknown")` sin tipar en vez de convertirse con exito o
  // rechazarse con un mensaje que explique el porque. Tambien se
  // aprovecha esta misma pasada para exigir el tope de columnas por fila
  // (`MAX_TABLE_ROW_CELLS`, ver defecto de `gridSpan`/`colspan`
  // desmesurado mas arriba) antes de construir nada mas grande.
  let width = 0;
  for (const row of rows) {
    if (row.length > MAX_TABLE_ROW_CELLS) throw new PdfError("tooLarge");
    if (row.length > width) width = row.length;
  }
  if (width === 0) return null;

  // Tope del total de celdas de la tabla (filas x columna mas ancha):
  // ver `MAX_TABLE_CELLS` mas arriba. Se comprueba ANTES de construir el
  // cuerpo relleno (la linea de abajo ya materializaria esa misma
  // cantidad de celdas), para no hacer el trabajo costoso que se
  // pretende evitar antes de rechazar.
  if (rows.length * width > MAX_TABLE_CELLS) throw new PdfError("tooLarge");

  return rows.map((row) =>
    row.length >= width
      ? row
      : [
          ...row,
          ...Array.from({ length: width - row.length }, () => ({ text: "" })),
        ],
  );
}

/**
 * Recorre el arbol de contenido que produce `html-to-pdfmake` (una mezcla
 * de objetos y arrays sin un tipo recursivo publico -- de ahi `unknown`)
 * arreglando dos formas en las que puede abortar la conversion entera de
 * un documento por lo demas valido:
 *
 *  - Tablas con filas de distinto largo (ver `padRaggedTableBody`); una
 *    tabla sin filas utilizables se omite del arbol resultante.
 *  - Imagenes en un formato que pdfmake no reconoce (solo acepta
 *    `data:image/jpeg` y `data:image/png`; Word puede incrustar GIF/BMP/
 *    TIFF/SVG/EMF/WMF -- este ultimo es lo que genera al pegar graficos/
 *    SmartArt/ecuaciones). pdfmake lanza "Invalid image: ..." y aborta
 *    todo el documento; aqui se sustituyen por un texto de aviso.
 *
 * Devuelve un arbol nuevo (no muta `content`) para no depender de la
 * forma exacta en que cada libreria construyo sus objetos.
 *
 * Se exporta unicamente para poder probarla de forma directa/unitaria
 * (`wordToPdf.test.ts`) en los casos donde construir un `.docx` real que
 * dispare la condicion exacta (tabla vacia, imagen no soportada) es
 * impractico con la API de alto nivel del paquete `docx`.
 */
export function sanitizePdfmakeContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    const mapped = content.map((child) => sanitizePdfmakeContent(child));
    return mapped.filter((child) => child !== undefined);
  }
  if (!isRecord(content)) return content;

  if (isRecord(content.table)) {
    const paddedBody = padRaggedTableBody(content.table.body);
    if (paddedBody === null) return undefined; // tabla vacia/malformada: se omite
    const sanitizedBody = paddedBody.map((row) =>
      (row as unknown[]).map((cell) => sanitizePdfmakeContent(cell)),
    );
    return {
      ...content,
      table: { ...content.table, body: sanitizedBody },
    };
  }

  if (typeof content.image === "string") {
    const mimeType = dataUriMimeType(content.image);
    if (mimeType !== null && !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      return { ...UNSUPPORTED_IMAGE_PLACEHOLDER };
    }
    return content;
  }

  const result: UnknownRecord = {};
  for (const key of Object.keys(content)) {
    result[key] = sanitizePdfmakeContent(content[key]);
  }
  return result;
}

/**
 * Convierte un archivo DOCX en PDF con texto nativo seleccionable.
 *
 * El formato legado `.doc` (OLE2, Office 97-2003) se rechaza de forma
 * explicita ANTES de intentar parsear: ninguna libreria permisiva de esta
 * fase sabe leerlo, y dejar que `mammoth` fallase por su cuenta solo
 * daria un error generico en vez de uno que explique el porque.
 */
export async function wordToPdf(
  file: File,
  options: WordToPdfOptions = DEFAULT_WORD_TO_PDF_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  try {
    throwIfAborted(signal);
    const bytes = await readFileBytes(file);
    if (bytes.byteLength === 0) throw new PdfError("empty");

    if (isLegacyOleOfficeFile(bytes)) {
      // Un .docx moderno protegido con contrasena TAMBIEN cumple la firma
      // OLE2 (envuelve el paquete OOXML cifrado). Hay que descartar ese
      // caso ANTES de asumir que es de verdad el formato legado: si no, un
      // archivo cifrado real se rechaza con el mensaje equivocado.
      if (looksLikeEncryptedOoxml(bytes)) throw new PdfError("encrypted");
      throw new PdfError("legacyOfficeFormat");
    }
    if (!isOoxmlZipFile(bytes)) throw new PdfError("corrupt");

    // Estimacion barata (solo directorio central del ZIP, sin inflar nada)
    // del total descomprimido. Corta una bomba de descompresion (.docx
    // diminuto cuyo XML interno se expande a cientos de MB) antes de que
    // llegue al parser de `mammoth`. `null` significa "no se pudo verificar
    // con confianza" (p.ej. ZIP64): en ese caso se sigue adelante, no se
    // bloquea sobre una estimacion inconclusa.
    const estimatedBytes = estimateZipUncompressedBytes(bytes);
    if (
      estimatedBytes !== null &&
      estimatedBytes > MAX_DECOMPRESSED_OFFICE_BYTES
    ) {
      throw new PdfError("tooLarge");
    }

    onProgress?.(0.2);
    throwIfAborted(signal);

    const [{ default: mammoth }, pdfMake] = await Promise.all([
      import("mammoth"),
      loadPdfMake(),
    ]);
    // @ts-expect-error -- "html-to-pdfmake" no trae tipos publicados en npm.
    const htmlToPdfmakeModule = await import("html-to-pdfmake");
    const htmlToPdfmake = (
      htmlToPdfmakeModule as unknown as { default: HtmlToPdfmakeFn }
    ).default;
    throwIfAborted(signal);

    let html: string;
    try {
      // `mammoth` resuelve por `package.json#browser` a una implementacion
      // distinta segun el entorno: el bundle de navegador (el que usa
      // Next.js en el cliente) solo mira `arrayBuffer`; la version de
      // Node (la que corre este mismo motor bajo Vitest, sin bundler de
      // por medio) solo mira `buffer`. Se aportan ambas claves -- las dos
      // apuntan a los mismos bytes -- para que cualquiera de las dos
      // implementaciones encuentre la que sabe leer.
      const input: Record<string, unknown> = {
        arrayBuffer: bytes.buffer as ArrayBuffer,
      };
      if (typeof Buffer !== "undefined") {
        input.buffer = Buffer.from(bytes);
      }
      const result = await mammoth.convertToHtml(
        input as unknown as Parameters<typeof mammoth.convertToHtml>[0],
      );
      html = result.value;
    } catch (error) {
      throw error instanceof PdfError ? error : toPdfError(error);
    }

    // Roboto (unica fuente que trae pdfmake) no puede dibujar CJK/hangul/
    // arabe/hebreo/tailandes/devanagari/la mayoria de emoji: los dibujaria
    // como glifos en blanco, sin lanzar ningun error, destruyendo ese
    // contenido en silencio. Se rechaza con honestidad antes de seguir.
    const plainText = html.replace(/<[^>]*>/g, " ");
    if (findUnsupportedGlyph(plainText) !== null) {
      throw new PdfError("unsupportedScript");
    }

    onProgress?.(0.5);
    throwIfAborted(signal);

    const content = sanitizePdfmakeContent(
      htmlToPdfmake(html, { window }),
    ) as Content;
    throwIfAborted(signal);

    const docDefinition = {
      content,
      pageSize: PAGE_SIZE_NAMES[options.pageSize],
      pageOrientation: options.orientation,
      pageMargins: MARGINS_PT[options.margin],
      defaultStyle: { font: "Roboto" },
    };

    throwIfAborted(signal);
    const blob = await pdfMake.createPdf(docDefinition).getBlob();
    onProgress?.(0.9);

    throwIfAborted(signal);
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
