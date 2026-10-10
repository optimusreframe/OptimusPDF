import { useEffect, type ComponentPropsWithoutRef, type ReactNode, type Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditWorkspace, type EditWorkspaceProps } from "@/app/edit-pdf/EditWorkspace";
import { useEditSession, type UseEditSession } from "@/app/edit-pdf/useEditSession";
import { splitForExport, textItem, type EditTextItem } from "@/app/edit-pdf/editSession";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { CALIBRI, makeBlock, makeEdit, metricsFor } from "@/app/edit-pdf/editTestUtils";
import type { PageMetrics } from "@/app/edit-pdf/editCanvasMath";
import type { PageTextAnalysis } from "@/lib/pdf/textBlocks";
import type { TextBlock } from "@/lib/pdf/editTypes";

const mocks = vi.hoisted(() => ({
  doc: { numPages: 2 } as unknown,
  texts: {} as Record<number, { status: "idle" | "analyzing" | "ready"; analysis: unknown }>,
  metrics: {} as Record<number, unknown>,
  sample: { color: "#fdfdfd", uniform: true, outliers: 0, samples: 100 } as {
    color: string;
    uniform: boolean;
    outliers: number;
    samples: number;
    clip?: Array<{ x: number; y: number; width: number; height: number }>;
  } | null,
  sampled: [] as unknown[],
  quads: [] as unknown[],
}));

vi.mock("@/app/edit-pdf/useEditDocument", () => ({
  useEditDocument: () => ({ doc: mocks.doc, pageCount: 2, error: null }),
  usePageText: (_doc: unknown, page: number) =>
    mocks.texts[page] ?? { status: "analyzing", analysis: null },
}));

vi.mock("@/app/edit-pdf/EditSurface", async () => {
  const react = await import("react");
  return {
    EditSurface: function EditSurfaceStub(props: {
      pageIndex: number;
      hostRef: { current: HTMLDivElement | null };
      clipRef: { current: HTMLDivElement | null };
      handleRef?: Ref<{ sampleBackground: (box: unknown, quad?: unknown) => unknown }>;
      onMetrics: (m: unknown, page: number) => void;
      hostProps?: ComponentPropsWithoutRef<"div">;
      children?: ReactNode;
    }) {
      const { pageIndex, hostRef, clipRef, handleRef, onMetrics, hostProps, children } = props;
      react.useImperativeHandle(handleRef, () => ({
        sampleBackground: (box: unknown, quad?: unknown) => {
          mocks.sampled.push(box);
          mocks.quads.push(quad);
          return mocks.sample;
        },
      }));
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
const file = new File(["%PDF"], "doc.pdf", { type: "application/pdf" });

const TITLE = makeBlock("p0-b0", { text: "Titulo", fontSize: 24, box: { x: 50, y: 780, width: 150, height: 24 } });
const TOTAL = makeBlock("p0-b1", { text: "Total a pagar", fontSize: 14, color: "#cc1111", box: { x: 50, y: 600, width: 120, height: 16 } });
const FOOT = makeBlock("p0-b2", { text: "Pie de pagina", box: { x: 50, y: 100, width: 140, height: 14 } });

function ready(blocks: TextBlock[], extra: Partial<PageTextAnalysis> = {}) {
  return { status: "ready" as const, analysis: { blocks, hiddenCount: 0, hasTextLayer: true, failed: false, ...extra } };
}

let live: UseEditSession;
let clock = 1000;
const flow = EDIT_FLOW_STRINGS.es;

function Harness(props: Partial<EditWorkspaceProps> = {}) {
  const edit = useEditSession({ now: () => clock, shortcuts: false });
  useEffect(() => {
    live = edit;
  });
  return <EditWorkspace file={file} session={edit} strings={EDIT_STRINGS.es} flow={flow} {...props} />;
}

function textItems(): EditTextItem[] {
  return live.session.items.filter((item): item is EditTextItem => item.kind === "text");
}

const region = (id: string) => document.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!;
const editor = () => document.querySelector<HTMLElement>("[data-inline-editor]");
const bar = () => document.querySelector<HTMLElement>("[data-floating-bar]");
/** Abre la hoja «Más opciones» de la barra (avisos y acciones secundarias) y la devuelve. */
async function openMore(): Promise<HTMLElement> {
  // Se reintenta el clic si la barra aun se estaba recolocando (tras Esc o al cambiar de seleccion).
  return waitFor(() => {
    const open = document.querySelector<HTMLElement>("[data-bar-more]");
    if (open) return open;
    bar()?.querySelector<HTMLElement>('[data-bar-action="more"]')?.click();
    throw new Error("la hoja «Más opciones» aun no esta abierta");
  });
}
const noticeText = (id: string) => document.querySelector(`[data-more-notice="${id}"]`)?.textContent ?? null;
const barButton = (name: string | RegExp) => within(bar()!).getByRole("button", { name, hidden: true });

function click(el: Element, init: Record<string, unknown> = {}) {
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 5, clientY: 5, ...init });
  fireEvent.pointerUp(el, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 5, clientY: 5, ...init });
}
function dblclick(el: Element) {
  click(el);
  click(el);
}
function typeInto(text: string) {
  const el = editor()!;
  el.textContent = text;
  fireEvent.input(el);
}

async function mount() {
  render(<Harness />);
  await waitFor(() => expect(region("p0-b1")).not.toBeNull());
}

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  // Con geometria real la barra queda colocada (y visible): asi sus nombres accesibles se calculan.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-floating-bar")) return rect(0, 0, 300, 44);
    // La barra de zoom y paginas (siempre un obstaculo) ocupa solo su franja superior.
    if (this.hasAttribute("data-canvas-sticky")) return rect(0, 0, 600, 44);
    if (this.hasAttribute("data-element-id")) return rect(100, 300, 120, 20);
    return rect(0, 100, 600, 800);
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 44 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
  clock = 1000;
  mocks.sampled.length = 0;
  mocks.quads.length = 0;
  mocks.sample = { color: "#fdfdfd", uniform: true, outliers: 0, samples: 100 };
  mocks.texts = { 0: ready([TITLE, TOTAL, FOOT]), 1: ready([makeBlock("p1-b0", { pageIndex: 1, text: "Pagina dos" })]) };
  mocks.metrics = { 0: metricsFor(), 1: metricsFor([20, 10, 380, 290], 90, 280) as PageMetrics };
});

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — restaura los accesores de prueba
  delete HTMLElement.prototype.offsetWidth;
  // @ts-expect-error — idem
  delete HTMLElement.prototype.offsetHeight;
});

