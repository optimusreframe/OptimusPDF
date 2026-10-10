import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  TextBlockLayer,
  buildEntries,
  entryRenderCounts,
  type LayerHandlers,
  type TextBlockLayerProps,
} from "@/app/edit-pdf/TextBlockLayer";
import { userBoxToPx } from "@/app/edit-pdf/editCanvasMath";
import { makeBlock, makeEdit, metricsFor } from "@/app/edit-pdf/editTestUtils";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import type { TextBlock } from "@/lib/pdf/editTypes";

const s = EDIT_STRINGS.es.inline;

function handlers(): LayerHandlers {
  return {
    onSelect: vi.fn(),
    onBeginEdit: vi.fn(),
    onDelete: vi.fn(),
    onNudge: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onGesture: vi.fn(),
    onTabIntoBar: vi.fn(() => false),
  };
}

const A = makeBlock("p0-b0", { text: "Titulo", box: { x: 50, y: 780, width: 120, height: 20 } });
const B = makeBlock("p0-b1", { text: "Segundo bloque", box: { x: 50, y: 700, width: 160, height: 14 } });
const C = makeBlock("p0-b2", { text: "Tercero", box: { x: 300, y: 700, width: 80, height: 14 } });

function setup(overrides: Partial<TextBlockLayerProps> = {}, blocks: TextBlock[] = [A, B, C]) {
  const h = handlers();
  const props: TextBlockLayerProps = {
    metrics: metricsFor(),
    blocks,
    edits: [],
    pending: null,
    selectedKey: null,
    editingKey: null,
    editingCover: null,
    coarse: false,
    strings: s,
    handlers: h,
    ...overrides,
  };
  const view = render(<TextBlockLayer {...props} />);
  return { h, props, ...view };
}

