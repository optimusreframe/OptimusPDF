import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { es } from "@/lib/locales/es";
import { EDGE_HANDLE_MIN_PX, RegionSelector, regionPercent } from "@/app/extract-assets/RegionSelector";
import type { CropFraction } from "@/app/sign-pdf/inkImportModel";
import { useState } from "react";

/** Rectangulo de recorte: teclado (flechas mueven, Mayus + flechas redimensionan), asas de 44 px y puntero. */

const START: CropFraction = { x: 0.2, y: 0.4, width: 0.3, height: 0.1 };
/** Un rectangulo grande (400 x 200 px en el marco de 1000 x 500): caben las OCHO asas. */
const BIG: CropFraction = { x: 0.2, y: 0.3, width: 0.4, height: 0.4 };

function Harness({ onChange, onAnnounce, start = START }: { onChange?: (rect: CropFraction) => void; onAnnounce?: (text: string) => void; start?: CropFraction }) {
  const [rect, setRect] = useState(start);
  return (
    <div data-testid="page" style={{ position: "relative", width: 1000, height: 500 }}>
      <RegionSelector
        rect={rect}
        onChange={(next) => {
          setRect(next);
          onChange?.(next);
        }}
        strings={es.extract}
        onAnnounce={onAnnounce ?? (() => {})}
      />
    </div>
  );
}

beforeEach(() => {
  // jsdom no calcula cajas: el marco mide 1000 x 500 en (0, 0).
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, toJSON: () => ({}) } as DOMRect;
  };
});

const rectEl = () => screen.getByRole("group");
const label = () => rectEl().getAttribute("aria-label") ?? "";