describe("EditWorkspace — seleccion y edicion en vivo", () => {
  it("seleccionar un bloque abre la barra pero NO crea nada en el historial", async () => {
    await mount();
    click(region("p0-b1"));
    expect(region("p0-b1").getAttribute("aria-pressed")).toBe("true");
    expect(bar()).not.toBeNull();
    expect(live.items).toHaveLength(0);
    expect(live.pendingChangeCount).toBe(0);
    expect(live.canUndo).toBe(false);
  });

  it("doble clic abre el editor con el texto del bloque, cubierto con el fondo muestreado", async () => {
    await mount();
    dblclick(region("p0-b1"));
    const el = editor()!;
    expect(el).not.toBeNull();
    expect(el.getAttribute("role")).toBe("textbox");
    expect(el.textContent).toBe("Total a pagar");
    expect(document.activeElement).toBe(el);
    const cover = document.querySelector<HTMLElement>('[data-cover="p0-b1"]')!;
    expect(cover.style.backgroundColor).toBe("rgb(253, 253, 253)");
    expect(mocks.sampled.length).toBeGreaterThan(0);
    expect(live.items).toHaveLength(0); // abrir el editor tampoco toca el historial
  });

  it("teclear crea la edicion en UNA sola operacion, con la cobertura y la fuente mapeada", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Total pagado");
    const items = textItems();
    expect(items).toHaveLength(1);
    const edit = items[0].edit;
    expect(edit.blockId).toBe("p0-b1");
    expect(edit.text).toBe("Total pagado");
    expect(edit.cover).toEqual({ color: "#fdfdfd", padding: 1 });
    expect(edit.coverBox).toEqual(TOTAL.box);
    expect(edit.fontKey).toBe("helvetica");
    expect(edit.color).toBe("#cc1111");
    expect(edit.fontSize).toBe(14);
    expect(live.session.history).toHaveLength(1);
    expect(live.session.history[0].op).toBe("add");
  });

  it("reescribir EXACTAMENTE el mismo texto no cuenta como cambio (ni edicion ni historial)", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Total a pagar"); // el texto original, tal cual
    expect(live.items).toHaveLength(0);
    expect(live.session.history).toHaveLength(0);
    expect(live.pendingChangeCount).toBe(0);

    typeInto("Total a pagar!");
    expect(textItems()).toHaveLength(1);
    const entries = live.session.history.length;
    clock += 1000;
    typeInto("Total a pagar!"); // misma cadena sobre la edicion ya hecha: nada nuevo
    expect(live.session.history).toHaveLength(entries);
  });

  it("un borde fino hallado al muestrear viaja a la edicion (coverClip) y recorta la cobertura que se exporta", async () => {
    // Franja de borde (espacio de usuario) pegada bajo la caja de «Total a pagar»: lo que EditSurface devuelve en `clip`.
    const strip = { x: TOTAL.box.x - 10, y: TOTAL.box.y - 1.5, width: TOTAL.box.width + 20, height: 2 };
    mocks.sample = { color: "#fdfdfd", uniform: true, outliers: 0, samples: 100, clip: [strip] };
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Total pagado");
    const edit = textItems()[0].edit;
    expect(edit.coverClip).toEqual([strip]);
    // Con la franja la cobertura NO baja hasta el borde (sin ella cubriria hasta 1 pt por debajo de la caja).
    const { coverShape } = await import("@/lib/pdf/editCover");
    const shape = coverShape(edit)!;
    expect(shape.kind).toBe("rect");
    expect(shape.kind === "rect" && shape.box.y).toBeGreaterThan(TOTAL.box.y - 0.001);
    expect(coverShape({ ...edit, coverClip: undefined })).toMatchObject({ box: { y: TOTAL.box.y - 1 } });
    // Y sale en la sesion que se exporta.
    expect(splitForExport(live.session).textEdits[0].coverClip).toEqual([strip]);
  });

  it("los tecleos seguidos se agrupan (500 ms) en UNA entrada: un solo deshacer vuelve al original y rehacer a lo ultimo escrito", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("T");
    clock += 100;
    typeInto("To");
    clock += 100;
    typeInto("Tot");
    clock += 100;
    typeInto("Tota");
    // W5-U5: el primer caracter (`add`) y los siguientes (`update`) son UNA sola entrada.
    expect(live.session.history).toHaveLength(1);
    act(() => live.undo());
    expect(textItems()).toHaveLength(0);
    // El editor sigue abierto y vuelve al texto original (el DOM se resincroniza), sin estado intermedio.
    await waitFor(() => expect(editor()!.textContent).toBe("Total a pagar"));
    act(() => live.redo());
    expect(textItems()[0].edit.text).toBe("Tota");
  });

  it("una pausa de mas de 500 ms abre una entrada nueva del historial", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("A");
    clock += 900;
    typeInto("AB");
    expect(live.session.history).toHaveLength(2);
    act(() => live.undo());
    expect(textItems()[0].edit.text).toBe("A");
  });

  it("Ctrl+Z dentro del editor deshace el historial de la sesion y rehace con Ctrl+Mayus+Z", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Uno");
    clock += 900;
    typeInto("Uno dos");
    fireEvent.keyDown(editor()!, { key: "z", ctrlKey: true });
    await waitFor(() => expect(editor()!.textContent).toBe("Uno"));
    fireEvent.keyDown(editor()!, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(editor()!.textContent).toBe("Uno dos"));
    expect(textItems()[0].edit.text).toBe("Uno dos");
  });

  it("Esc termina la edicion y el foco VUELVE al bloque (nunca a <body>)", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Nuevo");
    fireEvent.keyDown(editor()!, { key: "Escape" });
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(region("p0-b1"));
    expect(region("p0-b1").getAttribute("aria-pressed")).toBe("true");
    expect(textItems()[0].edit.text).toBe("Nuevo");
  });

  it("Mayus+Intro tambien termina y devuelve el foco al bloque", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Otro");
    fireEvent.keyDown(editor()!, { key: "Enter", shiftKey: true });
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(region("p0-b1"));
  });

  it("clic fuera (en lo vacio de la hoja) confirma y suelta la seleccion sin dejar el foco en <body>", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Fuera");
    const host = screen.getByTestId("host");
    fireEvent.pointerDown(host, { pointerId: 1, pointerType: "mouse", button: 0 });
    expect(editor()).toBeNull();
    await waitFor(() => expect(bar()).toBeNull());
    expect(textItems()[0].edit.text).toBe("Fuera");
    expect(document.activeElement).toBe(host);
    expect(region("p0-b1").getAttribute("aria-pressed")).toBe("false");
  });

  it("pasar el foco a otro bloque con el raton termina la edicion del primero", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Primero");
    click(region("p0-b2"));
    expect(editor()).toBeNull();
    expect(region("p0-b2").getAttribute("aria-pressed")).toBe("true");
    expect(textItems()).toHaveLength(1);
  });

  it("pasar el foco a la barra flotante NO termina la edicion", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Con barra");
    const size = within(bar()!).getByRole("textbox", { name: s.sizeLabel, hidden: true });
    act(() => size.focus());
    fireEvent.blur(editor()!, { relatedTarget: size });
    expect(editor()).not.toBeNull();
  });

  it("Intro sobre un bloque enfocado entra a editar y escribir una tecla lo hace con esa tecla", async () => {
    await mount();
    act(() => region("p0-b2").focus());
    fireEvent.keyDown(region("p0-b2"), { key: "Enter" });
    expect(editor()!.textContent).toBe("Pie de pagina");
    fireEvent.keyDown(editor()!, { key: "Escape" });
    fireEvent.keyDown(region("p0-b0"), { key: "X" });
    await waitFor(() => expect(editor()!.textContent).toBe("TituloX"));
    expect(textItems().find((i) => i.edit.blockId === "p0-b0")?.edit.text).toBe("TituloX");
  });

  it("un bloque no editable no abre el editor", async () => {
    mocks.texts[0] = ready([TITLE, makeBlock("p0-b9", { text: "??", editable: false, readOnlyReason: "type3", box: { x: 50, y: 400, width: 50, height: 10 } })]);
    render(<Harness />);
    await waitFor(() => expect(region("p0-b9")).not.toBeNull());
    fireEvent.keyDown(region("p0-b9"), { key: "Enter" });
    dblclick(region("p0-b9"));
    expect(editor()).toBeNull();
    expect(screen.getByText(s.nonEditableCount(1))).toBeTruthy();
  });
});

