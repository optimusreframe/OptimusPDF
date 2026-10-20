import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freeBand, isRevealed, revealElement } from "@/app/sign-pdf/scrollReveal";

/*
 * `scrollReveal` calcula la franja de la ventana que NO tapan las capas fijas/pegajosas y lleva un elemento a ella
 * (SC-01 / ER-01 de la auditoria movil/iPad). jsdom no tiene geometria: se simula con cajas fijas por elemento y un
 * agente de usuario que no es el de jsdom (con el suyo el modulo no hace nada, a proposito).
 */

type Box = { top: number; bottom: number; left?: number; right?: number };
const boxes = new Map<Element, Box>();

function place(element: HTMLElement, box: Box, style: Partial<CSSStyleDeclaration> = {}) {
  boxes.set(element, box);
  Object.assign(element.style, style);
  document.body.appendChild(element);
  return element;
}

beforeEach(() => {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone) AppleWebKit Mobile Safari");
  Object.defineProperty(window, "innerHeight", { value: 852, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 393, configurable: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = boxes.get(this) ?? { top: 0, bottom: 0 };
    const left = box.left ?? 0;
    const right = box.right ?? 393;
    return { top: box.top, bottom: box.bottom, left, right, width: right - left, height: box.bottom - box.top, x: left, y: box.top, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  boxes.clear();
  document.body.innerHTML = "";
});

function scene() {
  const header = place(document.createElement("header"), { top: 0, bottom: 56 }, { position: "fixed", top: "0px" });
  const bar = document.createElement("div");
  bar.className = "fixed inset-x-0"; // el modulo busca las capas por clase (`fixed`/`sticky`), como las de la aplicacion
  place(bar, { top: 712, bottom: 780 }, { position: "fixed", bottom: "72px" });
  const tabs = place(document.createElement("nav"), { top: 780, bottom: 852 }, { position: "fixed", bottom: "0px" });
  const target = place(document.createElement("div"), { top: 300, bottom: 360 });
  return { header, bar, tabs, target };
}

describe("freeBand", () => {
  it("descuenta la cabecera de arriba y la barra y la tab bar de abajo", () => {
    const { target } = scene();
    expect(freeBand(target, null)).toEqual({ top: 56, bottom: 712 });
  });

  it("ignora las capas que no se solapan con el elemento en horizontal", () => {
    const { target } = scene();
    boxes.set(target, { top: 300, bottom: 360, left: 0, right: 100 });
    const side = document.createElement("aside");
    side.className = "fixed";
    place(side, { top: 0, bottom: 852, left: 200, right: 393 }, { position: "fixed" });
    expect(freeBand(target, null)).toEqual({ top: 56, bottom: 712 });
    side.remove();
  });

  it("cuenta una capa pegajosa que contiene al elemento como si ya estuviera pegada", () => {
    const { target } = scene();
    const holder = document.createElement("section");
    const zoom = document.createElement("div");
    zoom.className = "sticky top-14";
    Object.assign(zoom.style, { position: "sticky", top: "56px" });
    boxes.set(zoom, { top: 600, bottom: 654 });
    holder.appendChild(zoom);
    holder.appendChild(target);
    document.body.appendChild(holder);
    // La barra de zoom se pegara a 56 px bajo la cabecera: su alto (54) se suma a la franja de arriba.
    expect(freeBand(target, null).top).toBe(56 + 54);
  });
});

describe("revealElement", () => {
  it("centra el elemento en la franja libre", () => {
    const { target } = scene();
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    expect(revealElement(target, { align: "center" })).toBe(true);
    // Centro de la franja = (56 + 712) / 2 = 384; el elemento esta centrado en 330 -> hay que bajar el contenido 54 px.
    expect(scrollBy).toHaveBeenCalledWith({ top: -54, behavior: "auto" });
  });

  it("con `start` deja el elemento justo bajo la cabecera, con su margen", () => {
    const { target } = scene();
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    revealElement(target, { align: "start", margin: 12 });
    expect(scrollBy).toHaveBeenCalledWith({ top: 300 - (56 + 12), behavior: "auto" });
  });

  it("no se mueve si ya esta donde toca", () => {
    const { target } = scene();
    boxes.set(target, { top: 354, bottom: 414 });
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    revealElement(target, { align: "center" });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("isRevealed: visto si cabe entero en la franja, no si lo tapa la barra de abajo", () => {
    const { target } = scene();
    expect(isRevealed(target)).toBe(true);
    boxes.set(target, { top: 690, bottom: 740 });
    expect(isRevealed(target)).toBe(false);
  });

  it("con el agente de usuario de jsdom no hace nada (sin geometria que calcular)", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/26.0.0");
    const { target } = scene();
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    expect(revealElement(target)).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
    expect(isRevealed(target)).toBe(true);
  });
});
