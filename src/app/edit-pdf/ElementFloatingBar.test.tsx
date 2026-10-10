import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import {
  ElementFloatingBar,
  barStateOf,
  formatWidth,
  type ElementBarState,
  type ElementFloatingBarProps,
} from "@/app/edit-pdf/ElementFloatingBar";
import { shapeItem, type EditImageItem } from "@/app/edit-pdf/editSession";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";

const s = EDIT_STRINGS.es.inline;

const RECT: ElementBarState = { type: "rect", strokeColor: "#e11d48", strokeWidth: 2, fill: false, fillColor: "#0d4bff", fillOpacity: 0.3 };
const FILLED: ElementBarState = { ...RECT, fill: true } as ElementBarState;
const LINE: ElementBarState = { type: "line", strokeColor: "#0f9d68", strokeWidth: 3 };
const HIGHLIGHT: ElementBarState = { type: "highlight", color: "#fff176", opacity: 0.4 };
const CHECK: ElementBarState = { type: "check", mark: "check", strokeColor: "#e11d48", strokeWidth: 2 };
const IMAGE: ElementBarState = { type: "image" };

type Callbacks = Pick<ElementFloatingBarProps, "onRestyle" | "onDuplicate" | "onDelete" | "onEscape" | "onTabBackward" | "onTabForward">;

function callbacks(): Callbacks {
  return {
    onRestyle: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onEscape: vi.fn(),
    onTabBackward: vi.fn(),
    onTabForward: vi.fn(() => false),
  };
}

function Harness({ state, selectionId = "el1", cb }: { state: ElementBarState | null; selectionId?: string | null; cb: Callbacks }) {
  const stage = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [layoutKey, setLayoutKey] = useState("first");
  useEffect(() => {
    const timer = setTimeout(() => setLayoutKey("second"), 0);
    return () => clearTimeout(timer);
  }, []);
  const kind = state?.type === "image" ? "image" : "shape";
  return (
    <div ref={stage} style={{ position: "relative" }}>
      <div ref={clip}>
        <div ref={host}>
          <div data-element-kind={kind} data-element-id="el1" data-drag-mode="move" tabIndex={0} />
        </div>
      </div>
      <ElementFloatingBar stageRef={stage} clipRef={clip} hostRef={host} selectionId={selectionId} layoutKey={layoutKey} state={state} strings={s} {...cb} />
    </div>
  );
}

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-floating-bar")) return rect(0, 0, 300, 44);
    if (this.getAttribute("data-element-id") === "el1") return rect(100, 300, 120, 20);
    return rect(0, 100, 600, 800);
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 44 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
});

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — restaura los accesores de prueba
  delete HTMLElement.prototype.offsetWidth;
  // @ts-expect-error — idem
  delete HTMLElement.prototype.offsetHeight;
});

async function mount(state: ElementBarState | null, cb = callbacks()) {
  const view = render(<Harness state={state} cb={cb} />);
  if (state) await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
  const bar = document.querySelector<HTMLElement>("[data-floating-bar]");
  return { ...view, bar, cb, q: bar ? within(bar) : null };
}

const action = (bar: HTMLElement, name: string) => bar.querySelector<HTMLElement>(`[data-bar-action="${name}"]`);