function region(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-element-id="${id}"]`);
  if (!el) throw new Error(`sin region ${id}`);
  return el;
}

function pointer(el: Element, type: "Down" | "Move" | "Up" | "Cancel", init: Record<string, unknown> = {}) {
  const fire = {
    Down: fireEvent.pointerDown,
    Move: fireEvent.pointerMove,
    Up: fireEvent.pointerUp,
    Cancel: fireEvent.pointerCancel,
  }[type];
  fire(el, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0, ...init });
}

beforeEach(() => entryRenderCounts.clear());

describe("TextBlockLayer — regiones accesibles", () => {
  it("pinta una region por bloque, enfocable, con el texto como nombre", () => {
    setup();
    const regions = screen.getAllByRole("button");
    expect(regions).toHaveLength(3);
    // Roving tabindex (W5-U5): UNA sola parada de Tab para toda la capa.
    expect(regions.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(regions.filter((r) => r.tabIndex === -1)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Texto: Segundo bloque" })).toBeTruthy();
    expect(region("p0-b1").getAttribute("data-element-kind")).toBe("text");
    expect(region("p0-b1").getAttribute("data-drag-mode")).toBe("move");
  });

  it("el orden del DOM (y de Tab) es el orden de lectura, no el de extraccion", () => {
    setup({}, [C, B, A]);
    const ids = screen.getAllByRole("button").map((r) => r.getAttribute("data-element-id"));
    expect(ids).toEqual(["p0-b0", "p0-b1", "p0-b2"]);
  });

  it("anuncia «Bloque n de N: texto» en una region viva al enfocar", () => {
    setup();
    const live = document.querySelector("[data-block-live]") as HTMLElement;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("");
    act(() => region("p0-b1").focus());
    expect(live.textContent).toBe("Bloque 2 de 3: Segundo bloque");
    act(() => region("p0-b2").focus());
    expect(live.textContent).toBe("Bloque 3 de 3: Tercero");
  });

  it("los bloques con edicion y los textos nuevos entran en la lista y en el total", () => {
    const edit = makeEdit({ id: "e1", blockId: "p0-b1", text: "Cambiado" });
    const own = makeEdit({ id: "e2", text: "Mio" });
    setup({ edits: [edit, own] });
    expect(screen.getByRole("button", { name: "Texto: Cambiado" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Texto añadido: Mio" })).toBeTruthy();
    const live = document.querySelector("[data-block-live]") as HTMLElement;
    act(() => region("e2").focus());
    expect(live.textContent).toBe("Bloque 4 de 4: Mio");
  });

  it("una edicion de un bloque que aun no se extrajo se muestra igual (clave = blockId)", () => {
    setup({ edits: [makeEdit({ id: "e9", blockId: "p0-b77", text: "Restaurado" })] }, []);
    expect(region("p0-b77")).toBeTruthy();
  });

  it("buildEntries: bloques en orden de lectura, luego textos propios y el borrador", () => {
    const pending = makeEdit({ id: "pend", text: "" });
    const entries = buildEntries([C, A, B], [makeEdit({ id: "x", text: "n" })], pending);
    expect(entries.map((e) => e.key)).toEqual(["p0-b0", "p0-b1", "p0-b2", "x", "pend"]);
    expect(entries[4].pending).toBe(true);
  });

  it("la region de un bloque empty muestra el nombre de texto vacio", () => {
    setup({ edits: [makeEdit({ id: "e1", blockId: "p0-b1", text: "" })] });
    const el = region("p0-b1");
    expect(el.getAttribute("aria-label")).toBe(s.emptyTextName);
    expect(el.hasAttribute("data-emptied")).toBe(true);
  });

  it("la posicion de la region sigue la geometria con /Rotate 90 y CropBox desplazado", () => {
    const metrics = metricsFor([20, 10, 380, 290], 90, 280);
    const block = makeBlock("g", { box: { x: 100, y: 120, width: 60, height: 12 } });
    setup({ metrics }, [block]);
    const expected = userBoxToPx(metrics, block.box);
    const el = region("g");
    expect(parseFloat(el.style.left)).toBeCloseTo(expected.left, 4);
    expect(parseFloat(el.style.top)).toBeCloseTo(expected.top, 4);
    expect(parseFloat(el.style.width)).toBeCloseTo(expected.width, 4);
    expect(parseFloat(el.style.height)).toBeCloseTo(expected.height, 4);
  });
});

describe("TextBlockLayer — selecccion y edicion con puntero", () => {
  it("el clic de raton selecciona al instante", () => {
    const { h } = setup();
    pointer(region("p0-b1"), "Down", { clientX: 10, clientY: 10 });
    expect(h.onSelect).toHaveBeenCalledWith("p0-b1");
    pointer(region("p0-b1"), "Up", { clientX: 10, clientY: 10 });
    expect(h.onBeginEdit).not.toHaveBeenCalled();
  });

  it("dos clics seguidos sobre el mismo bloque lo editan (doble clic)", () => {
    const { h } = setup();
    const el = region("p0-b1");
    for (let i = 0; i < 2; i += 1) {
      pointer(el, "Down", { clientX: 10, clientY: 10 });
      pointer(el, "Up", { clientX: 10, clientY: 10 });
    }
    expect(h.onBeginEdit).toHaveBeenCalledTimes(1);
    expect(h.onBeginEdit).toHaveBeenCalledWith("p0-b1");
  });

  it("dos clics en bloques distintos NO son un doble clic", () => {
    const { h } = setup();
    for (const id of ["p0-b1", "p0-b2"]) {
      pointer(region(id), "Down");
      pointer(region(id), "Up");
    }
    expect(h.onBeginEdit).not.toHaveBeenCalled();
  });

  it("con el dedo, el primer toque selecciona al soltar y tocar el ya seleccionado lo edita", () => {
    const { h, rerender, props } = setup();
    const touch = { pointerType: "touch", clientX: 5, clientY: 5 };
    pointer(region("p0-b1"), "Down", touch);
    expect(h.onSelect).not.toHaveBeenCalled(); // un dedo que arrastra desplaza la pagina
    pointer(region("p0-b1"), "Up", touch);
    expect(h.onSelect).toHaveBeenCalledWith("p0-b1");
    rerender(<TextBlockLayer {...props} selectedKey="p0-b1" />);
    pointer(region("p0-b1"), "Down", touch);
    pointer(region("p0-b1"), "Up", touch);
    // Se edita en el `click` posterior: el foco que mueve el navegador al tocar llega antes.
    expect(h.onBeginEdit).not.toHaveBeenCalled();
    fireEvent.click(region("p0-b1"));
    expect(h.onBeginEdit).toHaveBeenCalledWith("p0-b1");
  });

  it("un click suelto (sin toque previo sobre el bloque seleccionado) no abre la edicion", () => {
    const { h } = setup({ selectedKey: "p0-b1" });
    fireEvent.click(region("p0-b1"));
    expect(h.onBeginEdit).not.toHaveBeenCalled();
  });

  it("si el toque se convierte en arrastre no se edita al llegar el click", () => {
    const { h } = setup({ selectedKey: "p0-b1" });
    const touch = { pointerType: "touch", clientX: 5, clientY: 5 };
    pointer(region("p0-b1"), "Down", touch);
    pointer(region("p0-b1"), "Move", { ...touch, clientX: 60 });
    pointer(region("p0-b1"), "Up", { ...touch, clientX: 60 });
    fireEvent.click(region("p0-b1"));
    expect(h.onBeginEdit).not.toHaveBeenCalled();
    expect(h.onMove).toHaveBeenCalledTimes(1);
  });

  it("un bloque sin seleccionar deja desplazar la pagina con el dedo; seleccionado se queda el gesto", () => {
    const { rerender, props } = setup();
    expect(region("p0-b1").className).toContain("touch-pan-y");
    rerender(<TextBlockLayer {...props} selectedKey="p0-b1" />);
    expect(region("p0-b1").className).toContain("touch-none");
  });

  it("con puntero grueso la zona de toque mide al menos 44 px sin tocar al vecino", () => {
    const tiny = makeBlock("t1", { box: { x: 50, y: 400, width: 30, height: 10 } });
    const next = makeBlock("t2", { box: { x: 50, y: 360, width: 30, height: 10 } });
    setup({ coarse: true }, [tiny, next]);
    const a = region("t1");
    const b = region("t2");
    expect(parseFloat(a.style.width)).toBeGreaterThanOrEqual(43.9);
    expect(parseFloat(a.style.height)).toBeGreaterThanOrEqual(43.9 - 10);
    const aBottom = parseFloat(a.style.top) + parseFloat(a.style.height);
    expect(aBottom).toBeLessThanOrEqual(parseFloat(b.style.top) + 0.001);
  });

  it("con puntero fino la region mide lo que el bloque", () => {
    setup({ coarse: false }, [makeBlock("t1", { box: { x: 50, y: 400, width: 30, height: 10 } })]);
    expect(parseFloat(region("t1").style.width)).toBeCloseTo(30, 4);
  });
});

describe("TextBlockLayer — teclado", () => {
  it("Intro y F2 editan; Espacio selecciona", () => {
    const { h } = setup();
    const el = region("p0-b1");
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: "F2" });
    expect(h.onBeginEdit).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(el, { key: " " });
    expect(h.onSelect).toHaveBeenCalledWith("p0-b1");
  });

  it("teclear un caracter imprimible abre la edicion con esa tecla", () => {
    const { h } = setup();
    fireEvent.keyDown(region("p0-b1"), { key: "q" });
    expect(h.onBeginEdit).toHaveBeenCalledWith("p0-b1", "q");
  });

  it("los atajos con Ctrl/Cmd/Alt no abren la edicion", () => {
    const { h } = setup();
    fireEvent.keyDown(region("p0-b1"), { key: "c", ctrlKey: true });
    fireEvent.keyDown(region("p0-b1"), { key: "c", metaKey: true });
    expect(h.onBeginEdit).not.toHaveBeenCalled();
  });

  it("Supr y Retroceso borran", () => {
    const { h } = setup();
    fireEvent.keyDown(region("p0-b2"), { key: "Delete" });
    fireEvent.keyDown(region("p0-b2"), { key: "Backspace" });
    expect(h.onDelete).toHaveBeenCalledTimes(2);
    expect(h.onDelete).toHaveBeenCalledWith("p0-b2");
  });

  it("seleccionado, las flechas mueven (Mayus = paso grande) y Alt + flechas cambian el tamano", () => {
    const { h } = setup({ selectedKey: "p0-b1" });
    const el = region("p0-b1");
    fireEvent.keyDown(el, { key: "ArrowLeft" });
    expect(h.onNudge).toHaveBeenLastCalledWith("p0-b1", "left", false, false);
    fireEvent.keyDown(el, { key: "ArrowDown", shiftKey: true });
    expect(h.onNudge).toHaveBeenLastCalledWith("p0-b1", "down", true, false);
    fireEvent.keyDown(el, { key: "ArrowRight", altKey: true });
    expect(h.onNudge).toHaveBeenLastCalledWith("p0-b1", "right", false, true);
  });

  it("las flechas no desplazan la pagina (preventDefault)", () => {
    setup({ selectedKey: "p0-b1" });
    expect(fireEvent.keyDown(region("p0-b1"), { key: "ArrowUp" })).toBe(false);
  });

  it("Esc deselecciona", () => {
    const { h } = setup();
    fireEvent.keyDown(region("p0-b1"), { key: "Escape" });
    expect(h.onSelect).toHaveBeenCalledWith(null);
  });

  it("Tab desde el bloque seleccionado entra en la barra si hay barra", () => {
    const { h, rerender, props } = setup({ selectedKey: "p0-b1" });
    (h.onTabIntoBar as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
    expect(fireEvent.keyDown(region("p0-b1"), { key: "Tab" })).toBe(false);
    expect(h.onTabIntoBar).toHaveBeenCalledWith("p0-b1");
    // Mayus+Tab y los bloques sin seleccionar siguen el orden natural.
    expect(fireEvent.keyDown(region("p0-b1"), { key: "Tab", shiftKey: true })).toBe(true);
    rerender(<TextBlockLayer {...props} selectedKey={null} />);
    expect(fireEvent.keyDown(region("p0-b1"), { key: "Tab" })).toBe(true);
  });

  it("ignora las teclas que llegan desde un hijo (no del propio bloque)", () => {
    const { h } = setup();
    const inner = region("p0-b1").querySelector("span") as HTMLElement;
    fireEvent.keyDown(inner, { key: "Delete" });
    expect(h.onDelete).not.toHaveBeenCalled();
  });
});

describe("TextBlockLayer — bloques no editables", () => {
  const readOnly = makeBlock("p0-b9", {
    text: "ÿþ\u0001",
    editable: false,
    readOnlyReason: "no-unicode",
    box: { x: 50, y: 500, width: 100, height: 14 },
  });

  it("se marcan aria-disabled, con el motivo en el nombre accesible y en el tooltip", () => {
    setup({}, [A, readOnly]);
    const el = region("p0-b9");
    expect(el.getAttribute("aria-disabled")).toBe("true");
    expect(el.hasAttribute("data-not-editable")).toBe(true);
    expect(el.getAttribute("title")).toBe("No editable: sin mapa de caracteres");
    expect(el.getAttribute("aria-label")).toContain("No editable: sin mapa de caracteres");
    expect(el.getAttribute("aria-pressed")).toBeNull();
    expect(el.className).toContain("cursor-not-allowed");
  });

  it("cada motivo tiene su texto", () => {
    for (const reason of ["type3", "invisible", "symbolic", "vertical"] as const) {
      const { unmount } = setup({}, [{ ...readOnly, readOnlyReason: reason }]);
      expect(region("p0-b9").getAttribute("title")).toBe(s.notEditable(s.reasons[reason]));
      unmount();
    }
  });

  it("no se entra a editar: ni con Intro, ni con teclas, ni con clic; se anuncia el motivo", () => {
    const { h } = setup({}, [A, readOnly]);
    const el = region("p0-b9");
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: "x" });
    fireEvent.keyDown(el, { key: "Delete" });
    fireEvent.keyDown(el, { key: "ArrowLeft", shiftKey: true });
    pointer(el, "Down");
    pointer(el, "Up");
    pointer(el, "Down");
    pointer(el, "Up");
    expect(h.onBeginEdit).not.toHaveBeenCalled();
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(h.onNudge).not.toHaveBeenCalled();
    const live = document.querySelector("[data-block-live]") as HTMLElement;
    expect(live.textContent).toContain("No editable: sin mapa de caracteres");
  });

  it("al enfocarlo se anuncia el bloque con su motivo", () => {
    setup({}, [A, readOnly]);
    act(() => region("p0-b9").focus());
    const live = document.querySelector("[data-block-live]") as HTMLElement;
    expect(live.textContent).toMatch(/^Bloque 2 de 2: .*No editable: sin mapa de caracteres$/);
  });

  it("un bloque no editable no muestra tiradores ni siquiera 'seleccionado'", () => {
    setup({ selectedKey: "p0-b9" }, [readOnly]);
    expect(document.querySelectorAll("[data-resize-handle]")).toHaveLength(0);
  });
});

describe("TextBlockLayer — cobertura y vista del texto editado", () => {
  it("una edicion con cobertura pinta el rectangulo del color y 1 pt de margen alrededor de la caja original", () => {
    const edit = makeEdit({
      id: "e1",
      blockId: "p0-b1",
      cover: { color: "#fefefe", padding: 1 },
      coverBox: B.box,
    });
    setup({ edits: [edit] });
    const cover = document.querySelector<HTMLElement>('[data-cover="p0-b1"]')!;
    expect(cover.style.backgroundColor).toBe("rgb(254, 254, 254)");
    const rect = userBoxToPx(metricsFor(), B.box);
    expect(parseFloat(cover.style.left)).toBeCloseTo(rect.left - 1, 4);
    expect(parseFloat(cover.style.width)).toBeCloseTo(rect.width + 2, 4);
  });

  it("texto original girado un angulo libre: la cobertura es el rectangulo ORIENTADO (la misma forma que exporta), no la caja envolvente", () => {
    const edit = makeEdit({
      id: "e1",
      blockId: "p0-b1",
      cover: { color: "#ffffff", padding: 1 },
      coverBox: { x: 50, y: 600, width: 170, height: 150 },
      coverOriented: { origin: { x: 60, y: 610 }, width: 120, height: 20, rotation: 40 },
    });
    setup({ edits: [edit] });
    const cover = document.querySelector<HTMLElement>('[data-cover="p0-b1"]')!;
    // 120 x 20 pt mas 1 pt por lado (escala de metricsFor), girado 40 grados antihorarios en la vista.
    const scale = metricsFor().scale;
    expect(parseFloat(cover.style.width)).toBeCloseTo(122 * scale, 4);
    expect(parseFloat(cover.style.height)).toBeCloseTo(22 * scale, 4);
    expect(cover.style.transform).toBe("rotate(-40deg)");
  });

  it("sin edicion no hay cobertura salvo el bloque que se esta editando (color provisional)", () => {
    const { rerender, props } = setup();
    expect(document.querySelector("[data-cover]")).toBeNull();
    rerender(<TextBlockLayer {...props} editingKey="p0-b1" editingCover="#fafafa" />);
    expect(document.querySelector<HTMLElement>('[data-cover="p0-b1"]')?.style.backgroundColor).toBe(
      "rgb(250, 250, 250)",
    );
  });

  it("un texto nuevo (sin cobertura) no pinta rectangulo", () => {
    setup({ edits: [makeEdit({ id: "e2", text: "Nuevo" })] });
    expect(document.querySelector("[data-cover]")).toBeNull();
  });

  it("el texto editado se ve con su fuente, tamano escalado y color", () => {
    const edit = makeEdit({ id: "e1", blockId: "p0-b1", text: "Hola\nmundo", fontSize: 10, color: "#ff0000" });
    setup({ edits: [edit], metrics: metricsFor([0, 0, 595, 842], 0, 1190) });
    const view = document.querySelector<HTMLElement>('[data-text-view="p0-b1"]')!;
    expect(view.textContent).toBe("Hola\nmundo");
    expect(view.className).toContain("whitespace-pre-line");
    expect(view.style.fontSize).toBe("20px");
    expect(view.style.color).toBe("rgb(255, 0, 0)");
    expect(view.getAttribute("aria-hidden")).toBe("true");
  });

  it("mientras se edita, la vista estatica se oculta (lo pinta el editor)", () => {
    const edit = makeEdit({ id: "e1", blockId: "p0-b1", text: "Hola" });
    setup({ edits: [edit], editingKey: "p0-b1" });
    expect(document.querySelector('[data-text-view="p0-b1"]')).toBeNull();
  });

  it("una edicion girada coloca el marco con el giro de la vista", () => {
    const edit = makeEdit({
      id: "e1",
      blockId: "p0-b1",
      rotation: 90,
      box: { x: 100, y: 100, width: 14, height: 120 },
    });
    setup({ edits: [edit] });
    const view = document.querySelector<HTMLElement>('[data-text-view="p0-b1"]')!;
    expect(view.style.transform).toContain("rotate(-90deg)");
  });
});

describe("TextBlockLayer — mover y redimensionar", () => {
  it("arrastrar mas alla del umbral mueve el bloque al soltar, con una sola llamada", () => {
    const { h } = setup({ selectedKey: "p0-b1" });
    const el = region("p0-b1");
    pointer(el, "Down", { clientX: 100, clientY: 100 });
    pointer(el, "Move", { clientX: 130, clientY: 120 });
    expect(h.onGesture).toHaveBeenCalledWith(true);
    pointer(el, "Up", { clientX: 140, clientY: 125 });
    expect(h.onMove).toHaveBeenCalledTimes(1);
    expect(h.onMove).toHaveBeenCalledWith("p0-b1", 40, 25);
    expect(h.onGesture).toHaveBeenLastCalledWith(false);
    expect(h.onBeginEdit).not.toHaveBeenCalled();
  });

  it("un temblor por debajo del umbral sigue siendo un toque, no un arrastre", () => {
    const { h } = setup({ selectedKey: "p0-b1" });
    const el = region("p0-b1");
    pointer(el, "Down", { clientX: 100, clientY: 100 });
    pointer(el, "Move", { clientX: 103, clientY: 102 });
    pointer(el, "Up", { clientX: 103, clientY: 102 });
    expect(h.onMove).not.toHaveBeenCalled();
    expect(h.onGesture).not.toHaveBeenCalledWith(true);
  });

  it("mientras se arrastra, el bloque se desplaza en pantalla sin mover la cobertura", () => {
    const edit = makeEdit({ id: "e1", blockId: "p0-b1", cover: { color: "#fff", padding: 1 }, coverBox: B.box });
    setup({ edits: [edit], selectedKey: "p0-b1" });
    const el = region("p0-b1");
    const before = parseFloat(el.style.left);
    const coverBefore = (document.querySelector('[data-cover="p0-b1"]') as HTMLElement).style.left;
    pointer(el, "Down", { clientX: 100, clientY: 100 });
    pointer(el, "Move", { clientX: 160, clientY: 100 });
    expect(parseFloat(region("p0-b1").style.left)).toBeCloseTo(before + 60, 4);
    expect((document.querySelector('[data-cover="p0-b1"]') as HTMLElement).style.left).toBe(coverBefore);
  });

  it("Esc cancela el arrastre: al soltar no se mueve nada", () => {
    const { h } = setup({ selectedKey: "p0-b1" });
    const el = region("p0-b1");
    pointer(el, "Down", { clientX: 100, clientY: 100 });
    pointer(el, "Move", { clientX: 160, clientY: 100 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(h.onGesture).toHaveBeenLastCalledWith(false);
    pointer(el, "Up", { clientX: 160, clientY: 100 });
    expect(h.onMove).not.toHaveBeenCalled();
    expect(parseFloat(region("p0-b1").style.left)).toBeCloseTo(50, 4);
  });

  it("pointercancel (el navegador toma el gesto) descarta el arrastre", () => {
    const { h } = setup({ selectedKey: "p0-b1" });
    const el = region("p0-b1");
    pointer(el, "Down", { clientX: 100, clientY: 100 });
    pointer(el, "Move", { clientX: 160, clientY: 100 });
    pointer(el, "Cancel");
    pointer(el, "Up", { clientX: 160, clientY: 100 });
    expect(h.onMove).not.toHaveBeenCalled();
  });

  it("el bloque seleccionado (holgado) muestra cuatro tiradores con area tactil >= 44 px", () => {
    const big = makeBlock("p0-big", { text: "Grande", box: { x: 50, y: 500, width: 200, height: 120 } });
    setup({ selectedKey: "p0-big", coarse: true }, [big]);
    const handles = document.querySelectorAll<HTMLElement>("[data-resize-handle]");
    expect(handles).toHaveLength(4);
    handles.forEach((handle) => {
      expect(parseFloat(handle.style.width)).toBeGreaterThanOrEqual(44);
      expect(parseFloat(handle.style.height)).toBeGreaterThanOrEqual(44);
      expect(handle.getAttribute("aria-hidden")).toBe("true");
    });
  });

  it("los tiradores no existen sin seleccion ni en texto a 45 grados", () => {
    const { rerender, props } = setup();
    expect(document.querySelectorAll("[data-resize-handle]")).toHaveLength(0);
    const tilted = makeBlock("tilt", { rotation: 45, box: { x: 100, y: 100, width: 80, height: 80 } });
    rerender(<TextBlockLayer {...props} blocks={[tilted]} selectedKey="tilt" />);
    expect(document.querySelectorAll("[data-resize-handle]")).toHaveLength(0);
  });

  it("arrastrar el tirador SE cambia el tamano: el vertice opuesto queda fijo", () => {
    const { h } = setup({ selectedKey: "p0-b1" });
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    const before = userBoxToPx(metricsFor(), B.box);
    pointer(handle, "Down", { clientX: 200, clientY: 200 });
    pointer(handle, "Move", { clientX: 240, clientY: 230 });
    pointer(handle, "Up", { clientX: 240, clientY: 230 });
    expect(h.onResize).toHaveBeenCalledTimes(1);
    const [key, rect] = (h.onResize as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(key).toBe("p0-b1");
    expect(rect.left).toBeCloseTo(before.left, 4);
    expect(rect.top).toBeCloseTo(before.top, 4);
    expect(rect.width).toBeCloseTo(before.width + 40, 4);
    expect(rect.height).toBeCloseTo(before.height + 30, 4);
  });

  it("al editar aparece el asa de mover y el anillo exterior arrastra el bloque", () => {
    const { h } = setup({ editingKey: "p0-b1" });
    expect(document.querySelector("[data-move-handle]")).not.toBeNull();
    const el = region("p0-b1");
    pointer(el, "Down", { clientX: 100, clientY: 100 });
    pointer(el, "Move", { clientX: 100, clientY: 150 });
    pointer(el, "Up", { clientX: 100, clientY: 150 });
    expect(h.onMove).toHaveBeenCalledWith("p0-b1", 0, 50);
    // Tocar el anillo sin arrastrar no hace nada mas (no vuelve a seleccionar ni a editar).
    expect(h.onBeginEdit).not.toHaveBeenCalled();
  });
});

describe("TextBlockLayer — rendimiento con 300 bloques", () => {
  it("cambiar el texto de UN bloque solo vuelve a pintar esa entrada", () => {
    const blocks = Array.from({ length: 300 }, (_, i) =>
      makeBlock(`p0-b${i}`, {
        text: `Bloque ${i}`,
        box: { x: 20 + (i % 3) * 180, y: 800 - Math.floor(i / 3) * 6, width: 150, height: 5 },
      }),
    );
    const h = handlers();
    const base: TextBlockLayerProps = {
      metrics: metricsFor(),
      blocks,
      edits: [],
      pending: null,
      selectedKey: null,
      editingKey: null,
      editingCover: null,
      coarse: false,
      strings: s,
      handlers: h,
    };
    const { rerender } = render(<TextBlockLayer {...base} />);
    expect(screen.getAllByRole("button")).toHaveLength(300);
    entryRenderCounts.clear();

    const edit = makeEdit({ id: "e150", blockId: "p0-b150", text: "a" });
    rerender(<TextBlockLayer {...base} edits={[edit]} selectedKey="p0-b150" editingKey="p0-b150" />);
    const afterFirst = new Map(entryRenderCounts);
    expect(afterFirst.get("p0-b150")).toBe(1);

    // Teclear: la edicion cambia, el resto de props son las mismas.
    entryRenderCounts.clear();
    for (let i = 0; i < 20; i += 1) {
      rerender(
        <TextBlockLayer
          {...base}
          edits={[{ ...edit, text: "a".repeat(i + 2) }]}
          selectedKey="p0-b150"
          editingKey="p0-b150"
        />,
      );
    }
    expect(entryRenderCounts.get("p0-b150")).toBe(20);
    const others = [...entryRenderCounts.entries()].filter(([key]) => key !== "p0-b150");
    expect(others).toHaveLength(0);
  });

  it("buildEntries de 300 bloques es rapido y estable", () => {
    const blocks = Array.from({ length: 300 }, (_, i) => makeBlock(`b${i}`, { box: { x: 10, y: 800 - i * 2, width: 50, height: 2 } }));
    const t0 = performance.now();
    const entries = buildEntries(blocks, [], null);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(entries).toHaveLength(300);
    expect(within(document.body).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("TextBlockLayer — roving tabindex y navegacion con flechas (W5-U5)", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    makeBlock(`p0-b${i}`, { text: `Bloque ${i}`, box: { x: 50, y: 800 - i * 20, width: 100, height: 14 } }),
  );
  const focused = () => (document.activeElement as HTMLElement | null)?.dataset.elementId;

  it("con 30 bloques solo hay UNA parada de Tab (la primera por defecto)", () => {
    setup({}, many);
    const stops = Array.from(document.querySelectorAll<HTMLElement>('[data-element-kind="text"]')).filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0].dataset.elementId).toBe(many[0].id);
  });

  it("la parada de Tab es el bloque seleccionado si lo hay", () => {
    setup({ selectedKey: "p0-b7" }, many);
    expect(region("p0-b7").tabIndex).toBe(0);
    expect(region("p0-b0").tabIndex).toBe(-1);
  });

  it("las flechas (sin seleccionar) pasan al siguiente/anterior bloque en orden de lectura y mueven la parada de Tab", () => {
    const { h } = setup({}, many);
    act(() => region("p0-b0").focus());
    fireEvent.keyDown(region("p0-b0"), { key: "ArrowDown" });
    expect(focused()).toBe("p0-b1");
    fireEvent.keyDown(region("p0-b1"), { key: "ArrowRight" });
    expect(focused()).toBe("p0-b2");
    fireEvent.keyDown(region("p0-b2"), { key: "ArrowUp" });
    fireEvent.keyDown(region("p0-b1"), { key: "ArrowLeft" });
    expect(focused()).toBe("p0-b0");
    expect(region("p0-b0").tabIndex).toBe(0);
    expect(region("p0-b2").tabIndex).toBe(-1);
    expect(h.onNudge).not.toHaveBeenCalled();
  });

  it("Inicio, Fin, Av Pag y Re Pag saltan; los extremos no dan la vuelta", () => {
    setup({}, many);
    act(() => region("p0-b0").focus());
    fireEvent.keyDown(region("p0-b0"), { key: "End" });
    expect(focused()).toBe("p0-b29");
    fireEvent.keyDown(region("p0-b29"), { key: "ArrowDown" });
    expect(focused()).toBe("p0-b29");
    fireEvent.keyDown(region("p0-b29"), { key: "PageUp" });
    expect(focused()).toBe("p0-b19");
    fireEvent.keyDown(region("p0-b19"), { key: "PageDown" });
    expect(focused()).toBe("p0-b29");
    fireEvent.keyDown(region("p0-b29"), { key: "Home" });
    expect(focused()).toBe("p0-b0");
  });

  it("Mayus o Alt + flechas actuan sobre el bloque aunque no este seleccionado (mover grande / redimensionar)", () => {
    const { h } = setup({}, many);
    fireEvent.keyDown(region("p0-b3"), { key: "ArrowRight", altKey: true });
    expect(h.onNudge).toHaveBeenLastCalledWith("p0-b3", "right", false, true);
  });

  it("un bloque no editable tambien se recorre con flechas", () => {
    const readOnly = makeBlock("p0-b9", { text: "Solo lectura", editable: false, readOnlyReason: "type3" });
    setup({}, [A, readOnly]);
    act(() => region("p0-b9").focus());
    fireEvent.keyDown(region("p0-b9"), { key: "ArrowLeft" });
    expect(focused()).toBe("p0-b0");
  });

  it("la descripcion accesible nombra los atajos: flechas, Inicio/Fin, Intro, Espacio, Alt y Supr", () => {
    setup({}, many);
    const hint = document.getElementById(region("p0-b0").getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(s.blockHint);
    for (const word of ["flechas", "Inicio", "Intro", "Alt", "Supr"]) expect(s.blockHint).toContain(word);
    expect(region("p0-b0").getAttribute("aria-keyshortcuts")).toContain("Home");
  });
});

describe("TextBlockLayer — cobertura girada con huecos (W5-U5)", () => {
  it("el rectangulo girado marca que lleva huecos (clip-path par-impar), como la exportacion", () => {
    const crossed = makeBlock("p0-b7", { text: "Girado" });
    const edit = {
      id: "e7",
      blockId: "p0-b7",
      pageIndex: 0,
      box: { x: 60, y: 60, width: 130, height: 70 },
      coverBox: { x: 60, y: 60, width: 130, height: 70 },
      coverOriented: { origin: { x: 60, y: 60 }, width: 90, height: 16, rotation: 40 },
      text: "Nuevo",
      fontSize: 12,
      color: "#000000",
      align: "left" as const,
      fontKey: "helvetica" as const,
      bold: false,
      italic: false,
      rotation: 40,
      cover: { color: "#ffffff", padding: 1 },
      obstacles: [{ id: "p0-b1", box: { x: 92, y: 104, width: 70, height: 12 } }],
    };
    setup({ edits: [edit] }, [crossed]);
    const cover = document.querySelector<HTMLElement>('[data-cover="p0-b7"]')!;
    expect(cover).not.toBeNull();
    expect(cover.hasAttribute("data-cover-holes")).toBe(true);
  });

  it("sin vecino que lo cruce no hay recorte", () => {
    const block = makeBlock("p0-b8", { text: "Girado" });
    const edit = {
      id: "e8",
      blockId: "p0-b8",
      pageIndex: 0,
      box: { x: 60, y: 60, width: 130, height: 70 },
      coverBox: { x: 60, y: 60, width: 130, height: 70 },
      coverOriented: { origin: { x: 60, y: 60 }, width: 90, height: 16, rotation: 40 },
      text: "Nuevo",
      fontSize: 12,
      color: "#000000",
      align: "left" as const,
      fontKey: "helvetica" as const,
      bold: false,
      italic: false,
      rotation: 40,
      cover: { color: "#ffffff", padding: 1 },
    };
    setup({ edits: [edit] }, [block]);
    expect(document.querySelector('[data-cover="p0-b8"]')!.hasAttribute("data-cover-holes")).toBe(false);
  });
});

describe("TextBlockLayer — tiradores en bloques estrechos y bajos (W5-U5, N3)", () => {
  function boxOf(el: HTMLElement) {
    const left = Number.parseFloat(el.style.left);
    const top = Number.parseFloat(el.style.top);
    return { left, top, right: left + Number.parseFloat(el.style.width), bottom: top + Number.parseFloat(el.style.height) };
  }
  /** Fraccion del area del bloque que tapan los tiradores (tirador dentro del bloque). */
  function coveredFraction(blockId: string): number {
    const b = boxOf(region(blockId));
    const area = (b.right - b.left) * (b.bottom - b.top);
    let covered = 0;
    for (const handle of document.querySelectorAll<HTMLElement>("[data-resize-handle]")) {
      const h = boxOf(handle);
      const w = Math.max(0, Math.min(h.right, b.right) - Math.max(h.left, b.left));
      const hh = Math.max(0, Math.min(h.bottom, b.bottom) - Math.max(h.top, b.top));
      covered += w * hh;
    }
    return covered / area;
  }
  function centerCovered(blockId: string): boolean {
    const b = boxOf(region(blockId));
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    return Array.from(document.querySelectorAll<HTMLElement>("[data-resize-handle]")).some((handle) => {
      const h = boxOf(handle);
      return cx >= h.left && cx <= h.right && cy >= h.top && cy <= h.bottom;
    });
  }

  const SHAPES: Array<[string, { width: number; height: number }]> = [
    ["cifra estrecha y baja", { width: 30, height: 14 }],
    ["palabra «Total» baja", { width: 60, height: 12 }],
    ["alto pero muy estrecho", { width: 18, height: 80 }],
    ["bajo y ancho", { width: 300, height: 10 }],
    ["mediano", { width: 90, height: 40 }],
    ["holgado", { width: 200, height: 120 }],
  ];

  it.each(SHAPES)("con puntero grueso, %s: el centro queda libre y los tiradores tapan <= 20 %%", (_name, size) => {
    const block = makeBlock("p0-n", { text: "980,50", box: { x: 100, y: 500, ...size } });
    setup({ coarse: true, selectedKey: "p0-n" }, [block]);
    expect(centerCovered("p0-n")).toBe(false);
    expect(coveredFraction("p0-n")).toBeLessThanOrEqual(0.2);
    for (const handle of document.querySelectorAll<HTMLElement>("[data-resize-handle]")) {
      expect(Number.parseFloat(handle.style.width)).toBeGreaterThanOrEqual(28);
    }
  });

  it("el alto tambien cuenta: un bloque ancho pero bajo usa tiradores externos de 44 px a los lados de su zona de toque", () => {
    const block = makeBlock("p0-n", { text: "Total", box: { x: 100, y: 500, width: 300, height: 10 } });
    setup({ coarse: true, selectedKey: "p0-n" }, [block]);
    const handles = Array.from(document.querySelectorAll<HTMLElement>("[data-resize-handle]"));
    expect(handles.map((h) => h.dataset.handleMode)).toEqual(["external", "external"]);
    const zone = boxOf(region("p0-n"));
    for (const handle of handles) {
      expect(Number.parseFloat(handle.style.width)).toBe(44);
      const h = boxOf(handle);
      // Fuera de la zona de toque (a un lado) y sin crecer la altura total: alineado con su borde inferior.
      expect(h.right <= zone.left + 0.5 || h.left >= zone.right - 0.5).toBe(true);
      expect(h.bottom).toBeCloseTo(zone.bottom, 0);
    }
  });

  it("un tirador externo sigue redimensionando (SE cambia el ancho, el vertice opuesto queda fijo)", () => {
    const block = makeBlock("p0-n", { text: "Total", box: { x: 100, y: 500, width: 60, height: 10 } });
    const { h } = setup({ coarse: true, selectedKey: "p0-n" }, [block]);
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    pointer(handle, "Down", { clientX: 160, clientY: 300 });
    pointer(handle, "Move", { clientX: 200, clientY: 300 });
    pointer(handle, "Up", { clientX: 200, clientY: 300 });
    expect(h.onResize).toHaveBeenCalledTimes(1);
    const rect = (h.onResize as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(rect.width).toBeCloseTo(100, 4);
  });

  it("junto al borde izquierdo de la hoja los externos pasan al lado con sitio", () => {
    const block = makeBlock("p0-n", { text: "980,50", box: { x: 4, y: 500, width: 30, height: 12 } });
    setup({ coarse: true, selectedKey: "p0-n" }, [block]);
    const handles = Array.from(document.querySelectorAll<HTMLElement>("[data-resize-handle]"));
    expect(handles.map((h) => h.dataset.resizeHandle)).toEqual(["se"]);
    expect(handles.every((h) => boxOf(h).left >= 0)).toBe(true);
  });

  it("un glifo diminuto con un vecino pegado (region recortada y asimetrica): el cuadrado de 44 x 44 centrado en el sigue libre de tiradores (D3)", () => {
    const glyph = makeBlock("p0-g", { text: ".", box: { x: 100, y: 500, width: 1, height: 3 } });
    const above = makeBlock("p0-up", { text: "Vecino arriba", box: { x: 80, y: 506, width: 60, height: 10 } });
    const below = makeBlock("p0-dn", { text: "Vecino abajo", box: { x: 80, y: 487, width: 60, height: 10 } });
    setup({ coarse: true, selectedKey: "p0-g" }, [glyph, above, below]);
    const env = userBoxToPx(metricsFor(), glyph.box);
    const cx = env.left + env.width / 2;
    const cy = env.top + env.height / 2;
    const handles = Array.from(document.querySelectorAll<HTMLElement>("[data-resize-handle]"));
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      const h = boxOf(handle);
      const overlapX = Math.min(h.right, cx + 22) - Math.max(h.left, cx - 22);
      const overlapY = Math.min(h.bottom, cy + 22) - Math.max(h.top, cy - 22);
      expect(overlapX > 0.01 && overlapY > 0.01, `tirador ${handle.dataset.resizeHandle} pisa el cuadrado de toque`).toBe(false);
    }
  });

  it("un bloque bajo de lado a lado de la hoja (sin sitio a los lados): tiradores de 44 px DEBAJO, dentro de la hoja", () => {
    const block = makeBlock("p0-n", { text: "Linea larga", box: { x: 10, y: 500, width: 575, height: 12 } });
    setup({ coarse: true, selectedKey: "p0-n" }, [block]);
    const env = userBoxToPx(metricsFor(), block.box);
    const handles = Array.from(document.querySelectorAll<HTMLElement>("[data-resize-handle]"));
    expect(handles.length).toBeGreaterThanOrEqual(1);
    for (const handle of handles) {
      const h = boxOf(handle);
      expect(Number.parseFloat(handle.style.width)).toBe(44);
      expect(h.top).toBeGreaterThanOrEqual(env.top + env.height - 0.5);
      expect(h.left).toBeGreaterThanOrEqual(0);
      expect(h.right).toBeLessThanOrEqual(595);
    }
    expect(centerCovered("p0-n")).toBe(false);
  });

  describe("gestos de redimensionado (N1): ningun cambio de layout a mitad de arrastre pierde el cambio", () => {
    // Bloque bajo con sitio SOLO a la derecha: su tirador externo «se» (a la derecha) existe al empezar; al estirar la caja
    // hasta el borde de la hoja ya no habria sitio a ese lado y el layout en vivo lo desmontaria.
    const narrow = () => makeBlock("p0-n", { text: "Total", box: { x: 100, y: 500, width: 60, height: 10 } });

    it("el tirador que se arrastra sigue montado aunque el layout en vivo ya no lo ofreceria, y el pointerup confirma", () => {
      const { h } = setup({ coarse: true, selectedKey: "p0-n" }, [narrow()]);
      const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
      expect(handle).not.toBeNull();
      pointer(handle, "Down", { pointerType: "touch", clientX: 200, clientY: 300 });
      pointer(handle, "Move", { pointerType: "touch", clientX: 600, clientY: 310 });
      // Sigue siendo EL MISMO elemento, montado, y sigue a su esquina.
      expect(handle.isConnected).toBe(true);
      expect(document.querySelector('[data-resize-handle="se"]')).toBe(handle);
      pointer(handle, "Up", { pointerType: "touch", clientX: 600, clientY: 310 });
      expect(h.onResize).toHaveBeenCalledTimes(1);
      const rect = (h.onResize as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(rect.width).toBeGreaterThan(300);
    });

    it("si el pointerup solo llega a window (el elemento ya no esta) el gesto se confirma igualmente", () => {
      const { h } = setup({ coarse: true, selectedKey: "p0-n" }, [narrow()]);
      const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
      pointer(handle, "Down", { pointerType: "touch", pointerId: 7, clientX: 200, clientY: 300 });
      pointer(handle, "Move", { pointerType: "touch", pointerId: 7, clientX: 260, clientY: 310 });
      fireEvent.pointerUp(window, { pointerId: 7, pointerType: "touch", clientX: 260, clientY: 310 });
      expect(h.onResize).toHaveBeenCalledTimes(1);
      expect(h.onGesture).toHaveBeenLastCalledWith(false);
    });

    it("pointercancel o Esc durante el arrastre revierten limpio y el siguiente arrastre funciona", () => {
      const { h } = setup({ coarse: true, selectedKey: "p0-n" }, [narrow()]);
      let handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
      pointer(handle, "Down", { pointerType: "touch", pointerId: 3, clientX: 200, clientY: 300 });
      pointer(handle, "Move", { pointerType: "touch", pointerId: 3, clientX: 260, clientY: 310 });
      fireEvent.pointerCancel(window, { pointerId: 3 });
      expect(h.onResize).not.toHaveBeenCalled();
      expect(h.onGesture).toHaveBeenLastCalledWith(false);
      // Esc.
      handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
      pointer(handle, "Down", { pointerType: "touch", pointerId: 4, clientX: 200, clientY: 300 });
      pointer(handle, "Move", { pointerType: "touch", pointerId: 4, clientX: 260, clientY: 310 });
      fireEvent.keyDown(window, { key: "Escape" });
      pointer(handle, "Up", { pointerType: "touch", pointerId: 4, clientX: 260, clientY: 310 });
      expect(h.onResize).not.toHaveBeenCalled();
      // Siguiente arrastre.
      handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
      pointer(handle, "Down", { pointerType: "touch", pointerId: 5, clientX: 200, clientY: 300 });
      pointer(handle, "Move", { pointerType: "touch", pointerId: 5, clientX: 250, clientY: 305 });
      pointer(handle, "Up", { pointerType: "touch", pointerId: 5, clientX: 250, clientY: 305 });
      expect(h.onResize).toHaveBeenCalledTimes(1);
    });
  });

  it("un glifo diminuto (1 x 2 px): zona de toque de 44 x 44 centrada y los tiradores externos FUERA de ella (D3)", () => {
    const glyph = makeBlock("p0-g", { text: "x", box: { x: 100, y: 500, width: 1, height: 2 } });
    setup({ coarse: true, selectedKey: "p0-g" }, [glyph]);
    const env = userBoxToPx(metricsFor(), glyph.box);
    const cx = env.left + env.width / 2;
    const cy = env.top + env.height / 2;
    const zone = boxOf(region("p0-g"));
    expect(zone.right - zone.left).toBeGreaterThanOrEqual(44);
    expect(zone.bottom - zone.top).toBeGreaterThanOrEqual(44);
    expect(cx).toBeGreaterThan(zone.left);
    expect(cx).toBeLessThan(zone.right);
    const handles = Array.from(document.querySelectorAll<HTMLElement>("[data-resize-handle]"));
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      const h = boxOf(handle);
      // Ni una parte del cuadrado de 44 x 44 centrado en el bloque queda bajo un tirador.
      const overlapX = Math.min(h.right, cx + 22) - Math.max(h.left, cx - 22);
      const overlapY = Math.min(h.bottom, cy + 22) - Math.max(h.top, cy - 22);
      expect(overlapX > 0.01 && overlapY > 0.01, `tirador ${handle.dataset.resizeHandle} pisa la zona de toque`).toBe(false);
    }
    expect(centerCovered("p0-g")).toBe(false);
  });

  it("al editar, el asa de mover de un bloque externo queda arriba y centrada sin pisar los tiradores", () => {
    const block = makeBlock("p0-n", { text: "980,50", box: { x: 100, y: 500, width: 30, height: 12 } });
    setup({ coarse: true, editingKey: "p0-n" }, [block]);
    const move = document.querySelector<HTMLElement>("[data-move-handle]")!;
    const m = boxOf(move);
    const env = userBoxToPx(metricsFor(), block.box);
    expect(m.bottom).toBeLessThanOrEqual(env.top);
    for (const handle of document.querySelectorAll<HTMLElement>("[data-resize-handle]")) {
      const h = boxOf(handle);
      const overlap = Math.min(m.right, h.right) > Math.max(m.left, h.left) && Math.min(m.bottom, h.bottom) > Math.max(m.top, h.top);
      expect(overlap).toBe(false);
    }
  });

  it("un toque sin arrastre sobre un tirador externo llega al bloque que tapa (se puede seleccionar el siguiente)", () => {
    const a = makeBlock("p0-a", { text: "Total", box: { x: 100, y: 500, width: 60, height: 10 } });
    const below = makeBlock("p0-below", { text: "Linea de abajo larga", box: { x: 100, y: 485, width: 200, height: 10 } });
    const { h } = setup({ coarse: true, selectedKey: "p0-a" }, [a, below]);
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    const target = region("p0-below");
    const original = document.elementsFromPoint;
    document.elementsFromPoint = () => [handle, target];
    try {
      pointer(handle, "Down", { pointerType: "touch", clientX: 170, clientY: 300 });
      pointer(handle, "Up", { pointerType: "touch", clientX: 170, clientY: 300 });
    } finally {
      document.elementsFromPoint = original;
    }
    expect(h.onSelect).toHaveBeenCalledWith("p0-below");
    expect(h.onResize).not.toHaveBeenCalled();
  });

  it("arrastrar un tirador externo NO reenvia nada al bloque de debajo", () => {
    const a = makeBlock("p0-a", { text: "Total", box: { x: 100, y: 500, width: 60, height: 10 } });
    const below = makeBlock("p0-below", { text: "Linea de abajo larga", box: { x: 100, y: 485, width: 200, height: 10 } });
    const { h } = setup({ coarse: true, selectedKey: "p0-a" }, [a, below]);
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    const original = document.elementsFromPoint;
    document.elementsFromPoint = () => [handle, region("p0-below")];
    try {
      pointer(handle, "Down", { pointerType: "touch", clientX: 170, clientY: 300 });
      pointer(handle, "Move", { pointerType: "touch", clientX: 220, clientY: 300 });
      pointer(handle, "Up", { pointerType: "touch", clientX: 220, clientY: 300 });
    } finally {
      document.elementsFromPoint = original;
    }
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onResize).toHaveBeenCalledTimes(1);
  });

  it("con puntero fino los tiradores de 28 px se encogen igual en bloques pequenos", () => {
    const block = makeBlock("p0-n", { text: "980,50", box: { x: 100, y: 500, width: 50, height: 30 } });
    setup({ coarse: false, selectedKey: "p0-n" }, [block]);
    expect(centerCovered("p0-n")).toBe(false);
  });

  it("en un bloque ancho conservan los 44 px", () => {
    const big = makeBlock("p0-big", { text: "Grande", box: { x: 50, y: 500, width: 200, height: 120 } });
    setup({ coarse: true, selectedKey: "p0-big" }, [big]);
    const handle = document.querySelector<HTMLElement>("[data-resize-handle]")!;
    expect(Number.parseFloat(handle.style.width)).toBe(44);
  });
});
