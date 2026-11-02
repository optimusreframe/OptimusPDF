import {
  PdfError,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  collectBreakConstraints,
  neutralizeFloatingElements,
  prepareDocumentForPdf,
} from "@/lib/pdf/htmlToPdfLayout";
import {
  findCleanRow,
  groupPagesIntoBatches,
  planPages,
  SNAP_OVERSCAN_PX,
  SNAP_SLACK_PX,
  SNAP_WINDOW_PX,
} from "@/lib/pdf/htmlToPdfPagination";

/**
 * Motor "HTML -> PDF".
 *
 * El archivo que sube el usuario es CONTENIDO NO CONFIABLE: puede traer
 * `<script>`, manejadores `onerror=`, iframes anidados o URLs
 * `javascript:`. El motor nunca lo trata como codigo propio. La cadena
 * completa es:
 *
 *   1. `decodeHtml`     - bytes -> texto (respetando el charset declarado).
 *   2. `sanitizeHtml`   - se parsea con `DOMParser` (documento INERTE: no
 *                         ejecuta scripts ni descarga recursos) y se
 *                         eliminan elementos y atributos peligrosos.
 *   3. `mountSandboxedFrame` - el resultado se monta en un `<iframe
 *                         sandbox="allow-same-origin">` fuera de pantalla.
 *                         Al NO incluir `allow-scripts`, el navegador
 *                         desactiva el scripting en ese contexto: ni
 *                         `<script>`, ni `onload=`, ni `javascript:`
 *                         llegan a ejecutarse. `allow-same-origin` solo
 *                         se concede porque html2canvas necesita leer el
 *                         DOM; sin `allow-scripts` no otorga capacidad
 *                         alguna al contenido subido.
 *   4. `html2canvas`    - rasteriza. Internamente clona el arbol dentro de
 *                         OTRO iframe que crea en `element.ownerDocument`
 *                         (ver `createIFrameContainer` en
 *                         html2canvas 1.4.1). Como el elemento capturado
 *                         pertenece al documento del iframe sandbox, ese
 *                         iframe interno queda ANIDADO dentro de el y
 *                         hereda sus flags de sandbox: tampoco alli hay
 *                         scripting. Ademas html2canvas descarta por su
 *                         cuenta los nodos `SCRIPT` al clonar.
 *   5. `jsPDF`          - se trocea el canvas en paginas y se ensambla.
 *
 * El HTML llega de un archivo que sube la persona o, con «Direccion web», de
 * `POST /api/html-snapshot` (el unico paso que usa el servidor: el navegador no
 * puede leer otras webs por CORS). Esa ruta devuelve una pagina autocontenida y
 * ya saneada, pero aqui se vuelve a tratar como NO CONFIABLE: pasa por exactamente
 * la misma cadena de arriba. Renderizar y crear el PDF ocurre siempre en el
 * navegador; el motor no pide ningun recurso externo (la CSP del marco solo
 * admite `data:`).
 *
 * Distribucion en la hoja (ver `htmlToPdfLayout.ts` y `htmlToPdfPagination.ts`):
 * se maqueta con el ancho de la hoja (816 px en Carta), se aplica el `@media
 * print` de la pagina, las barras fijas pasan al flujo y los avisos flotantes se
 * quitan, y las paginas se cortan en los huecos entre lineas, imagenes y filas
 * de tabla en lugar de cada `H` pixeles.
 */

/* ------------------------------------------------------------------ *
 * Opciones y geometria
 * ------------------------------------------------------------------ */

export type HtmlPageSize = "a4" | "letter";
export type HtmlOrientation = "portrait" | "landscape";
export type HtmlMargin = "none" | "small" | "large";

export type HtmlToPdfOptions = {
  pageSize: HtmlPageSize;
  orientation: HtmlOrientation;
  margin: HtmlMargin;
};

/** Carta, vertical, margen de 0,5 in (36 pt). A4 sigue disponible en las opciones. */
export const DEFAULT_HTML_TO_PDF_OPTIONS: HtmlToPdfOptions = {
  pageSize: "letter",
  orientation: "portrait",
  margin: "small",
};

/** Puntos PostScript (1 pt = 1/72") de los tamanos estandar en vertical. */
const PAGE_SIZES_PT: Record<HtmlPageSize, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MARGINS_PT: Record<HtmlMargin, number> = {
  none: 0,
  small: 36,
  large: 64,
};

/** 1 px CSS = 1/96"; 1 pt = 1/72". */
export const PX_PER_PT = 96 / 72;

export type HtmlPageGeometry = {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  /** Ancho util (pagina menos margenes), en puntos. */
  contentWidth: number;
  /** Alto util (pagina menos margenes), en puntos. */
  contentHeight: number;
};

