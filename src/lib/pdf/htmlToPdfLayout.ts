import type { BreakConstraints, Interval } from "@/lib/pdf/htmlToPdfPagination";

/**
 * Maquetacion para el PDF de «HTML a PDF»: todo lo que prepara el documento (antes y despues de montarlo) para que la
 * hoja salga bien dimensionada y bien repartida. Se divide en tres momentos:
 *
 *   1. ANTES de montar (`prepareDocumentForPdf`, sobre el documento inerte que devuelve `DOMParser`): aplica el `@media
 *      print` de la pagina, convierte las unidades `vh` a px, e inyecta una hoja base (imagenes al ancho de la hoja, sin
 *      animaciones, `html`/`body` que crecen con el contenido).
 *   2. AL montar (`neutralizeFloatingElements`): lo que depende de la maquetacion real. Las barras `fixed`/`sticky` pasan
 *      al flujo normal (salen UNA vez), y los avisos de cookies, ventanas modales y botones flotantes se quitan, porque en
 *      una captura de una sola pasada taparian contenido.
 *   3. DESPUES de maquetar (`collectBreakConstraints`): mide lineas de texto, imagenes, filas de tabla y encabezados para
 *      que `planPages` busque cortes que no los partan.
 */

/* ------------------------------------------------------------------ *
 * 1. Antes de montar
 * ------------------------------------------------------------------ */

/**
 * `@media print` -> aplicado. Las paginas suelen ocultar menus y anuncios y fijar tipografia/colores legibles para
 * imprimir: justo lo que se quiere en un PDF. Se reescribe el tipo de medio `print` por `all` en la lista de cada `@media`
 * (`print and (min-width:..)` -> `all and (min-width:..)`); `screen, print` ya se aplica y `not print` no se toca.
 * Las reglas de `screen` se dejan como estan: es mas seguro un exceso de estilos que una pagina sin ellos.
 */
