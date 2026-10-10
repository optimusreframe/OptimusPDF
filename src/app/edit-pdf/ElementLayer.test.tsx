import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { ElementLayer, ShapeSvg, elementName, type ElementHandlers, type ElementItem } from "@/app/edit-pdf/ElementLayer";
import { metricsFor } from "@/app/edit-pdf/editTestUtils";
import type { EditImageItem, EditShapeElement, EditShapeItem } from "@/app/edit-pdf/editSession";
import { shapeItem } from "@/app/edit-pdf/editSession";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { PINCH_START_EVENT } from "@/app/edit-pdf/useZoomGestures";

const s = EDIT_STRINGS.es.inline;
const labels = EDIT_STRINGS.es.typeLabels;
/** Hoja A4 a 1 px por punto. */
const metrics = metricsFor();

const rect: EditShapeElement = { id: "r1", pageIndex: 0, type: "rect", x: 0.1, y: 0.1, width: 0.3, height: 0.2, strokeColor: "#e11d48", strokeWidth: 2, fill: false, fillColor: "#0d4bff", fillOpacity: 0.3 };
const filled: EditShapeElement = { ...rect, id: "r2", fill: true, x: 0.5, y: 0.1 };
const ellipse: EditShapeElement = { ...rect, id: "e1", type: "ellipse", y: 0.4 } as EditShapeElement;
const line: EditShapeElement = { id: "l1", pageIndex: 0, type: "line", x1: 0.1, y1: 0.7, x2: 0.5, y2: 0.8, strokeColor: "#0f9d68", strokeWidth: 3 };
const highlight: EditShapeElement = { id: "h1", pageIndex: 0, type: "highlight", x: 0.1, y: 0.05, width: 0.4, height: 0.03, color: "#fff176", opacity: 0.4 };
const check: EditShapeElement = { id: "c1", pageIndex: 0, type: "check", x: 0.7, y: 0.7, width: 0.04, height: 0.03, mark: "check", strokeColor: "#e11d48", strokeWidth: 2 };
const imageItem: EditImageItem = { kind: "image", id: "i1", element: { id: "i1", pageIndex: 0, type: "image", x: 0.5, y: 0.5, width: 0.3, height: 0.2, ratio: 1, assetId: "a1" } };
const assets = { a1: { bytes: new Uint8Array([1, 2, 3, 4]), previewUrl: "data:image/png;base64,AAAA" } };

function handlers(): ElementHandlers & Record<keyof ElementHandlers, ReturnType<typeof vi.fn>> {
  return {
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onReshape: vi.fn(),
    onNudge: vi.fn(),
    onDelete: vi.fn(),
    onGesture: vi.fn(),
    onTabIntoBar: vi.fn(() => false),
  } as never;
}

function mount(
  items: ElementItem[],
  props: Partial<{ selectedId: string | null; passive: boolean; interactiveTypes: readonly string[]; coarse: boolean; draft: EditShapeElement | null; handlers: ElementHandlers }> = {},
) {
  const h = (props.handlers as ReturnType<typeof handlers> | undefined) ?? handlers();
  const view = render(
    <div data-page-index="0">
      <ElementLayer
        metrics={metrics}
        items={items}
        assets={assets}
        selectedId={props.selectedId ?? null}
        passive={props.passive ?? false}
        interactiveTypes={props.interactiveTypes}
        coarse={props.coarse ?? false}
        draft={props.draft ?? null}
        strings={s}
        typeLabels={labels}
        handlers={h}
      />
    </div>,
  );
  return { ...view, h };
}

const region = (id: string) => document.querySelector<HTMLElement>(`[role="button"][data-element-id="${id}"]`)!;
const hit = (kind: string) => document.querySelector<SVGElement>(`[data-hit="${kind}"]`)!;
const mouse = (init: Record<string, unknown> = {}) => ({ pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100, ...init });

afterEach(cleanup);