export function resolvePageGeometry(
  options: HtmlToPdfOptions,
): HtmlPageGeometry {
  const [shortSide, longSide] = PAGE_SIZES_PT[options.pageSize];
  const landscape = options.orientation === "landscape";
  const pageWidth = landscape ? longSide : shortSide;
  const pageHeight = landscape ? shortSide : longSide;

  // El margen nunca puede comerse la pagina entera: se acota a un tercio
  // del lado menor para que siempre quede area util.
  const limit = Math.min(pageWidth, pageHeight) / 3;
  const margin = Math.min(MARGINS_PT[options.margin], limit);

  return {
    pageWidth,
    pageHeight,
    margin,
    contentWidth: Math.max(1, pageWidth - margin * 2),
    contentHeight: Math.max(1, pageHeight - margin * 2),
  };
}

/* ------------------------------------------------------------------ *
 * Presupuesto de canvas y paginacion
 * ------------------------------------------------------------------ */

/**
 * Limite conservador de lado de canvas. Chrome admite mucho mas, pero
 * Safari (sobre todo en iOS) falla en silencio bastante antes: si el
 * canvas excede el maximo del dispositivo se obtiene un lienzo en blanco,
 * no una excepcion. Por eso se trocea la captura.
 */
export const MAX_CANVAS_DIMENSION = 8192;

/**
 * Tope de pixeles por lienzo (lado x lado). iOS limita el AREA de un lienzo (~16,7 millones) ademas del lado, y falla con
 * un lienzo en blanco; en iOS/iPadOS se baja a 8 millones para dejar margen de memoria.
 */
export const MAX_CANVAS_PIXELS = 12_000_000;
export const MAX_CANVAS_PIXELS_IOS = 8_000_000;

/** Escala de rasterizado por defecto: 2 da texto nitido en una hoja carta (1632 px de ancho). */
export const DEFAULT_CAPTURE_SCALE = 2;

/** Ancho maximo con el que se maqueta una pagina mas ancha que la hoja (se reduce para que quepa). */
export const MAX_LAYOUT_WIDTH_PX = 1800;

export const CAPTURE_SCALE_MIN = 0.75;
export const CAPTURE_SCALE_MAX = 2;

/** Altura maxima del documento renderizado, en px CSS. */
export const MAX_DOCUMENT_HEIGHT_PX = 200_000;

/** Tamano maximo del archivo HTML de entrada. */
export const MAX_HTML_BYTES = 20 * 1024 * 1024;

/**
 * Escala de rasterizado. Se pide `desired` (normalmente el
 * `devicePixelRatio`) pero se acota para que el ancho del canvas no
 * supere `MAX_CANVAS_DIMENSION`.
 */
export function resolveCaptureScale(cssWidth: number, desired: number): number {
  const width = Math.max(1, cssWidth);
  const wanted = Number.isFinite(desired) ? desired : CAPTURE_SCALE_MIN;
  const capped = Math.min(
    Math.max(wanted, CAPTURE_SCALE_MIN),
    CAPTURE_SCALE_MAX,
  );
  return Math.max(0.25, Math.min(capped, MAX_CANVAS_DIMENSION / width));
}

/*
 * `planCaptureChunks` y `planPageSlices` son el troceado ORIGINAL (cada `H` px, a ciegas). El motor ya no los usa: reparte con
 * `planPages` / `groupPagesIntoBatches` (`htmlToPdfPagination.ts`), que corta entre lineas. Se conservan exportados y probados
 * como API publica del modulo.
 */
export type CaptureChunk = {
  /** Desplazamiento vertical dentro del documento, en px CSS. */
  y: number;
  height: number;
};

/**
 * Reparte la altura del documento en trozos que quepan en un canvas.
 * Cada trozo mide un numero ENTERO de paginas, asi que ningun corte de
 * pagina cae a mitad de un trozo y el recorte posterior es exacto.
 */
export function planCaptureChunks(
  documentHeight: number,
  sliceHeight: number,
  maxChunkHeight: number,
): CaptureChunk[] {
  const total = Math.max(1, documentHeight);
  const slice = Math.max(1, sliceHeight);
  const budget = Math.max(slice, maxChunkHeight);
  const chunkHeight = Math.max(1, Math.floor(budget / slice)) * slice;

  const chunks: CaptureChunk[] = [];
  for (let y = 0; y < total; y += chunkHeight) {
    chunks.push({ y, height: Math.min(chunkHeight, total - y) });
  }
  return chunks;
}

export type PageSlice = {
  /** Fila inicial dentro del canvas del trozo, en px de canvas. */
  y: number;
  height: number;
};

/**
 * Corta el canvas de un trozo en bandas de una pagina. Los limites se
 * redondean a partir del indice para que el error de coma flotante no se
 * acumule y no queden lineas repetidas o perdidas entre paginas.
 *
 * `tailTolerance` (px de canvas, 0 por defecto): una ULTIMA banda de esa altura o menos (con mas de una banda) se
 * descarta. El alto del documento se mide en px CSS enteros (`scrollHeight`), asi que puede pasarse de la pagina por
 * hasta 1 px CSS de redondeo (p. ej. 1027 frente a 1026,52): a escala 2 (Retina, iPhone) eso es una banda de 1 px y
 * salia una pagina extra casi en blanco al final de CUALQUIER documento corto. Quien llama pasa la escala (1 px CSS).
 */