describe("EditWorkspace — barra, estilo y avisos", () => {
  it("cambiar el tamano de un bloque sin tocar crea la edicion ya con ese cambio (una entrada)", async () => {
    await mount();
    click(region("p0-b1"));
    fireEvent.click(barButton(s.sizeIncrease));
    const [item] = textItems();
    expect(item.edit.blockId).toBe("p0-b1");
    expect(item.edit.fontSize).toBe(15);
    expect(item.edit.text).toBe("Total a pagar");
    expect(live.session.history).toHaveLength(1);
    expect(live.session.history[0].op).toBe("add");
    // El siguiente cambio ya es un restyle sobre la edicion existente...
    fireEvent.click(barButton(s.sizeIncrease));
    expect(textItems()[0].edit.fontSize).toBe(16);
    expect(live.session.history).toHaveLength(2);
    expect(live.session.history[1].op).toBe("restyle");
    // ...y los siguientes del mismo control se agrupan en una sola entrada.
    fireEvent.click(barButton(s.sizeIncrease));
    expect(textItems()[0].edit.fontSize).toBe(17);
    expect(live.session.history).toHaveLength(2);
  });

  it("negrita, cursiva, alineacion, color y fuente van al texto", async () => {
    await mount();
    click(region("p0-b1"));
    fireEvent.click(barButton(s.bold));
    fireEvent.click(barButton(s.italic));
    fireEvent.click(bar()!.querySelector('[data-bar-action="align"]')!); // cicla izquierda -> centro
    fireEvent.click(barButton(s.colorOpen));
    fireEvent.click(barButton("Color azul"));
    fireEvent.change(within(bar()!).getByRole("combobox", { name: s.fontLabel, hidden: true }), {
      target: { value: "times" },
    });
    const edit = textItems()[0].edit;
    expect(edit).toMatchObject({ bold: true, italic: true, align: "center", color: "#0d4bff", fontKey: "times" });
  });

  it("el aviso de fuente parecida sale para Calibri y no para Helvetica", async () => {
    mocks.texts[0] = ready([
      TITLE,
      makeBlock("p0-b1", { text: "Calibri", font: CALIBRI, box: { x: 50, y: 600, width: 120, height: 16 } }),
    ]);
    await mount();
    click(region("p0-b1"));
    await openMore();
    expect(noticeText("font")).toBe("Se usará Liberation Sans (parecida)");
    fireEvent.click(screen.getByRole("button", { name: s.moreClose }));
    await waitFor(() => expect(document.querySelector("[data-bar-more]")).toBeNull());
    click(region("p0-b0"));
    await waitFor(() => expect(bar()!.querySelector('[data-bar-action="more"]')).not.toBeNull());
    await openMore();
    expect(noticeText("font")).toBeNull();
  });

  it("fondo no uniforme: aviso junto a la barra y el color de fondo se puede cambiar", async () => {
    mocks.sample = { color: "#dde6ff", uniform: false, outliers: 0.4, samples: 80 };
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Con fondo raro");
    const sheet = await openMore();
    expect(noticeText("background")).toBe(s.backgroundNotUniform);
    const group = within(sheet).getByRole("group", { name: s.coverColorLabel, hidden: true });
    fireEvent.click(within(group).getByRole("button", { name: "Color blanco", hidden: true }));
    expect(textItems()[0].edit.cover).toEqual({ color: "#ffffff", padding: 1 });
  });

  it("el aviso de fondo no uniforme sigue la edicion (lo que cuenta la lista de descarga), no una lectura posterior", async () => {
    mocks.sample = { color: "#dde6ff", uniform: false, outliers: 0.4, samples: 80 };
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Con fondo raro");
    fireEvent.keyDown(editor()!, { key: "Escape" });
    await waitFor(() => expect(editor()).toBeNull());
    expect(textItems()[0].edit.cover.uniform).toBe(false);
    // Una lectura posterior del fondo (otro zoom, otro canvas) lo ve liso: la edicion ya lo marco, la barra lo mantiene.
    mocks.sample = { color: "#dde6ff", uniform: true, outliers: 0, samples: 80 };
    click(region("p0-b0"));
    click(region("p0-b1"));
    await openMore();
    await waitFor(() => expect(noticeText("background")).toBe(s.backgroundNotUniform));
  });

  it("al teclear un caracter que ninguna fuente dibuja, la barra avisa en el momento", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Total 日本");
    await openMore();
    await waitFor(() => expect(noticeText("glyph")).toContain("saldrán como «?»"));
  });

  it("fondo uniforme: sin aviso", async () => {
    await mount();
    click(region("p0-b1"));
    await openMore();
    expect(noticeText("background")).toBeNull();
  });

  it("el aviso permanente del original y «Aplanar pagina» abren la confirmacion (no aplanan sin preguntar)", async () => {
    await mount();
    click(region("p0-b1"));
    const sheet = await openMore();
    expect(noticeText("original")).toBe(s.originalRemains);
    fireEvent.click(sheet.querySelector('[data-more-action="flatten"]')!);
    expect(await screen.findByText(flow.flattenConfirmBody)).toBeTruthy();
    expect(live.session.items.some((item) => item.kind === "flatten")).toBe(false);
  });

  it("un texto nuevo no lleva el aviso del original", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: s.toolText }));
    const host = screen.getByTestId("host");
    host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 595, bottom: 842, width: 595, height: 842, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(host, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(host, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    await waitFor(() => expect(editor()).not.toBeNull());
    typeInto("Nuevo");
    await openMore();
    expect(noticeText("original")).toBeNull();
  });

  it("borrar desde la barra deja el bloque vacio y cubierto (se puede deshacer)", async () => {
    await mount();
    click(region("p0-b1"));
    fireEvent.click(barButton(s.remove));
    const edit = textItems()[0].edit;
    expect(edit.text).toBe("");
    expect(edit.cover.color).toBe("#fdfdfd");
    expect(live.pendingChangeCount).toBe(1);
    act(() => live.undo());
    expect(textItems()).toHaveLength(0);
  });
});

