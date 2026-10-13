import type { PDFDocumentProxy } from "pdfjs-dist";
import { PDF_STANDARD_FONTS_URL, getPdfJs, openPdfDocument } from "@/lib/pdf/core";

/**
 * Apertura del documento de pdf.js del VISOR (Wave 9 · memoria).
 *
 * `openPdfDocument` (core) COPIA los bytes enteros (`new Uint8Array(original)`) porque pdf.js transfiere —y deja
 * inutilizable— el buffer que recibe, y el worker de pdf.js se queda con esa copia mientras el documento esta abierto:
 * con un PDF de 100 MB, 100 MB mas en el hilo principal durante la copia y 100 MB mas en el worker, POR CADA snapshot
 * que el visor abre (y durante el cambio de uno a otro conviven dos).
 *
 * Para los documentos grandes se abre por RANGOS (`PDFDataRangeTransport`, lo que usa pdf.js para leer un archivo
 * remoto sin descargarlo entero): el worker pide solo lo que necesita (la tabla de referencias del final, el arbol de
 * paginas, lo que usa la pagina que se pinta) y esta funcion le sirve cada rango desde los bytes del snapshot, que NO se
 * copian enteros (cada rango es una copia pequeña propia: pdf.js la transfiere al worker, y si fuera una vista del
 * snapshot dejaria SU buffer inutilizable). Con `disableAutoFetch` no baja el resto del archivo por su cuenta.
 *
 *  - Umbral: por debajo de `VIEWER_RANGE_MIN_BYTES` se abre como siempre (copia entera): para un PDF pequeño la copia
 *    es barata y es el camino que ya se probaba.
 *  - Red de seguridad: si la apertura por rangos falla por cualquier motivo, se cierra y se abre como siempre; si el
 *    PDF es realmente invalido, esa segunda apertura da el error tipado de siempre.
 *  - Sin `startxref` cerca del final (archivo dañado o cortado), NO se abre por rangos (Wave 9 · lote 2). pdf.js busca esa
 *    marca hacia atras y, con el archivo troceado, cada trozo que falta le hace EMPEZAR DE NUEVO la busqueda (coste cuadratico):
 *    un PDF de 20 MB tardaba 3,4 s en vez de 0,9 s y uno de 100 MB, 69 s en vez de 1,4 s, solo para acabar reconstruyendo la
 *    tabla de referencias leyendo el archivo entero. Los bytes ya estan en memoria: mirar la cola cuesta microsegundos y se
 *    va directo a la apertura de siempre, que reconstruye de golpe.
 *  - Plazo: si por rangos el documento (y su primera pagina) no estan en `rangeOpenBudgetMs` — otra forma de dañado que no se ve
 *    mirando la cola, o un equipo muy lento —, se abandonan los rangos (se destruye la tarea y se sueltan sus bytes) y se abre
 *    como siempre; lo que la de rangos entregue despues ya no cuenta (se destruyo con la tarea).
 *  - El documento abierto retiene los bytes del snapshot mientras viva (los mismos que el historial ya tiene en RAM
 *    si es el actual): no es una copia mas.
 */

export const VIEWER_RANGE_MIN_BYTES = 16 * 1024 * 1024;

/**
 * Ajuste de diagnostico y de las pruebas E2E, en este navegador: bytes desde los que el visor abre por rangos (`0` = siempre).
 * Sin valor (o no numerico) manda `VIEWER_RANGE_MIN_BYTES`. Nunca lanza.
 */
export const PRO_VIEWER_RANGE_MIN_STORAGE_KEY = "optimuspdf.pro.viewerRangeMinBytes";