describe("ElementLayer: pintado de cada tipo", () => {
  it("una region accesible por elemento, con tipo, id y posicion en el nombre", () => {
    mount([shapeItem(rect), shapeItem(ellipse), imageItem]);
    const names = Array.from(document.querySelectorAll('[role="button"][data-element-id]')).map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Rectángulo (1 de 3)", "Elipse (2 de 3)", "Imagen (3 de 3)"]);
    expect(region("r1").dataset.elementKind).toBe("shape");
    expect(region("r1").dataset.elementType).toBe("rect");
    expect(region("i1").dataset.elementKind).toBe("image");
    expect(region("r1").getAttribute("aria-pressed")).toBe("false");
  });

  it("rectangulo: caja y trazo a la escala de la hoja, sin relleno", () => {
    mount([shapeItem(rect)]);
    const el = document.querySelector('[data-shape-visual="rect"]')!;
    expect(Number(el.getAttribute("x"))).toBeCloseTo(59.5);
    expect(Number(el.getAttribute("width"))).toBeCloseTo(178.5);
    expect(el.getAttribute("stroke")).toBe("#e11d48");
    expect(el.getAttribute("stroke-width")).toBe("2");
    expect(el.getAttribute("fill")).toBe("none");
  });

  it("rectangulo con relleno: color y opacidad del relleno", () => {
    mount([shapeItem(filled)]);
    const el = document.querySelector('[data-shape-visual="rect"]')!;
    expect(el.getAttribute("fill")).toBe("#0d4bff");
    expect(el.getAttribute("fill-opacity")).toBe("0.3");
  });

  it("grosor 0: sin borde", () => {
    mount([shapeItem({ ...rect, strokeWidth: 0 })]);
    expect(document.querySelector('[data-shape-visual="rect"]')!.getAttribute("stroke")).toBe("none");
  });

  it("elipse: centro y semiejes", () => {
    mount([shapeItem(ellipse)]);
    const el = document.querySelector('[data-shape-visual="ellipse"]')!;
    expect(Number(el.getAttribute("rx"))).toBeCloseTo(89.25);
    expect(Number(el.getAttribute("cx"))).toBeCloseTo(0.25 * 595);
  });

  it("linea: extremos y remate redondo, con el color y grosor propios", () => {
    mount([shapeItem(line)]);
    const el = document.querySelector('[data-shape-visual="line"]')!;
    expect(Number(el.getAttribute("x2"))).toBeCloseTo(0.5 * 595);
    expect(el.getAttribute("stroke")).toBe("#0f9d68");
    expect(el.getAttribute("stroke-linecap")).toBe("round");
  });

  it("resaltado: relleno translucido sin borde", () => {
    mount([shapeItem(highlight)]);
    const el = document.querySelector('[data-shape-visual="highlight"]')!;
    expect(el.getAttribute("fill")).toBe("#fff176");
    expect(el.getAttribute("fill-opacity")).toBe("0.4");
    expect(el.getAttribute("stroke")).toBeNull();
  });

  it("marca: los dos trazos del simbolo del motor", () => {
    mount([shapeItem(check)]);
    expect(document.querySelectorAll('[data-shape-visual="check"] line')).toHaveLength(2);
    cleanup();
    mount([shapeItem({ ...check, mark: "cross" })]);
    const lines = document.querySelectorAll('[data-shape-visual="check"] line');
    expect(lines).toHaveLength(2);
    expect(region("c1").getAttribute("aria-label")).toContain("Aspa");
  });

  it("imagen: usa la vista previa del asset, a su caja", () => {
    mount([imageItem]);
    const img = document.querySelector<HTMLImageElement>('[data-element-image="i1"]')!;
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(img.style.left).toBe("297.5px");
    expect(img.style.width).toBe("178.5px");
  });

  it("una imagen sin asset no pinta nada (pero no rompe)", () => {
    const { container } = render(
      <ElementLayer metrics={metrics} items={[imageItem]} assets={{}} selectedId={null} passive={false} coarse={false} draft={null} strings={s} typeLabels={labels} handlers={handlers()} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("la vista previa del dibujo es la misma figura, sin zona de puntero", () => {
    mount([], { draft: rect });
    const draft = document.querySelector("[data-element-draft]")!;
    expect(draft.querySelector('[data-shape-visual="rect"]')).not.toBeNull();
    expect(draft.querySelector("[data-hit]")).toBeNull();
  });

  it("elementName nombra la marca con su simbolo", () => {
    expect(elementName(shapeItem(check) as EditShapeItem, labels, s)).toBe("Marca: Visto");
    expect(elementName(imageItem, labels, s)).toBe("Imagen");
  });
});

describe("ElementLayer: zonas de puntero y apilado", () => {
  it("un rectangulo SIN relleno solo recibe el puntero por el borde; con relleno, por todo", () => {
    mount([shapeItem(rect), shapeItem(filled)]);
    const hits = document.querySelectorAll('[data-hit="rect"]');
    expect(hits[0].getAttribute("pointer-events")).toBe("stroke");
    expect(hits[1].getAttribute("pointer-events")).toBe("all");
  });

  it("la zona del borde mide 16 px con raton y 44 con el dedo", () => {
    mount([shapeItem(rect)]);
    expect(hit("rect").getAttribute("stroke-width")).toBe("16");
    cleanup();
    mount([shapeItem(rect)], { coarse: true });
    expect(hit("rect").getAttribute("stroke-width")).toBe("44");
  });

  it("el resaltado va un nivel por debajo de las regiones de texto (z-2), el resto por encima (z-4)", () => {
    mount([shapeItem(highlight), shapeItem(rect)]);
    const svgs = document.querySelectorAll("svg");
    expect(svgs[0].getAttribute("class")).toContain("z-[2]");
    expect(svgs[1].getAttribute("class")).toContain("z-[4]");
  });

  it("la marca y el resaltado pequenos tienen una zona de puntero de al menos 44 px con el dedo", () => {
    mount([shapeItem(check), shapeItem(highlight)], { coarse: true });
    expect(Number(hit("check").getAttribute("width"))).toBeGreaterThanOrEqual(44);
    expect(Number(hit("highlight").getAttribute("height"))).toBeGreaterThanOrEqual(44);
  });

  it("con una herramienta armada (passive) no hay zonas de puntero ni tiradores", () => {
    mount([shapeItem(rect), imageItem], { passive: true, selectedId: "r1" });
    expect(document.querySelector("[data-hit]")).toBeNull();
    expect(document.querySelector("[data-resize-handle]")).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-element-image="i1"]')!.className).toContain("pointer-events-none");
  });

  it("con el resaltador armado, los resaltados existentes SI reciben el puntero y el resto no", () => {
    mount([shapeItem(highlight), shapeItem(rect)], { passive: true, interactiveTypes: ["highlight"] });
    expect(hit("highlight")).not.toBeNull();
    expect(document.querySelector('[data-hit="rect"]')).toBeNull();
  });

  it("touch-action: pan-y sin seleccionar (el dedo desplaza la pagina) y none seleccionado", () => {
    mount([shapeItem(rect)]);
    expect(document.querySelector("svg")!.style.touchAction).toBe("pan-y");
    cleanup();
    mount([shapeItem(rect)], { selectedId: "r1" });
    expect(document.querySelector("svg")!.style.touchAction).toBe("none");
  });
});

describe("ElementLayer: tiradores", () => {
  it("una caja seleccionada lleva cuatro tiradores", () => {
    mount([shapeItem(rect)], { selectedId: "r1" });
    expect(Array.from(document.querySelectorAll("[data-resize-handle]")).map((el) => (el as HTMLElement).dataset.resizeHandle).sort()).toEqual(["ne", "nw", "se", "sw"]);
  });

  it("los tiradores miden 28 px con raton y 44 con el dedo", () => {
    mount([shapeItem(rect)], { selectedId: "r1" });
    expect(document.querySelector<HTMLElement>("[data-resize-handle]")!.style.width).toBe("28px");
    cleanup();
    mount([shapeItem(rect)], { selectedId: "r1", coarse: true });
    const handle = document.querySelector<HTMLElement>("[data-resize-handle]")!;
    expect(handle.style.width).toBe("44px");
    expect(handle.style.height).toBe("44px");
  });

  it("un elemento diminuto solo lleva el tirador inferior derecho, desplazado hacia fuera", () => {
    mount([shapeItem(check)], { selectedId: "c1" });
    const handles = document.querySelectorAll<HTMLElement>("[data-resize-handle]");
    expect(handles).toHaveLength(1);
    expect(handles[0].dataset.resizeHandle).toBe("se");
    // El centro del tirador queda FUERA de la caja de la marca (esquina inferior derecha).
    const center = parseFloat(handles[0].style.left) + 14;
    expect(center).toBeGreaterThan((check.x + (check as { width: number }).width) * 595);
  });

  it("una linea seleccionada lleva un tirador por extremo (no de esquina)", () => {
    mount([shapeItem(line)], { selectedId: "l1" });
    expect(document.querySelectorAll("[data-resize-handle]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-line-end]")).toHaveLength(2);
  });

  it("sin seleccionar no hay tiradores", () => {
    mount([shapeItem(rect), imageItem, shapeItem(line)]);
    expect(document.querySelector("[data-resize-handle], [data-line-end]")).toBeNull();
  });
});

describe("ElementLayer: gestos", () => {
  it("con el raton, pulsar selecciona al instante", () => {
    const { h } = mount([shapeItem(rect)]);
    fireEvent.pointerDown(hit("rect"), mouse());
    expect(h.onSelect).toHaveBeenCalledWith("r1");
  });

  it("con el dedo, pulsar NO selecciona (puede ser un desplazamiento); tocar y soltar si", () => {
    const { h } = mount([shapeItem(rect)]);
    fireEvent.pointerDown(hit("rect"), mouse({ pointerType: "touch" }));
    expect(h.onSelect).not.toHaveBeenCalled();
    fireEvent.pointerUp(hit("rect"), mouse({ pointerType: "touch" }));
    expect(h.onSelect).toHaveBeenCalledWith("r1");
  });

  it("arrastrar mueve: al soltar llama a onMove con el desplazamiento en px", () => {
    const { h } = mount([shapeItem(filled)], { selectedId: "r2" });
    fireEvent.pointerDown(hit("rect"), mouse());
    fireEvent.pointerMove(hit("rect"), mouse({ clientX: 130, clientY: 120 }));
    fireEvent.pointerUp(hit("rect"), mouse({ clientX: 130, clientY: 120 }));
    expect(h.onMove).toHaveBeenCalledWith("r2", 30, 20);
    expect(h.onGesture).toHaveBeenCalledWith(true);
    expect(h.onGesture).toHaveBeenLastCalledWith(false);
  });

  it("durante el arrastre la figura se ve en la posicion nueva (vista previa en vivo)", () => {
    mount([shapeItem(filled)], { selectedId: "r2" });
    const before = Number(document.querySelector('[data-shape-visual="rect"]')!.getAttribute("x"));
    fireEvent.pointerDown(hit("rect"), mouse());
    fireEvent.pointerMove(hit("rect"), mouse({ clientX: 150 }));
    expect(Number(document.querySelector('[data-shape-visual="rect"]')!.getAttribute("x"))).toBeCloseTo(before + 50);
  });

  it("el movimiento no saca la figura de la pagina", () => {
    mount([shapeItem(filled)], { selectedId: "r2" });
    fireEvent.pointerDown(hit("rect"), mouse());
    fireEvent.pointerMove(hit("rect"), mouse({ clientX: 5000 }));
    const x = Number(document.querySelector('[data-shape-visual="rect"]')!.getAttribute("x"));
    const width = Number(document.querySelector('[data-shape-visual="rect"]')!.getAttribute("width"));
    expect(x + width).toBeLessThanOrEqual(595 + 1e-6);
  });

  it("un toque sin movimiento no mueve nada", () => {
    const { h } = mount([shapeItem(rect)]);
    fireEvent.pointerDown(hit("rect"), mouse());
    fireEvent.pointerMove(hit("rect"), mouse({ clientX: 103 }));
    fireEvent.pointerUp(hit("rect"), mouse({ clientX: 103 }));
    expect(h.onMove).not.toHaveBeenCalled();
  });

  it("Esc durante el arrastre lo cancela y no mueve nada", () => {
    const { h } = mount([shapeItem(filled)], { selectedId: "r2" });
    fireEvent.pointerDown(hit("rect"), mouse());
    fireEvent.pointerMove(hit("rect"), mouse({ clientX: 160 }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(hit("rect"), mouse({ clientX: 160 }));
    expect(h.onMove).not.toHaveBeenCalled();
  });

  it("un pellizco con dos dedos cancela el arrastre del primero", () => {
    const { h } = mount([shapeItem(filled)], { selectedId: "r2" });
    fireEvent.pointerDown(hit("rect"), mouse({ pointerType: "touch" }));
    fireEvent.pointerMove(hit("rect"), mouse({ pointerType: "touch", clientX: 180 }));
    act(() => {
      window.dispatchEvent(new Event(PINCH_START_EVENT));
    });
    fireEvent.pointerUp(hit("rect"), mouse({ pointerType: "touch", clientX: 180 }));
    expect(h.onMove).not.toHaveBeenCalled();
    expect(Number(document.querySelector('[data-shape-visual="rect"]')!.getAttribute("x"))).toBeCloseTo(0.5 * 595);
  });

  it("pulsar un elemento con el raton le da el foco a su region (Supr y flechas actuan sobre el)", () => {
    mount([shapeItem(rect), shapeItem(filled)]);
    fireEvent.pointerDown(hit("rect"), mouse());
    expect(document.activeElement).toBe(region("r1"));
  });

  it("el clic no deja que el navegador lleve el foco a la hoja (mousedown cancelado)", () => {
    mount([shapeItem(rect), imageItem], { selectedId: "r1" });
    expect(fireEvent.mouseDown(hit("rect"))).toBe(false);
    expect(fireEvent.mouseDown(document.querySelector('[data-element-image="i1"]')!)).toBe(false);
    expect(fireEvent.mouseDown(document.querySelector('[data-resize-handle="se"]')!)).toBe(false);
  });

  it("pulsar un tirador tambien deja el foco en la region del elemento", () => {
    mount([shapeItem(rect)], { selectedId: "r1" });
    fireEvent.pointerDown(document.querySelector('[data-resize-handle="nw"]')!, mouse());
    expect(document.activeElement).toBe(region("r1"));
  });

  it("el boton derecho no empieza un arrastre", () => {
    const { h } = mount([shapeItem(rect)]);
    fireEvent.pointerDown(hit("rect"), mouse({ button: 2 }));
    expect(h.onSelect).not.toHaveBeenCalled();
  });

  it("redimensionar con una esquina llama a onResize con el rectangulo nuevo", () => {
    const { h } = mount([shapeItem(rect)], { selectedId: "r1" });
    const se = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    fireEvent.pointerDown(se, mouse());
    fireEvent.pointerMove(se, mouse({ clientX: 140, clientY: 130 }));
    fireEvent.pointerUp(se, mouse({ clientX: 140, clientY: 130 }));
    const [id, next] = h.onResize.mock.calls[0];
    expect(id).toBe("r1");
    expect(next.left).toBeCloseTo(59.5);
    expect(next.width).toBeCloseTo(178.5 + 40);
    expect(next.height).toBeCloseTo(168.4 + 30);
  });

  it("una imagen se redimensiona CONSERVANDO su proporcion", () => {
    const { h } = mount([imageItem], { selectedId: "i1" });
    const se = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    fireEvent.pointerDown(se, mouse());
    fireEvent.pointerMove(se, mouse({ clientX: 160, clientY: 105 }));
    fireEvent.pointerUp(se, mouse({ clientX: 160, clientY: 105 }));
    const [, next] = h.onResize.mock.calls[0];
    // Proporcion de partida: 0.2 * 842 / (0.3 * 595).
    expect(next.height / next.width).toBeCloseTo((0.2 * 842) / (0.3 * 595));
    expect(next.width).toBeGreaterThan(0.3 * 595);
  });

  it("arrastrar un extremo de la linea llama a onReshape con ese extremo movido", () => {
    const { h } = mount([shapeItem(line)], { selectedId: "l1" });
    const end = document.querySelector<HTMLElement>('[data-line-end="p2"]')!;
    fireEvent.pointerDown(end, mouse({ clientX: 300, clientY: 660 }));
    fireEvent.pointerMove(end, mouse({ clientX: 400, clientY: 300 }));
    fireEvent.pointerUp(end, mouse({ clientX: 400, clientY: 300 }));
    const [id, points] = h.onReshape.mock.calls[0];
    expect(id).toBe("l1");
    expect(points.x1).toBeCloseTo(0.1);
    expect(points.y1).toBeCloseTo(0.7);
    expect(points.x2).toBeCloseTo(400 / 595);
    expect(points.y2).toBeCloseTo(300 / 842);
  });

  it("arrastrar la linea entera mueve los dos extremos (onMove)", () => {
    const { h } = mount([shapeItem(line)], { selectedId: "l1" });
    fireEvent.pointerDown(hit("line"), mouse());
    fireEvent.pointerMove(hit("line"), mouse({ clientX: 140, clientY: 90 }));
    fireEvent.pointerUp(hit("line"), mouse({ clientX: 140, clientY: 90 }));
    expect(h.onMove).toHaveBeenCalledWith("l1", 40, -10);
  });

  it("durante el arrastre de un extremo, la linea se ve con el extremo nuevo", () => {
    mount([shapeItem(line)], { selectedId: "l1" });
    const end = document.querySelector<HTMLElement>('[data-line-end="p1"]')!;
    fireEvent.pointerDown(end, mouse({ clientX: 60, clientY: 590 }));
    fireEvent.pointerMove(end, mouse({ clientX: 200, clientY: 200 }));
    const visual = document.querySelector('[data-shape-visual="line"]')!;
    expect(Number(visual.getAttribute("x1"))).toBeCloseTo(200);
    expect(Number(visual.getAttribute("y1"))).toBeCloseTo(200);
    expect(Number(visual.getAttribute("x2"))).toBeCloseTo(0.5 * 595);
  });
});

describe("ElementLayer: teclado", () => {
  it("las flechas mueven (Mayus = paso grande) y Alt + flechas cambian el tamano", () => {
    const { h } = mount([shapeItem(rect)], { selectedId: "r1" });
    fireEvent.keyDown(region("r1"), { key: "ArrowLeft" });
    fireEvent.keyDown(region("r1"), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(region("r1"), { key: "ArrowRight", altKey: true });
    expect(h.onNudge.mock.calls).toEqual([
      ["r1", "left", false, false],
      ["r1", "down", true, false],
      ["r1", "right", false, true],
    ]);
  });

  it("Supr y Retroceso borran; Esc suelta; Intro selecciona", () => {
    const { h } = mount([shapeItem(rect)]);
    fireEvent.keyDown(region("r1"), { key: "Delete" });
    fireEvent.keyDown(region("r1"), { key: "Backspace" });
    expect(h.onDelete).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(region("r1"), { key: "Escape" });
    expect(h.onSelect).toHaveBeenLastCalledWith(null);
    fireEvent.keyDown(region("r1"), { key: "Enter" });
    expect(h.onSelect).toHaveBeenLastCalledWith("r1");
  });

  it("Tab desde el elemento seleccionado entra en la barra", () => {
    const { h } = mount([shapeItem(rect)], { selectedId: "r1" });
    h.onTabIntoBar.mockReturnValue(true);
    const event = fireEvent.keyDown(region("r1"), { key: "Tab" });
    expect(h.onTabIntoBar).toHaveBeenCalledWith("r1");
    expect(event).toBe(false); // preventDefault
  });

  it("las regiones son enfocables y no reciben puntero (lo recibe la figura)", () => {
    mount([shapeItem(rect)]);
    expect(region("r1").tabIndex).toBe(0);
    expect(region("r1").className).toContain("pointer-events-none");
  });

  it("una tecla en un hijo no se trata como del elemento", () => {
    const { h } = mount([shapeItem(rect)]);
    const inner = document.createElement("button");
    region("r1").appendChild(inner);
    fireEvent.keyDown(inner, { key: "Delete" });
    expect(h.onDelete).not.toHaveBeenCalled();
  });
});

describe("ShapeSvg suelto", () => {
  it("la marca seleccionada dibuja el contorno de seleccion", () => {
    const { container } = render(<ShapeSvg element={check} metrics={metrics} selected />);
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
  });
});