describe("EditWorkspace — teclado sobre el bloque", () => {
  it("Supr borra el texto del bloque y el foco se queda en el bloque", async () => {
    await mount();
    act(() => region("p0-b1").focus());
    fireEvent.keyDown(region("p0-b1"), { key: "Delete" });
    expect(textItems()[0].edit.text).toBe("");
    expect(document.activeElement).toBe(region("p0-b1"));
    expect(document.querySelector("[data-workspace-live]")!.textContent).toBe(s.deleted);
  });

  it("las flechas mueven una entrada de historial por pulsacion; Mayus mueve 10 pt", async () => {
    await mount();
    // Las flechas mueven un bloque SELECCIONADO; con solo el foco recorren los bloques.
    click(region("p0-b1"));
    act(() => region("p0-b1").focus());
    const before = { ...TOTAL.box };
    fireEvent.keyDown(region("p0-b1"), { key: "ArrowRight" });
    const first = textItems()[0].edit.box;
    expect(first.x).toBeCloseTo(before.x + 1 + (first.width - TOTAL.box.width) * 0, 6);
    fireEvent.keyDown(region("p0-b1"), { key: "ArrowRight", shiftKey: true });
    expect(textItems()[0].edit.box.x).toBeCloseTo(before.x + 11, 6);
    fireEvent.keyDown(region("p0-b1"), { key: "ArrowDown" });
    expect(textItems()[0].edit.box.y).toBeCloseTo(first.y - 1, 6);
    expect(textItems()[0].edit.coverBox).toEqual(TOTAL.box); // la cobertura NO se mueve
    expect(live.session.history).toHaveLength(3);
  });

  it("en una pagina con /Rotate 90 las flechas siguen la VISTA, no el espacio de usuario", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: EDIT_STRINGS.es.nextPage }));
    await waitFor(() => expect(region("p1-b0")).not.toBeNull());
    click(region("p1-b0"));
    act(() => region("p1-b0").focus());
    const start = (await waitFor(() => {
      fireEvent.keyDown(region("p1-b0"), { key: "ArrowRight" });
      return textItems()[0].edit.box;
    })) as { x: number; y: number };
    // Derecha en la vista = +Y de usuario cuando /Rotate es 90.
    expect(start.y).toBeCloseTo(makeBlock("p1-b0").box.y + 1, 4);
  });

  it("Alt + flechas cambian el tamano de la caja", async () => {
    await mount();
    act(() => region("p0-b1").focus());
    fireEvent.keyDown(region("p0-b1"), { key: "ArrowRight", altKey: true, shiftKey: true });
    const box = textItems()[0].edit.box;
    expect(box.width).toBeGreaterThan(TOTAL.box.width + 9);
  });
});