export function planPageSlices(
  canvasHeight: number,
  sliceHeight: number,
  tailTolerance = 0,
): PageSlice[] {
  const total = Math.floor(canvasHeight);
  const slice = Math.max(1, sliceHeight);
  if (total <= 0) return [];

  const count = Math.max(1, Math.ceil(total / slice));
  const slices: PageSlice[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.min(total, Math.round(index * slice));
    const end = Math.min(total, Math.round((index + 1) * slice));
    if (end - start < 1) continue;
    slices.push({ y: start, height: end - start });
  }
  if (slices.length > 1 && slices[slices.length - 1].height <= tailTolerance) slices.pop();
  return slices;
}

/* ------------------------------------------------------------------ *
 * Entrada: validacion y decodificacion
 * ------------------------------------------------------------------ */

export function isHtmlFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    file.type === "text/html" ||
    file.type === "application/xhtml+xml" ||
    name.endsWith(".html") ||
    name.endsWith(".htm") ||
    name.endsWith(".xhtml")
  );
}

/**
 * Deduce la codificacion del archivo: BOM primero y, si no lo hay, el
 * `<meta charset>` declarado en la cabecera. Sin ninguna pista, UTF-8.
 */
export function sniffHtmlCharset(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";

  // El nombre del charset siempre es ASCII, asi que decodificar la
  // cabecera como UTF-8 (no estricto) basta para encontrarlo.
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.+-]+)/i.exec(head) ??
    /<\?xml[^>]+encoding\s*=\s*["']\s*([a-z0-9_:.+-]+)/i.exec(head);
  return meta ? meta[1].toLowerCase() : "utf-8";
}

export function decodeHtml(bytes: Uint8Array): string {
  const charset = sniffHtmlCharset(bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // Charset declarado pero desconocido para el navegador.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/* ------------------------------------------------------------------ *
 * Saneado del HTML no confiable
 * ------------------------------------------------------------------ */

/**
 * Elementos que se eliminan siempre. Se compara por `localName`, no por
 * `tagName`, para cubrir tambien `<script>` dentro de `<svg>` (en SVG el
 * nombre va en minusculas y una comparacion con "SCRIPT" no lo detecta;
 * html2canvas tiene justo ese punto ciego).
 */
const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "portal",
  "noembed",
  "noframes",
  "audio",
  "video",
]);

/** Atributos que se retiran pase lo que pase. */
const STRIPPED_ATTRIBUTES = new Set([
  "srcdoc",
  "ping",
  "action",
  "formaction",
  "target",
  "http-equiv",
  "manifest",
  "integrity",
  "nonce",
  "autofocus",
]);

/** Atributos cuyo valor es una URL y hay que validar. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "xlink:href",
  "data",
  "poster",
  "background",
  "cite",
  "longdesc",
  "codebase",
  "profile",
  "icon",
]);

const SAFE_IMAGE_DATA_URL =
  /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|x-icon|svg\+xml)\s*[;,]/i;

/**
 * Espacios, tabuladores, saltos de linea y caracteres de control: el
 * navegador los ignora al resolver una URL, asi que "java\nscript:" es
 * `javascript:`. Se construye con `RegExp` porque un rango de control
 * literal dispara la regla `no-control-regex` de ESLint.
 */
const URL_NOISE = new RegExp("[\\u0000-\\u0020\\u007f]", "g");

/**
 * Solo se dejan pasar URLs relativas, fragmentos, `http(s):` y `data:`
 * de imagen. Eso descarta `javascript:`, `vbscript:`, `data:text/html`,
 * `blob:` y `file:`.
 *
 * El valor llega ya decodificado por el parser (`&#106;avascript:` es
 * `javascript:` a estas alturas), que es justo la ventaja de sanear sobre
 * el DOM y no sobre la cadena original.
 */
export function isSafeResourceUrl(value: string): boolean {
  // Espacios y caracteres de control se ignoran al resolver una URL, asi
  // que "java\nscript:" hay que verlo como "javascript:".
  const clean = value.replace(URL_NOISE, "");
  if (clean === "") return true;
  if (clean.startsWith("#")) return true;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean);
  if (!scheme) return true; // relativa

  const protocol = scheme[1].toLowerCase();
  if (protocol === "http" || protocol === "https") return true;
  if (protocol === "data") return SAFE_IMAGE_DATA_URL.test(clean);
  return false;
}

/** Un `srcset` solo se conserva si TODOS sus candidatos son seguros. */
export function isSafeSrcset(value: string): boolean {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .every((url) => isSafeResourceUrl(url));
}

