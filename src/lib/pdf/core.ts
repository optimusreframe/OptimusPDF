import {
  PDFDocument,
  EncryptedPDFError,
  StandardFonts,
  rgb,
  type Color,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

/**
 * Utilidades compartidas del motor PDF.
 *
 * Este modulo es puro (sin React) y se ejecuta siempre en el navegador:
 * ningun byte de los archivos del usuario sale del dispositivo.
 */

export const MAX_SAFE_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export type PdfErrorCode =
  | "encrypted"
  | "invalidType"
  | "corrupt"
  | "tooLarge"
  | "empty"
  | "needTwo"
  | "cancelled"
  | "unknown"
  | "wrongPassword"
  /** El documento no tiene ninguna proteccion que retirar. */
  | "notProtected"
  /** Cifrado por certificado digital (`/Adobe.PubSec`). */
  | "certificateEncryption"
  /** Manejador de seguridad distinto de `/Standard` que no reconocemos. */
  | "unsupportedSecurityHandler"
  /** La operacion invalida firmas y falta el consentimiento explicito. */
  | "consentRequired"
  /**
   * La estructura del documento no se pudo comprobar con seguridad
   * (referencia rota, tipo inesperado, arbol de campos sin terminar de
   * recorrer, u objetos invalidos tras descifrar). Nunca se interpreta
   * como "sin restriccion".
   */
  | "inspectionIncomplete"
  | "nothingSelected"
  /**
   * Un componente de la aplicacion (trozo de codigo de un motor, el worker de pdf.js) no se pudo descargar: sin
   * conexion o la red fallo. Distinto de «archivo danado»: el archivo esta bien, falta bajar una pieza una vez.
   */
  | "offline"
  /**
   * Fallo de red al descargar los activos de tesseract.js (worker/core/
   * traineddata) para el reconocimiento OCR. Distinto de "unknown": aqui
   * SI sabemos la causa probable (CDN inalcanzable, bloqueador de
   * anuncios, proxy corporativo) y se puede decir algo util.
   */
  | "ocrNetworkFailure"
  /**
   * El motor de OCR (tesseract.js) fallo por una razon que no parece de
   * red (crash del worker, error de tiempo de ejecucion de WASM...). Se
   * distingue de "ocrNetworkFailure" porque el consejo es distinto:
   * reintentar no suele ayudar si el problema es del propio motor.
   */
  | "ocrEngineFailure"
  /**
   * Fallo de red al descargar los pesos o el motor de un modelo WebLLM
   * (huggingface.co / raw.githubusercontent.com). Antes se bucketizaba
   * como "unknown" y la interfaz mostraba un mensaje de "falta de VRAM"
   * que no tenia nada que ver con la causa real.
   */
  | "modelDownloadFailure"
  /**
   * Perdida real del dispositivo WebGPU o falta de memoria de video
   * durante la carga o la inferencia. Es el UNICO caso en el que el
   * mensaje "prueba el modelo ligero" tiene sentido.
   */
  | "deviceLost"
  /**
   * El archivo es un formato binario OLE2 legado (.doc/.xls/.ppt de
   * Office 97-2003), no el contenedor OOXML moderno (.docx/.xlsx/.pptx).
   * Ninguna libreria permisiva (MIT/BSD) de esta fase sabe leer el
   * formato viejo, asi que se rechaza con honestidad en vez de fallar en
   * silencio o con un error generico.
   */
  | "legacyOfficeFormat"
  /**
   * El documento tiene texto en un alfabeto que la unica fuente que trae
   * pdfmake (Roboto) no puede dibujar (chino/japones/coreano/arabe/
   * hebreo/tailandes/emoji...). Sin esta deteccion, el PDF se generaria
   * "bien" pero con ese texto invisible: se prefiere rechazar con
   * honestidad antes que fingir una conversion que perderia contenido en
   * silencio.
   */
  | "unsupportedScript"
  /**
   * `pdf-to-excel` no encontro ninguna tabla que extraer: o el PDF no
   * tiene tablas de verdad, o sus paginas eran escaneadas y el motor
   * (a proposito) no intenta OCR para buscarlas — ver comentario junto a
   * `extractDocumentBlocks` en `pdfToExcel.ts`.
   */
  | "noTablesFound"
  /**
   * Un zip de configuracion de firma (exportado con `signConfig.ts`) no
   * es un zip valido, le falta `manifest.json`, su `version` no se
   * reconoce, o su contenido no pasa el type guard escrito a mano.
   */
  | "invalidConfig"
  /**
   * El archivo no tiene ningun byte (0 B). Lo asigna la comprobacion de la
   * entrada (`inputGuard.ts`): los motores siguen lanzando `corrupt` para un
   * archivo vacio, asi que el shell afina el codigo al ver el archivo.
   */
  | "emptyFile"
  /**
   * El contenido no es un PDF (no empieza por `%PDF-`): texto, una imagen
   * renombrada a .pdf, etc. Igual que `emptyFile`, lo asigna `inputGuard.ts`.
   */
  | "notPdf";

/** Error tipado del motor: la UI traduce `code` mediante i18n. */
export class PdfError extends Error {
  readonly code: PdfErrorCode;

  constructor(code: PdfErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PdfError";
    this.code = code;
  }
}

/**
 * Huellas de un PDF danado en los mensajes de pdf-lib y pdf.js. Un texto de
 * error de libreria nunca debe llegar a la persona usuaria como «Algo ha
 * fallado»: si el documento esta roto, se dice que esta roto.
 */
const CORRUPT_HINTS = [
  "invalid pdf",
  "no pdf header",
  "missing pdf header",
  "failed to parse",
  "invalid object ref",
  "invalid xref",
  "bad xref",
  "xref",
  "unexpected object",
  "unexpectedobjecterror",
  "pdfinvalidobjectparsingerror",
  "pdfparsingerror",
  "missingpdfheadererror",
  "invalidpdfexception",
  "missingpdfexception",
  "formaterror",
  "unexpected end of file",
  "unexpected eof",
  "reading 'pages'",
  "reading 'catalog'",
  "root object",
  // jszip (docx, xlsx, pptx): contenedor zip roto o truncado.
  "corrupted zip",
  "end of central directory",
  "not a zip",
] as const;

/** El navegador se quedo sin memoria al abrir o escribir un archivo enorme. */
const OUT_OF_MEMORY_HINTS = [
  "allocation failed",
  "invalid array length",
  "out of memory",
  "invalid typed array length",
] as const;

/** Fallos de CARGA de un trozo de codigo (`import()` dinamico, worker): la red, no el archivo. */
const CHUNK_LOAD_HINTS = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "loading chunk",
  "loading css chunk",
  "chunkloaderror",
  "setting up fake worker failed",
] as const;