describe("EditWorkspace — mover y redimensionar con el puntero", () => {
  it("arrastrar un bloque seleccionado crea UNA operacion de mover", async () => {
    await mount();
    click(region("p0-b1"));
    const el = region("p0-b1");
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    for (const x of [110, 130, 160]) fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: 100 });
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: "mouse", clientX: 160, clientY: 100 });
    expect(textItems()).toHaveLength(1);
    expect(textItems()[0].edit.box.x).toBeCloseTo(TOTAL.box.x + 60, 4);
    expect(live.session.history).toHaveLength(1);
  });

  it("la barra se oculta mientras se arrastra y vuelve al soltar", async () => {
    await mount();
    click(region("p0-b1"));
    const el = region("p0-b1");
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 140, clientY: 100 });
    await waitFor(() => expect(bar()).toBeNull());
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: "mouse", clientX: 140, clientY: 100 });
    await waitFor(() => expect(bar()).not.toBeNull());
  });

  it("arrastrar el tirador cambia la caja del texto", async () => {
    await mount();
    click(region("p0-b1"));
    const handle = document.querySelector<HTMLElement>('[data-resize-handle="se"]')!;
    fireEvent.pointerDown(handle, { pointerId: 2, pointerType: "mouse", button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 350, clientY: 320 });
    fireEvent.pointerUp(handle, { pointerId: 2, pointerType: "mouse", clientX: 350, clientY: 320 });
    const box = textItems()[0].edit.box;
    expect(box.width).toBeGreaterThan(TOTAL.box.width + 40);
  });
});

describe("EditWorkspace — herramienta «Anadir texto»", () => {
  function placeText(x = 100, y = 100, toX = x, toY = y) {
    fireEvent.click(screen.getByRole("button", { name: s.toolText }));
    const host = screen.getByTestId("host");
    host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 595, bottom: 842, width: 595, height: 842, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(host, { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y });
    if (toX !== x || toY !== y) fireEvent.pointerMove(host, { pointerId: 1, clientX: toX, clientY: toY });
    fireEvent.pointerUp(host, { pointerId: 1, pointerType: "mouse", button: 0, clientX: toX, clientY: toY });
  }

  it("la letra T activa la herramienta y V vuelve a Seleccionar (no mientras se teclea)", async () => {
    await mount();
    fireEvent.keyDown(screen.getByTestId("host"), { key: "t" });
    expect(screen.getByRole("button", { name: s.toolText }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("host"), { key: "v" });
    expect(screen.getByRole("button", { name: s.toolSelect }).getAttribute("aria-pressed")).toBe("true");
    dblclick(region("p0-b1"));
    fireEvent.keyDown(editor()!, { key: "t" });
    expect(screen.getByRole("button", { name: s.toolSelect }).getAttribute("aria-pressed")).toBe("true");
  });

  it("un clic crea un texto nuevo Helvetica 12 negro, sin cobertura, y abre el editor", async () => {
    await mount();
    placeText();
    await waitFor(() => expect(editor()).not.toBeNull());
    expect(textItems()).toHaveLength(0); // hasta que se escribe algo no hay nada en el historial
    typeInto("Hola");
    const [{ edit }] = textItems();
    expect(edit).toMatchObject({
      text: "Hola",
      fontKey: "helvetica",
      fontSize: 12,
      color: "#000000",
      cover: { color: null, padding: 0 },
      rotation: 0,
      pageIndex: 0,
    });
    expect(edit.blockId).toBeUndefined();
    expect(edit.box.width).toBeCloseTo(200, 4);
    expect(live.session.history).toHaveLength(1);
    expect(screen.getByRole("button", { name: s.toolSelect }).getAttribute("aria-pressed")).toBe("true");
  });

  it("un arrastre crea la caja trazada", async () => {
    await mount();
    placeText(100, 100, 300, 160);
    await waitFor(() => expect(editor()).not.toBeNull());
    typeInto("Caja");
    expect(textItems()[0].edit.box.width).toBeCloseTo(200, 4);
    expect(textItems()[0].edit.box.height).toBeCloseTo(60, 4);
  });

  it("Esc sin escribir nada descarta el borrador: ni historial ni region fantasma", async () => {
    await mount();
    placeText();
    await waitFor(() => expect(editor()).not.toBeNull());
    fireEvent.keyDown(editor()!, { key: "Escape" });
    expect(editor()).toBeNull();
    expect(textItems()).toHaveLength(0);
    expect(live.canUndo).toBe(false);
    expect(document.querySelectorAll('[data-element-kind="text"]')).toHaveLength(3);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("host")));
  });

  it("borrar el texto nuevo pasa el foco al siguiente bloque, nunca a <body>", async () => {
    await mount();
    placeText();
    await waitFor(() => expect(editor()).not.toBeNull());
    typeInto("Nuevo");
    fireEvent.keyDown(editor()!, { key: "Escape" });
    const id = textItems()[0].id;
    expect(document.activeElement).toBe(region(id));
    fireEvent.keyDown(region(id), { key: "Delete" });
    expect(textItems()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(region("p0-b2")));
  });

  it("deshacer el alta del texto nuevo mientras esta seleccionado suelta el foco sin caer a <body>", async () => {
    await mount();
    placeText();
    await waitFor(() => expect(editor()).not.toBeNull());
    typeInto("Efimero");
    fireEvent.keyDown(editor()!, { key: "Escape" });
    act(() => live.undo());
    await waitFor(() => expect(bar()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("host")));
  });

  it("duplicar crea un texto propio desplazado, sin cobertura ni bloque, y lo selecciona", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Copiame");
    fireEvent.keyDown(editor()!, { key: "Escape" });
    fireEvent.click((await openMore()).querySelector('[data-more-action="duplicate"]')!);
    const items = textItems();
    expect(items).toHaveLength(2);
    const copy = items[1].edit;
    expect(copy.blockId).toBeUndefined();
    expect(copy.coverBox).toBeUndefined();
    expect(copy.cover).toEqual({ color: null, padding: 0 });
    expect(copy.text).toBe("Copiame");
    expect(copy.box.y).toBeLessThan(items[0].edit.box.y);
    await waitFor(() => expect(document.activeElement).toBe(region(copy.id)));
  });
});

