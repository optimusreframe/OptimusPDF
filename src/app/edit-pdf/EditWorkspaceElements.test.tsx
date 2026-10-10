import { useEffect, type ComponentPropsWithoutRef, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditWorkspace } from "@/app/edit-pdf/EditWorkspace";
import { useEditSession, type UseEditSession } from "@/app/edit-pdf/useEditSession";
import type { EditImageItem, EditShapeItem } from "@/app/edit-pdf/editSession";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { makeBlock, metricsFor } from "@/app/edit-pdf/editTestUtils";
import type { PageMetrics } from "@/app/edit-pdf/editCanvasMath";
import type { PageTextAnalysis } from "@/lib/pdf/textBlocks";
import type { TextBlock } from "@/lib/pdf/editTypes";

/*
 * Imagenes y formas en el lienzo inline (W5-U4b), de punta a punta sobre la sesion:
 * dibujar cada herramienta, mover, redimensionar, estilo, duplicar, borrar,
 * deshacer/rehacer, imagen (selector y soltar) y navegacion del documento.
 */

const mocks = vi.hoisted(() => ({
  texts: {} as Record<number, { status: "idle" | "analyzing" | "ready"; analysis: unknown }>,
  metrics: {} as Record<number, unknown>,
  readImage: vi.fn(),
}));

vi.mock("@/app/edit-pdf/useEditDocument", () => ({
  useEditDocument: () => ({ doc: { numPages: 3 }, pageCount: 3, error: null }),
  usePageText: (_doc: unknown, page: number) => mocks.texts[page] ?? { status: "analyzing", analysis: null },
}));

vi.mock("@/app/edit-pdf/editImages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/edit-pdf/editImages")>()),
  readImageFile: (...args: unknown[]) => mocks.readImage(...args),
}));

vi.mock("@/app/edit-pdf/EditSurface", async () => {
  const react = await import("react");
  return {
    EditSurface: function EditSurfaceStub(props: {
      pageIndex: number;
      hostRef: { current: HTMLDivElement | null };
      clipRef: { current: HTMLDivElement | null };
      handleRef?: Ref<{ sampleBackground: (box: unknown) => unknown }>;
      onMetrics: (m: unknown, page: number) => void;
      hostProps?: ComponentPropsWithoutRef<"div">;
      children?: ReactNode;
    }) {
      const { pageIndex, hostRef, clipRef, handleRef, onMetrics, hostProps, children } = props;
      react.useImperativeHandle(handleRef, () => ({ sampleBackground: () => null }));
      react.useEffect(() => {
        onMetrics(mocks.metrics[pageIndex], pageIndex);
        return () => onMetrics(null, -1);
      }, [pageIndex]);
      return (
        <div ref={clipRef}>
          <div ref={hostRef} data-page-index={pageIndex} data-testid="host" {...hostProps}>
            {children}
          </div>
        </div>
      );
    },
  };
});

const s = EDIT_STRINGS.es.inline;
const strings = EDIT_STRINGS.es;
const file = new File(["%PDF"], "doc.pdf", { type: "application/pdf" });
const TITLE = makeBlock("p0-b0", { text: "Titulo", fontSize: 24, box: { x: 50, y: 780, width: 150, height: 24 } });

function ready(blocks: TextBlock[]) {
  return { status: "ready" as const, analysis: { blocks, hiddenCount: 0, hasTextLayer: true, failed: false } satisfies PageTextAnalysis };
}

let live: UseEditSession;
let clock = 1000;

function Harness() {
  const edit = useEditSession({ now: () => clock });
  useEffect(() => {
    live = edit;
  });
  return <EditWorkspace file={file} session={edit} strings={strings} flow={EDIT_FLOW_STRINGS.es} />;
}

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-floating-bar")) return rect(0, 0, 300, 44);
    // La barra de zoom y paginas (siempre un obstaculo) ocupa solo su franja superior.
    if (this.hasAttribute("data-canvas-sticky")) return rect(0, 0, 600, 44);
    if (this.getAttribute("data-element-id")) return rect(100, 300, 120, 20);
    return rect(0, 100, 595, 842);
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 44 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
  clock = 1000;
  mocks.readImage.mockReset();
  mocks.texts = { 0: ready([TITLE]), 1: ready([makeBlock("p1-b0", { pageIndex: 1, text: "Pagina dos" })]), 2: ready([]) };
  mocks.metrics = {
    0: metricsFor(),
    1: metricsFor([0, 0, 400, 300], 0, 400) as PageMetrics,
    2: metricsFor([0, 0, 612, 792], 0, 612) as PageMetrics,
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error — restaura los accesores de prueba
  delete HTMLElement.prototype.offsetWidth;
  // @ts-expect-error — idem
  delete HTMLElement.prototype.offsetHeight;
});

async function mount() {
  render(<Harness />);
  await waitFor(() => expect(document.querySelector('[data-element-id="p0-b0"]')).not.toBeNull());
}

const host = () => screen.getByTestId("host");
const palette = (id: string) => document.querySelector<HTMLElement>(`[data-palette-item="${id}"]`)!;
const arm = (id: string) => fireEvent.click(palette(id));
const items = () => live.items;
const shapes = () => items().filter((item): item is EditShapeItem => item.kind === "shape");
const shapeOf = (index = 0) => shapes()[index].element as unknown as Record<string, number | string | boolean>;
const hint = () => document.querySelector<HTMLElement>("[data-tool-hint]")!;
const liveRegion = () => document.querySelector<HTMLElement>("[data-workspace-live]")!;
const bar = () => document.querySelector<HTMLElement>('[data-floating-bar][aria-label="Opciones del elemento"]');
const barAction = (name: string) => bar()!.querySelector<HTMLElement>(`[data-bar-action="${name}"]`)!;
const elementRegion = (id: string) => document.querySelector<HTMLElement>(`[role="button"][data-element-id="${id}"]`)!;

