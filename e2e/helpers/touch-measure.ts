/**
 * Mediciones de layout tactil para los E2E de la unidad M3: objetivos, separacion, safe-area, contraste de un control.
 * Todo se calcula DENTRO de la pagina (`page.evaluate`), sin dependencias.
 */
import type { Locator, Page } from "@playwright/test";

export type SmallTarget = { label: string; w: number; h: number };

/** Controles visibles de `scope` (por defecto toda la pagina) que miden menos de `min` px en algun eje. */
export async function smallTargets(page: Page, scope: string, min = 44): Promise<SmallTarget[]> {
  return page.evaluate(
    ({ scope, min }) => {
      const label = (el: Element) =>
        (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 48);
      const visible = (el: Element) => {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      };
      const out: { label: string; w: number; h: number }[] = [];
      for (const root of document.querySelectorAll(scope)) {
        const nodes = root.matches("button,a[href]") ? [root] : [...root.querySelectorAll("button, a[href]")];
        for (const el of nodes) {
          if (!visible(el) || el.closest(".sr-only, [aria-hidden='true'], [data-skip-link]")) continue;
          // Enlaces dentro de un parrafo: exentos (WCAG 2.5.8, «inline»).
          if (el.tagName === "A" && el.closest("p, li:not([class])")) continue;
          const r = el.getBoundingClientRect();
          if (r.width < min - 0.5 || r.height < min - 0.5) out.push({ label: label(el), w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      return out;
    },
    { scope, min },
  );
}

/** Controles visibles cuya caja se sale de `[left, right]` (px de pantalla): bajo la muesca o la isla. */
export async function outsideSafeColumns(page: Page, left: number, right: number): Promise<string[]> {
  return page.evaluate(
    ({ left, right }) => {
      const out: string[] = [];
      const sel = "button, a[href], input:not([type=hidden]):not([type=file]), select, textarea, [role=tab], [role=switch]";
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (el.closest(".sr-only, [aria-hidden='true'], [data-skip-link]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
        if (r.left < left - 0.5 || r.right > right + 0.5) {
          const name = (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().replace(/\s+/g, " ").slice(0, 36);
          out.push(`${name} [${Math.round(r.left)}..${Math.round(r.right)}]`);
        }
      }
      return out;
    },
    { left, right },
  );
}

export type ContrastReading = { ratio: number; opacity: number; fg: string; bg: string };

/**
 * Contraste del texto de un control (color del texto con la opacidad acumulada del elemento y sus padres, sobre el
 * primer fondo opaco). Convierte colores con un canvas (admite oklch / color-mix).
 */
export async function contrastOf(locator: Locator): Promise<ContrastReading> {
  return locator.evaluate((el) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const parse = (value: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const over = (top: { r: number; g: number; b: number; a: number }, under: { r: number; g: number; b: number }) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
    });
    // Fondo efectivo: capas translucidas de abajo arriba sobre el primer fondo opaco (o el del lienzo del tema).
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    let opacity = 1;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      opacity *= Number(cs.opacity);
      const bg = parse(cs.backgroundColor);
      if (bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1 && node !== el) break;
      }
    }
    const page = parse(getComputedStyle(document.body).backgroundColor);
    let base: { r: number; g: number; b: number } = page.a > 0 ? page : { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
    // La opacidad del control atenua el texto Y el fondo del propio control: se compone el todo sobre la pagina.
    const fgRaw = parse(getComputedStyle(el).color);
    const pageBase = page.a > 0 ? page : { r: 255, g: 255, b: 255, a: 1 };
    const own = over({ ...fgRaw, a: fgRaw.a * opacity }, over({ ...base, a: opacity }, pageBase));
    const bgFinal = over({ ...base, a: opacity }, pageBase);
    const l1 = lum(own) + 0.05;
    const l2 = lum(bgFinal) + 0.05;
    const hex = (c: { r: number; g: number; b: number }) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
    return { ratio: Math.max(l1, l2) / Math.min(l1, l2), opacity, fg: hex(own), bg: hex(bgFinal) };
  });
}

/** Separacion minima (px) entre controles visibles contiguos de `scope` que se tocan o casi (misma fila / columna). */
export async function minGapBetweenControls(page: Page, scope: string): Promise<{ gap: number; pair: string } | null> {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope);
    if (!root) return null;
    const nodes = [...root.querySelectorAll("button, a[href], select, input:not([type=hidden])")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden";
    });
    let best: { gap: number; pair: string } | null = null;
    const name = (el: Element) => (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 24);
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i].getBoundingClientRect();
        const b = nodes[j].getBoundingClientRect();
        const overlapV = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const overlapH = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        let gap: number | null = null;
        if (overlapV > 8) gap = Math.max(b.left - a.right, a.left - b.right);
        else if (overlapH > 8) gap = Math.max(b.top - a.bottom, a.top - b.bottom);
        if (gap === null || gap > 24) continue;
        if (!best || gap < best.gap) best = { gap: Math.round(gap * 10) / 10, pair: `${name(nodes[i])} | ${name(nodes[j])}` };
      }
    }
    return best;
  }, scope);
}