describe("ElementFloatingBar: controles por tipo", () => {
  it("Editar activa aboveSticky tambien en la barra de elementos (z-40)", async () => {
    const { bar } = await mount(RECT);
    expect(bar!.className).toContain("z-40");
  });

  it("es un grupo con nombre, anclado al elemento y sin robar el foco", async () => {
    const { bar } = await mount(RECT);
    expect(bar!.getAttribute("role")).toBe("group");
    expect(bar!.getAttribute("aria-label")).toBe(s.elementBarLabel);
    expect(document.activeElement).toBe(document.body);
  });

  it("rectangulo y elipse: color del trazo, grosor, relleno, duplicar y borrar", async () => {
    const { bar } = await mount(RECT);
    for (const name of ["stroke-color", "width-down", "width", "width-up", "fill", "duplicate", "delete"]) {
      expect(action(bar!, name), name).not.toBeNull();
    }
    expect(action(bar!, "fill-color")).toBeNull(); // sin relleno no hay color de relleno
    expect(action(bar!, "highlight-color")).toBeNull();
  });

  it("con relleno aparecen su color y las cinco opacidades", async () => {
    const { bar } = await mount(FILLED);
    expect(action(bar!, "fill-color")).not.toBeNull();
    for (const percent of [15, 30, 50, 75, 100]) expect(action(bar!, `fill-opacity-${percent}`), String(percent)).not.toBeNull();
    expect(action(bar!, "fill-opacity-30")!.getAttribute("aria-pressed")).toBe("true");
    expect(action(bar!, "fill-opacity-50")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("linea: solo trazo (sin relleno)", async () => {
    const { bar } = await mount(LINE);
    expect(action(bar!, "stroke-color")).not.toBeNull();
    expect(action(bar!, "width")).not.toBeNull();
    expect(action(bar!, "fill")).toBeNull();
  });

  it("marca: simbolo (visto/aspa), color y grosor", async () => {
    const { bar } = await mount(CHECK);
    expect(action(bar!, "mark-check")!.getAttribute("aria-pressed")).toBe("true");
    expect(action(bar!, "mark-cross")!.getAttribute("aria-pressed")).toBe("false");
    expect(action(bar!, "stroke-color")).not.toBeNull();
    expect(action(bar!, "width")).not.toBeNull();
  });

  it("resaltado: color, intensidad y nada de grosor ni relleno", async () => {
    const { bar } = await mount(HIGHLIGHT);
    expect(action(bar!, "highlight-color")).not.toBeNull();
    expect(action(bar!, "highlight-opacity-50")).not.toBeNull();
    expect(action(bar!, "width")).toBeNull();
    expect(action(bar!, "fill")).toBeNull();
    // 0.4 no es uno de los pasos: ninguno queda pulsado.
    expect(bar!.querySelectorAll('[data-bar-action^="highlight-opacity"][aria-pressed="true"]')).toHaveLength(0);
  });

  it("imagen: solo duplicar y borrar", async () => {
    const { bar } = await mount(IMAGE);
    const actions = Array.from(bar!.querySelectorAll("[data-bar-action]")).map((el) => el.getAttribute("data-bar-action"));
    expect(actions).toEqual(["duplicate", "delete"]);
  });

  it("sin estado no hay barra", async () => {
    const { bar } = await mount(null);
    expect(bar).toBeNull();
  });
});

describe("ElementFloatingBar: cambios de estilo", () => {
  it("elegir un color del trazo envia strokeColor", async () => {
    const { bar, cb } = await mount(RECT);
    fireEvent.click(action(bar!, "stroke-color")!);
    expect(action(bar!, "stroke-color")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(bar!.querySelector('[data-color-swatch="#0d4bff"]')!);
    expect(cb.onRestyle).toHaveBeenCalledWith({ strokeColor: "#0d4bff" });
  });

  it("el resaltado ofrece SUS colores, no las tintas", async () => {
    const { bar } = await mount(HIGHLIGHT);
    fireEvent.click(action(bar!, "highlight-color")!);
    const swatches = Array.from(bar!.querySelectorAll("[data-color-swatch]")).map((el) => el.getAttribute("data-color-swatch"));
    expect(swatches).toEqual(["#fff176", "#a5f3a0", "#9ad9ff", "#ffb4d1", "#ffd08a"]);
  });

  it("el color del resaltado envia `color`; su intensidad, `opacity`", async () => {
    const { bar, cb } = await mount(HIGHLIGHT);
    fireEvent.click(action(bar!, "highlight-color")!);
    fireEvent.click(bar!.querySelector('[data-color-swatch="#ffb4d1"]')!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ color: "#ffb4d1" });
    fireEvent.click(action(bar!, "highlight-opacity-75")!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ opacity: 0.75 });
  });

  it("grosor: +/- de 0,5 en 0,5 con limites", async () => {
    const { bar, cb } = await mount(RECT);
    fireEvent.click(action(bar!, "width-up")!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ strokeWidth: 2.5 });
    fireEvent.click(action(bar!, "width-down")!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ strokeWidth: 1.5 });
  });

  it("el grosor de una linea no baja de 0,5 y el de una forma puede llegar a 0", async () => {
    const small: ElementBarState = { type: "line", strokeColor: "#000000", strokeWidth: 0.5 };
    const { bar, cb } = await mount(small);
    fireEvent.click(action(bar!, "width-down")!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ strokeWidth: 0.5 });
    cleanup();
    const zero: ElementBarState = { ...RECT, strokeWidth: 0.5 } as ElementBarState;
    const second = await mount(zero);
    fireEvent.click(action(second.bar!, "width-down")!);
    expect(second.cb.onRestyle).toHaveBeenLastCalledWith({ strokeWidth: 0 });
  });

  it("el grosor no pasa de 12", async () => {
    const thick: ElementBarState = { type: "line", strokeColor: "#000000", strokeWidth: 12 };
    const { bar, cb } = await mount(thick);
    fireEvent.click(action(bar!, "width-up")!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ strokeWidth: 12 });
  });

  it("se puede teclear un grosor (con coma decimal) y se aplica al confirmar", async () => {
    const { bar, cb } = await mount(RECT);
    const input = action(bar!, "width") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "4,5" } });
    expect(cb.onRestyle).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ strokeWidth: 4.5 });
  });

  it("un grosor tecleado fuera de rango se recorta", async () => {
    const { bar, cb } = await mount(LINE);
    const input = action(bar!, "width") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ strokeWidth: 12 });
  });

  it("alternar el relleno envia fill; con relleno, el color y la opacidad", async () => {
    const { bar, cb } = await mount(RECT);
    fireEvent.click(action(bar!, "fill")!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ fill: true });
    cleanup();
    const filled = await mount(FILLED);
    fireEvent.click(action(filled.bar!, "fill")!);
    expect(filled.cb.onRestyle).toHaveBeenLastCalledWith({ fill: false });
    fireEvent.click(action(filled.bar!, "fill-opacity-75")!);
    expect(filled.cb.onRestyle).toHaveBeenLastCalledWith({ fillOpacity: 0.75 });
    fireEvent.click(action(filled.bar!, "fill-color")!);
    fireEvent.click(filled.bar!.querySelector('[data-color-swatch="#0f9d68"]')!);
    expect(filled.cb.onRestyle).toHaveBeenLastCalledWith({ fillColor: "#0f9d68" });
  });

  it("el boton del relleno esta pulsado cuando hay relleno", async () => {
    const { bar } = await mount(FILLED);
    expect(action(bar!, "fill")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("la marca cambia de simbolo", async () => {
    const { bar, cb } = await mount(CHECK);
    fireEvent.click(action(bar!, "mark-cross")!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ mark: "cross" });
  });

  it("duplicar y borrar llaman a sus callbacks", async () => {
    const { bar, cb } = await mount(IMAGE);
    fireEvent.click(action(bar!, "duplicate")!);
    fireEvent.click(action(bar!, "delete")!);
    expect(cb.onDuplicate).toHaveBeenCalledTimes(1);
    expect(cb.onDelete).toHaveBeenCalledTimes(1);
  });

  it("los botones llevan nombre accesible y los de opacidad dicen el porcentaje", async () => {
    const { bar } = await mount(FILLED);
    expect(within(bar!).getByRole("button", { name: s.duplicate, hidden: true })).toBeTruthy();
    expect(within(bar!).getByRole("button", { name: "Opacidad 50 %", hidden: true })).toBeTruthy();
    expect(within(bar!).getByRole("button", { name: s.strokeColorOpen, hidden: true })).toBeTruthy();
  });
});

