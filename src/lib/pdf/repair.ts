import { EncryptedPDFError, PDFDocument } from "@cantoo/pdf-lib";
import {
  PdfError,
  closePdfDocument,
  openPdfDocument,
  readFileBytes,
  renderPageToCanvas,
  savePdfToBlob,
  scaleProgress,
  throwIfAborted,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { canvasToBlob } from "@/lib/pdf/imagesToPdf";

/**
 * Reparar PDF — recuperacion estructural best-effort, 100% en el navegador.
 *
 * ALCANCE HONESTO (leer antes de tocar nada aqui):
 *
 * Esta herramienta reconstruye la ESTRUCTURA de un PDF danado. Puede
 * arreglar tablas `xref` invalidas, `trailer` rotos, `startxref` que
 * apunta a ninguna parte, cabeceras `%PDF-` perdidas y colas truncadas,
 * porque en todos esos casos los OBJETOS del documento siguen estando en
 * el archivo y solo hace falta volver a indexarlos.
 *
 * NO puede inventar bytes que ya no estan. Si el archivo se corto a la
 * mitad, las paginas cuyos objetos quedaron fuera del corte NO se
 * recuperan: se informa exactamente de cuantas se salvaron. Si el
 * contenido esta cifrado sin contrasena, o el archivo directamente no
 * contiene un PDF, no hay reparacion posible y se falla en claro.
 *
 * Por eso el motor NUNCA devuelve solo un Blob: devuelve `RepairOutcome`
 * con un `RepairReport` que la interfaz esta obligada a mostrar. Todo lo
 * que el informe afirma esta medido sobre el resultado real, no supuesto.
 */

/* ------------------------------------------------------------------ *
 * Diagnostico: que le pasa al archivo
 * ------------------------------------------------------------------ */

/**
 * Danos estructurales detectables leyendo los bytes en crudo, SIN pasar
 * por un parser tolerante.
 *
 * Esta distincion es la que hace honesto al diagnostico: pdf-lib
 * reconstruye la `xref` en silencio al cargar, asi que "pdf-lib abrio el
 * archivo" no significa "el archivo estaba sano". Estos detectores miran
 * el original tal cual y por eso pueden decir si habia algo roto de
 * verdad.
 */
export type DamageSignal =
  /** No hay `%PDF-` en el offset 0 (falta del todo o hay basura delante). */
  | "header"
  /** No aparece `%%EOF` cerca del final: el archivo esta cortado. */
  | "eof"
  /** No aparece la palabra `startxref`. */
  | "startxref"
  /** `startxref` existe pero su offset no cae sobre una tabla/objeto xref. */
  | "startxrefOffset"
  /**
   * La tabla `xref` existe pero sus entradas no respetan el formato fijo
   * de 20 bytes (`nnnnnnnnnn ggggg n`). Es el dano que deja un editor que
   * reescribio el archivo sin recalcular los offsets.
   */
  | "xrefEntries"
  /** El ultimo `obj` del archivo no llega a cerrarse con `endobj`. */
  | "danglingObject";

/**
 * Como se reconstruyo el documento.
 *
 * - `"structural"`: se conservaron los objetos originales (texto, fuentes
 *   y vectores intactos) y solo se rehizo el indice.
 * - `"raster"`: ultimo recurso. pdf-lib no pudo reconstruir el arbol de
 *   objetos, asi que se rescato lo que pdf.js logro RENDERIZAR y cada
 *   pagina salvada se guarda como imagen. Se recupera lo que se ve; se
 *   pierden el texto seleccionable, los vectores y los formularios.
 */
export type RepairMode = "structural" | "raster";

/** Cada arreglo concreto que hubo que aplicar. */
export type RepairAction =
  /**
   * Se reindexaron todos los objetos y se escribieron `xref` y `trailer`
   * nuevos. Arregla xref/trailer/startxref/`/Length` corruptos.
   */
  | "reindexed"
  /** Se restauro la cabecera `%PDF-` (perdida o con basura delante). */
  | "headerRestored"
  /** Se descarto una cola incompleta (archivo truncado a mitad de objeto). */
  | "tailTrimmed"
  /**
   * El arbol de paginas declaraba paginas que ya no existian, asi que el
   * documento se reconstruyo copiando SOLO las que se resuelven de verdad.
   */
  | "prunedPageTree"
  /** Las paginas se reconstruyeron como imagenes. */
  | "rasterized";

/** Motivo por el que no se pudo reparar nada. */
export type RepairFailure =
  /** Ni pdf-lib ni pdf.js reconocieron un PDF ahi dentro. */
  | "unreadable"
  /** Se reconocio el PDF pero esta cifrado y no se aporto contrasena. */
  | "encrypted"
  /** pdf.js abrio el documento pero no se pudo rasterizar ni una pagina. */
  | "noPagesRecovered"
  /** El archivo esta vacio. */
  | "empty";

export class RepairError extends PdfError {
  readonly reason: RepairFailure;

  constructor(reason: RepairFailure) {
    // "encrypted" y "empty" existen en PdfErrorCode y ToolShell ya sabe
    // traducirlos; los otros dos caen en "corrupt", que es lo que son.
    super(
      reason === "encrypted" ? "encrypted" : reason === "empty" ? "empty" : "corrupt",
      `repair:${reason}`,
    );
    this.name = "RepairError";
    this.reason = reason;
  }
}

/**
 * Informe de lo que REALMENTE ocurrio. Cada campo se mide sobre el
 * documento de salida ya construido.
 */
export type RepairReport = {
  mode: RepairMode;
  /** Arreglos aplicados, en el orden en que se aplicaron. */
  actions: RepairAction[];
  /** Danos encontrados en el archivo original (lista vacia = sin danos). */
  damage: DamageSignal[];
  /** Paginas que tiene el PDF reparado. Medido, no estimado. */
  pagesRecovered: number;
  /**
   * Paginas que el documento original DECLARABA tener (`/Count` del nodo
   * `/Type /Pages`), si se pudo leer del archivo en crudo. `null` cuando
   * no hay declaracion legible: entonces la interfaz no debe inventar un
   * denominador ni afirmar que no se perdio nada.
   */
  pagesDeclared: number | null;
  /** Bytes del original que hubo que descartar para poder reconstruirlo. */
  bytesDiscarded: number;
  /**
   * `false` solo en la estrategia "raster": el texto deja de ser
   * seleccionable porque las paginas pasan a ser imagenes.
   */
  textPreserved: boolean;
  /** Indices (base 1) de las paginas que pdf.js no pudo rescatar. */
  failedPages: number[];
  inputBytes: number;
  outputBytes: number;
  /**
   * `true` si el original estaba cifrado pero se abrio sin contrasena propia (PDF «solo propietario»:
   * restringe editar/imprimir, no pide nada para abrirse) y se reparo una copia sin cifrar.
   */
  openedDecryptedCopy?: boolean;
};

export type RepairOutcome = {
  blob: Blob;
  report: RepairReport;
};

export type RepairOptions = {
  /** Contrasena, si el documento danado ademas esta cifrado. */
  password?: string;
  /** Escala de rasterizado del ultimo recurso. Por defecto 2 (~144 dpi). */
  rasterScale?: number;
  /** Calidad JPEG del ultimo recurso. Por defecto 0.82. */
  rasterQuality?: number;
};

/* ------------------------------------------------------------------ *
 * Utilidades de bytes (puras: son las que cubre repair.test.ts)
 * ------------------------------------------------------------------ */

/** Codifica ASCII a bytes. Los marcadores PDF son todos ASCII. */
function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Primera aparicion de `needle` en `haystack` a partir de `from`. */
export function findSequence(
  haystack: Uint8Array,
  needle: Uint8Array,
  from = 0,
): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  const last = haystack.length - needle.length;
  const first = needle[0];
  outer: for (let i = Math.max(0, from); i <= last; i += 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Ultima aparicion de `needle` en `haystack`. */
export function findLastSequence(
  haystack: Uint8Array,
  needle: Uint8Array,
): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  const first = needle[0];
  outer: for (let i = haystack.length - needle.length; i >= 0; i -= 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Lee `bytes` como latin1 (1 byte = 1 code unit) para inspeccion textual. */
function latin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

const HEADER = ascii("%PDF-");
const EOF = ascii("%%EOF");
const STARTXREF = ascii("startxref");
const ENDOBJ = ascii("endobj");
const OBJ = ascii(" obj");

/**
 * Comprueba que la tabla `xref` que empieza en `offset` tenga entradas
 * con el formato fijo que exige la especificacion.
 *
 * Tras la palabra `xref` viene una cabecera de subseccion (`primero
 * cuantos`) y despues una entrada por objeto, cada una de exactamente 20
 * bytes: 10 digitos de offset, espacio, 5 digitos de generacion, espacio
 * y `n` (en uso) o `f` (libre). Basta validar las primeras entradas: si
 * el indice esta corrupto, lo esta desde el principio.
 */
function hasValidXrefEntries(bytes: Uint8Array, offset: number): boolean {
  const text = latin1(bytes.subarray(offset, offset + 512));
  const header = /^\s*xref\s*[\r\n]+\s*(\d+)\s+(\d+)\s*[\r\n]+/.exec(text);
  if (!header) return false;
  const declared = Number.parseInt(header[2], 10);
  if (!Number.isFinite(declared) || declared <= 0) return false;

  let cursor = header[0].length;
  const toCheck = Math.min(declared, 4);
  for (let i = 0; i < toCheck; i += 1) {
    const entry = text.slice(cursor, cursor + 20);
    if (!/^\d{10} \d{5} [nf]/.test(entry)) return false;
    cursor += 20;
  }
  return true;
}

/**
 * Examina los bytes originales y devuelve los danos estructurales que se
 * pueden afirmar mirando el archivo tal cual.
 *
 * Solo se reporta lo que se comprueba. Un archivo con `xref` semanticamente
 * mal pero sintacticamente plausible puede pasar este examen sin senales:
 * la lista vacia significa "no se detecto dano", nunca "el archivo esta
 * perfecto".
 */
export function assessDamage(bytes: Uint8Array): DamageSignal[] {
  const signals: DamageSignal[] = [];
  if (bytes.length === 0) return signals;

  if (findSequence(bytes, HEADER, 0) !== 0) signals.push("header");

  // `%%EOF` debe estar en la cola. 2 KB cubre de sobra el relleno legal.
  const tailStart = Math.max(0, bytes.length - 2048);
  if (findSequence(bytes.subarray(tailStart), EOF) < 0) signals.push("eof");

  const sxPos = findLastSequence(bytes, STARTXREF);
  if (sxPos < 0) {
    signals.push("startxref");
  } else {
    const tail = latin1(bytes.subarray(sxPos + STARTXREF.length, sxPos + 64));
    const offset = Number.parseInt(tail.trim(), 10);
    if (!Number.isFinite(offset) || offset <= 0 || offset >= bytes.length) {
      signals.push("startxrefOffset");
    } else {
      // El offset debe caer sobre una tabla `xref` clasica o sobre el
      // objeto que contiene un xref stream ("N G obj").
      const at = latin1(bytes.subarray(offset, offset + 24));
      if (/^\s*xref/.test(at)) {
        // Hay tabla: se comprueba ademas que sus entradas sean validas.
        // Encontrar la palabra `xref` no basta — un editor puede haber
        // dejado la palabra y destrozado los offsets de debajo, y eso es
        // exactamente el dano que esta herramienta arregla.
        if (!hasValidXrefEntries(bytes, offset)) signals.push("xrefEntries");
      } else if (!/^\s*\d+\s+\d+\s+obj/.test(at)) {
        signals.push("startxrefOffset");
      }
    }
  }

  // Un `obj` posterior al ultimo `endobj` es un objeto que quedo abierto.
  const lastObj = findLastSequence(bytes, OBJ);
  const lastEndobj = findLastSequence(bytes, ENDOBJ);
  if (lastObj >= 0 && lastObj > lastEndobj) signals.push("danglingObject");

  return signals;
}

/**
 * Numero de paginas que el documento DECLARA en el nodo `/Type /Pages`
 * (`/Count`), leido de los bytes en crudo.
 *
 * Sirve como denominador honesto cuando el archivo esta truncado: el
 * `/Count` sobrevive aunque los objetos de pagina se hayan perdido, asi
 * que permite decir "4 de 6" en vez de solo "4". Se toma el maximo de los
 * candidatos porque el nodo raiz del arbol es el que declara el total.
 *
 * Devuelve `null` si no hay ninguna declaracion legible: en ese caso la
 * interfaz NO debe afirmar nada sobre paginas perdidas.
 */
export function readDeclaredPageCount(bytes: Uint8Array): number | null {
  const text = latin1(bytes);
  let best: number | null = null;
  // `/Type /Pages` y `/Count N` pueden ir en cualquier orden dentro del
  // mismo diccionario, asi que se busca el marcador y se explora una
  // ventana alrededor en vez de exigir un orden concreto.
  const marker = /\/Type\s*\/Pages(?![a-zA-Z])/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    const from = Math.max(0, match.index - 512);
    const window = text.slice(from, match.index + 512);
    const count = /\/Count\s+(\d+)/.exec(window);
    if (!count) continue;
    const value = Number.parseInt(count[1], 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

/**
 * Devuelve los bytes a partir de la cabecera `%PDF-`, o con una cabecera
 * sintetica delante si no hay ninguna.
 *
 * Un `%PDF-` desplazado (basura delante) es corriente cuando un servidor
 * mal configurado pega texto antes del archivo; un `%PDF-` machacado
 * aparece cuando la descarga empezo mal. `null` si no habia nada que
 * cambiar.
 */
export function repairHeader(
  bytes: Uint8Array,
): { bytes: Uint8Array; discarded: number } | null {
  const marker = findSequence(bytes, HEADER);
  if (marker === 0) return null;
  if (marker > 0) {
    return { bytes: bytes.subarray(marker), discarded: marker };
  }
  // Sin cabecera en ninguna parte: se antepone una. No se descarta nada,
  // asi que los objetos que hubiera siguen todos disponibles.
  const head = ascii("%PDF-1.7\n");
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return { bytes: out, discarded: 0 };
}

/**
 * Recorta el archivo justo despues del ultimo `endobj` completo.
 *
 * Es la reparacion clasica del archivo truncado: la descarga se corto a
 * mitad de un objeto, y ese objeto a medias hace fallar al parser aunque
 * todos los anteriores esten intactos. Cortando por el ultimo objeto
 * cerrado se salva todo lo que si llego. `null` si no hay ningun `endobj`
 * (no queda nada aprovechable) o si ya era el final del archivo.
 */
export function truncateToLastEndobj(
  bytes: Uint8Array,
): { bytes: Uint8Array; discarded: number } | null {
  const pos = findLastSequence(bytes, ENDOBJ);
  if (pos < 0) return null;
  const end = pos + ENDOBJ.length;
  if (end >= bytes.length) return null;
  return { bytes: bytes.subarray(0, end), discarded: bytes.length - end };
}

/* ------------------------------------------------------------------ *
 * Motor
 * ------------------------------------------------------------------ */

/**
 * Carga tolerante: se le pide a pdf-lib que no aborte por objetos sueltos.
 *
 * `ignoreEncryption` se queda en `false` A PROPOSITO. Ponerlo en `true`
 * haria que un documento cifrado "cargase" y se reescribiese con sus
 * streams todavia cifrados: un archivo ilegible entregado como reparado.
 * Es preferible fallar y pedir la contrasena que devolver basura con
 * cara de exito.
 */
async function tolerantLoad(
  bytes: Uint8Array,
  password?: string,
): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    password,
    ignoreEncryption: false,
    // Clave de la reparacion: un objeto invalido suelto no debe tumbar la
    // carga entera del documento.
    throwOnInvalidObject: false,
    updateMetadata: false,
    // Los numeros fuera de rango se recortan en vez de reventar el parseo.
    capNumbers: true,
  });
}

/**
 * ¿Declara el arbol de paginas exactamente las paginas que existen?
 *
 * Un archivo truncado deja `/Kids` apuntando a objetos que ya no estan y
 * un `/Count` que los sigue contando. pdf-lib resuelve el arbol y sabe
 * que solo hay 4 paginas, pero al serializar conserva el nodo original
 * tal cual: el PDF resultante afirmaria tener 6 paginas y solo traeria 4,
 * con dos referencias colgando. Entregar eso seria justo lo que esta
 * herramienta promete no hacer, asi que cuando no cuadra se reconstruye.
 */
function pageTreeIsConsistent(document: PDFDocument): boolean {
  try {
    return document.catalog.Pages().Count().asNumber() === document.getPageCount();
  } catch {
    // Si ni siquiera se puede leer el `/Count`, se asume inconsistente:
    // fallar hacia la reconstruccion es siempre lo seguro.
    return false;
  }
}

/**
 * Reconstruye el documento copiando UNA A UNA solo las paginas que se
 * resuelven de verdad. El resultado no tiene referencias colgando, y las
 * paginas que no se dejan copiar se devuelven aparte para poder
 * nombrarlas en el informe.
 */
async function rebuildFromResolvablePages(
  source: PDFDocument,
  signal: AbortSignal | undefined,
): Promise<{ document: PDFDocument; failedPages: number[] }> {
  const output = await PDFDocument.create();
  const failedPages: number[] = [];

  for (const index of source.getPageIndices()) {
    throwIfAborted(signal);
    try {
      const [page] = await output.copyPages(source, [index]);
      output.addPage(page);
    } catch {
      // Esta pagina concreta no se deja copiar: se anota y se sigue.
      failedPages.push(index + 1);
    }
  }

  return { document: output, failedPages };
}

/** Un intento de la escalera de reparacion. */
type Attempt = {
  actions: RepairAction[];
  bytes: Uint8Array;
  discarded: number;
};

/**
 * Construye la escalera de intentos con pdf-lib, de menos a mas
 * destructivo. El primero que funcione gana: nunca se descarta contenido
 * si un intento mas conservador ya habia bastado.
 *
 * Todos los peldanos incluyen `"reindexed"` porque volver a serializar
 * con pdf-lib siempre reescribe `xref` y `trailer` desde cero.
 */
export function buildAttempts(original: Uint8Array): Attempt[] {
  const attempts: Attempt[] = [
    { actions: ["reindexed"], bytes: original, discarded: 0 },
  ];

  const headed = repairHeader(original);
  if (headed) {
    attempts.push({
      actions: ["reindexed", "headerRestored"],
      bytes: headed.bytes,
      discarded: headed.discarded,
    });
  }

  // El recorte de cola sobre el original tal cual.
  const bare = truncateToLastEndobj(original);
  if (bare) {
    attempts.push({
      actions: ["reindexed", "tailTrimmed"],
      bytes: bare.bytes,
      discarded: bare.discarded,
    });
  }

  // Y el caso en que los dos danos coexisten en el mismo archivo.
  if (headed) {
    const both = truncateToLastEndobj(headed.bytes);
    if (both) {
      attempts.push({
        actions: ["reindexed", "headerRestored", "tailTrimmed"],
        bytes: both.bytes,
        discarded: headed.discarded + both.discarded,
      });
    }
  }

  return attempts;
}

/**
 * Ultimo recurso: pdf.js suele abrir documentos que pdf-lib rechaza,
 * porque reconstruye su propio indice. No se puede copiar sus objetos a
 * pdf-lib, asi que se rasteriza cada pagina que consiga renderizar y se
 * arma un PDF nuevo con esas imagenes.
 *
 * Es recuperacion REAL de lo visible, pero con perdida declarada: el
 * resultado ya no tiene texto seleccionable. La interfaz lo dice.
 */
async function rasterSalvage(
  bytes: Uint8Array,
  options: RepairOptions,
  onProgress: ProgressCallback | undefined,
  signal: AbortSignal | undefined,
): Promise<{ document: PDFDocument; failedPages: number[]; total: number }> {
  const source = await openPdfDocument(bytes, options.password);
  const failedPages: number[] = [];
  const total = source.numPages;

  try {
    const output = await PDFDocument.create();
    for (let index = 1; index <= total; index += 1) {
      throwIfAborted(signal);
      try {
        const page = await source.getPage(index);
        const canvas = await renderPageToCanvas(page, {
          scale: options.rasterScale ?? 2,
          intent: "print",
        });
        const jpeg = await canvasToBlob(
          canvas,
          "image/jpeg",
          options.rasterQuality ?? 0.82,
        );
        const image = await output.embedJpg(await readFileBytes(jpeg));
        // El tamano de pagina se toma del viewport sin escalar, para que
        // el documento reparado conserve las medidas originales.
        const viewport = page.getViewport({ scale: 1 });
        const target = output.addPage([viewport.width, viewport.height]);
        target.drawImage(image, {
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height,
        });
        canvas.width = 0;
        canvas.height = 0;
      } catch (error) {
        if (error instanceof PdfError && error.code === "cancelled") throw error;
        // Esta pagina concreta no se pudo rescatar: se anota y se sigue.
        // Perder una pagina no puede costar las demas.
        failedPages.push(index);
      }
      onProgress?.(scaleProgress(index / total, 0.35, 0.9));
    }
    return { document: output, failedPages, total };
  } finally {
    await closePdfDocument(source);
  }
}

/**
 * Repara un PDF danado y devuelve SIEMPRE el informe de lo conseguido
 * junto al archivo. Si no se pudo recuperar nada, lanza `RepairError` en
 * vez de devolver un PDF vacio haciendolo pasar por reparado.
 */
export async function repairPdf(
  file: Blob,
  options: RepairOptions = {},
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<RepairOutcome> {
  try {
    return await repairPdfCore(file, options, onProgress, signal);
  } catch (error) {
    if (!(error instanceof RepairError && error.reason === "encrypted")) throw error;
    // Un PDF cifrado que se abre sin contrasena de usuario («solo propietario») no necesita la
    // contrasena de nadie: se descifra una copia y se repara esa, con aviso. Con contrasena de usuario
    // (o una equivocada) sigue siendo «cifrado»: no hay nada que hacer sin ella.
    let copy: Blob;
    try {
      const { decryptPdfCopy } = await import("@/lib/pdf/unlock");
      const source =
        file instanceof File ? file : new File([file], "documento.pdf", { type: "application/pdf" });
      copy = await decryptPdfCopy(source, options.password ?? "");
    } catch (inner) {
      if (inner instanceof PdfError && inner.code === "cancelled") throw inner;
      throw error;
    }
    const outcome = await repairPdfCore(copy, { ...options, password: undefined }, onProgress, signal);
    return { ...outcome, report: { ...outcome.report, openedDecryptedCopy: true } };
  }
}

async function repairPdfCore(
  file: Blob,
  options: RepairOptions,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<RepairOutcome> {
  throwIfAborted(signal);
  const original = await readFileBytes(file);
  if (original.length === 0) throw new RepairError("empty");

  onProgress?.(0.05);
  const damage = assessDamage(original);
  const pagesDeclared = readDeclaredPageCount(original);
  onProgress?.(0.1);

  const base = {
    damage,
    pagesDeclared,
    inputBytes: original.length,
  };

  /*
   * Sin ningun dano detectado, forzar la escalera de mas abajo
   * reserializaria un archivo que ya estaba bien: pdf-lib reescribe
   * `xref`/`trailer` SIEMPRE al guardar, lo que invalidaria una firma
   * digital por rango de bytes si el documento tenia una, sin que nada
   * en el informe lo advirtiera ("reindexed" sonaria a que hizo falta
   * arreglar algo). Se comprueba que el original realmente abre y tiene
   * paginas, y se devuelve tal cual, sin tocar un solo byte.
   */
  if (damage.length === 0) {
    try {
      const probe = await tolerantLoad(original);
      const pages = probe.getPageCount();
      if (pages > 0) {
        onProgress?.(1);
        return {
          blob: new Blob([original as unknown as BlobPart], {
            type: "application/pdf",
          }),
          report: {
            ...base,
            mode: "structural",
            actions: [],
            pagesRecovered: pages,
            bytesDiscarded: 0,
            textPreserved: true,
            failedPages: [],
            outputBytes: original.length,
          },
        };
      }
    } catch {
      // No abrio pese a no mostrar danos detectables (p.ej. cifrado, o
      // un problema que estos detectores no cubren): se sigue por la
      // escalera normal en vez de asumir que estaba sano.
    }
  }

  /* --- Escalera 1: reconstruccion estructural con pdf-lib -------- */
  let encryptedSeen = false;
  const attempts = buildAttempts(original);

  for (let index = 0; index < attempts.length; index += 1) {
    throwIfAborted(signal);
    const attempt = attempts[index];
    try {
      const loaded = await tolerantLoad(attempt.bytes, options.password);
      // Un documento sin ninguna pagina no es una reparacion: es un
      // resultado vacio. Se sigue bajando por la escalera en vez de
      // entregarlo como si valiese.
      if (loaded.getPageCount() === 0) continue;

      // Si el arbol de paginas no cuadra, se reconstruye: nunca se
      // entrega un PDF con referencias colgando.
      let document = loaded;
      let failedPages: number[] = [];
      const actions = [...attempt.actions];
      if (!pageTreeIsConsistent(loaded)) {
        const rebuilt = await rebuildFromResolvablePages(loaded, signal);
        if (rebuilt.document.getPageCount() === 0) continue;
        document = rebuilt.document;
        failedPages = rebuilt.failedPages;
        actions.push("prunedPageTree");
      }

      onProgress?.(scaleProgress((index + 1) / attempts.length, 0.1, 0.8));
      const blob = await savePdfToBlob(document);
      onProgress?.(1);
      return {
        blob,
        report: {
          ...base,
          mode: "structural",
          actions,
          pagesRecovered: document.getPageCount(),
          bytesDiscarded: attempt.discarded,
          textPreserved: true,
          failedPages,
          outputBytes: blob.size,
        },
      };
    } catch (error) {
      if (error instanceof PdfError && error.code === "cancelled") throw error;
      if (error instanceof EncryptedPDFError) {
        encryptedSeen = true;
        // Sin la contrasena correcta no hay nada que reparar: reintentar
        // los demas peldanos daria exactamente el mismo resultado.
        break;
      }
      const text = error instanceof Error ? error.message.toLowerCase() : "";
      if (text.includes("password") || text.includes("encrypt")) {
        encryptedSeen = true;
      }
      // Cualquier otro fallo: se prueba el siguiente peldano.
    }
  }

  // Cifrado detectado y sin contrasena valida: se falla en claro en vez de
  // pasar al rescate visual, que tampoco podria descifrar los streams.
  if (encryptedSeen) throw new RepairError("encrypted");

  /* --- Escalera 2: rescate visual con pdf.js --------------------- */
  onProgress?.(0.35);
  try {
    throwIfAborted(signal);
    const { document, failedPages, total } = await rasterSalvage(
      original,
      options,
      onProgress,
      signal,
    );
    const pages = document.getPageCount();
    if (pages === 0) {
      throw new RepairError(
        total > 0 ? "noPagesRecovered" : "unreadable",
      );
    }
    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return {
      blob,
      report: {
        ...base,
        mode: "raster",
        actions: ["rasterized"],
        pagesRecovered: pages,
        // pdf.js pudo decir cuantas paginas hay: es un denominador mas
        // fiable que el `/Count` en crudo, asi que manda.
        pagesDeclared: total > 0 ? total : pagesDeclared,
        bytesDiscarded: 0,
        textPreserved: false,
        failedPages,
        outputBytes: blob.size,
      },
    };
  } catch (error) {
    if (error instanceof RepairError) throw error;
    if (error instanceof PdfError && error.code === "cancelled") throw error;
    if (error instanceof PdfError && error.code === "encrypted") {
      throw new RepairError("encrypted");
    }
    const text = error instanceof Error ? error.message.toLowerCase() : "";
    if (encryptedSeen || text.includes("password")) {
      throw new RepairError("encrypted");
    }
    // Ni pdf-lib ni pdf.js reconocieron un PDF: no se entrega nada.
    throw new RepairError("unreadable");
  }
}