export function applyPrintMedia(css: string): string {
  return css.replace(/@media\s+([^{;]+)\{/gi, (whole, prelude: string) => {
    const queries = prelude.split(",").map((query) => {
      const trimmed = query.trim();
      return /^(?:only\s+)?print(?![\w-])/i.test(trimmed) ? trimmed.replace(/print/i, "all") : trimmed;
    });
    return `@media ${queries.join(", ")}{`;
  });
}

/**
 * `100vh`/`100dvh`/... -> px fijos. En el iframe de la captura el viewport mide lo que mide el documento entero (crece
 * con el contenido), asi que un `min-height:100vh` o un hero `height:100vh` se estirarian hasta tener el alto de todo el
 * documento. Con la altura de UNA pagina como referencia, un hero a pantalla completa ocupa una pagina.
 */
export function rewriteViewportUnits(css: string, viewportHeightPx: number): string {
  return css.replace(/(-?(?:\d+\.?\d*|\.\d+))\s*(?:d|s|l)?vh\b/gi, (_whole, amount: string) => {
    const px = (Number(amount) * viewportHeightPx) / 100;
    return `${Math.round(px * 100) / 100}px`;
  });
}

export type PrepareOptions = {
  /** Alto de una pagina de contenido, en px CSS de maquetacion (referencia de `vh`). */
  viewportHeightPx: number;
};

/** Hoja base: va PRIMERO en `<head>`, asi que lo que no lleva `!important` cede ante la pagina. */
export function buildBaseCss(viewportHeightPx: number): string {
  const maxImageHeight = Math.max(200, Math.floor(viewportHeightPx * 0.92));
  return [
    // El documento crece con su contenido (nada de «scroll interno» a pantalla completa ni pie pegado al viewport).
    "html,body{height:auto!important;min-height:0!important;overflow:visible!important}",
    // Nada se sale del ancho de la hoja ni es mas alto que una pagina.
    "img,svg,canvas,picture,video,iframe,object,embed{max-width:100%!important}",
    `img{height:auto;max-height:${maxImageHeight}px!important;object-fit:contain}`,
    "table{max-width:100%}",
    "pre{white-space:pre-wrap!important;overflow-wrap:anywhere}",
    // Sin animaciones: el estado FINAL (una entrada con fundido que acaba en opacity:1 no sale invisible).
    "*,*::before,*::after{animation-duration:.001s!important;animation-delay:0s!important;animation-iteration-count:1!important;animation-fill-mode:forwards!important;transition:none!important;scroll-behavior:auto!important}",
  ].join("\n");
}

/** Reescritura de estilos del documento inerte; ver las funciones de arriba. */
export function prepareDocumentForPdf(document: Document, options: PrepareOptions): void {
  for (const style of Array.from(document.querySelectorAll("style"))) {
    // `<style media="print">`: se aplica siempre.
    if ((style.getAttribute("media") ?? "").trim().toLowerCase() === "print") style.removeAttribute("media");
    const css = style.textContent ?? "";
    style.textContent = rewriteViewportUnits(applyPrintMedia(css), options.viewportHeightPx);
  }
  for (const element of Array.from(document.querySelectorAll("[style]"))) {
    const value = element.getAttribute("style") ?? "";
    if (/vh\b/i.test(value)) element.setAttribute("style", rewriteViewportUnits(value, options.viewportHeightPx));
  }

  const head = document.head;
  if (!head) return;
  const base = document.createElement("style");
  base.setAttribute("data-optimus", "print-base");
  base.textContent = buildBaseCss(options.viewportHeightPx);
  // Despues de las metas de seguridad, antes de cualquier hoja de la pagina.
  const firstSheet = Array.from(head.children).find((child) => child.localName !== "meta");
  head.insertBefore(base, firstSheet ?? null);
}

/* ------------------------------------------------------------------ *
 * 2. Al montar: barras y avisos flotantes
 * ------------------------------------------------------------------ */

/** Avisos y widgets tipicos que se quedan fijos encima del contenido. */
const FLOATING_NOISE =
  /cookie|consent|gdpr|ccpa|privacy-?(banner|notice)|banner|popup|pop-up|modal|overlay|lightbox|newsletter|subscribe|chat|intercom|drift|crisp|zendesk|hubspot|back-?to-?top|scroll-?top|toast|snackbar|notification|promo|sticky-?cta|whatsapp/i;

const LAYOUT_BAR_TAGS = new Set(["header", "nav", "footer"]);

function elementNoiseText(element: Element): string {
  const className = typeof element.className === "string" ? element.className : (element.getAttribute("class") ?? "");
  return `${element.id} ${className} ${element.getAttribute("role") ?? ""}`;
}

/**
 * `position: sticky` -> flujo normal. `position: fixed`: las barras de ancho completo (cabecera, menu, pie) pasan al
 * flujo normal y salen una sola vez en su sitio; los avisos de cookies, modales, ventanas flotantes y botones sueltos se
 * ocultan. Devuelve cuantos elementos se tocaron (para pruebas). Con `viewport` se juzga el tamano del elemento.
 */
export function neutralizeFloatingElements(
  document: Document,
  viewport: { width: number; height: number },
): { madeStatic: number; removed: number } {
  const view = document.defaultView;
  const root = document.body;
  const result = { madeStatic: 0, removed: 0 };
  if (!view || !root) return result;

  const elements = root.querySelectorAll<HTMLElement>("*");
  const limit = Math.min(elements.length, 25_000);
  for (let index = 0; index < limit; index += 1) {
    const element = elements[index];
    const position = view.getComputedStyle(element).position;
    if (position !== "fixed" && position !== "sticky") continue;

    if (position === "sticky") {
      element.style.setProperty("position", "static", "important");
      result.madeStatic += 1;
      continue;
    }

    const rect = element.getBoundingClientRect();
    const tag = element.localName;
    const noisy = FLOATING_NOISE.test(elementNoiseText(element)) || element.getAttribute("aria-modal") === "true";
    const fullWidth = rect.width >= viewport.width * 0.8;
    const strip = fullWidth && rect.height <= viewport.height * 0.35;
    const coversScreen = fullWidth && rect.height >= viewport.height * 0.6;
    const hasContent = (element.textContent ?? "").trim().length >= 80 && !noisy;

    const keepAsBar = (LAYOUT_BAR_TAGS.has(tag) || strip) && !(noisy && !LAYOUT_BAR_TAGS.has(tag));
    // Una capa a pantalla completa con mucho texto y sin aspecto de aviso es el CONTENIDO (una app de pagina completa).
    const keepAsContent = coversScreen && hasContent;

    if (keepAsBar || keepAsContent) {
      element.style.setProperty("position", "static", "important");
      element.style.setProperty("inset", "auto", "important");
      result.madeStatic += 1;
    } else {
      element.style.setProperty("display", "none", "important");
      result.removed += 1;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 3. Despues de maquetar: restricciones de corte
 * ------------------------------------------------------------------ */

/**
 * Fraccion de la altura de una linea de texto que se descuenta arriba y abajo. La caja de un texto cubre ascendente y
 * descendente de la fuente, mas alta que la tinta: sin este margen, dos lineas con interlineado ajustado (1,1-1,2) se
 * tocan y no quedaria ningun hueco donde cortar.
 */
const INK_INSET = 0.1;

const TEXT_BLOCKS = "p,li,dd,dt,figcaption";
const REPLACED = "img,svg,canvas,picture,video,iframe,object,embed,hr";
const NESTED_BLOCKS = "p,div,ul,ol,li,table,blockquote,pre,figure,dl,section,article,h1,h2,h3,h4,h5,h6";

const MAX_TEXT_NODES = 80_000;
const MAX_BLOCKS = 12_000;

type Box = { top: number; bottom: number; height: number; width: number };

function boxOf(rect: DOMRect, offset: number): Box {
  return { top: rect.top + offset, bottom: rect.bottom + offset, height: rect.height, width: rect.width };
}

/** Agrupa las cajas de una lista en lineas (cajas que se solapan en vertical mas de la mitad de su altura). */
function toLines(boxes: Box[]): Interval[] {
  const sorted = boxes.filter((box) => box.height > 0.5 && box.width > 0).sort((a, b) => a.top - b.top);
  const lines: [number, number][] = [];
  for (const box of sorted) {
    const last = lines[lines.length - 1];
    if (last && box.top < last[1] - Math.min(box.height, last[1] - last[0]) * 0.5) last[1] = Math.max(last[1], box.bottom);
    else lines.push([box.top, box.bottom]);
  }
  return lines;
}

export type CollectOptions = {
  /** Alto de una pagina de contenido, en px de maquetacion. */
  pageHeightPx: number;
};

/**
 * Recorre el documento YA maquetado y devuelve los intervalos verticales que un corte no debe atravesar.
 * Coordenadas: px de maquetacion desde el borde superior del documento.
 */
export function collectBreakConstraints(document: Document, options: CollectOptions): BreakConstraints {
  const view = document.defaultView;
  const body = document.body;
  const empty: BreakConstraints = { hard: [], keep: [], orphans: [] };
  if (!view || !body) return empty;

  const offset = view.scrollY || 0;
  const hard: Interval[] = [];
  const keep: Interval[] = [];
  const orphans: Interval[] = [];
  const atomicLimit = options.pageHeightPx * 0.9;

  // ---- Lineas de texto (una caja por fragmento de linea de cada nodo de texto).
  const range = document.createRange();
  const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  let visited = 0;
  for (let node = walker.nextNode(); node && visited < MAX_TEXT_NODES; node = walker.nextNode()) {
    if (!node.nodeValue || node.nodeValue.trim() === "") continue;
    const parent = node.parentElement?.localName;
    if (parent === "style" || parent === "script" || parent === "noscript" || parent === "title") continue;
    visited += 1;
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index];
      if (rect.height < 0.5 || rect.width <= 0) continue;
      const inset = rect.height * INK_INSET;
      hard.push([rect.top + offset + inset, rect.bottom + offset - inset]);
    }
  }

  // ---- Imagenes, SVG, canvas, lineas horizontales: indivisibles.
  for (const element of Array.from(body.querySelectorAll(REPLACED))) {
    if (element.localName !== "svg" || !element.parentElement?.closest("svg")) {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0.5 && rect.width > 0) hard.push([rect.top + offset, rect.bottom + offset]);
    }
  }

  // ---- Filas de tabla: indivisibles mientras quepan en una pagina.
  for (const row of Array.from(body.querySelectorAll("tr"))) {
    const rect = row.getBoundingClientRect();
    if (rect.height > 0.5 && rect.height <= atomicLimit) hard.push([rect.top + offset, rect.bottom + offset]);
  }

  // ---- `break-inside: avoid` (lo que la propia pagina pide para imprimir).
  const candidates = body.querySelectorAll<HTMLElement>("figure,blockquote,pre,table,ul,ol,dl,details,fieldset,section,article,aside,div,li,tr");
  const blockLimit = Math.min(candidates.length, MAX_BLOCKS);
  for (let index = 0; index < blockLimit; index += 1) {
    const element = candidates[index];
    const style = view.getComputedStyle(element);
    const avoid = style.breakInside === "avoid" || style.breakInside === "avoid-page" || style.getPropertyValue("page-break-inside") === "avoid";
    if (!avoid) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height > 0.5 && rect.height <= atomicLimit) hard.push([rect.top + offset, rect.bottom + offset]);
  }

  // ---- Encabezados: se quedan con la primera cosa que les sigue.
  const atoms = [...hard].sort((a, b) => a[0] - b[0]);
  for (const heading of Array.from(body.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    const rect = heading.getBoundingClientRect();
    if (rect.height < 0.5) continue;
    const bottom = rect.bottom + offset;
    // Primer elemento indivisible que empieza despues del encabezado.
    let low = 0;
    let high = atoms.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (atoms[middle][0] >= bottom - 1) {
        found = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    if (found !== -1 && atoms[found][0] - bottom < 200) keep.push([rect.top + offset, atoms[found][1]]);
  }

  // ---- Viudas y huerfanas: 2 lineas minimo arriba y abajo; los parrafos de 2-3 lineas no se parten.
  const blocks = body.querySelectorAll(TEXT_BLOCKS);
  const orphanLimit = Math.min(blocks.length, MAX_BLOCKS);
  for (let index = 0; index < orphanLimit; index += 1) {
    const block = blocks[index];
    if (block.querySelector(NESTED_BLOCKS)) continue;
    range.selectNodeContents(block);
    const rects = range.getClientRects();
    const boxes: Box[] = [];
    for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) boxes.push(boxOf(rects[rectIndex], offset));
    const lines = toLines(boxes);
    if (lines.length < 2) continue;
    if (lines.length <= 3) {
      orphans.push([lines[0][0], lines[lines.length - 1][1]]);
    } else {
      orphans.push([lines[0][0], lines[1][1]]);
      orphans.push([lines[lines.length - 2][0], lines[lines.length - 1][1]]);
    }
  }

  range.detach?.();
  return { hard, keep, orphans };
}