describe("EditWorkspace — historial, paleta y paginas", () => {
  it("deshacer y rehacer de la paleta: aria-disabled correcto y aria-keyshortcuts", async () => {
    await mount();
    const undo = screen.getByRole("button", { name: s.undo });
    const redo = screen.getByRole("button", { name: s.redo });
    expect(undo.getAttribute("aria-disabled")).toBe("true");
    expect(redo.getAttribute("aria-disabled")).toBe("true");
    expect(undo.getAttribute("aria-keyshortcuts")).toContain("Control+Z");
    click(region("p0-b1"));
    fireEvent.click(barButton(s.bold));
    expect(undo.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(undo);
    expect(textItems()).toHaveLength(0);
    expect(redo.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(redo);
    expect(textItems()[0].edit.bold).toBe(true);
  });

  it("la sesion exporta una edicion de texto con blockId y coverBox", async () => {
    await mount();
    dblclick(region("p0-b0"));
    typeInto("Titulo nuevo");
    const { textEdits, elements } = splitForExport(live.session);
    expect(elements).toHaveLength(0);
    expect(textEdits).toHaveLength(1);
    expect(textEdits[0]).toMatchObject({ blockId: "p0-b0", coverBox: TITLE.box, text: "Titulo nuevo" });
  });

  it("cambiar de pagina suelta la seleccion y muestra las paginas «n de N»", async () => {
    await mount();
    click(region("p0-b1"));
    expect(screen.getByText("Página 1 de 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: EDIT_STRINGS.es.nextPage }));
    await waitFor(() => expect(screen.getByText("Página 2 de 2")).toBeTruthy());
    await waitFor(() => expect(bar()).toBeNull());
    await waitFor(() => expect(region("p1-b0")).not.toBeNull());
    expect(document.querySelector('[data-element-id="p0-b1"]')).toBeNull();
  });
});

describe("EditWorkspace — zoom y paginas", () => {
  it("los botones de paginas y zoom se agotan con aria-disabled (no disabled): el foco no cae a <body>", async () => {
    await mount();
    const next = screen.getByRole("button", { name: EDIT_STRINGS.es.nextPage }) as HTMLButtonElement;
    const prev = screen.getByRole("button", { name: EDIT_STRINGS.es.previousPage }) as HTMLButtonElement;
    const zoomOut = screen.getByRole("button", { name: s.zoomOut }) as HTMLButtonElement;
    expect(prev.getAttribute("aria-disabled")).toBe("true");
    expect(prev.disabled).toBe(false);
    expect(zoomOut.getAttribute("aria-disabled")).toBe("true");
    expect(zoomOut.disabled).toBe(false);
    act(() => next.focus());
    fireEvent.click(next);
    await waitFor(() => expect(screen.getByText("Página 2 de 2")).toBeTruthy());
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.disabled).toBe(false);
    expect(document.activeElement).toBe(next);
    fireEvent.click(next); // agotado: no hace nada
    expect(screen.getByText("Página 2 de 2")).toBeTruthy();
    expect(prev.getAttribute("aria-disabled")).toBeNull();
  });

  it("el zoom sube por pasos hasta 300 % y baja a 100 %, con el valor visible", async () => {
    await mount();
    const zoomIn = screen.getByRole("button", { name: s.zoomIn });
    expect(screen.getByText("100 %")).toBeTruthy();
    fireEvent.click(zoomIn);
    expect(screen.getByText("125 %")).toBeTruthy();
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    expect(screen.getByText("300 %")).toBeTruthy();
    expect(zoomIn.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(zoomIn);
    expect(screen.getByText("300 %")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.zoomOut }));
    expect(screen.getByText("200 %")).toBeTruthy();
  });
});

describe("EditWorkspace — estados de la extraccion", () => {
  const status = () => document.querySelector<HTMLElement>("[data-analysis-status]")!;

  it("mientras analiza hay un indicador siempre montado (no vivo: la region unica anuncia lo terminal)", async () => {
    mocks.texts = {};
    render(<Harness />);
    expect(status().getAttribute("role")).toBeNull();
    expect(status().textContent).toBe(s.analyzing);
  });

  it("pagina sin capa de texto: aviso de escaneo, no error, y «Anadir texto» sigue disponible", async () => {
    mocks.texts[0] = ready([], { hasTextLayer: false });
    render(<Harness />);
    await waitFor(() => expect(status().textContent).toBe(s.scanned));
    expect(status().textContent).toBe(
      "Esta página parece un escaneo: no tiene texto que editar. Puedes añadir texto, imágenes y formas encima.",
    );
    // La accion «Añadir texto» arma la herramienta de texto.
    fireEvent.click(document.querySelector<HTMLElement>("[data-scanned-add-text]")!);
    const textButtons = screen.getAllByRole("button", { name: s.toolText });
    expect(textButtons.some((button) => button.getAttribute("aria-pressed") === "true")).toBe(true);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("fallo de extraccion: aviso amable y la herramienta de anadir texto sigue disponible", async () => {
    mocks.texts[0] = ready([], { failed: true, hasTextLayer: false });
    render(<Harness />);
    await waitFor(() => expect(status().textContent).toBe(s.analysisFailed));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: s.toolText }));
    expect(screen.getByRole("button", { name: s.toolText }).getAttribute("aria-pressed")).toBe("true");
  });

  it("con texto editable la region de estado queda vacia", async () => {
    await mount();
    expect(status().textContent).toBe("");
  });
});


/** Acepta la hoja de confirmacion (su boton se llama igual que el de la barra: se busca DENTRO del dialogo). */
async function confirmFlatten() {
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: flow.flattenConfirmAction }));
}
const toggle = () => document.querySelector<HTMLElement>("[data-flatten-toggle]")!;
const flattenItems = () => live.session.items.filter((item) => item.kind === "flatten");