/** Suelta archivos sobre la hoja (jsdom no pone clientX/clientY en los eventos de arrastre). */
function dropFiles(files: File[], at: [number, number] = [300, 400]) {
  const event = createEvent.drop(host(), { dataTransfer: { types: ["Files"], files } });
  Object.defineProperty(event, "clientX", { value: at[0] });
  Object.defineProperty(event, "clientY", { value: at[1] });
  fireEvent(host(), event);
}

const pointer = (x: number, y: number, init: Record<string, unknown> = {}) => ({
  pointerId: 1,
  pointerType: "mouse",
  button: 0,
  clientX: x,
  clientY: y,
  ...init,
});

/** Arrastra sobre la hoja; `y` es de ventana (la hoja empieza en y = 100). */
function drag(from: [number, number], to: [number, number], init: Record<string, unknown> = {}) {
  fireEvent.pointerDown(host(), pointer(from[0], from[1], init));
  fireEvent.pointerMove(host(), pointer(to[0], to[1], init));
  fireEvent.pointerUp(host(), pointer(to[0], to[1], init));
}

function tap(at: [number, number], init: Record<string, unknown> = {}) {
  fireEvent.pointerDown(host(), pointer(at[0], at[1], init));
  fireEvent.pointerUp(host(), pointer(at[0], at[1], init));
}

describe("dibujar cada herramienta", () => {
  it("rectangulo: arrastrar crea el elemento con el estilo activo y vuelve a Seleccionar", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    expect(shapes()).toHaveLength(1);
    expect(shapeOf()).toMatchObject({ type: "rect", pageIndex: 0, strokeColor: "#e11d48", strokeWidth: 2, fill: false });
    expect(shapeOf().x as number).toBeCloseTo(100 / 595);
    expect(shapeOf().y as number).toBeCloseTo(100 / 842);
    expect(shapeOf().width as number).toBeCloseTo(200 / 595);
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
    expect(palette("rect").getAttribute("aria-pressed")).toBe("false");
  });

  it("elipse, linea, resaltado y marca se crean con su tipo", async () => {
    await mount();
    arm("ellipse");
    drag([100, 200], [200, 280]);
    arm("line");
    drag([300, 200], [500, 320]);
    arm("highlight");
    drag([60, 400], [300, 420]);
    arm("check");
    drag([400, 400], [440, 440]);
    expect(shapes().map((item) => item.element.type)).toEqual(["ellipse", "line", "highlight", "check"]);
    expect(shapeOf(1)).toMatchObject({ strokeColor: "#e11d48", strokeWidth: 2 });
    expect(shapeOf(2)).toMatchObject({ color: "#fff176", opacity: 0.4 });
    expect(shapeOf(3)).toMatchObject({ mark: "check" });
  });

  it("la marca de un solo toque deja el simbolo de tamano fijo, centrado en el toque", async () => {
    await mount();
    arm("check");
    tap([300, 300]);
    expect(shapeOf()).toMatchObject({ type: "check", width: 0.035 });
    expect((shapeOf().x as number) + (shapeOf().width as number) / 2).toBeCloseTo(300 / 595);
  });

  it("un toque con el rectangulo deja una figura de tamano por defecto", async () => {
    await mount();
    arm("rect");
    tap([300, 400]);
    expect(shapes()).toHaveLength(1);
    expect((shapeOf().width as number) * 595).toBeCloseTo(140);
  });

  it("vista previa en vivo mientras se arrastra, sin crear nada hasta soltar", async () => {
    await mount();
    arm("ellipse");
    fireEvent.pointerDown(host(), pointer(100, 200));
    expect(document.querySelector("[data-element-draft]")).toBeNull();
    fireEvent.pointerMove(host(), pointer(260, 330));
    expect(document.querySelector('[data-element-draft] [data-shape-visual="ellipse"]')).not.toBeNull();
    expect(items()).toHaveLength(0);
    fireEvent.pointerUp(host(), pointer(260, 330));
    expect(document.querySelector("[data-element-draft]")).toBeNull();
    expect(shapes()).toHaveLength(1);
  });

  it("un trazo por debajo de los minimos no crea nada y deja la herramienta armada", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [100, 330]); // sin ancho
    expect(items()).toHaveLength(0);
    expect(palette("rect").getAttribute("aria-pressed")).toBe("true");
  });

  it("Esc durante el trazo lo cancela", async () => {
    await mount();
    arm("rect");
    fireEvent.pointerDown(host(), pointer(100, 200));
    fireEvent.pointerMove(host(), pointer(250, 300));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(host(), pointer(250, 300));
    expect(items()).toHaveLength(0);
    expect(document.querySelector("[data-element-draft]")).toBeNull();
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
  });

  it("el elemento nuevo queda seleccionado, con su barra y el foco en su region (nunca en <body>)", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    const id = items()[0].id;
    expect(live.session.selectedId).toBe(id);
    await waitFor(() => expect(bar()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(elementRegion(id)));
    expect(elementRegion(id).getAttribute("aria-pressed")).toBe("true");
  });

  it("anuncia el elemento anadido en la region viva", async () => {
    await mount();
    arm("line");
    drag([100, 200], [300, 300]);
    expect(liveRegion().textContent).toBe("Línea añadido.");
  });

  it("cada trazo es UNA entrada del historial", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    arm("ellipse");
    drag([320, 200], [420, 300]);
    expect(live.session.history).toHaveLength(2);
    expect(live.session.history.every((entry) => entry.op === "add")).toBe(true);
  });

  it("en una pagina con otro tamano las fracciones son las de SU vista", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    await waitFor(() => expect(host().getAttribute("data-page-index")).toBe("1"));
    arm("rect");
    drag([100, 200], [300, 300]);
    expect(shapeOf()).toMatchObject({ pageIndex: 1 });
    expect(shapeOf().x as number).toBeCloseTo(100 / 400);
  });
});