/**
 * CSP que se inyecta en el documento aislado. `default-src 'none'` deja
 * fuera scripts, workers, `connect-src` y cualquier navegacion; solo se
 * reabre lo que hace falta para PINTAR: imagenes, hojas de estilo y
 * tipografias. `form-action` y `base-uri` en 'none' impiden que un
 * formulario o un `<base>` reintroducido cambien el destino de nada.
 *
 * Nada de `http:`/`https:` en img-src/style-src/font-src: permitirlos
 * dejaria que el HTML no confiable disparase peticiones de red reales
 * (imagenes, `@font-face`, hojas de estilo remotas) hacia cualquier
 * origen -- filtracion de IP/tracking a terceros, y en el propio origen
 * un GET "ciego" con las cookies de la app. Solo `data:` (embebido en el
 * propio HTML) esta permitido; un recurso remoto simplemente no carga,
 * que es justo lo que la copia de la herramienta ya advierte.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "img-src data:",
  "style-src 'unsafe-inline' data:",
  "font-src data:",
].join("; ");

function isStylesheetLink(element: Element): boolean {
  const rel = (element.getAttribute("rel") ?? "").toLowerCase();
  return rel.split(/\s+/).includes("stylesheet");
}

function cleanAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();

    // Cualquier manejador inline: onclick, onerror, onload, onanimationend...
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (STRIPPED_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === "style") {
      if (/(?:javascript|vbscript)\s*:/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
      continue;
    }
    if (name === "srcset" || name === "imagesrcset") {
      if (!isSafeSrcset(attribute.value)) element.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeResourceUrl(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }
}

/**
 * Limpia un documento ya parseado. Se separa de `sanitizeHtml` para poder
 * razonar sobre el paso (y reutilizarlo) sin depender de `DOMParser`.
 */
export function sanitizeDocument(document: Document): void {
  for (const element of Array.from(document.querySelectorAll("*"))) {
    const local = element.localName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(local)) {
      element.remove();
      continue;
    }
    if (local === "link" && !isStylesheetLink(element)) {
      element.remove();
      continue;
    }
    cleanAttributes(element);
  }

  const head = document.head;
  if (!head) return;

  // Sin referer: el HTML subido no debe filtrar la URL de OptimusPDF a
  // los servidores de las imagenes o tipografias a las que apunte.
  const referrer = document.createElement("meta");
  referrer.setAttribute("name", "referrer");
  referrer.setAttribute("content", "no-referrer");
  head.insertBefore(referrer, head.firstChild);

  // Tercera capa, independiente del atributo `sandbox` y del propio
  // saneador: aunque un mXSS del viaje parsear -> serializar -> volver a
  // parsear reintrodujese un `<script>` o un `onerror`, la CSP los
  // bloquea igualmente. Se inserta la PRIMERA para que cubra todo lo que
  // el parser lea despues.
  const csp = document.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", CONTENT_SECURITY_POLICY);
  head.insertBefore(csp, head.firstChild);
}

/**
 * Parsea con `DOMParser` (documento inerte: no ejecuta scripts ni pide
 * recursos), limpia y vuelve a serializar. Con `prepare` aplica ademas la
 * preparacion para el PDF (`@media print`, unidades `vh`, hoja base): sigue
 * siendo un paso sobre el documento inerte, antes de montarlo.
 */
export function sanitizeHtml(html: string, prepare?: { viewportHeightPx: number }): string {
  if (typeof DOMParser === "undefined") {
    throw new PdfError("unknown", "DOMParser unavailable");
  }
  const parsed = new DOMParser().parseFromString(html, "text/html");
  sanitizeDocument(parsed);
  if (prepare) prepareDocumentForPdf(parsed, prepare);
  return `<!DOCTYPE html>${parsed.documentElement.outerHTML}`;
}

/* ------------------------------------------------------------------ *
 * Render aislado
 * ------------------------------------------------------------------ */

type MountedFrame = {
  frame: HTMLIFrameElement;
  document: Document;
  /** Ancho con el que se maqueto (la hoja; mas si la pagina es mas ancha), en px CSS. */
  width: number;
  /** Alto real del documento maquetado, en px CSS. */
  height: number;
};

const FRAME_LOAD_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 8_000;

function waitForFrameLoad(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new PdfError("unknown", "HTML preview timed out"));
    }, FRAME_LOAD_TIMEOUT_MS);

    function cleanup() {
      window.clearTimeout(timer);
      frame.removeEventListener("load", onLoad);
    }
    function onLoad() {
      cleanup();
      resolve();
    }
    frame.addEventListener("load", onLoad);
  });
}

/** Cada cuanto se mira si el documento de un iframe anidado ya termino de cargar. */
const NESTED_FRAME_POLL_MS = 25;

