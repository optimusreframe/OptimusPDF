import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findBottomBars,
  measureBottomBars,
  useBottomBarsClearance,
} from "@/app/edit-pdf/useBottomBarsClearance";

/**
 * Wave 10 · C-A3: la paleta movil de «Editar PDF» se coloca sobre las barras FIJAS de abajo (la de «Procesar» y la
 * pestana movil) midiendolas, en vez de a una distancia fija (9,25 rem) que suponia una barra de 4,75 rem y dejaba la
 * segunda fila de la paleta bajo la barra cuando esta lleva el motivo de «Procesar» desactivado.
 *
 * jsdom no maqueta: la geometria de cada elemento se da en `data-rect="[x, y, ancho, alto]"` y se sirve desde un
 * `getBoundingClientRect` simulado; `position` y `bottom` salen de `style` (jsdom los resuelve en `getComputedStyle`).
 */

type Rect = [number, number, number, number];

function box(parent: Element, rect: Rect, style: Partial<CSSStyleDeclaration> & { bottom?: string } = {}): HTMLElement {
  const element = document.createElement("div");
  element.dataset.rect = JSON.stringify(rect);
  Object.assign(element.style, style);
  parent.appendChild(element);
  return element;
}

const fixed = (bottom: string, extra: Partial<CSSStyleDeclaration> = {}) => ({ position: "fixed", bottom, ...extra });

/** body > main > editor (la raiz) y, alrededor, barras fijas como las del movil a 375 x 812. */
function page() {
  const main = box(document.body, [0, 0, 375, 3000]);
  const root = box(main, [0, 100, 375, 900]);
  return { main, root };
}

let observers: Array<{ callback: () => void; observed: Element[]; disconnected: boolean }> = [];

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 812 });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const raw = (this as HTMLElement).dataset?.rect;
    const [x, y, width, height] = raw ? (JSON.parse(raw) as Rect) : [0, 0, 0, 0];
    return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
  });
  stubPhone(true);
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: { callback: () => void; observed: Element[]; disconnected: boolean } = {
        callback: () => undefined,
        observed: [],
        disconnected: false,
      };
      constructor(callback: () => void) {
        this.entry.callback = callback;
        observers.push(this.entry);
      }
      observe(element: Element) {
        this.entry.observed.push(element);
      }
      unobserve() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

describe("findBottomBars / measureBottomBars", () => {
  it("la barra de «Procesar» (bottom 72 + alto 96) y la pestana (bottom 0 + alto 72): manda la mas alta, no la suma", () => {
    const { main, root } = page();
    box(main, [0, 644, 375, 96], fixed("72px"));
    box(document.body, [0, 740, 375, 72], fixed("0px"));
    const bars = findBottomBars(root);
    expect(bars.map((bar) => bar.reach).sort((a, b) => a - b)).toEqual([72, 168]);
    expect(measureBottomBars(root)).toBe(168);
  });

  it("sube por los antepasados: la barra puede ser hermana de cualquiera de ellos", () => {
    const { main, root } = page();
    const inner = box(root, [0, 200, 375, 400]);
    box(main, [0, 600, 375, 140], fixed("72px"));
    expect(measureBottomBars(inner)).toBe(212);
  });

  it("no cuenta lo que esta DENTRO del editor (la propia paleta fija) ni a sus descendientes", () => {
    const { root } = page();
    box(root, [0, 560, 375, 98], fixed("148px"));
    expect(measureBottomBars(root)).toBe(0);
  });

  it("ignora lo que no es una barra de abajo: no fija, oculta, estrecha, arriba, velo o con `bottom` negativo", () => {
    const { main, root } = page();
    box(main, [0, 644, 375, 96], { position: "sticky", bottom: "72px" });
    box(main, [0, 644, 375, 96], fixed("72px", { display: "none" }));
    box(main, [0, 644, 375, 96], fixed("72px", { visibility: "hidden" }));
    box(main, [0, 644, 200, 96], fixed("72px")); // estrecha: un aviso, no una barra
    box(main, [0, 0, 375, 56], fixed("756px")); // cabecera: su parte alta cae arriba
    box(main, [0, 0, 375, 812], fixed("0px")); // velo `inset-0`
    box(main, [0, 700, 375, 60], fixed("-40px")); // fuera de la ventana por abajo
    box(main, [0, 700, 375, 0], fixed("0px")); // sin alto
    expect(findBottomBars(root)).toEqual([]);
    expect(measureBottomBars(root)).toBe(0);
  });
});