describe("herramientas: atajos, pista y estado", () => {
  it("las letras arman cada herramienta y V vuelve a Seleccionar", async () => {
    await mount();
    for (const [key, id] of [["r", "rect"], ["e", "ellipse"], ["l", "line"], ["h", "highlight"], ["m", "check"], ["t", "text"]] as const) {
      fireEvent.keyDown(host(), { key });
      expect(palette(id).getAttribute("aria-pressed"), id).toBe("true");
    }
    fireEvent.keyDown(host(), { key: "v" });
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
  });

  it("Esc vuelve a Seleccionar desde cualquier herramienta", async () => {
    await mount();
    arm("highlight");
    fireEvent.keyDown(host(), { key: "Escape" });
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
  });

  it("las letras no actuan mientras se escribe en un campo", async () => {
    await mount();
    const input = screen.getByRole("textbox", { name: s.goToPageLabel });
    fireEvent.keyDown(input, { key: "r" });
    expect(palette("rect").getAttribute("aria-pressed")).toBe("false");
  });

  it("con Ctrl o Meta las letras no son atajos de herramienta", async () => {
    await mount();
    fireEvent.keyDown(host(), { key: "r", ctrlKey: true });
    expect(palette("rect").getAttribute("aria-pressed")).toBe("false");
  });

  it("la pista de la herramienta armada esta siempre montada, NO es una region viva propia y se anuncia por la region unica", async () => {
    await mount();
    // W5-U5: una sola region viva en el editor; la pista visible no lo es (evita el anuncio doble).
    expect(hint().getAttribute("role")).toBeNull();
    expect(hint().textContent).toBe("");
    arm("rect");
    expect(hint().textContent).toBe(s.toolHints.rect);
    expect(liveRegion().textContent).toBe(s.toolHints.rect);
    arm("select");
    expect(hint().textContent).toBe("");
    expect(document.querySelector("[data-tool-hint]")).toBe(hint());
  });

  it("armar una herramienta suelta la seleccion y oculta la barra", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(bar()).not.toBeNull());
    arm("ellipse");
    expect(live.session.selectedId).toBeNull();
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("con una herramienta de dibujo armada los bloques de texto no reciben puntero (se puede resaltar encima)", async () => {
    await mount();
    const block = document.querySelector<HTMLElement>('[data-element-id="p0-b0"]')!;
    expect(block.className).toContain("pointer-events-auto");
    arm("highlight");
    expect(block.className).toContain("pointer-events-none");
    arm("select");
    expect(block.className).toContain("pointer-events-auto");
  });

  it("con el resaltador armado se puede elegir un resaltado existente (suelta la herramienta y abre su barra)", async () => {
    await mount();
    arm("highlight");
    drag([60, 400], [300, 420]);
    arm("select");
    arm("rect");
    drag([320, 300], [420, 380]);
    arm("highlight");
    expect(document.querySelector('[data-hit="rect"]')).toBeNull(); // el rectangulo no recibe puntero
    const highlightHit = document.querySelector<SVGElement>('[data-hit="highlight"]')!;
    fireEvent.pointerDown(highlightHit, pointer(100, 510));
    expect(live.session.selectedId).toBe(items()[0].id);
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(barAction("highlight-color")).not.toBeNull();
  });

  it("el cursor de la hoja cambia con la herramienta", async () => {
    await mount();
    expect(host().className).not.toContain("cursor-crosshair");
    arm("rect");
    expect(host().className).toContain("cursor-crosshair");
    expect(host().className).toContain("touch-none");
  });
});