describe("EditWorkspace — aplanar pagina (W5-U5)", () => {
  it("pedir aplanar abre la confirmacion que explica las consecuencias; no aplana hasta confirmar", async () => {
    await mount();
    fireEvent.click(toggle());
    expect(await screen.findByText(flow.flattenConfirmTitle(1))).toBeTruthy();
    expect(screen.getByText(flow.flattenConfirmBody)).toBeTruthy();
    expect(flow.flattenConfirmBody).toMatch(/imagen/);
    expect(flow.flattenConfirmBody).toMatch(/no se puede deshacer/);
    expect(flattenItems()).toHaveLength(0);
    expect(document.querySelector("[data-flatten-chip]")).toBeNull();
  });

  it("sin formularios ni marcadores la confirmacion no anade la nota de lo que se pierde", async () => {
    await mount();
    fireEvent.click(toggle());
    expect(await screen.findByText(flow.flattenConfirmBody)).toBeTruthy();
    expect(document.body.textContent).not.toContain("campos de formulario");
  });

  it("con formularios o marcadores la confirmacion lo dice: «se pierden campos de formulario y marcadores del documento»", async () => {
    render(<Harness flattenLoss={{ forms: true, outlines: true }} />);
    await waitFor(() => expect(region("p0-b1")).not.toBeNull());
    fireEvent.click(toggle());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "Aplanar convierte la página en imagen: se pierden campos de formulario y marcadores del documento.",
    );
  });

  it("cancelar no cambia nada", async () => {
    await mount();
    fireEvent.click(toggle());
    fireEvent.click(await screen.findByRole("button", { name: flow.flattenCancel }));
    expect(flattenItems()).toHaveLength(0);
    expect(live.canUndo).toBe(false);
  });

  it("confirmar anade UN aplanado de la pagina visible, con indicador en la hoja y anuncio", async () => {
    await mount();
    fireEvent.click(toggle());
    await confirmFlatten();
    await waitFor(() => expect(flattenItems()).toHaveLength(1));
    expect(flattenItems()[0]).toMatchObject({ kind: "flatten", pageIndex: 0 });
    expect(document.querySelector("[data-flatten-chip]")!.textContent).toBe(flow.flattenChip);
    expect(document.querySelector("[data-flatten-outline]")).not.toBeNull();
    expect(document.querySelector("[data-workspace-live]")!.textContent).toBe(flow.flattenedAnnounce(1));
    expect(live.pendingChangeCount).toBe(1);
  });

  it("el boton pasa a «Quitar aplanado» y lo desmarca; Deshacer tambien lo quita", async () => {
    await mount();
    fireEvent.click(toggle());
    await confirmFlatten();
    await waitFor(() => expect(flattenItems()).toHaveLength(1));
    expect(toggle().textContent).toContain(flow.unflattenAction);
    fireEvent.click(toggle());
    expect(flattenItems()).toHaveLength(0);
    expect(document.querySelector("[data-flatten-chip]")).toBeNull();
    expect(document.querySelector("[data-workspace-live]")!.textContent).toBe(flow.unflattenedAnnounce(1));
    // Deshacer el «quitar» lo vuelve a marcar; deshacer otra vez, no hay aplanado.
    act(() => live.undo());
    expect(document.querySelector("[data-flatten-chip]")).not.toBeNull();
    act(() => live.undo());
    expect(document.querySelector("[data-flatten-chip]")).toBeNull();
  });

  it("la marca es de LA PAGINA: en otra pagina no hay indicador y el boton vuelve a ofrecer aplanar", async () => {
    await mount();
    fireEvent.click(toggle());
    await confirmFlatten();
    await waitFor(() => expect(flattenItems()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Página siguiente" }));
    await waitFor(() => expect(document.querySelector("[data-page-index='1']")).not.toBeNull());
    expect(document.querySelector("[data-flatten-chip]")).toBeNull();
    expect(toggle().textContent).toContain(flow.flattenAction);
  });

  it("aplanar desde «Más»: cancelar devuelve el foco a «Más»; confirmar lo deja en el control de pagina aplanada (nunca en <body>)", async () => {
    await mount();
    click(region("p0-b1"));
    // Cancelar.
    fireEvent.click((await openMore()).querySelector('[data-more-action="flatten"]')!);
    let dialog = await screen.findByRole("dialog", { name: flow.flattenConfirmTitle(1) });
    fireEvent.click(within(dialog).getByRole("button", { name: flow.flattenCancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(bar()!.querySelector('[data-bar-action="more"]'));
    });
    // Confirmar.
    fireEvent.click((await openMore()).querySelector('[data-more-action="flatten"]')!);
    dialog = await screen.findByRole("dialog", { name: flow.flattenConfirmTitle(1) });
    fireEvent.click(within(dialog).getByRole("button", { name: flow.flattenConfirmAction }));
    await waitFor(() => expect(flattenItems()).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(toggle()), { timeout: 3000 });
  });

  it("el enlace «Aplanar pagina» de la barra del texto abre la misma confirmacion y desaparece si la pagina ya esta aplanada", async () => {
    await mount();
    click(region("p0-b1"));
    fireEvent.click((await openMore()).querySelector('[data-more-action="flatten"]')!);
    await confirmFlatten();
    await waitFor(() => expect(flattenItems()).toHaveLength(1));
    click(region("p0-b0"));
    const sheet = await openMore();
    expect(sheet.querySelector('[data-more-action="flatten"]')).toBeNull();
  });
});

describe("EditWorkspace — ajuste «editar el texto existente» apagado (W5-U5)", () => {
  it("los bloques del PDF no existen como regiones, se avisa y se ofrece Ajustes", async () => {
    render(<Harness existingText={false} />);
    await waitFor(() => expect(screen.getByTestId("host")).not.toBeNull());
    expect(region("p0-b1")).toBeNull();
    expect(document.querySelector("[data-analysis-status]")!.textContent).toBe(flow.existingTextOff);
    expect(document.querySelector("[data-settings-link]")!.getAttribute("href")).toBe("/settings");
  });

  it("siguen todas las herramientas de anadir: texto nuevo con la paleta", async () => {
    render(<Harness existingText={false} />);
    await waitFor(() => expect(screen.getByTestId("host")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: s.toolText }));
    const host = screen.getByTestId("host");
    fireEvent.pointerDown(host, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(host, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 200 });
    await waitFor(() => expect(editor()).not.toBeNull());
  });

  it("encendido, el aviso del ajuste no aparece", async () => {
    await mount();
    expect(document.querySelector("[data-settings-link]")).toBeNull();
    expect(document.querySelector("[data-analysis-status]")!.textContent).toBe("");
  });
});

describe("EditWorkspace — fondo no uniforme y borrador (W5-U5)", () => {
  it("la edicion que nace de un bloque con fondo NO uniforme lo anota en su cobertura (aviso al exportar)", async () => {
    mocks.sample = { color: "#e0e0e0", uniform: false, outliers: 0.4, samples: 100 };
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Cambiado");
    const edit = textItems()[0].edit;
    expect(edit.cover).toMatchObject({ color: "#e0e0e0", uniform: false });
  });

  it("con fondo liso la cobertura no lleva la marca", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Cambiado");
    expect(textItems()[0].edit.cover.uniform).toBeUndefined();
  });

  it("elegir a mano el color del fondo retira la marca de no uniforme", async () => {
    mocks.sample = { color: "#e0e0e0", uniform: false, outliers: 0.4, samples: 100 };
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Cambiado");
    act(() => live.dispatch({ type: "restyle", id: textItems()[0].id, patch: { cover: { color: "#ffffff", padding: 1 } } }));
    expect(textItems()[0].edit.cover.uniform).toBeUndefined();
  });

  it("avisa de la pagina visible y del total para el borrador, y una pagina restaurada fuera de rango cae a la ultima", async () => {
    const onPageChange = vi.fn();
    render(<Harness onPageChange={onPageChange} initialPage={9} />);
    await waitFor(() => expect(onPageChange).toHaveBeenCalled());
    expect(onPageChange).toHaveBeenLastCalledWith(1, 2);
    expect(document.querySelector("[data-page-index='1']")).not.toBeNull();
  });
});