/**
 * Da a un iframe creado DENTRO del documento aislado una propiedad `onload` que se dispara desde la pagina.
 *
 * Por que: WebKit (Safari) no ejecuta NINGUN manejador de eventos sobre los elementos de un documento sin scripts
 * (`sandbox` sin `allow-scripts`), ni `onload =` ni `addEventListener`, aunque el manejador lo asigne la propia
 * pagina («Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed...»). html2canvas
 * clona el arbol en un iframe que crea dentro de ese documento y espera su `onload`: en Safari no llegaba nunca y la
 * conversion se quedaba para siempre en el 11 %. Chrome y Firefox si los ejecutan.
 *
 * Como se resuelve (sin tocar el sandbox ni dar scripts al contenido): el iframe recibe su propia propiedad `onload`
 * (una propiedad de JS sobre el objeto, no el atributo nativo). Al asignarle un manejador, un temporizador de la
 * PAGINA mira `contentDocument.readyState` (legible porque el sandbox conserva `allow-same-origin`) y llama al
 * manejador una sola vez cuando el documento esta `complete`, igual que haria el evento `load`.
 */
export function installPolledOnload(frame: HTMLIFrameElement): void {
  let handler: ((event: Event) => unknown) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const loaded = (): boolean => {
    try {
      return frame.contentDocument?.readyState === "complete";
    } catch {
      return false;
    }
  };

  Object.defineProperty(frame, "onload", {
    configurable: true,
    get: () => handler,
    set: (value: unknown) => {
      stop();
      handler = typeof value === "function" ? (value as (event: Event) => unknown) : null;
      if (!handler) return;
      const startedAt = Date.now();
      timer = setInterval(() => {
        if (!loaded() && Date.now() - startedAt < FRAME_LOAD_TIMEOUT_MS) return;
        stop();
        const fire = handler;
        handler = null;
        fire?.call(frame, new Event("load"));
      }, NESTED_FRAME_POLL_MS);
    },
  });
}

/**
 * Hace que los iframes que html2canvas cree en `sandboxDocument` (el iframe de clonado) avisen de su carga aunque el
 * motor no ejecute manejadores en ese documento. Ver `installPolledOnload`.
 */
export function makeNestedFramesLoadObservable(sandboxDocument: Document): void {
  const createElement = sandboxDocument.createElement.bind(sandboxDocument) as (
    tagName: string,
    options?: ElementCreationOptions,
  ) => HTMLElement;
  (sandboxDocument as unknown as { createElement: typeof createElement }).createElement = (tagName, options) => {
    const element = createElement(tagName, options);
    if (tagName.toLowerCase() === "iframe") installPolledOnload(element as HTMLIFrameElement);
    return element;
  };
}

/** Espera a que las imagenes esten resueltas (o fallidas) antes de medir. */
function waitForImages(document: Document): Promise<void> {
  const images = Array.from(document.images);
  if (images.length === 0) return Promise.resolve();

  const settled = images.map(
    (image) =>
      new Promise<void>((resolve) => {
        if (image.complete) {
          resolve();
          return;
        }
        const done = () => resolve();
        image.addEventListener("load", done, { once: true });
        // Un `src` roto NO debe abortar la conversion: se resuelve igual
        // y la imagen simplemente no se dibuja.
        image.addEventListener("error", done, { once: true });
      }),
  );

  return Promise.race([
    Promise.all(settled).then(() => undefined),
    new Promise<void>((resolve) =>
      window.setTimeout(resolve, IMAGE_TIMEOUT_MS),
    ),
  ]);
}

function measureHeight(document: Document): number {
  const root = document.documentElement;
  const body = document.body;
  return Math.max(
    1,
    root?.scrollHeight ?? 0,
    root?.offsetHeight ?? 0,
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
  );
}

/**
 * Monta el HTML saneado en un iframe aislado y fuera de pantalla.
 *
 * `sandbox="allow-same-origin"` SIN `allow-scripts` es la combinacion
 * segura: el navegador desactiva el scripting del documento, de modo que
 * `allow-same-origin` no concede nada al contenido subido y si permite
 * que html2canvas (que corre en la app) lea el DOM para rasterizarlo.
 *
 * Maquetacion: el ancho es el de la HOJA (`widthPx`); si el contenido es mas
 * ancho (una tabla de 1400 px, un `min-width`), se vuelve a maquetar con ese
 * ancho (hasta `MAX_LAYOUT_WIDTH_PX`) y la pagina se REDUCE al imprimir, en vez
 * de recortarse. Las barras fijas pasan al flujo y los avisos flotantes se
 * quitan antes de medir (`neutralizeFloatingElements`).
 */