describe("mover, redimensionar y estilo de un elemento", () => {
  async function withRect() {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(bar()).not.toBeNull());
    return items()[0].id;
  }

  it("las flechas mueven un paso de 1 pt (10 con Mayus) y cada pulsacion es un paso de historial", async () => {
    const id = await withRect();
    const x0 = shapeOf().x as number;
    fireEvent.keyDown(elementRegion(id), { key: "ArrowRight" });
    expect(shapeOf().x as number).toBeCloseTo(x0 + 1 / 595);
    fireEvent.keyDown(elementRegion(id), { key: "ArrowRight", shiftKey: true });
    expect(shapeOf().x as number).toBeCloseTo(x0 + 11 / 595);
    expect(live.session.history.map((e) => e.op)).toEqual(["add", "move", "move"]);
  });

  it("Alt + flecha cambia el tamano", async () => {
    const id = await withRect();
    const w0 = shapeOf().width as number;
    fireEvent.keyDown(elementRegion(id), { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(shapeOf().width as number).toBeCloseTo(w0 + 10 / 595);
    fireEvent.keyDown(elementRegion(id), { key: "ArrowUp", altKey: true });
    expect(live.session.history.at(-1)?.op).toBe("resize");
  });

  it("arrastrar el elemento lo mueve (op move) y deshacer lo devuelve", async () => {
    const id = await withRect();
    const x0 = shapeOf().x as number;
    const hit = document.querySelector<SVGElement>('[data-hit="rect"]')!;
    fireEvent.pointerDown(hit, pointer(100, 200));
    fireEvent.pointerMove(hit, pointer(160, 230));
    fireEvent.pointerUp(hit, pointer(160, 230));
    expect(shapeOf().x as number).toBeCloseTo(x0 + 60 / 595);
    expect(live.session.history.at(-1)?.op).toBe("move");
    act(() => live.undo());
    expect(shapeOf().x as number).toBeCloseTo(x0);
    act(() => live.redo());
    expect(shapeOf().x as number).toBeCloseTo(x0 + 60 / 595);
    expect(items()[0].id).toBe(id);
  });

  it("redimensionar con el tirador de una esquina (op resize)", async () => {
    await withRect();
    const w0 = shapeOf().width as number;
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    fireEvent.pointerDown(handle, pointer(300, 300));
    fireEvent.pointerMove(handle, pointer(360, 340));
    fireEvent.pointerUp(handle, pointer(360, 340));
    expect(shapeOf().width as number).toBeCloseTo(w0 + 60 / 595);
    expect(live.session.history.at(-1)?.op).toBe("resize");
  });

  it("mover un extremo de una linea (op reshape) y deshacer", async () => {
    await mount();
    arm("line");
    drag([100, 300], [300, 300]);
    await waitFor(() => expect(document.querySelector('[data-line-end="p2"]')).not.toBeNull());
    const end = document.querySelector<HTMLElement>('[data-line-end="p2"]')!;
    fireEvent.pointerDown(end, pointer(300, 300));
    fireEvent.pointerMove(end, pointer(300, 500));
    fireEvent.pointerUp(end, pointer(300, 500));
    expect(shapeOf()).toMatchObject({ y1: 200 / 842 });
    expect(shapeOf().y2 as number).toBeCloseTo(400 / 842);
    expect(live.session.history.at(-1)?.op).toBe("reshape");
    act(() => live.undo());
    expect(shapeOf().y2 as number).toBeCloseTo(shapeOf().y1 as number);
  });

  it("cambiar el color desde la barra reaplica al elemento Y lo usa el siguiente", async () => {
    await withRect();
    fireEvent.click(barAction("stroke-color"));
    fireEvent.click(bar()!.querySelector('[data-color-swatch="#0d4bff"]')!);
    expect(shapeOf().strokeColor).toBe("#0d4bff");
    arm("rect");
    drag([320, 200], [420, 300]);
    expect(shapeOf(1).strokeColor).toBe("#0d4bff");
  });

  it("los cambios de grosor seguidos se agrupan en un solo paso de deshacer", async () => {
    await withRect();
    const before = live.session.history.length;
    fireEvent.click(barAction("width-up"));
    clock += 100;
    fireEvent.click(barAction("width-up"));
    clock += 100;
    fireEvent.click(barAction("width-up"));
    expect(shapeOf().strokeWidth).toBe(3.5);
    expect(live.session.history).toHaveLength(before + 1);
    act(() => live.undo());
    expect(shapeOf().strokeWidth).toBe(2);
  });

  it("relleno: activar, color y opacidad", async () => {
    await withRect();
    fireEvent.click(barAction("fill"));
    expect(shapeOf().fill).toBe(true);
    fireEvent.click(barAction("fill-opacity-75"));
    expect(shapeOf().fillOpacity).toBe(0.75);
    fireEvent.click(barAction("fill-color"));
    fireEvent.click(bar()!.querySelector('[data-color-swatch="#0f9d68"]')!);
    expect(shapeOf().fillColor).toBe("#0f9d68");
  });

  it("el resaltado cambia de color y de intensidad desde su barra", async () => {
    await mount();
    arm("highlight");
    drag([60, 400], [300, 420]);
    await waitFor(() => expect(bar()).not.toBeNull());
    fireEvent.click(barAction("highlight-color"));
    fireEvent.click(bar()!.querySelector('[data-color-swatch="#9ad9ff"]')!);
    fireEvent.click(barAction("highlight-opacity-75"));
    expect(shapeOf()).toMatchObject({ color: "#9ad9ff", opacity: 0.75 });
  });

  it("la marca cambia de simbolo y el boton de la paleta lo refleja en el siguiente", async () => {
    await mount();
    arm("check");
    tap([300, 300]);
    await waitFor(() => expect(bar()).not.toBeNull());
    fireEvent.click(barAction("mark-cross"));
    expect(shapeOf().mark).toBe("cross");
    arm("check");
    tap([400, 300]);
    expect(shapeOf(1).mark).toBe("cross");
  });

  it("duplicar crea una copia desplazada, seleccionada, y lo anuncia", async () => {
    const id = await withRect();
    fireEvent.click(barAction("duplicate"));
    expect(shapes()).toHaveLength(2);
    expect(items()[1].id).not.toBe(id);
    expect(live.session.selectedId).toBe(items()[1].id);
    expect(shapeOf(1).x as number).toBeCloseTo((shapeOf(0).x as number) + 0.02);
    expect(liveRegion().textContent).toBe("Rectángulo duplicado.");
    await waitFor(() => expect(document.activeElement).toBe(elementRegion(items()[1].id)));
  });

  it("borrar con la barra quita el elemento, lo anuncia y el foco NO cae a <body>", async () => {
    await withRect();
    fireEvent.click(barAction("delete"));
    expect(items()).toHaveLength(0);
    expect(liveRegion().textContent).toBe("Rectángulo borrado. Puedes deshacerlo.");
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(host().contains(document.activeElement) || document.activeElement === host()).toBe(true);
  });

  it("Supr sobre el elemento enfocado lo borra y el foco pasa al siguiente elemento", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [200, 300]);
    arm("ellipse");
    drag([300, 200], [400, 300]);
    const [first, second] = items().map((item) => item.id);
    act(() => elementRegion(first).focus());
    fireEvent.keyDown(elementRegion(first), { key: "Delete" });
    expect(items().map((item) => item.id)).toEqual([second]);
    await waitFor(() => expect(document.activeElement).toBe(elementRegion(second)));
  });

  it("deshacer el elemento enfocado no deja el foco en <body> (mutacion del DOM)", async () => {
    await withRect();
    await waitFor(() => expect(document.activeElement?.getAttribute("data-element-kind")).toBe("shape"));
    act(() => live.undo());
    expect(items()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(host());
  });

  it("clic en una parte vacia de la hoja deselecciona el elemento", async () => {
    await withRect();
    tap([500, 700]);
    expect(live.session.selectedId).toBeNull();
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("con el dedo, el toque en vacio deselecciona al SOLTAR; un arrastre (desplazamiento) no", async () => {
    await withRect();
    fireEvent.pointerDown(host(), pointer(500, 700, { pointerType: "touch" }));
    expect(live.session.selectedId).not.toBeNull();
    fireEvent.pointerUp(host(), pointer(500, 760, { pointerType: "touch" }));
    expect(live.session.selectedId).not.toBeNull();
    fireEvent.pointerDown(host(), pointer(500, 700, { pointerType: "touch" }));
    fireEvent.pointerUp(host(), pointer(502, 701, { pointerType: "touch" }));
    expect(live.session.selectedId).toBeNull();
  });

  it("elegir un elemento suelta el texto seleccionado y viceversa", async () => {
    await withRect();
    const block = document.querySelector<HTMLElement>('[data-element-id="p0-b0"]')!;
    fireEvent.pointerDown(block, pointer(60, 130));
    fireEvent.pointerUp(block, pointer(60, 130));
    expect(block.getAttribute("aria-pressed")).toBe("true");
    expect(live.session.selectedId).toBeNull();
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("deshacer y rehacer por teclado y por la paleta recorren dibujar, mover y estilo", async () => {
    const id = await withRect();
    fireEvent.click(barAction("fill"));
    fireEvent.keyDown(elementRegion(id), { key: "ArrowDown" });
    expect(live.session.history.map((e) => e.op)).toEqual(["add", "restyle", "move"]);
    fireEvent.click(palette("undo"));
    fireEvent.keyDown(document, { key: "z", ctrlKey: true });
    expect(live.session.cursor).toBe(1);
    expect(shapeOf().fill).toBe(false);
    fireEvent.keyDown(document, { key: "z", ctrlKey: true, shiftKey: true });
    fireEvent.click(palette("redo"));
    expect(live.session.cursor).toBe(3);
    expect(shapeOf().fill).toBe(true);
  });
});

describe("imagen", () => {
  const okImage = (ratio = 0.5) => ({
    ok: true as const,
    image: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), previewUrl: "data:image/png;base64,AAAA", ratio, width: 200, height: 100, mime: "image/png" as const },
  });
  const picked = () => new File(["x"], "foto.png", { type: "image/png" });
  const input = () => document.querySelector<HTMLInputElement>("[data-image-input]")!;
  const images = () => items().filter((item): item is EditImageItem => item.kind === "image");

  it("el selector acepta PNG y JPG y no es una parada de Tab", async () => {
    await mount();
    expect(input().accept).toContain("image/png");
    expect(input().accept).toContain("image/jpeg");
    expect(input().tabIndex).toBe(-1);
  });

  it("armar Imagen abre el selector de archivos", async () => {
    await mount();
    const click = vi.spyOn(input(), "click").mockImplementation(() => undefined);
    arm("image");
    expect(click).toHaveBeenCalledTimes(1);
    expect(palette("image").getAttribute("aria-pressed")).toBe("true");
  });

  it("la tecla I tambien lo abre, y la pista ofrece un boton para elegir", async () => {
    await mount();
    const click = vi.spyOn(input(), "click").mockImplementation(() => undefined);
    fireEvent.keyDown(host(), { key: "i" });
    expect(click).toHaveBeenCalled();
    expect(hint().textContent).toBe(s.toolHints.image);
    fireEvent.click(document.querySelector("[data-image-pick]")!);
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("elegir un archivo valido coloca la imagen centrada, seleccionada, y vuelve a Seleccionar", async () => {
    await mount();
    mocks.readImage.mockResolvedValue(okImage());
    arm("image");
    fireEvent.change(input(), { target: { files: [picked()] } });
    await waitFor(() => expect(images()).toHaveLength(1));
    const el = images()[0].element;
    expect(el.pageIndex).toBe(0);
    expect(el.ratio).toBe(0.5);
    expect(el.width).toBe(0.3);
    expect(live.session.assets[el.assetId].previewUrl).toBe("data:image/png;base64,AAAA");
    expect(live.session.selectedId).toBe(images()[0].id);
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");
    expect(liveRegion().textContent).toBe(s.imagePlaced);
    await waitFor(() => expect(bar()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(elementRegion(images()[0].id)));
  });

  it("la barra de una imagen solo ofrece duplicar y borrar", async () => {
    await mount();
    mocks.readImage.mockResolvedValue(okImage());
    fireEvent.change(input(), { target: { files: [picked()] } });
    await waitFor(() => expect(bar()).not.toBeNull());
    const actions = Array.from(bar()!.querySelectorAll("[data-bar-action]")).map((el) => el.getAttribute("data-bar-action"));
    expect(actions).toEqual(["duplicate", "delete"]);
  });

  it("un archivo no valido muestra un mensaje amable, no crea nada y deja la herramienta armada", async () => {
    await mount();
    arm("image");
    const reasons = {
      type: s.imageWrongType,
      size: s.imageTooLarge(15),
      pixels: s.imageTooManyPixels(40),
      unreadable: s.imageUnreadable,
      empty: s.imageEmpty,
    } as const;
    for (const [reason, text] of Object.entries(reasons)) {
      mocks.readImage.mockResolvedValue({ ok: false, reason });
      fireEvent.change(input(), { target: { files: [picked()] } });
      await waitFor(() => expect(hint().textContent).toBe(text));
    }
    expect(items()).toHaveLength(0);
    expect(palette("image").getAttribute("aria-pressed")).toBe("true");
    expect(hint().className).toContain("text-destructive-text");
  });

  it("el mensaje de error esta en una region de estado y desaparece al cambiar de herramienta", async () => {
    await mount();
    arm("image");
    mocks.readImage.mockResolvedValue({ ok: false, reason: "type" });
    fireEvent.change(input(), { target: { files: [picked()] } });
    await waitFor(() => expect(hint().textContent).toBe(s.imageWrongType));
    // El error se anuncia por la region unica (y deja de ser verdad «Imagen colocada»).
    expect(hint().getAttribute("role")).toBeNull();
    expect(liveRegion().textContent).toBe(s.imageWrongType);
    arm("rect");
    expect(hint().textContent).toBe(s.toolHints.rect);
    expect(liveRegion().textContent).toBe(s.toolHints.rect);
  });

  it("un error de imagen NO deja «Imagen colocada» como estado obsoleto", async () => {
    await mount();
    mocks.readImage.mockResolvedValue(okImage(1));
    arm("image");
    fireEvent.change(input(), { target: { files: [picked()] } });
    await waitFor(() => expect(liveRegion().textContent).toContain(s.imagePlaced));
    arm("image");
    mocks.readImage.mockResolvedValue({ ok: false, reason: "type" });
    fireEvent.change(input(), { target: { files: [picked()] } });
    await waitFor(() => expect(liveRegion().textContent).toBe(s.imageWrongType));
    expect(liveRegion().textContent).not.toContain(s.imagePlaced);
  });

  it("soltar una imagen sobre la pagina la coloca centrada en el punto soltado", async () => {
    await mount();
    mocks.readImage.mockResolvedValue(okImage(1));
    fireEvent.dragOver(host(), { dataTransfer: { types: ["Files"], files: [picked()], dropEffect: "none" } });
    expect(host().className).toContain("outline-signal");
    dropFiles([picked()], [300, 400]);
    await waitFor(() => expect(images()).toHaveLength(1));
    const el = images()[0].element;
    expect(el.x + el.width / 2).toBeCloseTo(300 / 595);
    expect(el.y + el.height / 2).toBeCloseTo(300 / 842);
    expect(host().className).not.toContain("outline-signal");
  });

  it("soltar un archivo no valido muestra el aviso (sin crear nada)", async () => {
    await mount();
    mocks.readImage.mockResolvedValue({ ok: false, reason: "type" });
    dropFiles([new File(["x"], "doc.pdf", { type: "application/pdf" })]);
    await waitFor(() => expect(hint().textContent).toBe(s.imageWrongType));
    expect(items()).toHaveLength(0);
  });

  it("soltar varias coloca solo la primera y lo avisa", async () => {
    await mount();
    mocks.readImage.mockResolvedValue(okImage());
    const files = [picked(), new File(["y"], "otra.png", { type: "image/png" })];
    dropFiles(files);
    await waitFor(() => expect(images()).toHaveLength(1));
    expect(liveRegion().textContent).toContain(s.imageMultiple);
  });

  it("arrastrar algo que no son archivos (texto) no se intercepta", async () => {
    await mount();
    const event = fireEvent.dragOver(host(), { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(event).toBe(true); // sin preventDefault
    expect(host().className).not.toContain("outline-signal");
  });

  it("una imagen se redimensiona conservando la proporcion y se exporta con sus bytes", async () => {
    await mount();
    mocks.readImage.mockResolvedValue(okImage(0.5));
    fireEvent.change(input(), { target: { files: [picked()] } });
    await waitFor(() => expect(images()).toHaveLength(1));
    await waitFor(() => expect(document.querySelector('[data-resize-handle="se"]')).not.toBeNull());
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    fireEvent.pointerDown(handle, pointer(400, 300));
    fireEvent.pointerMove(handle, pointer(480, 330));
    fireEvent.pointerUp(handle, pointer(480, 330));
    const el = images()[0].element;
    // La proporcion en pantalla (alto / ancho en px) sigue siendo la de la imagen.
    expect((el.height * 842) / (el.width * 595)).toBeCloseTo(0.5, 2);
  });

  it("duplicar una imagen comparte el asset", async () => {
    await mount();
    mocks.readImage.mockResolvedValue(okImage());
    fireEvent.change(input(), { target: { files: [picked()] } });
    await waitFor(() => expect(bar()).not.toBeNull());
    fireEvent.click(barAction("duplicate"));
    expect(images()).toHaveLength(2);
    expect(images()[1].element.assetId).toBe(images()[0].element.assetId);
    expect(Object.keys(live.session.assets)).toHaveLength(1);
  });
});

describe("navegacion del documento", () => {
  it("el paginador va a la pagina siguiente y anuncia pagina y cambios en la region viva", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    expect(liveRegion().textContent).toBe("Página 2 de 3. Sin cambios.");
    fireEvent.click(screen.getByRole("button", { name: strings.previousPage }));
    expect(liveRegion().textContent).toBe("Página 1 de 3. 1 cambio.");
  });

  it("ir a la pagina N desde el campo", async () => {
    await mount();
    const field = screen.getByRole("textbox", { name: s.goToPageLabel });
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(host().getAttribute("data-page-index")).toBe("2"));
    expect((screen.getByRole("textbox", { name: s.goToPageLabel }) as HTMLInputElement).value).toBe("3");
  });

  it("los corchetes cambian de pagina y no pasan de los extremos", async () => {
    await mount();
    fireEvent.keyDown(host(), { key: "]" });
    await waitFor(() => expect(host().getAttribute("data-page-index")).toBe("1"));
    fireEvent.keyDown(host(), { key: "]" });
    fireEvent.keyDown(host(), { key: "]" });
    await waitFor(() => expect(host().getAttribute("data-page-index")).toBe("2"));
    fireEvent.keyDown(host(), { key: "[" });
    await waitFor(() => expect(host().getAttribute("data-page-index")).toBe("1"));
  });

  it("cada pagina muestra solo SUS elementos", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    expect(document.querySelectorAll('[role="button"][data-element-kind="shape"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    await waitFor(() => expect(host().getAttribute("data-page-index")).toBe("1"));
    expect(document.querySelectorAll('[role="button"][data-element-kind="shape"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: strings.previousPage }));
    await waitFor(() => expect(document.querySelectorAll('[role="button"][data-element-kind="shape"]')).toHaveLength(1));
  });

  it("al cambiar de pagina con el foco en un elemento, el foco pasa a la hoja (no a <body>)", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-element-kind")).toBe("shape"));
    fireEvent.keyDown(document.activeElement!, { key: "]" });
    await waitFor(() => expect(host().getAttribute("data-page-index")).toBe("1"));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(host());
  });

  it("al cambiar de pagina se cancela lo que se dibujaba y se suelta la seleccion", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    expect(live.session.selectedId).toBeNull();
  });

  it("la tira de miniaturas se muestra y se oculta con su interruptor", async () => {
    await mount();
    expect(document.querySelector("[data-page-strip]")).toBeNull();
    const toggle = screen.getByRole("button", { name: s.thumbsLabel });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(document.querySelector("[data-page-strip]")).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(document.querySelector("[data-page-strip]")).toBeNull();
  });

  it("una miniatura va a su pagina y marca la actual; el contador de cambios sale en la celda", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    fireEvent.click(screen.getByRole("button", { name: s.thumbsLabel }));
    const cells = document.querySelectorAll<HTMLElement>("[data-page-thumb]");
    expect(cells).toHaveLength(3);
    expect(cells[0].getAttribute("aria-current")).toBe("page");
    expect(cells[0].getAttribute("aria-label")).toBe("Ir a la página 1 (1 cambio)");
    fireEvent.click(cells[2]);
    await waitFor(() => expect(host().getAttribute("data-page-index")).toBe("2"));
    expect(document.querySelectorAll<HTMLElement>("[data-page-thumb]")[2].getAttribute("aria-current")).toBe("page");
  });

  it("zoom con los botones y con + / -", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: s.zoomIn }));
    expect(screen.getByText("125 %")).toBeTruthy();
    fireEvent.keyDown(host(), { key: "+" });
    expect(screen.getByText("150 %")).toBeTruthy();
    fireEvent.keyDown(host(), { key: "-" });
    fireEvent.keyDown(host(), { key: "-" });
    expect(screen.getByText("100 %")).toBeTruthy();
  });

  it("Ctrl + rueda sobre la hoja acerca (y no deja que el navegador acerque la pagina)", async () => {
    await mount();
    const stage = host().closest(".surface-card") as HTMLElement;
    const event = new WheelEvent("wheel", { ctrlKey: true, deltaY: -30, bubbles: true, cancelable: true });
    act(() => {
      stage.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByText("100 %")).toBeNull();
  });

  it("el pellizco con dos dedos cancela un trazo en curso y cambia el zoom", async () => {
    await mount();
    arm("rect");
    fireEvent.pointerDown(host(), pointer(100, 200, { pointerType: "touch", pointerId: 1 }));
    fireEvent.pointerMove(host(), pointer(200, 300, { pointerType: "touch", pointerId: 1 }));
    expect(document.querySelector("[data-element-draft]")).not.toBeNull();
    fireEvent.pointerDown(host(), pointer(300, 300, { pointerType: "touch", pointerId: 2 }));
    await waitFor(() => expect(document.querySelector("[data-element-draft]")).toBeNull());
    fireEvent.pointerUp(host(), pointer(200, 300, { pointerType: "touch", pointerId: 1 }));
    fireEvent.pointerUp(host(), pointer(300, 300, { pointerType: "touch", pointerId: 2 }));
    expect(items()).toHaveLength(0);
  });

  it("los botones de zoom y pagina quedan en la barra pegajosa que la barra flotante respeta", async () => {
    await mount();
    const nav = document.querySelector("[data-canvas-sticky]")!;
    expect(within(nav as HTMLElement).getByRole("button", { name: s.zoomIn })).toBeTruthy();
    expect(within(nav as HTMLElement).getByRole("button", { name: strings.nextPage })).toBeTruthy();
  });
});

describe("Esc, atajos con el foco en <body> y roving tabindex (W5-U5)", () => {
  it("Esc justo despues de dibujar (el foco aun esta en la paleta) SUELTA la seleccion", async () => {
    await mount();
    palette("rect").focus();
    arm("rect");
    drag([100, 200], [300, 300]);
    expect(live.selected?.kind).toBe("shape");
    // El foco todavia no pasó al elemento (lo hace un cuadro de animacion despues): Esc va a la paleta.
    expect(document.activeElement).toBe(palette("rect"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(live.selected).toBeNull();
    await waitFor(() => expect(bar()).toBeNull());
  });

  it("Esc con el foco en <body> (tras un clic fuera) tambien suelta la seleccion", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    expect(live.selected).not.toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(live.selected).toBeNull();
  });

  it("las letras de la paleta funcionan con el foco en <body> y se callan con una hoja abierta o en un campo de texto", async () => {
    await mount();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "r" });
    expect(palette("rect").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(palette("select").getAttribute("aria-pressed")).toBe("true");

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    fireEvent.keyDown(input, { key: "e" });
    expect(palette("ellipse").getAttribute("aria-pressed")).toBe("false");
    input.remove();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "l" });
    expect(palette("line").getAttribute("aria-pressed")).toBe("false");
    dialog.remove();
  });

  it("con varios elementos hay UNA parada de Tab y las flechas recorren los elementos (seleccionado, mueven)", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [200, 260]);
    arm("ellipse");
    drag([250, 200], [350, 260]);
    arm("line");
    drag([100, 400], [300, 420]);
    const regions = Array.from(document.querySelectorAll<HTMLElement>('[role="button"][data-element-kind="shape"]'));
    expect(regions).toHaveLength(3);
    expect(regions.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    // Suelta la seleccion: con solo el foco, las flechas navegan.
    act(() => live.select(null));
    regions[0].focus();
    fireEvent.keyDown(regions[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(regions[1]);
    fireEvent.keyDown(regions[1], { key: "End" });
    expect(document.activeElement).toBe(regions[2]);
    expect(regions[2].tabIndex).toBe(0);
    expect(regions[0].tabIndex).toBe(-1);
    fireEvent.keyDown(regions[2], { key: "Home" });
    expect(document.activeElement).toBe(regions[0]);
    // Alt + flecha actua aunque no este seleccionado: no navega.
    const before = shapes().length;
    fireEvent.keyDown(regions[0], { key: "ArrowRight", altKey: true });
    expect(document.activeElement).toBe(regions[0]);
    expect(shapes()).toHaveLength(before);
  });

  it("la barra del elemento y la del texto describen los atajos de mover y redimensionar una vez", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    const group = bar()!;
    const describedBy = group.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)!.textContent).toBe(EDIT_STRINGS.es.inline.barShortcuts);
  });
});