/** Mensajes genericos de red: solo cuentan como «sin conexion» si el navegador dice que no hay red. */
const NETWORK_HINTS = ["failed to fetch", "networkerror", "load failed", "network error"] as const;

export function toPdfError(error: unknown): PdfError {
  if (error instanceof PdfError) return error;
  if (error instanceof EncryptedPDFError) return new PdfError("encrypted");
  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase();
    if (CHUNK_LOAD_HINTS.some((hint) => text.includes(hint))) return new PdfError("offline", error.message);
    if (
      typeof navigator !== "undefined" &&
      navigator.onLine === false &&
      NETWORK_HINTS.some((hint) => text.includes(hint))
    ) {
      return new PdfError("offline", error.message);
    }
    if (text.includes("password") || text.includes("encrypt")) {
      return new PdfError("encrypted", error.message);
    }
    if (OUT_OF_MEMORY_HINTS.some((hint) => text.includes(hint))) {
      return new PdfError("tooLarge", error.message);
    }
    if (CORRUPT_HINTS.some((hint) => text.includes(hint))) {
      return new PdfError("corrupt", error.message);
    }
    return new PdfError("unknown", error.message);
  }
  return new PdfError("unknown");
}

/**
 * Clasifica un fallo de tesseract.js (creacion de worker o reconocimiento)
 * en "ocrNetworkFailure" vs "ocrEngineFailure". Se usa en los motores que
 * ofrecen reserva de OCR (`pdfToMarkdown.ts` hoy; cualquier otro que se
 * sume despues deberia reutilizar esto en vez de inventar su propia
 * heuristica) para no bucketizar un simple corte de red como un fallo
 * generico del motor.
 *
 * Nunca devuelve "unknown": un fallo de OCR que no reconocemos como red
 * sigue siendo, con la informacion que tenemos, mas util etiquetado como
 * fallo del motor que como "algo paso".
 */
export function classifyOcrError(error: unknown): PdfErrorCode {
  if (error instanceof PdfError) return error.code;
  // Sin conexion el motor falla de formas muy variadas (importScripts, WASM, datos de idioma): la causa es la red.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "ocrNetworkFailure";
  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase();
    const networkHints = [
      "failed to fetch",
      "networkerror",
      "load failed",
      "net::",
      "cors",
      "fetch",
      "cdn.jsdelivr",
      "404",
      "ENOTFOUND".toLowerCase(),
    ];
    if (networkHints.some((hint) => text.includes(hint))) {
      return "ocrNetworkFailure";
    }
    return "ocrEngineFailure";
  }
  return "ocrEngineFailure";
}

/**
 * Clasifica un fallo del motor WebLLM (descarga del modelo o inferencia)
 * usado por `summarize.ts`. Antes de esto, `toPdfError` bucketizaba TODO
 * — incluido un corte de red simple durante la descarga — como "unknown",
 * y la interfaz lo traducia a "falta de memoria de video" sin ninguna
 * base real. Aqui se distingue:
 *
 *  - cancelacion (el propio `AbortSignal`, incluido el que dispara
 *    `engine.interruptGenerate()`, puede resolver como un `AbortError`
 *    nativo en vez de como nuestro `PdfError("cancelled")`),
 *  - perdida real de dispositivo / falta de VRAM (la unica que justifica
 *    el consejo de "prueba el modelo ligero"),
 *  - fallo de red al descargar pesos o motor,
 *  - cualquier otra cosa, que se deja como "unknown" a proposito: la
 *    interfaz le anade el texto tecnico real en vez de ocultarlo.
 */
export function classifyWebLlmError(error: unknown): PdfErrorCode {
  if (error instanceof PdfError) return error.code;
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const text = `${error.name} ${error.message}`.toLowerCase();

    if (name === "aborterror" || text.includes("abort")) {
      return "cancelled";
    }

    const deviceLostHints = [
      "device was lost",
      "device lost",
      "out of memory",
      "oom",
      "gpu process",
      "shader-f16",
      "no available adapter",
      "webgpu",
    ];
    if (deviceLostHints.some((hint) => text.includes(hint))) {
      return "deviceLost";
    }

    const networkHints = [
      "failed to fetch",
      "networkerror",
      "load failed",
      "net::",
      "cors",
      "fetch",
      "huggingface",
      "githubusercontent",
      "timeout",
      "timed out",
      "404",
      "http error",
    ];
    if (networkHints.some((hint) => text.includes(hint))) {
      return "modelDownloadFailure";
    }

    return "unknown";
  }
  return "unknown";
}