describe("RegionSelector · teclado", () => {
  it("el rectangulo es enfocable y su nombre dice la posicion y como manejarlo", () => {
    render(<Harness />);
    expect(rectEl().tabIndex).toBe(0);
    expect(label()).toBe("Región a recortar: izquierda 20 %, arriba 40 %, ancho 30 %, alto 10 %. Flechas para mover, Mayús + flechas para cambiar el tamaño.");
  });

  it("las flechas MUEVEN 1 % y anuncian el valor", () => {
    const onAnnounce = vi.fn();
    render(<Harness onAnnounce={onAnnounce} />);
    fireEvent.keyDown(rectEl(), { key: "ArrowRight" });
    expect(label()).toContain("izquierda 21 %, arriba 40 %, ancho 30 %");
    fireEvent.keyDown(rectEl(), { key: "ArrowDown" });
    fireEvent.keyDown(rectEl(), { key: "ArrowDown" });
    fireEvent.keyDown(rectEl(), { key: "ArrowLeft" });
    fireEvent.keyDown(rectEl(), { key: "ArrowUp" });
    expect(label()).toContain("izquierda 20 %, arriba 41 %, ancho 30 %, alto 10 %");
    expect(onAnnounce).toHaveBeenLastCalledWith("Región: izquierda 20 %, arriba 41 %, ancho 30 %, alto 10 %");
    expect(onAnnounce).toHaveBeenCalledTimes(5);
  });

  it("Mayus + flechas cambian el TAMANO (derecha/abajo agrandan, izquierda/arriba reducen) sin mover la esquina", () => {
    render(<Harness />);
    fireEvent.keyDown(rectEl(), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(rectEl(), { key: "ArrowDown", shiftKey: true });
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 31 %, alto 11 %");
    fireEvent.keyDown(rectEl(), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(rectEl(), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(rectEl(), { key: "ArrowUp", shiftKey: true });
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 29 %, alto 10 %");
  });

  it("no sale de la pagina ni baja del lado minimo", () => {
    render(<Harness />);
    for (let i = 0; i < 100; i += 1) fireEvent.keyDown(rectEl(), { key: "ArrowLeft" });
    for (let i = 0; i < 100; i += 1) fireEvent.keyDown(rectEl(), { key: "ArrowUp" });
    expect(label()).toContain("izquierda 0 %, arriba 0 %");
    for (let i = 0; i < 200; i += 1) fireEvent.keyDown(rectEl(), { key: "ArrowLeft", shiftKey: true });
    expect(label()).toContain("ancho 5 %");
    for (let i = 0; i < 200; i += 1) fireEvent.keyDown(rectEl(), { key: "ArrowDown", shiftKey: true });
    expect(Number(/alto (\d+) %/.exec(label())![1])).toBeLessThanOrEqual(100);
  });

  it("otras teclas no hacen nada (y no se las traga: Tab sigue su camino)", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const prevented = !fireEvent.keyDown(rectEl(), { key: "Tab" });
    fireEvent.keyDown(rectEl(), { key: "a" });
    expect(prevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("las flechas no desplazan la pagina (preventDefault)", () => {
    render(<Harness />);
    expect(fireEvent.keyDown(rectEl(), { key: "ArrowDown" })).toBe(false);
  });
});

describe("RegionSelector · puntero", () => {
  it("ocho asas (cuatro esquinas y cuatro bordes) de 44 px, tactiles y con nombre para los lectores", () => {
    render(<Harness start={BIG} />);
    const handles = document.querySelectorAll("[data-region-handle]");
    expect(handles).toHaveLength(8);
    expect([...handles].map((handle) => handle.getAttribute("data-region-handle"))).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
    for (const handle of handles) {
      expect(handle.tagName).toBe("BUTTON");
      expect(handle.getAttribute("aria-hidden")).toBeNull();
      expect(handle.getAttribute("aria-label")).toMatch(/^Cambiar el tamaño desde la (esquina|borde)/);
      expect(handle.className).toContain("size-11");
      expect(handle.className).toContain("touch-none");
    }
    expect(screen.getByRole("button", { name: /^Cambiar el tamaño desde la esquina superior izquierda\./ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cambiar el tamaño desde la borde derecho\./ })).toBeTruthy();
  });

  it("en un rectangulo pequeno los bordes cortos no llevan asa (sus zonas de toque taparian las de las esquinas): quedan las esquinas y los bordes largos", () => {
    render(<Harness />);
    // 300 x 50 px: el borde superior e inferior miden 300 (caben), los laterales 50 (no).
    expect([...document.querySelectorAll("[data-region-handle]")].map((handle) => handle.getAttribute("data-region-handle"))).toEqual(["nw", "n", "ne", "se", "s", "sw"]);
    expect(EDGE_HANDLE_MIN_PX).toBe(96);
  });
  it("con un rectangulo de 90 x 40 px solo quedan las cuatro esquinas; y al llegar a 96 px aparece el asa del borde", () => {
    render(<Harness start={{ x: 0.2, y: 0.3, width: 0.09, height: 0.08 }} />);
    expect(document.querySelectorAll("[data-region-handle]")).toHaveLength(4);
    cleanup();
    render(<Harness start={{ x: 0.2, y: 0.3, width: 0.096, height: 0.08 }} />);
    expect(document.querySelectorAll('[data-region-handle="n"], [data-region-handle="s"]')).toHaveLength(2);
    cleanup();
    render(<Harness start={{ x: 0.2, y: 0.3, width: 0.0959, height: 0.08 }} />);
    expect(document.querySelectorAll('[data-region-handle="n"]')).toHaveLength(0);
  });

  it("arrastrar una asa mueve SOLO esa esquina (la opuesta no se mueve)", () => {
    render(<Harness />);
    const se = document.querySelector('[data-region-handle="se"]')!;
    fireEvent.pointerDown(se, { pointerId: 1, clientX: 500, clientY: 250 });
    fireEvent.pointerMove(se, { pointerId: 1, clientX: 700, clientY: 300 });
    fireEvent.pointerUp(se, { pointerId: 1 });
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 50 %, alto 20 %");
    const nw = document.querySelector('[data-region-handle="nw"]')!;
    fireEvent.pointerDown(nw, { pointerId: 2 });
    fireEvent.pointerMove(nw, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(nw, { pointerId: 2 });
    expect(label()).toContain("izquierda 10 %, arriba 20 %, ancho 60 %, alto 40 %");
  });

  it("arrastrar el cuerpo desplaza sin cambiar el tamano; otro puntero no interfiere", () => {
    render(<Harness />);
    fireEvent.pointerDown(rectEl(), { pointerId: 1, clientX: 350, clientY: 225 });
    fireEvent.pointerMove(rectEl(), { pointerId: 2, clientX: 900, clientY: 100 });
    expect(label()).toContain("izquierda 20 %, arriba 40 %");
    fireEvent.pointerMove(rectEl(), { pointerId: 1, clientX: 450, clientY: 275 });
    fireEvent.pointerUp(rectEl(), { pointerId: 1 });
    expect(label()).toContain("izquierda 30 %, arriba 50 %, ancho 30 %, alto 10 %");
    // Soltado: mas movimiento no cambia nada.
    fireEvent.pointerMove(rectEl(), { pointerId: 1, clientX: 800, clientY: 400 });
    expect(label()).toContain("izquierda 30 %, arriba 50 %");
  });

  it("un toque en la pagina (fuera del rectangulo) coloca su centro ahi; sobre el rectangulo no", () => {
    render(<Harness />);
    const frame = document.querySelector("[data-region-frame]")!;
    fireEvent.click(frame, { clientX: 500, clientY: 150 });
    expect(label()).toContain("izquierda 35 %, arriba 25 %");
    fireEvent.click(rectEl(), { clientX: 10, clientY: 10 });
    expect(label()).toContain("izquierda 35 %, arriba 25 %");
    // Cerca del borde: se detiene dentro de la pagina.
    fireEvent.click(frame, { clientX: 1000, clientY: 500 });
    expect(label()).toContain("izquierda 70 %, arriba 90 %");
  });
});

describe("RegionSelector · cualquier asa con el teclado (H13)", () => {
  const handle = (name: string) => document.querySelector(`[data-region-handle="${name}"]`) as HTMLElement;
  it("con el foco en un asa, las flechas mueven ESA esquina o borde (1 %) y la opuesta no se mueve", () => {
    const onAnnounce = vi.fn();
    render(<Harness start={BIG} onAnnounce={onAnnounce} />);
    fireEvent.keyDown(handle("nw"), { key: "ArrowLeft" });
    fireEvent.keyDown(handle("nw"), { key: "ArrowUp" });
    expect(label()).toContain("izquierda 19 %, arriba 29 %, ancho 41 %, alto 41 %");
    fireEvent.keyDown(handle("e"), { key: "ArrowRight" });
    expect(label()).toContain("izquierda 19 %, arriba 29 %, ancho 42 %, alto 41 %");
    // Un asa de borde ignora el eje que no es suyo.
    fireEvent.keyDown(handle("e"), { key: "ArrowDown" });
    expect(label()).toContain("ancho 42 %, alto 41 %");
    fireEvent.keyDown(handle("s"), { key: "ArrowDown" });
    fireEvent.keyDown(handle("w"), { key: "ArrowRight" });
    expect(label()).toContain("izquierda 20 %, arriba 29 %, ancho 41 %, alto 42 %");
    fireEvent.keyDown(handle("sw"), { key: "ArrowLeft" });
    fireEvent.keyDown(handle("ne"), { key: "ArrowUp" });
    expect(label()).toContain("izquierda 19 %, arriba 28 %, ancho 42 %, alto 43 %");
    expect(onAnnounce).toHaveBeenLastCalledWith("Región: izquierda 19 %, arriba 28 %, ancho 42 %, alto 43 %");
  });
  it("Mayus + flechas: saltos de 5 %", () => {
    render(<Harness />);
    fireEvent.keyDown(handle("se"), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(handle("se"), { key: "ArrowDown", shiftKey: true });
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 35 %, alto 15 %");
  });
  it("las flechas de un asa no mueven todo el rectangulo (no sube el evento) ni desplazan la pagina; otras teclas no se tragan", () => {
    render(<Harness />);
    expect(fireEvent.keyDown(handle("se"), { key: "ArrowDown" })).toBe(false);
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 30 %, alto 11 %");
    expect(fireEvent.keyDown(handle("se"), { key: "Tab" })).toBe(true);
  });
  it("no se sale de la pagina ni baja del minimo desde ningun asa", () => {
    render(<Harness start={BIG} />);
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(handle("w"), { key: "ArrowRight", shiftKey: true });
    expect(label()).toContain("ancho 5 %");
    expect(document.querySelector('[data-region-handle="w"]')).not.toBeNull();
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(handle("nw"), { key: "ArrowLeft", shiftKey: true });
    expect(label()).toMatch(/izquierda 0 %/);
  });
});

describe("RegionSelector · UN solo puntero (H13)", () => {
  const handle = (name: string) => document.querySelector(`[data-region-handle="${name}"]`) as HTMLElement;
  const frame = () => document.querySelector("[data-region-frame]") as HTMLElement;
  it("tocar un asa (sin arrastrar) la elige; el siguiente toque en la pagina la coloca ahi", () => {
    const onAnnounce = vi.fn();
    render(<Harness onAnnounce={onAnnounce} />);
    fireEvent.pointerDown(handle("se"), { pointerId: 1, clientX: 500, clientY: 250 });
    fireEvent.pointerUp(handle("se"), { pointerId: 1, clientX: 502, clientY: 251 });
    expect(handle("se").getAttribute("aria-pressed")).toBe("true");
    expect(frame().getAttribute("data-region-picked")).toBe("se");
    expect(onAnnounce).toHaveBeenLastCalledWith("Elegida: esquina inferior derecha. Toca la página donde quieres colocarla.");
    fireEvent.click(frame(), { clientX: 800, clientY: 350 });
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 60 %, alto 30 %");
    expect(handle("se").getAttribute("aria-pressed")).toBe("false");
    expect(frame().getAttribute("data-region-picked")).toBeNull();
    // Un segundo toque en la pagina, sin asa elegida, vuelve a colocar el CENTRO (no cambia el tamano).
    fireEvent.click(frame(), { clientX: 500, clientY: 150 });
    expect(label()).toContain("ancho 60 %, alto 30 %");
    expect(label()).toContain("izquierda 20 %, arriba 15 %");
  });
  it("sirve con un asa de borde: solo cambia su lado", () => {
    render(<Harness start={BIG} />);
    fireEvent.pointerDown(handle("w"), { pointerId: 1, clientX: 200, clientY: 250 });
    fireEvent.pointerUp(handle("w"), { pointerId: 1, clientX: 200, clientY: 250 });
    fireEvent.click(frame(), { clientX: 100, clientY: 10 });
    expect(label()).toContain("izquierda 10 %, arriba 30 %, ancho 50 %, alto 40 %");
  });
  it("tocar otra vez el asa elegida la suelta; elegir otra cambia la eleccion; Escape tambien suelta", () => {
    render(<Harness start={BIG} />);
    const tap = (name: string) => {
      fireEvent.pointerDown(handle(name), { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(handle(name), { pointerId: 1, clientX: 10, clientY: 10 });
    };
    tap("nw");
    expect(handle("nw").getAttribute("aria-pressed")).toBe("true");
    tap("nw");
    expect(handle("nw").getAttribute("aria-pressed")).toBe("false");
    tap("nw");
    tap("sw");
    expect(handle("nw").getAttribute("aria-pressed")).toBe("false");
    expect(handle("sw").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(handle("sw"), { key: "Escape" });
    expect(handle("sw").getAttribute("aria-pressed")).toBe("false");
  });
  it("un ARRASTRE (se mueve mas de unos pixeles) no elige el asa y sigue moviendo solo esa esquina", () => {
    render(<Harness />);
    fireEvent.pointerDown(handle("ne"), { pointerId: 1, clientX: 500, clientY: 200 });
    fireEvent.pointerMove(handle("ne"), { pointerId: 1, clientX: 700, clientY: 100 });
    fireEvent.pointerUp(handle("ne"), { pointerId: 1, clientX: 700, clientY: 100 });
    expect(label()).toContain("izquierda 20 %, arriba 20 %, ancho 50 %, alto 30 %");
    expect(handle("ne").getAttribute("aria-pressed")).toBe("false");
  });
  it("un movimiento de pocos pixeles sigue siendo un toque (6 px de holgura)", () => {
    render(<Harness />);
    fireEvent.pointerDown(handle("n"), { pointerId: 1, clientX: 350, clientY: 200 });
    fireEvent.pointerMove(handle("n"), { pointerId: 1, clientX: 353, clientY: 202 });
    fireEvent.pointerUp(handle("n"), { pointerId: 1, clientX: 353, clientY: 202 });
    expect(handle("n").getAttribute("aria-pressed")).toBe("true");
    expect(label()).toContain("izquierda 20 %, arriba 40 %, ancho 30 %, alto 10 %");
  });
});

describe("regionPercent", () => {
  it("redondea a enteros", () => {
    expect(regionPercent({ x: 0.1234, y: 0.5, width: 0.3351, height: 0.0049 })).toEqual({ left: 12, top: 50, width: 34, height: 0 });
  });
});