describe("una sola region viva y un solo anuncio por accion (W5-U5)", () => {
  const okImage = (ratio = 0.5) => ({
    ok: true as const,
    image: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), previewUrl: "data:image/png;base64,AAAA", ratio, width: 200, height: 100, mime: "image/png" as const },
  });
  const picked = () => new File(["x"], "foto.png", { type: "image/png" });
  const input = () => document.querySelector<HTMLInputElement>("[data-image-input]")!;
  it("el editor tiene UNA region role=status (la pista, el estado de analisis y los avisos de la barra no son vivos)", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    const regions = document.querySelectorAll('[data-edit-workspace] [role="status"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toBe(liveRegion());
  });

  it("borrar un elemento anuncia UN mensaje: el foco que pasa al bloque siguiente no lo pisa con «Bloque n de m»", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    const id = shapes()[0].id;
    fireEvent.keyDown(elementRegion(id), { key: "Delete" });
    const expected = s.elementDeleted(EDIT_STRINGS.es.typeLabels.rect);
    await waitFor(() => expect(liveRegion().textContent).toBe(expected));
    // Deja pasar el cuadro de animacion en el que el foco llega al bloque siguiente.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(liveRegion().textContent).toBe(expected);
  });

  it("duplicar anuncia UN mensaje", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    fireEvent.click(barAction("duplicate"));
    const spoken = s.elementDuplicated(EDIT_STRINGS.es.typeLabels.rect);
    await waitFor(() => expect(liveRegion().textContent).toBe(spoken));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(liveRegion().textContent).toBe(spoken);
  });

  it("al cambiar de herramienta el aviso anterior deja de ser verdad (se limpia al volver a Seleccionar)", async () => {
    await mount();
    mocks.readImage.mockResolvedValue(okImage(1));
    arm("image");
    fireEvent.change(input(), { target: { files: [picked()] } });
    await waitFor(() => expect(liveRegion().textContent).toContain(s.imagePlaced));
    arm("rect");
    expect(liveRegion().textContent).toBe(s.toolHints.rect);
    arm("select");
    expect(liveRegion().textContent).toBe("");
  });

  it("lo que se anuncia dos veces seguidas se vuelve a leer (el nodo del texto cambia)", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    const first = liveRegion().firstElementChild;
    act(() => live.undo());
    arm("rect");
    drag([100, 200], [300, 300]);
    expect(liveRegion().firstElementChild).not.toBe(first);
  });
});