describe("useBottomBarsClearance", () => {
  it("movil con barra fija: devuelve su alcance (bottom + alto) en px", () => {
    const { main, root } = page();
    box(main, [0, 644, 375, 96], fixed("72px"));
    const ref = { current: root as HTMLElement | null };
    const { result } = renderHook(() => useBottomBarsClearance(ref, true));
    expect(result.current).toBe(168);
  });

  it("redondea hacia ARRIBA (una fraccion de px no deja una linea de la barra sobre la paleta)", () => {
    const { main, root } = page();
    box(main, [0, 644.6, 375, 95.4], fixed("72px"));
    const ref = { current: root as HTMLElement | null };
    const { result } = renderHook(() => useBottomBarsClearance(ref, true));
    expect(result.current).toBe(168);
    box(main, [0, 640, 375, 98.2], fixed("72px")); // otra barra mas alta
    const second = renderHook(() => useBottomBarsClearance(ref, true));
    expect(second.result.current).toBe(171);
  });

  it("desactivado (la paleta va dentro del flujo): null aunque haya una barra de abajo; y sin barras tambien null", () => {
    const { main, root } = page();
    box(main, [0, 644, 375, 96], fixed("72px"));
    const ref = { current: root as HTMLElement | null };
    const off = renderHook(() => useBottomBarsClearance(ref, false));
    expect(off.result.current).toBeNull();
    // Y con ella activada ESA misma barra si se mide: la prueba no pasa por casualidad.
    const on = renderHook(() => useBottomBarsClearance(ref, true));
    expect(on.result.current).toBe(168);
    document.body.innerHTML = "";
    const bare = page();
    const bareRef = { current: bare.root as HTMLElement | null };
    expect(renderHook(() => useBottomBarsClearance(bareRef, true)).result.current).toBeNull();
  });

  it("en escritorio (>= 768 px) es null aunque haya barras: la paleta es una columna pegajosa", () => {
    stubPhone(false);
    const { main, root } = page();
    box(main, [0, 644, 375, 96], fixed("72px"));
    const ref = { current: root as HTMLElement | null };
    const { result } = renderHook(() => useBottomBarsClearance(ref, true));
    expect(result.current).toBeNull();
  });

  it("vuelve a medir en el render siguiente (el motivo de «Procesar» aparece y desaparece al editar)", () => {
    const { main, root } = page();
    const bar = box(main, [0, 644, 375, 96], fixed("72px"));
    const ref = { current: root as HTMLElement | null };
    const { result, rerender } = renderHook(() => useBottomBarsClearance(ref, true));
    expect(result.current).toBe(168);
    // Sin motivo la barra es mas baja (68 px): la paleta baja con ella.
    bar.dataset.rect = JSON.stringify([0, 672, 375, 68]);
    rerender();
    expect(result.current).toBe(140);
  });

  it("vuelve a medir cuando una barra cambia de alto sin que el editor se repinte (texto que envuelve) y al girar la ventana", () => {
    const { main, root } = page();
    const bar = box(main, [0, 644, 375, 96], fixed("72px"));
    const ref = { current: root as HTMLElement | null };
    const { result } = renderHook(() => useBottomBarsClearance(ref, true));
    // Observa la barra hallada.
    expect(observers.some((observer) => observer.observed.includes(bar))).toBe(true);
    bar.dataset.rect = JSON.stringify([0, 626, 375, 114]);
    act(() => observers.forEach((observer) => observer.callback()));
    expect(result.current).toBe(186);
    bar.dataset.rect = JSON.stringify([0, 644, 375, 96]);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(168);
  });

  it("al desmontar suelta el observador y deja de escuchar la ventana", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { main, root } = page();
    box(main, [0, 644, 375, 96], fixed("72px"));
    const ref = { current: root as HTMLElement | null };
    const { unmount } = renderHook(() => useBottomBarsClearance(ref, true));
    unmount();
    expect(observers.every((observer) => observer.disconnected)).toBe(true);
    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});