describe("EditWorkspace — fondo de un texto girado (W5-U5)", () => {
  const ROTATED = makeBlock("p0-b5", {
    text: "Girado",
    rotation: 30,
    box: { x: 100, y: 500, width: 90, height: 60 },
    lines: [{ text: "Girado", box: { x: 100, y: 500, width: 90, height: 60 }, baseline: 520, origin: { x: 110, y: 505 }, length: 70 }],
    orientedBox: { origin: { x: 110, y: 505 }, width: 70, height: 14 },
  });

  it("un bloque girado un angulo libre muestrea el anillo pegado al CUADRILATERO orientado (4 esquinas)", async () => {
    mocks.texts[0] = ready([ROTATED]);
    render(<Harness />);
    await waitFor(() => expect(region("p0-b5")).not.toBeNull());
    click(region("p0-b5"));
    const quad = mocks.quads.at(-1) as Array<{ x: number; y: number }> | undefined;
    expect(quad).toHaveLength(4);
    // Las esquinas no son las de la caja del eje: el cuadrilatero esta girado.
    const xs = new Set(quad!.map((p) => Math.round(p.x * 10)));
    expect(xs.size).toBe(4);
  });

  it("un bloque sin giro (o girado 90) NO manda cuadrilatero: se muestrea como siempre", async () => {
    await mount();
    click(region("p0-b1"));
    expect(mocks.sampled.length).toBeGreaterThan(0);
    expect(mocks.quads.at(-1)).toBeUndefined();
  });
});

describe("EditWorkspace — avisos en vivo y anuncios (W5-U5 · N4/N5)", () => {
  it("Alt + flechas sobre un bloque anuncia su tamano nuevo", async () => {
    await mount();
    click(region("p0-b1"));
    fireEvent.keyDown(region("p0-b1"), { key: "ArrowRight", altKey: true, shiftKey: true });
    await waitFor(() => expect(document.querySelector("[data-workspace-live]")!.textContent).toMatch(/^Tamaño: \d+ × \d+ pt\.$/));
  });

  it("deshacer un cambio de texto se anuncia con lo que era", async () => {
    await mount();
    dblclick(region("p0-b1"));
    typeInto("Cambiado");
    act(() => live.undo());
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-live]")!.textContent).toBe("Deshecho: cambio de texto en “Cambiado”."),
    );
    act(() => live.redo());
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-live]")!.textContent).toBe("Rehecho: cambio de texto en “Cambiado”."),
    );
  });

  it("deshacer un texto nuevo dice «texto nuevo» (no «añadir texto»)", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: s.toolText }));
    const host = screen.getByTestId("host");
    host.getBoundingClientRect = () => ({ left: 0, top: 0, right: 595, bottom: 842, width: 595, height: 842, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(host, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(host, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
    await waitFor(() => expect(editor()).not.toBeNull());
    typeInto("Hola");
    fireEvent.keyDown(editor()!, { key: "Enter", ctrlKey: true });
    expect(textItems().some((item) => item.edit.blockId === undefined)).toBe(true);
    act(() => live.undo());
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-live]")!.textContent).toBe("Deshecho: texto nuevo."),
    );
  });

  it("deshacer el borrado de un texto cita el texto", async () => {
    await mount();
    click(region("p0-b1"));
    fireEvent.click(barButton(s.remove));
    act(() => live.undo());
    await waitFor(() =>
      expect(document.querySelector("[data-workspace-live]")!.textContent).toMatch(/^Deshecho: borrado de “.+”\.$/),
    );
  });

  it("un texto que invade a un bloque vecino lo avisa en la barra MIENTRAS se edita (no solo al descargar)", async () => {
    await mount();
    const edit = makeEdit({
      id: "ov",
      box: { x: 50, y: 600, width: 120, height: 16 },
      obstacles: [{ id: "p0-b0", box: { x: 50, y: 590, width: 200, height: 30 } }],
    });
    act(() => live.dispatch({ type: "add", item: textItem(edit) }));
    await waitFor(() => expect(region("ov")).not.toBeNull());
    click(region("ov"));
    await openMore();
    await waitFor(() => expect(noticeText("overlap")).toBe(s.overlapNotice));
  });

  it("sin vecinos que invadir no hay aviso", async () => {
    await mount();
    act(() => live.dispatch({ type: "add", item: textItem(makeEdit({ id: "free", box: { x: 50, y: 300, width: 120, height: 16 } })) }));
    await waitFor(() => expect(region("free")).not.toBeNull());
    click(region("free"));
    await waitFor(() => expect(bar()).not.toBeNull());
    await openMore();
    expect(noticeText("overlap")).toBeNull();
  });
});