async function mountSandboxedFrame(
  html: string,
  widthPx: number,
  viewportHeightPx: number,
): Promise<MountedFrame> {
  const frame = document.createElement("iframe");
  // El sandbox se fija ANTES de insertar y de asignar contenido: si se
  // pusiera despues, el documento ya se habria creado sin restricciones.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", "");
  frame.tabIndex = -1;
  frame.style.cssText = [
    "position:fixed",
    "left:-100000px",
    "top:0",
    "border:0",
    "margin:0",
    "padding:0",
    "background:#ffffff",
    "pointer-events:none",
    "z-index:-1",
    `width:${Math.round(widthPx)}px`,
    `height:${Math.round(viewportHeightPx)}px`,
  ].join(";");

  document.body.appendChild(frame);

  try {
    const loaded = waitForFrameLoad(frame);
    frame.srcdoc = html;
    await loaded;

    const inner = frame.contentDocument;
    if (!inner) {
      throw new PdfError("unknown", "Sandboxed document unavailable");
    }

    // Safari no entrega `onload` a los iframes de este documento sin scripts: html2canvas lo necesita (ver
    // `installPolledOnload`).
    makeNestedFramesLoadObservable(inner);

    await waitForImages(inner);
    neutralizeFloatingElements(inner, { width: widthPx, height: viewportHeightPx });

    // Ancho: si el contenido no cabe en la hoja se maqueta mas ancho (y se reducira al imprimir). Dos pasadas porque al
    // ensanchar, el contenido fluido puede volver a reordenarse.
    let width = Math.round(widthPx);
    for (let pass = 0; pass < 2; pass += 1) {
      const overflow = Math.ceil(measureWidth(inner));
      if (overflow <= width + 2 || width >= MAX_LAYOUT_WIDTH_PX) break;
      width = Math.min(MAX_LAYOUT_WIDTH_PX, overflow);
      frame.style.width = `${width}px`;
    }

    // El alto se ajusta al contenido en dos pasadas: la primera revela el alto real y la segunda deja que lo anclado al
    // viewport se reevalue (las unidades `vh` ya son px fijos desde `prepareDocumentForPdf`).
    for (let pass = 0; pass < 2; pass += 1) {
      const height = measureHeight(inner);
      if (height > MAX_DOCUMENT_HEIGHT_PX) throw new PdfError("tooLarge");
      if (Math.abs(height - frame.offsetHeight) < 1) break;
      frame.style.height = `${Math.ceil(height)}px`;
    }

    const height = Math.min(MAX_DOCUMENT_HEIGHT_PX, measureHeight(inner));
    return { frame, document: inner, width, height };
  } catch (error) {
    frame.remove();
    throw error;
  }
}

function measureWidth(document: Document): number {
  const root = document.documentElement;
  const body = document.body;
  return Math.max(1, root?.scrollWidth ?? 0, body?.scrollWidth ?? 0);
}

/* ------------------------------------------------------------------ *
 * API de la herramienta
 * ------------------------------------------------------------------ */

/** Calidad JPEG de cada banda. Compromiso entre nitidez y peso. */
const SLICE_JPEG_QUALITY = 0.92;

/** Un pixel cuenta como «tinta» si algun canal baja de este valor (el blanco con ruido JPEG no cuenta). */
const BLANK_THRESHOLD = 250;

/** `true` si el lienzo es todo blanco (una pagina sin nada que ver: no se emite). */
export function isBlankCanvas(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context || canvas.width === 0 || canvas.height === 0) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] < BLANK_THRESHOLD || data[index + 1] < BLANK_THRESHOLD || data[index + 2] < BLANK_THRESHOLD) return false;
  }
  return true;
}

/** iOS y iPadOS (que se presenta como Mac con pantalla tactil): lienzos mas pequenos por su limite de memoria. */
export function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Ajusta un corte (px del documento) a la banda en blanco mas cercana mirando los pixeles del lienzo capturado. El corte
 * nunca sube por debajo de `minY` + 1/4 de pagina ni pasa de `maxY`; sin banda lisa cerca (cruza una imagen o un degradado)
 * se devuelve el corte planificado.
 */
function snapCut(canvas: HTMLCanvasElement, canvasY: number, scale: number, planned: number, maxY: number, minY: number): number {
  const context = canvas.getContext("2d");
  if (!context) return planned;
  const target = Math.round((planned - canvasY) * scale);
  const shift = Math.ceil(SNAP_WINDOW_PX * scale);
  const first = Math.max(0, target - shift - 2);
  const last = Math.min(canvas.height - 1, target + shift + 2);
  if (last <= first) return planned;
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, first, canvas.width, last - first + 1).data;
  } catch {
    return planned;
  }
  const minRow = Math.round((minY + (maxY - minY) * 0.25 - canvasY) * scale) - first;
  const maxRow = Math.round((maxY - canvasY) * scale) - first;
  const row = findCleanRow(data, canvas.width, last - first + 1, target - first, shift, minRow, maxRow);
  return row === null ? planned : canvasY + (row + first) / scale;
}