export function readViewerRangeMinOverride(): number | undefined {
  try {
    const raw = window.localStorage.getItem(PRO_VIEWER_RANGE_MIN_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Bytes que se entregan de entrada (la cabecera y el primer trozo; pdf.js pide el resto por rangos). */
const INITIAL_BYTES = 64 * 1024;

/**
 * Cola del archivo en la que se busca `startxref`. pdf.js la busca hacia atras hasta el principio del archivo; un PDF sano la
 * lleva en sus ultimos bytes (a lo sumo, tras algo de relleno), y cada trozo de 64 KB que pdf.js recorre hacia atras le cuesta
 * volver a empezar la busqueda: 1 MB son 16 trozos y unos 40 ms, una cola mayor se trata como «sin marca».
 */
export const VIEWER_STARTXREF_WINDOW_BYTES = 1024 * 1024;

const STARTXREF = Array.from("startxref", (character) => character.charCodeAt(0));

/** `true` si `startxref` aparece en los ultimos `windowBytes` del archivo. Busca desde el final: en un PDF sano, a los pocos bytes. */
export function hasStartXrefNearEnd(bytes: Uint8Array, windowBytes: number = VIEWER_STARTXREF_WINDOW_BYTES): boolean {
  const first = Math.max(0, bytes.byteLength - windowBytes);
  for (let at = bytes.byteLength - STARTXREF.length; at >= first; at -= 1) {
    if (bytes[at] !== STARTXREF[0]) continue;
    let matched = 1;
    while (matched < STARTXREF.length && bytes[at + matched] === STARTXREF[matched]) matched += 1;
    if (matched === STARTXREF.length) return true;
  }
  return false;
}

/** Plazo base para que por rangos aparezcan el documento y su primera pagina (un PDF sano tarda decenas de ms). */
export const VIEWER_RANGE_OPEN_BUDGET_MS = 2500;
/** Cada MB por encima del umbral de rangos suma esto al plazo (archivos enormes en equipos lentos). */
const BUDGET_MS_PER_EXTRA_MB = 10;

/** Plazo para abrir `byteLength` bytes por rangos: el base, mas un poco por cada MB por encima del umbral de rangos. */
export function rangeOpenBudgetMs(byteLength: number): number {
  const extraMb = Math.max(0, byteLength / (1024 * 1024) - VIEWER_RANGE_MIN_BYTES / (1024 * 1024));
  return Math.round(VIEWER_RANGE_OPEN_BUDGET_MS + extraMb * BUDGET_MS_PER_EXTRA_MB);
}

type PdfJsModule = Awaited<ReturnType<typeof getPdfJs>>;

export type OpenViewerOptions = {
  /** Motor de pdf.js (por defecto, el de la aplicacion). Para pruebas con la build «legacy». */
  pdfjs?: PdfJsModule;
  /** Desde que tamaño se abre por rangos. */
  rangeMinBytes?: number;
  /** Direccion de las fuentes estandar (por defecto, la de la aplicacion). */
  standardFontDataUrl?: string;
  /** Plazo (ms) para abrir por rangos el documento y su primera pagina antes de abandonar los rangos (por defecto, `rangeOpenBudgetMs`). */
  rangeBudgetMs?: number;
};

/** La apertura por rangos no dio el documento en su plazo. */
class RangeOpenTooSlow extends Error {
  constructor() {
    super("range open exceeded its budget");
    this.name = "RangeOpenTooSlow";
  }
}

async function openByRanges(bytes: Uint8Array, options: OpenViewerOptions): Promise<PDFDocumentProxy> {
  const pdfjs = options.pdfjs ?? (await getPdfJs());
  const length = bytes.byteLength;
  // Los bytes viven en un SOBRE que se vacia al cerrar el documento: pdf.js (y React, y las cache de miniaturas) pueden
  // seguir referenciando el documento ya cerrado unos instantes (medido: un buffer de 100 MB retenido tras cada deshacer
  // por la funcion `requestDataRange` de un documento cerrado); sin los bytes en el sobre, eso ya no pesa nada.
  const source: { bytes: Uint8Array | null } = { bytes };
  // Copias PROPIAS: pdf.js transfiere el buffer de cada trozo al worker (`bytes.subarray` dejaria el snapshot inutil).
  const transport = new pdfjs.PDFDataRangeTransport(length, bytes.slice(0, Math.min(length, INITIAL_BYTES)));
  transport.requestDataRange = (begin: number, end: number) => {
    const current = source.bytes;
    if (!current) return; // documento cerrado: nadie espera ya esa respuesta
    const chunk = current.slice(begin, Math.min(end, length));
    // Asincrono, como una lectura real: el lector del rango ya esta registrado cuando llega.
    queueMicrotask(() => transport.onDataRange(begin, chunk));
  };
  const task = pdfjs.getDocument({
    range: transport,
    disableAutoFetch: true,
    disableStream: true,
    standardFontDataUrl: options.standardFontDataUrl ?? PDF_STANDARD_FONTS_URL,
  });
  const destroy = task.destroy.bind(task);
  task.destroy = () => {
    source.bytes = null;
    return destroy();
  };
  // El documento Y su primera pagina, dentro del plazo: si pdf.js esta reconstruyendo la tabla de referencias a base de
  // rangos, ninguna de las dos llega a tiempo y sale mas barato abrir de golpe.
  const opened = (async () => {
    const document = await task.promise;
    if (document.numPages > 0) await document.getPage(1);
    return document;
  })();
  // Si el plazo gana, el resultado tardio (o su fallo) ya no le importa a nadie.
  opened.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), options.rangeBudgetMs ?? rangeOpenBudgetMs(length));
  });
  try {
    const outcome = await Promise.race([opened, expired]);
    if (outcome === "expired") throw new RangeOpenTooSlow();
    return outcome;
  } catch (error) {
    void task.destroy().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Abre los bytes de un snapshot para el visor: por rangos si son grandes, como siempre si no. */
export async function openViewerDocument(bytes: Uint8Array, options: OpenViewerOptions = {}): Promise<PDFDocumentProxy> {
  const rangeMin = options.rangeMinBytes ?? readViewerRangeMinOverride() ?? VIEWER_RANGE_MIN_BYTES;
  if (bytes.byteLength < rangeMin) return openPdfDocument(bytes);
  // Sin `startxref` cerca del final pdf.js reconstruiria la tabla leyendo el archivo trozo a trozo (3,4 s en vez de 0,9 s con
  // 20 MB, 69 s en vez de 1,4 s con 100 MB): se abre de golpe, que reconstruye leyendo los bytes que ya estan en memoria.
  if (!hasStartXrefNearEnd(bytes)) return openPdfDocument(bytes);
  try {
    return await openByRanges(bytes, options);
  } catch {
    return openPdfDocument(bytes);
  }
}
