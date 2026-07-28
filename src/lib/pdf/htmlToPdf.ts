import {
  PdfError,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

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
 * Todo ocurre en el navegador: ningun byte sale del dispositivo y no hay
 * proxy de recursos externos (sin servidor, no hay nada que proxyar).
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

export const DEFAULT_HTML_TO_PDF_OPTIONS: HtmlToPdfOptions = {
  pageSize: "a4",
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
 */
export function planPageSlices(
  canvasHeight: number,
  sliceHeight: number,
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
 * recursos), limpia y vuelve a serializar.
 */
export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === "undefined") {
    throw new PdfError("unknown", "DOMParser unavailable");
  }
  const parsed = new DOMParser().parseFromString(html, "text/html");
  sanitizeDocument(parsed);
  return `<!DOCTYPE html>${parsed.documentElement.outerHTML}`;
}

/* ------------------------------------------------------------------ *
 * Render aislado
 * ------------------------------------------------------------------ */

type MountedFrame = {
  frame: HTMLIFrameElement;
  document: Document;
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

    // El alto se ajusta al contenido en dos pasadas: la primera revela el
    // alto real y la segunda deja que las unidades `vh` se reevaluen con
    // el nuevo viewport (converge, porque `min-height:100vh` iguala al
    // propio alto ya aplicado).
    await waitForImages(inner);
    for (let pass = 0; pass < 2; pass += 1) {
      const height = measureHeight(inner);
      if (height > MAX_DOCUMENT_HEIGHT_PX) throw new PdfError("tooLarge");
      if (Math.abs(height - frame.offsetHeight) < 1) break;
      frame.style.height = `${Math.ceil(height)}px`;
    }

    const height = Math.min(MAX_DOCUMENT_HEIGHT_PX, measureHeight(inner));
    return { frame, document: inner, height };
  } catch (error) {
    frame.remove();
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * API de la herramienta
 * ------------------------------------------------------------------ */

/** Calidad JPEG de cada banda. Compromiso entre nitidez y peso. */
const SLICE_JPEG_QUALITY = 0.92;

function sliceToDataUrl(
  source: HTMLCanvasElement,
  slice: PageSlice,
): string {
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
    return target.toDataURL("image/jpeg", SLICE_JPEG_QUALITY);
  } finally {
    target.width = 0;
    target.height = 0;
  }
}

/**
 * Convierte un archivo HTML en PDF rasterizando su render.
 *
 * El resultado es una instantanea visual: no conserva texto seleccionable
 * ni la estructura del documento, y el CSS complejo, las tipografias
 * externas y todo lo que dependa de JavaScript pueden no reproducirse.
 */
export async function htmlToPdf(
  file: File,
  options: HtmlToPdfOptions = DEFAULT_HTML_TO_PDF_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
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

    const safeHtml = sanitizeHtml(source);
    onProgress?.(0.08);
    throwIfAborted(signal);

    const geometry = resolvePageGeometry(options);
    // El iframe se maqueta con el ancho exacto del area util de la pagina
    // convertido a px CSS: asi los anchos relativos y las `media queries`
    // ven un viewport coherente con el PDF final.
    const widthPx = Math.max(1, Math.round(geometry.contentWidth * PX_PER_PT));
    const sliceHeightPx = Math.max(1, geometry.contentHeight * PX_PER_PT);

    mounted = await mountSandboxedFrame(safeHtml, widthPx, sliceHeightPx);
    onProgress?.(0.15);
    throwIfAborted(signal);

    const scale = resolveCaptureScale(
      widthPx,
      typeof window === "undefined" ? 2 : (window.devicePixelRatio ?? 1) + 0.5,
    );
    const chunks = planCaptureChunks(
      mounted.height,
      sliceHeightPx,
      MAX_CANVAS_DIMENSION / scale,
    );

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

    for (let index = 0; index < chunks.length; index += 1) {
      throwIfAborted(signal);
      const chunk = chunks[index];

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
        y: chunk.y,
        width: widthPx,
        height: chunk.height,
        windowWidth: widthPx,
        windowHeight: mounted.height,
        scrollX: 0,
        scrollY: 0,
      });

      const slices = planPageSlices(canvas.height, sliceHeightPx * scale);
      // Puntos PDF por pixel de canvas: el ancho encaja exacto en el area
      // util, asi que la misma relacion vale para el alto.
      const ptPerPx = geometry.contentWidth / Math.max(1, canvas.width);

      for (const slice of slices) {
        throwIfAborted(signal);
        const dataUrl = sliceToDataUrl(canvas, slice);
        if (pageCount > 0) {
          pdf.addPage([geometry.pageWidth, geometry.pageHeight]);
        }
        pdf.addImage(
          dataUrl,
          "JPEG",
          geometry.margin,
          geometry.margin,
          geometry.contentWidth,
          Math.min(geometry.contentHeight, slice.height * ptPerPx),
          undefined,
          "FAST",
        );
        pageCount += 1;
      }

      canvas.width = 0;
      canvas.height = 0;
      onProgress?.(0.15 + ((index + 1) / chunks.length) * 0.8);
    }

    if (pageCount === 0) throw new PdfError("empty");

    const blob = pdf.output("blob");
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  } finally {
    mounted?.frame.remove();
  }
}