/**
 * Recorta la banda `slice` del lienzo. Devuelve el JPEG y si la banda esta en blanco. El lienzo de destino se libera
 * siempre.
 */
function sliceToJpeg(
  source: HTMLCanvasElement,
  slice: PageSlice,
): { dataUrl: string; blank: boolean } {
  const target = document.createElement("canvas");
  target.width = source.width;
  target.height = slice.height;

  const context = target.getContext("2d");
  if (!context) throw new PdfError("unknown", "Canvas 2D context unavailable");

  // JPEG no tiene canal alfa: sin fondo blanco las zonas transparentes
  // saldrian negras.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(
    source,
    0,
    slice.y,
    source.width,
    slice.height,
    0,
    0,
    source.width,
    slice.height,
  );

  try {
    return { dataUrl: target.toDataURL("image/jpeg", SLICE_JPEG_QUALITY), blank: isBlankCanvas(target) };
  } finally {
    target.width = 0;
    target.height = 0;
  }
}

/** Datos de la distribucion de una conversion; solo para diagnostico y pruebas. */
export type HtmlLayoutReport = {
  /** Paginas del PDF. */
  pages: number;
  /** Paginas en blanco que se descartaron. */
  blankPagesSkipped: number;
  /** Cortes a ciegas (ninguna posicion valida entre lineas); 0 en documentos normales. */
  forcedBreaks: number;
  /** Cortes que el ajuste fino sobre los pixeles movio a una banda realmente en blanco. */
  snappedCuts: number;
  /** Ancho con el que se maqueto la pagina, en px CSS (816 = Carta; mas si la pagina era mas ancha). */
  layoutWidthPx: number;
  /** Alto del documento maquetado, en px CSS. */
  documentHeightPx: number;
  /** Escala de rasterizado usada. */
  scale: number;
};

/**
 * Convierte un archivo HTML en PDF rasterizando su render.
 *
 * El resultado es una instantanea visual: no conserva texto seleccionable
 * ni la estructura del documento, y el CSS complejo, las tipografias
 * externas y todo lo que dependa de JavaScript pueden no reproducirse.
 *
 * `onLayout` recibe, al terminar, los datos de la distribucion (paginas, cortes, escala) para diagnostico.
 */
