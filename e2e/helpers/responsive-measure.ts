/**
 * Mediciones de responsive para los E2E de «Responsive Apple Design» (W-RESP-A): desborde horizontal, objetivos tactiles < 44 px,
 * elementos fuera de pantalla y campos que hacen zoom en iOS. Todo se calcula DENTRO de la pagina (`page.evaluate`), sin dependencias.
 *
 * Criterios (los mismos que la auditoria de rutas x viewports de la unidad):
 *  - Objetivo tactil: solo con `pointer: coarse`; un control mide < 43,5 px en algun eje -> hallazgo, SALVO
 *      · una casilla/radio pequeño cuya etiqueta asociada cubre >= 42 px a cada lado de su centro (el toque llega a la etiqueta),
 *      · un control con un pseudo-elemento absoluto de >= 44 x 44 (patron `HIT_44` del repo: ampliar la zona sin cambiar el dibujo),
 *      · un enlace en linea dentro de un parrafo (WCAG 2.5.8), controles `sr-only` / ocultos / `inert` / `aria-hidden`.
 *  - Desborde: `documentElement.scrollWidth > clientWidth + 1`.
 *  - iOS: campo de texto/numero/selector con fuente < 16 px (Safari amplia la pagina al enfocarlo).
 */
import type { Page } from "@playwright/test";

export type Measure = {
  /** `scrollWidth > clientWidth + 1` (px del exceso, 0 si no hay). */
  overflowPx: number;
  /** Controles con puntero grueso que miden menos de 44 px (etiqueta + medida). */
  smallTargets: string[];
  /** Controles cuya caja se sale de la pantalla (fuera de un desplazador horizontal intencional). */
  offScreen: string[];
  /** Campos con fuente < 16 px con puntero grueso. */
  zoomFields: string[];
  /** Texto cortado: hoja de texto con `overflow:hidden` sin elipsis cuyo contenido no cabe. */
  clippedText: string[];
};

export async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const coarse = matchMedia("(pointer: coarse)").matches;
    const out = {
      overflowPx: Math.max(0, document.documentElement.scrollWidth - vw),
      smallTargets: [] as string[],
      offScreen: [] as string[],
      zoomFields: [] as string[],
      clippedText: [] as string[],
    };
    if (out.overflowPx <= 1) out.overflowPx = 0;
    const hit44 = (el: Element) => {
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content !== "none" && ps.position === "absolute" && parseFloat(ps.width) >= 43.5 && parseFloat(ps.height) >= 43.5) return true;
      }
      return false;
    };
    const seen = new Set<string>();
    const selector =
      "a[href],button,input,select,textarea,summary,[role=button],[role=tab],[role=radio],[role=switch],[role=checkbox],[tabindex]:not([tabindex='-1'])";
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2 || cs.visibility === "hidden" || cs.display === "none") continue;
      if (el.closest("[aria-hidden=true],[hidden],[inert],.sr-only")) continue;
      if (el.closest("[data-scroll-x],.overflow-x-auto,.overflow-x-scroll,[class*=overflow-x-]") && (r.right > vw + 1 || r.left < -1)) continue;
      const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
      if (r.right > vw + 1 || r.left < -1) {
        const key = `off:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.offScreen.push(`${name} [${Math.round(r.left)}..${Math.round(r.right)}] vw ${vw}`);
        }
      }
      if (!coarse) continue;
      if (el.tagName === "A" && cs.display === "inline") continue;
      if (r.height < 43.5 || r.width < 43.5) {
        let ok = false;
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
          // El toque llega a la etiqueta asociada si esta cubre una caja de 44 x 44 px centrada en el control o anclada a su borde izquierdo
          // (la fila de una casilla empieza en la propia caja). Se vuelve a la posicion de scroll de antes para no mover las medidas siguientes.
          const sx = window.scrollX;
          const sy = window.scrollY;
          el.scrollIntoView({ block: "center", inline: "nearest" });
          const r2 = el.getBoundingClientRect();
          const cx = r2.left + r2.width / 2;
          const cy = r2.top + r2.height / 2;
          const hits = (x: number, y: number) => {
            const top = document.elementFromPoint(x, y);
            return !!top && (top === el || (el.labels !== null && [...el.labels].some((label) => label.contains(top))));
          };
          const centred = [[-21, -21], [21, -21], [-21, 21], [21, 21], [0, 0]].every(([dx, dy]) => hits(cx + dx, cy + dy));
          const anchored = [[1, -21], [43, -21], [1, 21], [43, 21], [r2.width / 2, 0]].every(([dx, dy]) => hits(r2.left + dx, cy + dy));
          window.scrollTo(sx, sy);
          ok = centred || anchored;
        }
        if (!ok && hit44(el)) ok = true;
        const key = `tap:${name}:${Math.round(r.width)}x${Math.round(r.height)}`;
        if (!ok && !seen.has(key)) {
          seen.add(key);
          out.smallTargets.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      if (
        (el instanceof HTMLInputElement && !["checkbox", "radio", "file", "range", "color", "hidden", "button", "submit"].includes(el.type)) ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement
      ) {
        if (parseFloat(cs.fontSize) < 15.99) out.zoomFields.push(`${el.tagName.toLowerCase()} ${name || el.id} ${cs.fontSize}`);
      }
    }
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      // `sr-only` (visualmente oculto: `clip-path: inset(50%)` en Tailwind 4, `clip: rect(0 0 0 0)` en 3) puede tener ancho propio (p. ej. con `min-w-*`): no es texto cortado a la vista.
      if (cs.position === "absolute" && (cs.clipPath === "inset(50%)" || /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(cs.clip.trim()))) continue;
      if (
        (cs.overflowX === "hidden" || cs.overflow === "hidden") &&
        el.scrollWidth > el.clientWidth + 2 &&
        el.clientWidth > 0 &&
        cs.textOverflow !== "ellipsis" &&
        el.children.length === 0 &&
        el.getBoundingClientRect().width > 4 &&
        (el.textContent || "").trim().length > 2
      ) {
        out.clippedText.push(`${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 40)}" ${el.scrollWidth}>${el.clientWidth}`);
      }
    }
    return out;
  });
}

/** Resumen de una medicion en una linea (vacio si no hay nada que reportar). */
export function describeMeasure(m: Measure, options: { targets?: boolean; zoom?: boolean } = {}): string {
  const parts: string[] = [];
  if (m.overflowPx > 0) parts.push(`desborde horizontal de ${m.overflowPx} px`);
  if (m.offScreen.length) parts.push(`fuera de pantalla: ${m.offScreen.join("; ")}`);
  if (m.clippedText.length) parts.push(`texto cortado: ${m.clippedText.join("; ")}`);
  if (options.targets !== false && m.smallTargets.length) parts.push(`objetivos < 44 px: ${m.smallTargets.join("; ")}`);
  if (options.zoom !== false && m.zoomFields.length) parts.push(`campos < 16 px (zoom en iOS): ${m.zoomFields.join("; ")}`);
  return parts.join(" | ");
}