/**
 * Referencia a una pagina concreta dentro del conjunto de archivos
 * cargados. Es el contrato que comparten `PageThumbnailGrid` y los
 * motores de `lib/pdf/` para respetar orden, rotacion y seleccion.
 */
export type PageRef = {
  /** Identificador estable para React keys y drag & drop. */
  id: string;
  fileIndex: number;
  pageIndex: number;
  /** Rotacion adicional aplicada por el usuario, en grados (0/90/180/270). */
  rotation: number;
  selected: boolean;
};

/** Progreso normalizado 0..1. */
export type ProgressCallback = (progress: number) => void;

/**
 * Corta el trabajo en curso si el usuario ya ha cancelado.
 *
 * Se llama al principio de cada iteracion de los bucles largos (una
 * pagina = una unidad de trabajo cara). Lanza `PdfError("cancelled")`,
 * el mismo codigo que `ToolShell` ya muestra al cancelar, asi que la
 * interfaz no necesita distinguir entre "cancelado por el usuario antes
 * de empezar" y "cancelado a mitad".
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PdfError("cancelled");
}

/* ------------------------------------------------------------------ *
 * Lectura de archivos
 * ------------------------------------------------------------------ */

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

export function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

export function matchesAccept(
  file: File,
  accept: string[],
  extensions: string[],
): boolean {
  if (accept.length === 0) return true;
  if (file.type && accept.includes(file.type)) return true;
  const lower = file.name.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

const OLE_COMPOUND_SIGNATURE = [
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
];
/**
 * Firma de un archivo ZIP local con AL MENOS una entrada. `PK\x05\x06`
 * (fin de directorio central, archivo vacio) y `PK\x07\x08` (marcador de
 * "spanned archive") tambien empiezan por `PK`, pero ningun paquete OOXML
 * real generado por Office/LibreOffice/exceljs/docx puede empezar asi:
 * un .docx/.xlsx siempre trae `[Content_Types].xml` como primera entrada
 * local. Aceptar esas otras firmas solo hacia que un archivo corrupto se
 * etiquetase como "unknown" en vez de "corrupt".
 */
const OOXML_ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

function matchesSignature(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * El formato binario OLE2 legado que usan .doc/.xls/.ppt (Office
 * 97-2003). Se detecta por firma de bytes, no por extension: un archivo
 * renombrado no deberia colar un formato que ninguna libreria permisiva
 * de esta fase sabe leer.
 *
 * OJO: un .docx/.xlsx moderno protegido con contrasena (MS-OFFCRYPTO)
 * TAMBIEN se guarda como contenedor OLE2 (envuelve el paquete OOXML
 * cifrado dentro de streams `EncryptedPackage`/`EncryptionInfo`). Un
 * archivo que cumpla esta firma debe comprobarse con
 * `looksLikeEncryptedOoxml` ANTES de asumir que es el formato legado.
 */
export function isLegacyOleOfficeFile(bytes: Uint8Array): boolean {
  return matchesSignature(bytes, OLE_COMPOUND_SIGNATURE);
}

/** El contenedor ZIP que usan los formatos OOXML modernos (.docx/.xlsx/.pptx). */
export function isOoxmlZipFile(bytes: Uint8Array): boolean {
  return matchesSignature(bytes, OOXML_ZIP_SIGNATURE);
}

/**
 * Busca la codificacion UTF-16LE de `token` en `bytes`. Los nombres de
 * stream de un archivo OLE2 (`MS-CFB`) se guardan asi en el sector de
 * directorio, asi que buscar el texto plano codificado es una forma
 * barata de reconocer streams conocidos sin implementar un parser CFB
 * completo.
 */
function containsUtf16LeToken(bytes: Uint8Array, token: string): boolean {
  const needle = new Uint8Array(token.length * 2);
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    needle[i * 2] = code & 0xff;
    needle[i * 2 + 1] = (code >> 8) & 0xff;
  }
  const limit = Math.min(bytes.length, MAX_ENCRYPTION_SCAN_BYTES);
  outer: for (let i = 0; i <= limit - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Limite del escaneo de `looksLikeEncryptedOoxml`: los streams
 * `EncryptedPackage`/`EncryptionInfo` de un documento cifrado con
 * contrasena viven en el sector de directorio del contenedor OLE2, que en
 * la practica cae dentro de los primeros megabytes incluso en documentos
 * grandes. Acotar el escaneo evita que un archivo OLE2 gigante (legado o
 * no) cueste un recorrido completo solo para esta comprobacion.
 */
const MAX_ENCRYPTION_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Distingue "esto es realmente el formato legado .doc/.xls/.ppt" de "esto
 * es un .docx/.xlsx/.pptx moderno cifrado con contrasena", que tambien
 * cumple la firma OLE2. Sin esta comprobacion, un archivo cifrado real se
 * rechazaria con el mensaje equivocado ("solo soportamos el formato
 * moderno"), cuando el problema real es que hace falta la contrasena.
 */
export function looksLikeEncryptedOoxml(bytes: Uint8Array): boolean {
  return (
    containsUtf16LeToken(bytes, "EncryptedPackage") ||
    containsUtf16LeToken(bytes, "EncryptionInfo")
  );
}

/* ------------------------------------------------------------------ *
 * Presupuesto de descompresion (bombas ZIP)
 * ------------------------------------------------------------------ */

/**
 * Limite de bytes descomprimidos que esta app esta dispuesta a materializar
 * en memoria a partir de un contenedor OOXML. 300 MB es generoso para
 * cualquier documento/hoja de calculo real, pero corta una amplificacion
 * patologica (ej. 630 KB -> 216 MB, x343, visto en pruebas) antes de que
 * `mammoth`/`exceljs` empiecen a inflar el XML interno.
 */
export const MAX_DECOMPRESSED_OFFICE_BYTES = 300 * 1024 * 1024;

/**
 * Tope compartido de celdas totales que las conversiones Office -> PDF con
 * tablas nativas estan dispuestas a materializar antes de rechazar la
 * conversion con `PdfError("tooLarge")`. Lo usan `excelToPdf.ts` (celdas
 * de hoja de calculo, contadas via `eachRow`/`eachCell`) y `wordToPdf.ts`
 * (celdas de tabla de Word, incluido un `gridSpan`/`colspan` manipulado a
 * mano en el XML). Un valor unico evita que las rutas de conversion se
 * desincronicen si algun dia se ajusta.
 */
export const MAX_TABLE_CELLS = 200_000;

/**
 * Suma el tamano sin comprimir declarado por cada entrada del directorio
 * central de un ZIP, leyendo solo esos registros (no el contenido de las
 * entradas). Devuelve `null` cuando no se puede calcular con confianza
 * (formato ZIP64, EOCD no encontrado, archivo truncado) en vez de
 * arriesgar un falso "esta bien": quien llama debe tratar `null` como
 * "no se pudo verificar" y decidir con ese limite de informacion.
 */
export function estimateZipUncompressedBytes(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD_SIGNATURE = 0x06054b50;
  const EOCD_MIN_SIZE = 22;
  if (bytes.length < EOCD_MIN_SIZE) return null;

  // El EOCD esta al final, pero puede llevar un comentario de longitud
  // variable delante: se busca desde el final hacia atras.
  const searchFloor = Math.max(0, bytes.length - EOCD_MIN_SIZE - 0xffff);
  let eocdOffset = -1;
  for (let i = bytes.length - EOCD_MIN_SIZE; i >= searchFloor; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirSize = view.getUint32(eocdOffset + 12, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  // Sentinelas de ZIP64: el tamano/offset real vive en un registro
  // "ZIP64 end of central directory" que no se parsea aqui.
  if (
    totalEntries === 0xffff ||
    centralDirSize === 0xffffffff ||
    centralDirOffset === 0xffffffff
  ) {
    return null;
  }
  if (centralDirOffset + centralDirSize > bytes.length) return null;

  const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
  const CENTRAL_HEADER_SIZE = 46;
  let offset = centralDirOffset;
  let total = 0;
  let seen = 0;

  // OJO: `totalEntries` (leido del EOCD) NO se usa como limite del bucle.
  // Un EOCD manipulado puede declarar 0 entradas mientras el directorio
  // central real, unos bytes despues, sigue teniendo objetos validos con
  // su tamano real -- y JSZip (que tampoco confia ciegamente en ese
  // campo) los lee igual, así que un archivo asi burlaba por completo
  // este presupuesto. En su lugar se recorre el directorio central
  // firma por firma hasta que deja de haber un encabezado valido,
  // independientemente de lo que declare `totalEntries`.
  while (
    offset + CENTRAL_HEADER_SIZE <= bytes.length &&
    view.getUint32(offset, true) === CENTRAL_HEADER_SIGNATURE
  ) {
    const uncompressedSize = view.getUint32(offset + 24, true);
    if (uncompressedSize === 0xffffffff) return null; // ZIP64: no fiable aqui.
    total += uncompressedSize;

    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    seen += 1;
  }

  // El EOCD promete entradas pero no se encontro ninguna donde decia que
  // empezaba el directorio central: algo no cuadra (corrupto o forjado
  // en la otra direccion). Mejor no arriesgar un total de 0 falso.
  if (seen === 0 && totalEntries !== 0) return null;

  return total;
}

/* ------------------------------------------------------------------ *
 * Cobertura de glifos de Roboto (unica fuente que trae pdfmake)
 * ------------------------------------------------------------------ */

/**
 * Bloques Unicode que Roboto (la unica fuente que registra
 * `loadPdfMake`) no cubre. pdfmake dibuja un glifo ausente como espacio
 * en blanco, sin lanzar ningun error: sin esta comprobacion, un documento
 * con texto en estos alfabetos se "convierte" a un PDF valido pero con el
 * contenido invisible. Cubre CJK, hangul, arabe, hebreo, tailandes,
 * devanagari y los bloques de emoji/simbolos mas comunes del BMP; el
 * resto de emoji vive en planos suplementarios (code point >= 0x10000) y
 * se detecta aparte, sin necesitar su propio rango.
 */
const UNSUPPORTED_ROBOTO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0530, 0x058f], // armenio
  [0x0590, 0x05ff], // hebreo
  [0x0600, 0x06ff], // arabe
  [0x0700, 0x074f], // siriaco / thaana
  [0x0750, 0x077f], // arabe suplementario
  [0x0900, 0x097f], // devanagari
  [0x0980, 0x09ff], // bengali
  [0x0a00, 0x0a7f], // gurmukhi
  [0x0a80, 0x0aff], // gujarati
  [0x0b00, 0x0b7f], // oriya
  [0x0b80, 0x0bff], // tamil
  [0x0c00, 0x0c7f], // telugu
  [0x0c80, 0x0cff], // kannada
  [0x0d00, 0x0d7f], // malayalam
  [0x0d80, 0x0dff], // cingales
  [0x0e00, 0x0e7f], // tailandes
  [0x0e80, 0x0eff], // lao
  [0x0f00, 0x0fff], // tibetano
  [0x1000, 0x109f], // birmano
  [0x10a0, 0x10ff], // georgiano
  [0x1100, 0x11ff], // hangul jamo
  [0x1200, 0x137f], // etiope
  [0x1780, 0x17ff], // jemer
  [0x13a0, 0x13ff], // cherokee
  [0x3040, 0x30ff], // hiragana / katakana
  [0x3400, 0x4dbf], // cjk extension a
  [0x4e00, 0x9fff], // ideogramas cjk unificados
  [0xac00, 0xd7a3], // silabas hangul
  [0xf900, 0xfaff], // ideogramas de compatibilidad cjk
  [0x2600, 0x27bf], // simbolos varios y dingbats (emoji comunes del BMP)
  [0x2b00, 0x2bff], // simbolos y flechas varios (incluye emoji)
];

/**
 * Devuelve el primer caracter de `text` que Roboto no puede dibujar, o
 * `null` si todo el texto esta cubierto. Cualquier caracter de un plano
 * suplementario (code point >= 0x10000: la inmensa mayoria de emoji y
 * las extensiones B+ de CJK) se trata como no cubierto directamente.
 */
export function findUnsupportedGlyph(text: string): string | null {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x10000) return char;
    if (
      UNSUPPORTED_ROBOTO_RANGES.some(
        ([start, end]) => code >= start && code <= end,
      )
    ) {
      return char;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * pdfmake (bootstrap perezoso compartido)
 * ------------------------------------------------------------------ */

type PdfMakeModule = typeof import("pdfmake/build/pdfmake");

let pdfMakeReady: Promise<PdfMakeModule> | null = null;

/**
 * Carga perezosa de `pdfmake` + su sistema de archivos virtual (las
 * fuentes Roboto). Antes cada motor (`wordToPdf.ts`, `excelToPdf.ts`)
 * repetia este arranque por su cuenta: registraban el VFS por separado
 * (~640 KB de base64 decodificados en cada conversion) y uno de los dos
 * ni siquiera fijaba `defaultStyle.font`. Centralizarlo aqui lo hace una
 * sola vez por pagina y evita que un tercer motor (`powerpoint-to-pdf`)
 * repita la divergencia.
 *
 * Tambien cierra la politica de acceso a URLs: pdfmake puede intentar
 * descargar imagenes por red si un documento las referencia via
 * `imagesByReference`, y esta app promete que ningun byte del archivo del
 * usuario sale del dispositivo. Ningun motor actual usa esa opcion, pero
 * cerrarla ahora cuesta una linea y evita que un cambio futuro la abra
 * por accidente.
 */
export async function loadPdfMake(): Promise<PdfMakeModule> {
  if (!pdfMakeReady) {
    pdfMakeReady = Promise.all([
      import("pdfmake/build/pdfmake"),
      import("pdfmake/build/vfs_fonts"),
    ])
      .then(([{ default: pdfMake }, vfsModule]) => {
        const vfs =
          (vfsModule as { default?: Record<string, string> }).default ??
          (vfsModule as unknown as Record<string, string>);
        pdfMake.addVirtualFileSystem(vfs);
        pdfMake.setUrlAccessPolicy(() => false);
        return pdfMake;
      })
      .catch((error: unknown) => {
        // Un fallo transitorio (ej. un hipo de red en el import dinamico)
        // no debe quedar cacheado para siempre: sin esto, toda conversion
        // posterior en la misma pagina reutilizaria esta misma promesa
        // rechazada hasta que el usuario recargue, aunque un segundo
        // intento hubiera funcionado bien.
        pdfMakeReady = null;
        throw error;
      });
  }
  return pdfMakeReady;
}

/* ------------------------------------------------------------------ *
 * pdf-lib (escritura / manipulacion)
 * ------------------------------------------------------------------ */

export type LoadPdfOptions = {
  password?: string;
  /** Permite abrir un PDF cifrado sin descifrarlo (solo lectura parcial). */
  ignoreEncryption?: boolean;
};

/**
 * Carga un PDF con pdf-lib. Si el documento esta cifrado y no se aporta
 * contrasena valida, lanza `PdfError("encrypted")`.
 */
export async function loadPdf(
  source: Blob | ArrayBuffer | Uint8Array,
  options: LoadPdfOptions = {},
): Promise<PDFDocument> {
  let bytes: Uint8Array;
  if (source instanceof Uint8Array) {
    bytes = source;
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else {
    bytes = await readFileBytes(source);
  }

  if (bytes.byteLength === 0) {
    throw new PdfError("corrupt");
  }

  try {
    return await PDFDocument.load(bytes, {
      password: options.password,
      ignoreEncryption: options.ignoreEncryption ?? false,
      updateMetadata: false,
    });
  } catch (error) {
    throw toPdfError(error);
  }
}

/**
 * Serializa un documento pdf-lib a BYTES (`Uint8Array`, respaldado por un `ArrayBuffer` propio y del tamaño justo),
 * sin pasar por un `Blob`. Para quien sigue trabajando con los bytes (el documento de trabajo de PDF Pro los guarda
 * como snapshot): ir a `Blob` y volver a leerlo (`blob.arrayBuffer()`) son dos copias enteras de un PDF que, con 100 MB,
 * suman ~200 MB de pico y ~50 ms por operacion. Los bytes son EXACTAMENTE los de `savePdfToBlob`: misma llamada.
 */
export async function savePdfToBytes(document: PDFDocument): Promise<Uint8Array> {
  return document.save({ useObjectStreams: true });
}

/**
 * Envuelve unos bytes de PDF en un `Blob` descargable. Un fallo de memoria al crearlo se tipa como cualquier otro error
 * del motor (antes ocurria dentro del `try` de cada motor, que lo pasaba por `toPdfError`).
 */
export function pdfBytesToBlob(bytes: Uint8Array): Blob {
  try {
    return new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  } catch (error) {
    throw toPdfError(error);
  }
}

/** Serializa un documento pdf-lib a Blob descargable. */
export async function savePdfToBlob(document: PDFDocument): Promise<Blob> {
  return pdfBytesToBlob(await savePdfToBytes(document));
}

/* ------------------------------------------------------------------ *
 * pdf.js (lectura / render)
 * ------------------------------------------------------------------ */

/**
 * El worker se sirve como asset estatico desde `public/`. Se copia de
 * `pdfjs-dist/build/pdf.worker.min.mjs` y debe refrescarse al subir de
 * version la libreria.
 */
export const PDF_WORKER_SRC = `/pdf.worker.min.mjs?v=${process.env.NEXT_PUBLIC_PDFJS_VERSION ?? "0"}`;

/**
 * Fuentes de reemplazo de pdf.js (Liberation TTF y Foxit PFB) para los PDF
 * que NO embeben Helvetica/Times/Courier. Sin esta ruta pdf.js tiene que
 * inventar otra fuente y la vista previa deja de parecerse a lo que
 * exportara el editor. Se copia de `pdfjs-dist/standard_fonts` a
 * `public/standard_fonts/` y, igual que el worker, debe refrescarse al
 * subir de version la libreria. Lleva la barra final que exige pdf.js.
 */
export const PDF_STANDARD_FONTS_URL = "/standard_fonts/";

/**
 * Decodificadores WebAssembly de pdf.js: `openjpeg.wasm` (imagenes JPX / JPEG 2000), `jbig2.wasm` (JBIG2) y
 * `qcms_bg.wasm` (perfiles de color ICC), mas sus respaldos en JavaScript (`*_nowasm_fallback.js`, para un navegador
 * sin WebAssembly). Escaneos y facturas suelen traer JPX o JBIG2: sin esta ruta pdf.js no sabe de donde cargar el
 * decodificador y la imagen se queda SIN pintar ni extraer («OpenJPEG failed to initialize»). Se copian de
 * `pdfjs-dist/wasm` a `public/pdfjs-wasm/` (igual que el worker y las fuentes) y deben refrescarse al subir de version
 * la libreria (`core.wasm.test.ts` falla si dejan de coincidir byte a byte). Mismo origen: no hay peticiones externas y
 * el CSP ya permite `'wasm-unsafe-eval'`. Lleva la barra final que exige pdf.js.
 */
export const PDF_WASM_URL = "/pdfjs-wasm/";

type PdfJsModule = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJsModule> | null = null;

/** Carga perezosa de pdf.js con el worker ya configurado. */
export async function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist")
      .then((module) => {
        module.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        return module;
      })
      .catch((error: unknown) => {
        // Un fallo de red al cargar pdf.js NO se cachea: al volver la conexion el siguiente intento funciona.
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

/**
 * Abre un documento con pdf.js. Copia los bytes porque pdf.js transfiere
 * (y deja inutilizable) el buffer que recibe.
 */
export async function openPdfDocument(
  source: Blob | Uint8Array,
  password?: string,
): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfJs();
  const original =
    source instanceof Uint8Array ? source : await readFileBytes(source);
  const copy = new Uint8Array(original);

  try {
    const task = pdfjs.getDocument({
      data: copy,
      password,
      standardFontDataUrl: PDF_STANDARD_FONTS_URL,
      wasmUrl: PDF_WASM_URL,
    });
    return await task.promise;
  } catch (error) {
    // pdf.js usa PasswordException para documentos protegidos.
    if (
      error instanceof Error &&
      (error.name === "PasswordException" ||
        error.message.toLowerCase().includes("password"))
    ) {
      throw new PdfError("encrypted", error.message);
    }
    throw toPdfError(error);
  }
}

/** Libera el documento y el worker asociado. */
export async function closePdfDocument(
  document: PDFDocumentProxy,
): Promise<void> {
  try {
    await document.loadingTask.destroy();
  } catch {
    // Ya estaba destruido: nada que hacer.
  }
}

export type RenderOptions = {
  /** Escala base del render. Por defecto 1. */
  scale?: number;
  /** Limita el ancho en pixeles CSS del canvas resultante. */
  maxWidth?: number;
  /**
   * Intencion de render de pdf.js.
   *
   * "display" encadena los pasos con `requestAnimationFrame`, asi que se
   * detiene mientras la pestana esta en segundo plano: correcto para un
   * preview visible. "print" avanza con microtareas y termina aunque la
   * pestana no este pintando, que es lo que necesita cualquier rasterizado
   * fuera de pantalla (miniaturas, PDF a imagen, aplanado).
   */
  intent?: "display" | "print";
};

/** Renderiza una pagina de pdf.js sobre un canvas nuevo. */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  options: RenderOptions = {},
): Promise<HTMLCanvasElement> {
  const baseViewport = page.getViewport({ scale: options.scale ?? 1 });
  const scale = options.maxWidth
    ? Math.min(1, options.maxWidth / baseViewport.width) * (options.scale ?? 1)
    : (options.scale ?? 1);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new PdfError("unknown", "Canvas 2D context unavailable");
  }

  await page.render({
    canvas,
    viewport,
    intent: options.intent ?? "display",
  }).promise;
  return canvas;
}

/** Renderiza una pagina y devuelve un data URL (miniaturas). */
export async function renderPageToDataUrl(
  page: PDFPageProxy,
  options: RenderOptions = {},
): Promise<string> {
  const canvas = await renderPageToCanvas(page, {
    // Rasterizado fuera de pantalla: no debe depender de que la pestana pinte.
    intent: "print",
    ...options,
  });
  const url = canvas.toDataURL("image/jpeg", 0.72);
  canvas.width = 0;
  canvas.height = 0;
  return url;
}

/* ------------------------------------------------------------------ *
 * Geometria de pagina (compartida por los motores de edicion)
 * ------------------------------------------------------------------ */

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Relacion entre el espacio de usuario del PDF (origen abajo-izquierda,
 * sin rotacion aplicada) y el espacio "de vista": lo que el lector
 * muestra en pantalla despues de aplicar `/Rotate`, tambien con origen
 * abajo-izquierda.
 */
export type PageGeometry = {
  /** CropBox en espacio de usuario (o MediaBox si no hay CropBox). */
  box: Box;
  /** `/Rotate` normalizado a 0, 90, 180 o 270 grados (horario). */
  rotation: number;
  /** Ancho tal y como lo ve el usuario. */
  viewWidth: number;
  /** Alto tal y como lo ve el usuario. */
  viewHeight: number;
};

function normalizeAngle(angle: number): number {
  const value = Math.round(angle / 90) * 90;
  return ((value % 360) + 360) % 360;
}

export function getPageGeometry(page: PDFPage): PageGeometry {
  const box = page.getCropBox();
  const rotation = normalizeAngle(page.getRotation().angle);
  const swapped = rotation === 90 || rotation === 270;
  return {
    box,
    rotation,
    viewWidth: swapped ? box.height : box.width,
    viewHeight: swapped ? box.width : box.height,
  };
}

/**
 * Convierte un punto del espacio de vista (lo que el usuario ve) al
 * espacio de usuario del PDF, deshaciendo `/Rotate`.
 */
export function viewPointToUser(
  geometry: PageGeometry,
  vx: number,
  vy: number,
): { x: number; y: number } {
  const { box, rotation } = geometry;
  switch (rotation) {
    case 90:
      return { x: box.x + box.width - vy, y: box.y + vx };
    case 180:
      return { x: box.x + box.width - vx, y: box.y + box.height - vy };
    case 270:
      return { x: box.x + vy, y: box.y + box.height - vx };
    default:
      return { x: box.x + vx, y: box.y + vy };
  }
}

/**
 * Convierte un rectangulo normalizado (0..1) medido sobre la vista
 * renderizada, con origen ARRIBA-izquierda como en el DOM, en la caja
 * equivalente del espacio de usuario del PDF.
 */
export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function normalizedRectToUserBox(
  geometry: PageGeometry,
  rect: NormalizedRect,
): Box {
  const vx = rect.x * geometry.viewWidth;
  const vw = rect.width * geometry.viewWidth;
  // El DOM mide desde arriba; el espacio de vista, desde abajo.
  const vy = (1 - rect.y - rect.height) * geometry.viewHeight;
  const vh = rect.height * geometry.viewHeight;

  const corners = [
    viewPointToUser(geometry, vx, vy),
    viewPointToUser(geometry, vx + vw, vy),
    viewPointToUser(geometry, vx, vy + vh),
    viewPointToUser(geometry, vx + vw, vy + vh),
  ];

  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/**
 * Punto del espacio de usuario del PDF al espacio de vista (lo que el
 * usuario ve), con origen abajo-izquierda en ambos. Es el inverso exacto
 * de `viewPointToUser`: deshace la traduccion del CropBox y vuelve a
 * aplicar `/Rotate` en vez de deshacerlo.
 */
function userPointToView(
  geometry: PageGeometry,
  ux: number,
  uy: number,
): { vx: number; vy: number } {
  const { box, rotation } = geometry;
  switch (rotation) {
    case 90:
      return { vx: uy - box.y, vy: box.x + box.width - ux };
    case 180:
      return { vx: box.x + box.width - ux, vy: box.y + box.height - uy };
    case 270:
      return { vx: box.y + box.height - uy, vy: ux - box.x };
    default:
      return { vx: ux - box.x, vy: uy - box.y };
  }
}

/**
 * Convierte una caja del espacio de usuario del PDF (la que devuelven,
 * por ejemplo, los widgets de `/AcroForm` o un camino vectorial de
 * pdf.js) en el rectangulo normalizado (0..1) equivalente sobre la
 * vista renderizada, con origen ARRIBA-izquierda como en el DOM.
 *
 * Es el inverso exacto de `normalizedRectToUserBox`: mismo reparto de
 * esquinas para que una rotacion de 90/270 siga dando una caja recta.
 * Se usa para pasar del espacio de deteccion (AcroForm, geometria
 * vectorial) al espacio en el que ya trabaja `SignatureField.rect`.
 */
export function userBoxToNormalizedRect(
  geometry: PageGeometry,
  box: Box,
): NormalizedRect {
  const corners = [
    userPointToView(geometry, box.x, box.y),
    userPointToView(geometry, box.x + box.width, box.y),
    userPointToView(geometry, box.x, box.y + box.height),
    userPointToView(geometry, box.x + box.width, box.y + box.height),
  ];
  const vxs = corners.map((corner) => corner.vx);
  const vys = corners.map((corner) => corner.vy);
  const minVx = Math.min(...vxs);
  const maxVx = Math.max(...vxs);
  const minVy = Math.min(...vys);
  const maxVy = Math.max(...vys);

  const viewWidth = geometry.viewWidth || 1;
  const viewHeight = geometry.viewHeight || 1;

  return {
    x: minVx / viewWidth,
    // El DOM mide desde arriba; el espacio de vista, desde abajo.
    y: 1 - maxVy / viewHeight,
    width: (maxVx - minVx) / viewWidth,
    height: (maxVy - minVy) / viewHeight,
  };
}

/**
 * Punto de dibujo (`x`/`y` de pdf-lib) para que un elemento de tamano
 * `width` x `height` quede centrado en (`cx`, `cy`) despues de rotarlo
 * `angle` grados en sentido antihorario alrededor de ese mismo punto de
 * dibujo. `baselineOffset` es la distancia entre el borde inferior de la
 * caja y el origen de dibujo (0 para imagenes, el descendente para texto).
 */
export function originForCenter(
  cx: number,
  cy: number,
  width: number,
  height: number,
  baselineOffset: number,
  angle: number,
): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localX = width / 2;
  const localY = height / 2 - baselineOffset;
  return {
    x: cx - (localX * cos - localY * sin),
    y: cy - (localX * sin + localY * cos),
  };
}

/** Tamano de la caja envolvente de un rectangulo `w` x `h` rotado. */
export function rotatedBounds(
  width: number,
  height: number,
  angle: number,
): { width: number; height: number } {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  };
}

/* ------------------------------------------------------------------ *
 * Tipografia y color del documento (compartido por los motores)
 * ------------------------------------------------------------------ */

export type PdfFontFamily = "helvetica" | "times" | "courier";

export const PDF_FONT_FAMILIES: readonly PdfFontFamily[] = [
  "helvetica",
  "times",
  "courier",
] as const;

export function standardFontFor(
  family: PdfFontFamily,
  bold: boolean,
  italic: boolean,
): StandardFonts {
  if (family === "times") {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (family === "courier") {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/**
 * Tintas disponibles para texto del documento. NO son tokens de la
 * interfaz: son datos que el usuario elige y que acaban impresos en el
 * PDF, por eso viven aqui como valores hexadecimales y no en el CSS.
 */
export const INK_COLORS = [
  "#000000",
  "#5b6470",
  "#c0c6cf",
  "#0d4bff",
  "#0f9d68",
  "#e11d48",
  "#f59e0b",
  "#ffffff",
] as const;

export type InkColor = (typeof INK_COLORS)[number];

export function hexToPdfColor(hex: string): Color {
  const clean = hex.replace("#", "").trim();
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => char + char)
          .join("")
      : clean;
  const value = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(value)) return rgb(0, 0, 0);
  return rgb(
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  );
}

/**
 * Los tipos estandar de PDF solo codifican WinAnsi. Se sustituye todo lo
 * que quede fuera para que un caracter exotico no aborte el proceso
 * entero (los acentos del espanol si estan cubiertos).
 */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function toWinAnsiSafe(text: string): string {
  let out = "";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 10 || code === 13) {
      out += " ";
    } else if ((code >= 32 && code <= 255) || WIN_ANSI_EXTRA.has(code)) {
      out += char;
    } else {
      out += "?";
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Salida
 * ------------------------------------------------------------------ */

/**
 * SHA-256 de unos bytes, en hexadecimal. Extraido de
 * `documentContentKey` (`src/app/sign-pdf/documentKey.ts`), que hace
 * exactamente esto sobre un `File`: comparten la misma huella para no
 * duplicar la conversion a hex, ese archivo ahora llama a esta funcion.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Se libera en el siguiente tick para no cortar la descarga en Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function formatFileSize(bytes: number, locale = "es-ES"): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value)} ${units[unit]}`;
}

/** Marcas diacriticas combinantes U+0300..U+036F. */
const DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

/** "Unir PDF" -> "unir-pdf" */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `informe.pdf` -> `informe`. Sin extension no cambia nada. */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** `informe.pdf` + `unido` -> `informe-unido.pdf` */
export function withSuffix(
  filename: string,
  suffix: string,
  extension = "pdf",
): string {
  const safeBase = stripExtension(filename).trim() || "documento";
  return `${safeBase}-${suffix}.${extension}`;
}

/** Reparte un progreso 0..1 de un paso dentro de un rango global. */
export function scaleProgress(
  value: number,
  from: number,
  to: number,
): number {
  const clamped = Math.min(1, Math.max(0, value));
  return from + (to - from) * clamped;
}