export async function htmlToPdf(
  file: File,
  options: HtmlToPdfOptions = DEFAULT_HTML_TO_PDF_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  onLayout?: (report: HtmlLayoutReport) => void,
): Promise<Blob> {
  if (!file) throw new PdfError("empty");
  if (!isHtmlFile(file)) throw new PdfError("invalidType");
  if (file.size === 0) throw new PdfError("empty");
  if (file.size > MAX_HTML_BYTES) throw new PdfError("tooLarge");

  let mounted: MountedFrame | null = null;

  try {
    throwIfAborted(signal);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const source = decodeHtml(bytes);
    onProgress?.(0.02);

    const geometry = resolvePageGeometry(options);
    // Se maqueta con el ancho de la HOJA (816 px en Carta, 794 en A4) y el contenido se escala despues al area util:
    // el diseno no depende del margen elegido y cabe en el ancho en vez de salir diminuto. Un viewport de la altura de
    // UNA pagina es la referencia de `vh`.
    const paperWidthPx = Math.max(1, Math.round(geometry.pageWidth * PX_PER_PT));
    const viewportHeightPx = Math.max(1, Math.round((geometry.contentHeight / geometry.contentWidth) * paperWidthPx));

    const safeHtml = sanitizeHtml(source, { viewportHeightPx });
    onProgress?.(0.08);
    throwIfAborted(signal);

    mounted = await mountSandboxedFrame(safeHtml, paperWidthPx, viewportHeightPx);
    onProgress?.(0.15);
    throwIfAborted(signal);

    // Si la pagina era mas ancha que la hoja, el contenido se reduce para caber: mas px de maquetacion por pagina.
    const layoutWidthPx = mounted.width;
    const ptPerLayoutPx = geometry.contentWidth / layoutWidthPx;
    const pageHeightPx = geometry.contentHeight / ptPerLayoutPx;

    const constraints = collectBreakConstraints(mounted.document, { pageHeightPx });
    // Se planifica con un poco menos de pagina: el ajuste fino sobre los pixeles (`snapCut`) puede mover cada corte hasta
    // `SNAP_WINDOW_PX` y esa holgura evita que una pagina se pase de la hoja.
    const plan = planPages(mounted.height, Math.max(1, pageHeightPx - SNAP_SLACK_PX), constraints);
    throwIfAborted(signal);

    const ios = isIosLike();
    const scale = resolveCaptureScale(layoutWidthPx, DEFAULT_CAPTURE_SCALE);
    const maxCanvasHeight = Math.min(
      MAX_CANVAS_DIMENSION,
      Math.floor((ios ? MAX_CANVAS_PIXELS_IOS : MAX_CANVAS_PIXELS) / (layoutWidthPx * scale)),
    );
    // Cada lote es un tramo contiguo de paginas planificadas que cabe en un lienzo.
    const batches = groupPagesIntoBatches(plan.pages, Math.max(pageHeightPx, maxCanvasHeight / scale - 2 * SNAP_OVERSCAN_PX));

    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);

    const pdf = new jsPDF({
      unit: "pt",
      format: [geometry.pageWidth, geometry.pageHeight],
      orientation: options.orientation === "landscape" ? "landscape" : "portrait",
      compress: true,
    });

    let pageCount = 0;
    let blankSkipped = 0;
    /** Primera pagina en blanco: solo se usa si TODO el documento esta en blanco (un PDF necesita una pagina). */
    let firstBlank: { dataUrl: string; height: number } | null = null;
    const bottomLimit = geometry.pageHeight - geometry.margin;
    const lastPage = plan.pages[plan.pages.length - 1];
    /** Donde empieza la pagina que se esta cortando (px del documento); el corte anterior ya esta ajustado. */
    let startY = 0;
    let snapped = 0;

    for (let index = 0; index < batches.length; index += 1) {
      throwIfAborted(signal);
      const batch = batches[index];
      // Se captura un poco mas arriba y abajo de lo planificado, para poder ajustar los cortes de los bordes del lote.
      const captureY = Math.max(0, batch.y - SNAP_OVERSCAN_PX);
      const captureEnd = Math.min(mounted.height, batch.y + batch.height + SNAP_OVERSCAN_PX);

      const canvas = await html2canvas(mounted.document.documentElement, {
        backgroundColor: "#ffffff",
        scale,
        // Las imagenes de otros origenes se piden con CORS y, si el
        // servidor no lo permite, simplemente no se dibujan. `allowTaint`
        // en false garantiza ademas que el canvas nunca quede contaminado
        // y que `toDataURL` no lance SecurityError.
        useCORS: true,
        allowTaint: false,
        logging: false,
        imageTimeout: IMAGE_TIMEOUT_MS,
        removeContainer: true,
        x: 0,
        y: captureY,
        width: layoutWidthPx,
        height: captureEnd - captureY,
        windowWidth: layoutWidthPx,
        windowHeight: mounted.height,
        scrollX: 0,
        scrollY: 0,
      });

      // Puntos PDF por pixel de canvas: el ancho encaja exacto en el area util, asi que la misma relacion vale para el
      // alto.
      const ptPerCanvasPx = geometry.contentWidth / Math.max(1, canvas.width);
      const rowOf = (documentY: number) => Math.min(canvas.height, Math.max(0, Math.round((documentY - captureY) * scale)));

      for (const page of batch.pages) {
        throwIfAborted(signal);
        const planned = page.y + page.height;
        let endY = page === lastPage ? mounted.height : planned;
        if (page !== lastPage) {
          const adjusted = snapCut(canvas, captureY, scale, planned, startY + pageHeightPx, startY);
          if (adjusted !== planned) snapped += 1;
          endY = adjusted;
        }

        // Los limites se redondean a partir de la posicion absoluta: el error no se acumula y no quedan filas repetidas
        // ni perdidas entre paginas contiguas.
        const top = rowOf(startY);
        const bottom = rowOf(endY);
        startY = endY;
        if (bottom - top < 1) continue;

        const { dataUrl, blank } = sliceToJpeg(canvas, { y: top, height: bottom - top });
        const heightPt = Math.min((bottom - top) * ptPerCanvasPx, bottomLimit - geometry.margin);

        if (blank) {
          blankSkipped += 1;
          firstBlank ??= { dataUrl, height: heightPt };
          continue;
        }
        if (pageCount > 0) {
          pdf.addPage([geometry.pageWidth, geometry.pageHeight]);
        }
        pdf.addImage(
          dataUrl,
          "JPEG",
          geometry.margin,
          geometry.margin,
          geometry.contentWidth,
          heightPt,
          undefined,
          "FAST",
        );
        pageCount += 1;
      }

      canvas.width = 0;
      canvas.height = 0;
      onProgress?.(0.15 + ((index + 1) / batches.length) * 0.8);
    }

    if (pageCount === 0 && firstBlank) {
      pdf.addImage(firstBlank.dataUrl, "JPEG", geometry.margin, geometry.margin, geometry.contentWidth, firstBlank.height, undefined, "FAST");
      pageCount = 1;
      blankSkipped -= 1;
    }
    if (pageCount === 0) throw new PdfError("empty");

    const blob = pdf.output("blob");
    onLayout?.({
      pages: pageCount,
      blankPagesSkipped: blankSkipped,
      forcedBreaks: plan.forcedBreaks,
      snappedCuts: snapped,
      layoutWidthPx,
      documentHeightPx: mounted.height,
      scale,
    });
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  } finally {
    mounted?.frame.remove();
  }
}