describe("ElementFloatingBar: teclado", () => {
  it("Esc devuelve el foco al elemento", async () => {
    const { bar, cb } = await mount(RECT);
    fireEvent.keyDown(action(bar!, "fill")!, { key: "Escape" });
    expect(cb.onEscape).toHaveBeenCalled();
  });

  it("Mayus+Tab desde la primera accion vuelve al elemento y Tab desde la ultima sigue con el siguiente", async () => {
    const { bar, cb } = await mount(IMAGE);
    const first = action(bar!, "duplicate")!;
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(cb.onTabBackward).toHaveBeenCalled();
    const last = action(bar!, "delete")!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(cb.onTabForward).toHaveBeenCalled();
  });
});

describe("barStateOf", () => {
  it("devuelve solo los campos de estilo que entiende cada tipo", () => {
    const rect = shapeItem({ id: "r", pageIndex: 0, type: "rect", x: 0.1, y: 0.1, width: 0.2, height: 0.2, strokeColor: "#000000", strokeWidth: 1, fill: true, fillColor: "#ffffff", fillOpacity: 0.5 });
    expect(barStateOf(rect)).toEqual({ type: "rect", strokeColor: "#000000", strokeWidth: 1, fill: true, fillColor: "#ffffff", fillOpacity: 0.5 });
    expect(barStateOf(shapeItem({ id: "h", pageIndex: 0, type: "highlight", x: 0, y: 0, width: 0.2, height: 0.1, color: "#fff176", opacity: 0.4 }))).toEqual(HIGHLIGHT);
    const image: EditImageItem = { kind: "image", id: "i", element: { id: "i", pageIndex: 0, type: "image", x: 0, y: 0, width: 0.1, height: 0.1, ratio: 1, assetId: "a" } };
    expect(barStateOf(image)).toEqual({ type: "image" });
  });

  it("formatWidth redondea a un decimal", () => {
    expect(formatWidth(2)).toBe("2");
    expect(formatWidth(2.54)).toBe("2.5");
  });
});
