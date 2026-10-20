/**
 * Region visible de un contenedor que se desplaza y utilidades para llevar una caja a la vista, descontando las barras
 * fijas o pegajosas que la tapan (cabecera, barra de zoom, paleta, barra de accion, tab bar).
 *
 * Todo es geometria en px de pantalla (`getBoundingClientRect`). Sin dependencias de React.
 */

export type Box = { left: number; top: number; right: number; bottom: number };

/** Ancestro mas cercano que se desplaza en vertical, o el scroller del documento. */
export function findScrollParent(element: Element | null): HTMLElement {
  let node: Element | null = element?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY);
    if (scrollable && node.scrollHeight > node.clientHeight + 1) return node as HTMLElement;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** `true` si el contenedor es el propio documento (su caja visible es la ventana). */
export function isDocumentScroller(scroller: Element): boolean {
  return (
    scroller === document.scrollingElement ||
    scroller === document.documentElement ||
    scroller === document.body
  );
}

/** Caja visible de un scroller en px de pantalla (la ventana, para el documento). */
export function scrollerBox(scroller: Element): Box {
  if (isDocumentScroller(scroller)) {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const top = viewport?.offsetTop ?? 0;
    const left = viewport?.offsetLeft ?? 0;
    return { left, top, right: left + width, bottom: top + height };
  }
  const rect = scroller.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/** Un elemento con `position: fixed|sticky` que ocupa casi todo el ancho y toca el borde de arriba o el de abajo. */
function isChromeBar(element: Element, box: Box): "top" | "bottom" | null {
  const style = getComputedStyle(element);
  if (style.position !== "fixed" && style.position !== "sticky") return null;
  if (style.visibility === "hidden" || style.display === "none") return null;
  const rect = element.getBoundingClientRect();
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (rect.width < width * 0.5 || rect.height < 24 || rect.height > height * 0.6) return null;
  // Una barra pegajosa que aun no esta pegada (esta en el flujo, lejos del borde) no tapa nada.
  const nearTop = rect.top <= box.top + 140 && rect.bottom > box.top + 4 && rect.bottom < box.top + height * 0.6;
  if (nearTop) return "top";
  const nearBottom = rect.bottom >= box.bottom - 140 && rect.top < box.bottom - 4 && rect.top > box.top + height * 0.4;
  if (nearBottom) return "bottom";
  return null;
}

export type Obstructions = { top: number; bottom: number };

/**
 * Cuanto tapan, por arriba y por abajo, las barras fijas o pegajosas sobre la caja visible `box`. Se miden las
 * candidatas habituales (`header`, `nav`, barras de herramientas, `[data-fixed-chrome]`, `[data-canvas-sticky]` y todo
 * lo que declare `position: fixed|sticky` en una clase) en vez de recorrer todo el DOM.
 */
export function measureObstructions(box: Box, root: ParentNode = document): Obstructions {
  const candidates = root.querySelectorAll(
    'header, nav, [role="toolbar"], [data-fixed-chrome], [data-canvas-sticky], [data-chrome], [class*="fixed"], [class*="sticky"]',
  );
  let top = box.top;
  let bottom = box.bottom;
  candidates.forEach((element) => {
    const side = isChromeBar(element, box);
    if (!side) return;
    const rect = element.getBoundingClientRect();
    if (side === "top") top = Math.max(top, rect.bottom);
    else bottom = Math.min(bottom, rect.top);
  });
  return { top: top - box.top, bottom: box.bottom - bottom };
}

/** Region libre (lo que de verdad ve la persona) de un scroller: su caja menos las barras que la tapan. */
export function freeRegion(scroller: Element, root: ParentNode = document): Box {
  const box = scrollerBox(scroller);
  const covered = measureObstructions(box, root);
  const top = box.top + covered.top;
  const bottom = Math.max(top + 1, box.bottom - covered.bottom);
  return { left: box.left, right: box.right, top, bottom };
}

/** Scroll vertical (px) que hace falta para que `target` quede centrado, o dentro, de `region` con `margin`. */
export function revealDelta(
  target: Pick<Box, "top" | "bottom">,
  region: Pick<Box, "top" | "bottom">,
  options: { block?: "center" | "nearest"; margin?: number } = {},
): number {
  const margin = options.margin ?? 12;
  const regionTop = region.top + margin;
  const regionBottom = region.bottom - margin;
  const regionHeight = regionBottom - regionTop;
  const targetHeight = target.bottom - target.top;
  if (options.block === "nearest") {
    if (target.top >= regionTop && target.bottom <= regionBottom) return 0;
    if (targetHeight > regionHeight || target.top < regionTop) return target.top - regionTop;
    return target.bottom - regionBottom;
  }
  if (targetHeight > regionHeight) return target.top - regionTop;
  const targetCenter = (target.top + target.bottom) / 2;
  return targetCenter - (regionTop + regionBottom) / 2;
}

/** Desplaza `scroller` en vertical `dy` px y devuelve lo que de verdad se movio (el tope lo limita). */
export function scrollVerticallyBy(scroller: HTMLElement, dy: number, behavior: ScrollBehavior = "auto"): number {
  const before = scroller.scrollTop;
  if (behavior === "smooth" && typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top: before + dy, behavior });
    return dy;
  }
  scroller.scrollTop = before + dy;
  return scroller.scrollTop - before;
}