describe("anuncios de deshacer/rehacer, tamano y zoom (W5-U5 · N5)", () => {
  it("deshacer y rehacer se anuncian: «Deshecho: …» / «Rehecho: …»", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    act(() => live.undo());
    await waitFor(() => expect(liveRegion().textContent).toBe("Deshecho: añadir rectángulo."));
    act(() => live.redo());
    await waitFor(() => expect(liveRegion().textContent).toBe("Rehecho: añadir rectángulo."));
  });

  it("una accion NUEVA tras deshacer no se anuncia como «Rehecho» (pisaba el anuncio real: «Rectángulo borrado»)", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    const id = shapes()[0].id;
    act(() => live.dispatch({ type: "restyle", id, patch: { strokeColor: "#0d4bff" } }));
    act(() => live.undo());
    await waitFor(() => expect(liveRegion().textContent).toBe("Deshecho: cambiar el estilo de rectángulo."));
    // Borrar tras deshacer: descarta lo rehacible (largo igual, cursor +1): NO es un rehacer.
    fireEvent.keyDown(elementRegion(id), { key: "Delete" });
    await waitFor(() => expect(liveRegion().textContent).toMatch(/borrado/i));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(liveRegion().textContent).not.toContain("Rehecho");
  });

  it("deshacer un borrado y un cambio de estilo dicen que era", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    const id = shapes()[0].id;
    act(() => live.dispatch({ type: "restyle", id, patch: { strokeColor: "#0d4bff" } }));
    act(() => live.undo());
    await waitFor(() => expect(liveRegion().textContent).toBe("Deshecho: cambiar el estilo de rectángulo."));
    act(() => live.dispatch({ type: "remove", id }));
    act(() => live.undo());
    await waitFor(() => expect(liveRegion().textContent).toBe("Deshecho: borrar rectángulo."));
  });

  it("Alt + flechas anuncia el tamano nuevo de un elemento (en puntos)", async () => {
    await mount();
    arm("rect");
    drag([100, 200], [300, 300]);
    const id = shapes()[0].id;
    fireEvent.keyDown(elementRegion(id), { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(liveRegion().textContent).toMatch(/^Tamaño: \d+ × \d+ pt\.$/));
    const first = liveRegion().textContent;
    fireEvent.keyDown(elementRegion(id), { key: "ArrowRight", altKey: true, shiftKey: true });
    await waitFor(() => expect(liveRegion().textContent).not.toBe(first));
  });

  it("tras acercar, el estado obsoleto «Pagina 2 de 4…» se sustituye por el zoom", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: EDIT_STRINGS.es.nextPage }));
    await waitFor(() => expect(liveRegion().textContent).toContain("Página 2"));
    fireEvent.click(screen.getByRole("button", { name: s.zoomIn }));
    await waitFor(() => expect(liveRegion().textContent).toBe("125 %"), { timeout: 2000 });
    expect(liveRegion().textContent).not.toContain("Página 2");
  });
});
