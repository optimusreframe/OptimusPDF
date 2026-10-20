/*
 * Desplazar la vista a un elemento SIN que lo tapen las barras fijas (cabecera, barra de zoom pegajosa, barra
 * «Opciones/Procesar» y tab bar del movil). Es lo que faltaba en Firmar: tras «Continuar», un turno o «Usar esta
 * firma» la vista se quedaba donde estaba (auditoria movil/iPad: SC-01 y ER-01).
 *
 * `freeBand` calcula la franja de la ventana (o del contenedor que se desplaza) que NO cubre ninguna capa
 * `fixed`/`sticky` que se superponga con el elemento; `revealElement` lo lleva a esa franja. Las capas pegajosas
 * cuentan como si ya estuvieran pegadas: se supone que el desplazamiento las pega.
 */

export type Band = { top: number; bottom: number };

/** jsdom no implementa el desplazamiento: sin geometria real no hay nada que calcular ni mover. */
function hasLayout(): boolean {
  return typeof window !== "undefined" && !/jsdom/i.test(window.navigator.userAgent);
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** El ancestro que se desplaza de verdad (`null` = la propia ventana). */
export function scrollParentOf(element: Element): HTMLElement | null {
  let node = element.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return null;
}

const LAYER_CANDIDATES = '[class*="fixed"], [class*="sticky"], header, nav, [role="toolbar"], [data-canvas-sticky]';

/** La franja visible (coordenadas de ventana) libre de capas fijas/pegajosas que se solapan en horizontal con `target`. */
export function freeBand(target: Element, container: HTMLElement | null): Band {
  const view = container
    ? (() => {
        const r = container.getBoundingClientRect();
        return { top: Math.max(0, r.top), bottom: Math.min(window.innerHeight, r.bottom) };
      })()
    : { top: 0, bottom: window.visualViewport?.height ?? window.innerHeight };
  const box = target.getBoundingClientRect();
  const middle = (view.top + view.bottom) / 2;
  let top = view.top;
  let bottom = view.bottom;
  for (const layer of document.querySelectorAll<HTMLElement>(LAYER_CANDIDATES)) {
    if (layer === target || layer.contains(target) || target.contains(layer)) continue;
    const cs = getComputedStyle(layer);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = layer.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (Math.min(r.right, box.right) - Math.max(r.left, box.left) <= 0) continue;
    if (container && !container.contains(layer) && cs.position === "sticky") continue;
    if (cs.position === "sticky") {
      // Solo las pegajosas que seguiran pegadas al desplazarse: las que contienen al elemento como hermano de su caja.
      const holder = layer.parentElement;
      if (!holder || !holder.contains(target)) continue;
      const stickTop = cs.top !== "auto" ? parseFloat(cs.top) : NaN;
      const stickBottom = cs.bottom !== "auto" ? parseFloat(cs.bottom) : NaN;
      if (!Number.isNaN(stickTop)) top = Math.max(top, view.top + stickTop + r.height);
      else if (!Number.isNaN(stickBottom)) bottom = Math.min(bottom, view.bottom - stickBottom - r.height);
      continue;
    }
    if (r.top + r.height / 2 < middle) top = Math.max(top, r.bottom);
    else bottom = Math.min(bottom, r.top);
  }
  if (bottom - top < 40) return { top: view.top, bottom: view.bottom };
  return { top, bottom };
}

export type RevealOptions = {
  /** `center`: el elemento al centro de la franja libre; `start`: pegado a su borde superior. */
  align?: "center" | "start";
  /** Margen (px) bajo la capa de arriba con `align: "start"`. */
  margin?: number;
  /** `smooth` solo si no hay preferencia de movimiento reducido. Por defecto, salto directo. */
  smooth?: boolean;
};

/** Lleva `target` a la franja libre. Devuelve `false` si no se pudo (sin geometria, p. ej. en jsdom). */
export function revealElement(target: Element, { align = "center", margin = 8, smooth = false }: RevealOptions = {}): boolean {
  if (!hasLayout()) return false;
  const container = scrollParentOf(target);
  const band = freeBand(target, container);
  const rect = target.getBoundingClientRect();
  let delta: number;
  if (align === "start" || rect.height >= band.bottom - band.top - 2 * margin) {
    delta = rect.top - (band.top + margin);
  } else {
    delta = rect.top + rect.height / 2 - (band.top + band.bottom) / 2;
  }
  if (Math.abs(delta) < 1) return true;
  const behavior: ScrollBehavior = smooth && !reducedMotion() ? "smooth" : "auto";
  const scroller: { scrollBy?: (options: ScrollToOptions) => void } | null = container ?? window;
  scroller?.scrollBy?.({ top: delta, behavior });
  return true;
}

/** `true` si `target` cabe entero en la franja libre (nada fijo lo tapa). Sin geometria (jsdom) se da por visto. */
export function isRevealed(target: Element): boolean {
  if (!hasLayout()) return true;
  const container = scrollParentOf(target);
  const band = freeBand(target, container);
  const rect = target.getBoundingClientRect();
  return rect.top >= band.top - 1 && rect.bottom <= band.bottom + 1 && rect.left >= -1 && rect.right <= window.innerWidth + 1;
}

/** Destello corto (~0,9 s) del elemento recien colocado, para que el ojo lo encuentre. Sin movimiento reducido. */
export function pulseElement(element: Element): void {
  if (!hasLayout() || reducedMotion() || typeof (element as HTMLElement).animate !== "function") return;
  (element as HTMLElement).animate(
    [
      { boxShadow: "0 0 0 0 color-mix(in oklab, var(--color-signal) 55%, transparent)" },
      { boxShadow: "0 0 0 14px color-mix(in oklab, var(--color-signal) 0%, transparent)" },
    ],
    { duration: 900, easing: "ease-out" },
  );
}
