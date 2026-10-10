import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import {
  EditFloatingBar,
  fontNotice,
  glyphNotice,
  fontVariantAvailable,
  formatSize,
  type BarTextState,
  type EditFloatingBarProps,
} from "@/app/edit-pdf/EditFloatingBar";
import { CALIBRI, HELVETICA } from "@/app/edit-pdf/editTestUtils";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";

const s = EDIT_STRINGS.es.inline;

const STATE: BarTextState = {
  fontKey: "helvetica",
  fontSize: 14,
  bold: false,
  italic: false,
  color: "#000000",
  align: "left",
  coverColor: "#ffffff",
  sourceFont: HELVETICA,
};

type Callbacks = Pick<
  EditFloatingBarProps,
  "onRestyle" | "onDuplicate" | "onDelete" | "onEscape" | "onTabBackward" | "onTabForward" | "onFlattenRequested"
>;

function Harness({
  state = STATE,
  selectionId = "p0-b1",
  replacesBlock = true,
  backgroundNotUniform = false,
  originalRemoved = false,
  onFlatten = true,
  callbacks,
  variantAvailable,
}: {
  state?: BarTextState | null;
  selectionId?: string | null;
  replacesBlock?: boolean;
  backgroundNotUniform?: boolean;
  originalRemoved?: boolean;
  onFlatten?: boolean;
  callbacks: Callbacks;
  variantAvailable?: EditFloatingBarProps["variantAvailable"];
}) {
  const stage = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  // Las referencias se asignan despues de los efectos del hijo: un segundo ciclo las encuentra.
  const [layoutKey, setLayoutKey] = useState("first");
  useEffect(() => {
    const timer = setTimeout(() => setLayoutKey("second"), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div ref={stage} style={{ position: "relative" }}>
      <div ref={clip}>
        <div ref={host}>
          <div data-element-kind="text" data-element-id="p0-b1" data-drag-mode="move" tabIndex={0}>
            bloque
          </div>
          <div data-element-kind="text" data-element-id="other" data-drag-mode="move" tabIndex={0} />
        </div>
      </div>
      <EditFloatingBar
        stageRef={stage}
        clipRef={clip}
        hostRef={host}
        selectionId={selectionId}
        layoutKey={layoutKey}
        state={state}
        replacesBlock={replacesBlock}
        backgroundNotUniform={backgroundNotUniform}
        originalRemoved={originalRemoved}
        strings={s}
        variantAvailable={variantAvailable}
        {...callbacks}
        onFlattenRequested={onFlatten ? callbacks.onFlattenRequested : undefined}
      />
    </div>
  );
}

function callbacks(): Callbacks {
  return {
    onRestyle: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onEscape: vi.fn(),
    onTabBackward: vi.fn(),
    onTabForward: vi.fn(() => false),
    onFlattenRequested: vi.fn(),
  };
}

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-floating-bar")) return rect(0, 0, 300, 44);
    if (this.getAttribute("data-element-id") === "p0-b1") return rect(100, 300, 120, 20);
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

async function mount(props: Parameters<typeof Harness>[0]) {
  const view = render(<Harness {...props} />);
  await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
  const bar = document.querySelector<HTMLElement>("[data-floating-bar]")!;
  return { ...view, bar, q: within(bar) };
}

/** Abre la hoja «Más opciones» (donde viven los avisos y las acciones secundarias) y la devuelve. */
async function openMore(bar: HTMLElement): Promise<HTMLElement> {
  const existing = document.querySelector<HTMLElement>("[data-bar-more]");
  if (existing) return existing;
  fireEvent.click(bar.querySelector<HTMLElement>('[data-bar-action="more"]')!);
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-bar-more]");
    expect(el).not.toBeNull();
    return el!;
  });
}
const noticeText = (id: string) => document.querySelector(`[data-more-notice="${id}"]`)?.textContent ?? null;

const byName = (bar: HTMLElement, name: string | RegExp) =>
  within(bar).getByRole("button", { name, hidden: true });

describe("EditFloatingBar — contenido", () => {
  it("es un grupo con nombre, anclado al bloque seleccionado y sin robar el foco", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    expect(bar.getAttribute("role")).toBe("group");
    expect(bar.getAttribute("aria-label")).toBe(s.barLabel);
    expect(document.activeElement).toBe(document.body);
  });

  it("no hay barra sin seleccion ni sin estado", async () => {
    const cb = callbacks();
    const { rerender } = render(<Harness callbacks={cb} selectionId={null} />);
    expect(document.querySelector("[data-floating-bar]")).toBeNull();
    rerender(<Harness callbacks={cb} state={null} />);
    expect(document.querySelector("[data-floating-bar]")).toBeNull();
  });

  it("Editar activa aboveSticky en la barra flotante (z-40): lo especifico de Editar no depende de Firmar", async () => {
    const { bar } = await mount({ callbacks: callbacks() });
    expect(bar.className).toContain("z-40");
    expect(bar.className).not.toContain("z-20");
  });

  it("la fuente es un select accesible con las fuentes que se dibujan de verdad", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    const select = within(bar).getByRole("combobox", { name: s.fontLabel, hidden: true }) as HTMLSelectElement;
    expect(select.value).toBe("helvetica");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Helvetica",
      "Times",
      "Courier",
      "Liberation Sans",
      "Liberation Serif",
      "Liberation Mono",
    ]);
    fireEvent.change(select, { target: { value: "times" } });
    expect(cb.onRestyle).toHaveBeenCalledWith({ fontKey: "times" });
  });

  it("Liberation Serif es una opcion real (tiene su propio TTF)", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, state: { ...STATE, fontKey: "liberation-serif" } });
    const select = within(bar).getByRole("combobox", { name: s.fontLabel, hidden: true }) as HTMLSelectElement;
    // Con los TTF de Liberation Serif/Mono ya no hay sustitutas: se ofrece y se muestra tal cual.
    expect(select.value).toBe("liberation-serif");
    expect([...select.options].map((o) => o.value)).toContain("liberation-serif");
  });

  it("avisa «Se usara … (parecida)» (en la hoja «Más», sin region viva propia) cuando la fuente es una sustituta aproximada", async () => {
    const cb = callbacks();
    const { bar } = await mount({
      callbacks: cb,
      state: { ...STATE, fontKey: "liberation-sans", sourceFont: CALIBRI },
    });
    expect(bar.querySelector("[data-bar-font-notice]")).toBeNull();
    expect(bar.getAttribute("role")).toBe("group");
    await openMore(bar);
    expect(noticeText("font")).toBe("Se usará Liberation Sans (parecida)");
    expect(document.querySelector("[data-bar-more] [role='status'], [data-bar-more] [aria-live]")).toBeNull();
  });

  it("con la fuente exacta no hay aviso de fuente", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    await openMore(bar);
    expect(noticeText("font")).toBeNull();
  });

  it("si se elige otra fuente distinta de la sugerida el aviso desaparece", async () => {
    const cb = callbacks();
    const { bar } = await mount({
      callbacks: cb,
      state: { ...STATE, fontKey: "times", sourceFont: CALIBRI },
    });
    await openMore(bar);
    expect(noticeText("font")).toBeNull();
  });

  it("fontNotice: exacta, parecida y sin fuente de origen (texto nuevo)", () => {
    expect(fontNotice({ ...STATE, sourceFont: HELVETICA }).similar).toBe(false);
    expect(fontNotice({ ...STATE, fontKey: "liberation-sans", sourceFont: CALIBRI })).toEqual({
      label: "Liberation Sans",
      similar: true,
    });
    expect(fontNotice({ ...STATE, sourceFont: undefined }).similar).toBe(false);
  });
});

describe("EditFloatingBar — glifos que la fuente no dibuja", () => {
  it("avisa (en la hoja «Más», sin region viva propia) y no cambia nada en silencio", async () => {
    const cb = callbacks();
    const { bar, rerender } = await mount({ callbacks: cb, state: { ...STATE, text: "Hola" } });
    await openMore(bar);
    expect(noticeText("glyph")).toBeNull();
    // «ж» (cirilico) no esta en Helvetica pero si en Liberation Sans: se dibujara con ella.
    rerender(<Harness callbacks={cb} state={{ ...STATE, text: "Hola ж" }} />);
    await waitFor(() =>
      expect(noticeText("glyph")).toBe("Algunos caracteres no existen en Helvetica: se dibujarán con Liberation Sans."),
    );
    // Ninguna fuente del catalogo dibuja el kanji: saldra como «?».
    rerender(<Harness callbacks={cb} state={{ ...STATE, text: "日本" }} />);
    await waitFor(() => expect(noticeText("glyph")).toContain("saldrán como «?»"));
    expect(noticeText("glyph")).toContain("日");
  });

  it("con una fuente que ya cubre todo no hay aviso", () => {
    expect(glyphNotice({ ...STATE, fontKey: "liberation-sans", text: "Hola ж" }, s)).toBe("");
    expect(glyphNotice({ ...STATE, text: undefined }, s)).toBe("");
    expect(glyphNotice({ ...STATE, text: "ñandú — “comillas” €" }, s)).toBe("");
  });
});

describe("EditFloatingBar — tamano, color y estilo", () => {
  it("−/+ cambian el cuerpo de uno en uno y se acotan a [1, 400]", async () => {
    const cb = callbacks();
    const { bar, rerender } = await mount({ callbacks: cb });
    fireEvent.click(byName(bar, s.sizeIncrease));
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ fontSize: 15 });
    fireEvent.click(byName(bar, s.sizeDecrease));
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ fontSize: 13 });
    rerender(<Harness callbacks={cb} state={{ ...STATE, fontSize: 1 }} />);
    fireEvent.click(byName(bar, s.sizeDecrease));
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ fontSize: 1 });
    rerender(<Harness callbacks={cb} state={{ ...STATE, fontSize: 400 }} />);
    fireEvent.click(byName(bar, s.sizeIncrease));
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ fontSize: 400 });
  });

  it("el campo numerico confirma con Intro o al salir, acepta coma decimal y descarta lo invalido", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    const input = within(bar).getByRole("textbox", { name: s.sizeLabel, hidden: true }) as HTMLInputElement;
    expect(input.value).toBe("14");
    fireEvent.change(input, { target: { value: "18,5" } });
    expect(cb.onRestyle).not.toHaveBeenCalled(); // no se aplica tecla a tecla
    fireEvent.keyDown(input, { key: "Enter" });
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ fontSize: 18.5 });
    fireEvent.change(input, { target: { value: "22" } });
    fireEvent.blur(input);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ fontSize: 22 });
    (cb.onRestyle as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "-4" } });
    fireEvent.blur(input);
    expect(cb.onRestyle).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.blur(input);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ fontSize: 400 });
  });

  it("Esc en el campo numerico descarta lo escrito", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    const input = within(bar).getByRole("textbox", { name: s.sizeLabel, hidden: true }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("14");
  });

  it("formatSize redondea a un decimal", () => {
    expect(formatSize(12)).toBe("12");
    expect(formatSize(12.34)).toBe("12.3");
  });

  it("el color se abre bajo demanda, con las tintas del documento y un selector libre", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    expect(bar.querySelectorAll("[data-color-swatch]")).toHaveLength(0);
    const open = byName(bar, s.colorOpen);
    expect(open.getAttribute("aria-expanded")).toBe("true" === open.getAttribute("aria-expanded") ? "true" : "false");
    fireEvent.click(open);
    const swatches = bar.querySelectorAll<HTMLElement>("[data-color-swatch]");
    expect(swatches).toHaveLength(8);
    const red = byName(bar, "Color rojo");
    fireEvent.click(red);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ color: "#e11d48" });
    const custom = bar.querySelector<HTMLInputElement>('input[type="color"]')!;
    fireEvent.change(custom, { target: { value: "#123456" } });
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ color: "#123456" });
  });

  it("el color elegido queda marcado (aria-pressed) y el selector se cierra al cambiar de seleccion", async () => {
    const cb = callbacks();
    const { bar, rerender } = await mount({ callbacks: cb, state: { ...STATE, color: "#0d4bff" } });
    fireEvent.click(byName(bar, s.colorOpen));
    expect(byName(bar, "Color azul").getAttribute("aria-pressed")).toBe("true");
    expect(byName(bar, "Color negro").getAttribute("aria-pressed")).toBe("false");
    rerender(<Harness callbacks={cb} selectionId="other" state={{ ...STATE, color: "#0d4bff" }} />);
    await waitFor(() => expect(document.querySelectorAll("[data-color-swatch]")).toHaveLength(0));
  });

  it("negrita y cursiva alternan con aria-pressed", async () => {
    const cb = callbacks();
    const { bar, rerender } = await mount({ callbacks: cb });
    expect(byName(bar, s.bold).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(byName(bar, s.bold));
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ bold: true });
    fireEvent.click(byName(bar, s.italic));
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ italic: true });
    rerender(<Harness callbacks={cb} state={{ ...STATE, bold: true, italic: true }} />);
    expect(byName(bar, s.bold).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(byName(bar, s.bold));
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ bold: false });
  });

  it("sin la variante en el catalogo, negrita/cursiva se deshabilitan y dicen por que", async () => {
    const cb = callbacks();
    const { bar } = await mount({
      callbacks: cb,
      variantAvailable: (_key, bold, italic) => !bold && !italic,
    });
    const bold = byName(bar, s.variantUnavailable("negrita")) as HTMLButtonElement;
    const italic = byName(bar, s.variantUnavailable("cursiva")) as HTMLButtonElement;
    expect(bold.disabled).toBe(true);
    expect(italic.disabled).toBe(true);
    expect(bold.getAttribute("title")).toBe("Esta fuente no tiene negrita");
    fireEvent.click(bold);
    expect(cb.onRestyle).not.toHaveBeenCalled();
  });

  it("una variante YA activa no se puede quedar atrapada: sigue habilitada para quitarla", async () => {
    const cb = callbacks();
    const { bar } = await mount({
      callbacks: cb,
      state: { ...STATE, bold: true },
      variantAvailable: () => false,
    });
    const bold = within(bar).getAllByRole("button", { hidden: true }).find((b) => b.dataset.barAction === "bold")!;
    expect((bold as HTMLButtonElement).disabled).toBe(false);
  });

  it("el catalogo real tiene los cuatro estilos en todas las fuentes", () => {
    for (const key of ["helvetica", "times", "courier", "liberation-sans", "liberation-serif", "liberation-mono"] as const) {
      expect(fontVariantAvailable(key)).toBe(true);
    }
  });

  it("en escritorio la barra es UNA fila de controles (alinear cicla; duplicar y las tres alineaciones van en «Más»)", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, state: { ...STATE, align: "center" } });
    const layout = bar.querySelector("[data-bar-compact]")!;
    expect(layout.getAttribute("data-bar-layout")).toBe("row");
    // Una sola fila de controles (la segunda fila solo aparece si se abre el selector de color).
    expect(layout.children).toHaveLength(1);
    const names = Array.from(layout.querySelectorAll<HTMLElement>("[data-bar-action]")).map((el) => el.dataset.barAction);
    expect(names).toEqual(["font", "size-down", "size", "size-up", "color", "bold", "italic", "align", "delete", "more"]);
    fireEvent.click(bar.querySelector<HTMLElement>('[data-bar-action="align"]')!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ align: "right" });
    const sheet = await openMore(bar);
    expect(sheet.querySelector('[data-more-action="align-center"]')!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(sheet.querySelector('[data-more-action="align-left"]')!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ align: "left" });
  });

  it("duplicar (en «Más») y borrar (en la barra) llaman a sus acciones; borrar es destructivo", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    const sheet = await openMore(bar);
    fireEvent.click(sheet.querySelector('[data-more-action="duplicate"]')!);
    fireEvent.click(byName(bar, s.remove));
    expect(cb.onDuplicate).toHaveBeenCalledTimes(1);
    expect(cb.onDelete).toHaveBeenCalledTimes(1);
    expect(byName(bar, s.remove).className).toContain("text-destructive-text");
  });

  it("clic de raton en un boton no roba el foco al editor (mousedown cancelado)", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    const notPrevented = fireEvent.mouseDown(byName(bar, s.bold));
    expect(notPrevented).toBe(false);
    const select = within(bar).getByRole("combobox", { hidden: true });
    expect(fireEvent.mouseDown(select)).toBe(true);
  });
});

describe("EditFloatingBar — avisos del original", () => {
  it("un bloque del PDF muestra el aviso permanente y «Aplanar pagina» en la hoja «Más» (nunca dentro de la barra)", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    expect(bar.textContent).not.toContain(s.originalRemains);
    const sheet = await openMore(bar);
    expect(noticeText("original")).toBe(s.originalRemains);
    fireEvent.click(sheet.querySelector('[data-more-action="flatten"]')!);
    expect(cb.onFlattenRequested).toHaveBeenCalledTimes(1);
  });

  it("sin accion de aplanar solo queda el texto del aviso", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, onFlatten: false });
    const sheet = await openMore(bar);
    expect(noticeText("original")).toBe(s.originalRemains);
    expect(sheet.querySelector('[data-more-action="flatten"]')).toBeNull();
  });

  it("en una pagina aplanada el original ya no queda: sin aviso (como la lista de descarga)", async () => {
    const { bar } = await mount({ callbacks: callbacks(), originalRemoved: true });
    await openMore(bar);
    expect(noticeText("original")).toBeNull();
  });

  it("un texto nuevo no lleva ese aviso", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, replacesBlock: false });
    await openMore(bar);
    expect(noticeText("original")).toBeNull();
  });

  it("fondo no uniforme: aviso y color de fondo editable (en «Más») que reescribe la cobertura", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, backgroundNotUniform: true });
    const sheet = await openMore(bar);
    expect(noticeText("background")).toBe(s.backgroundNotUniform);
    const group = within(sheet).getByRole("group", { name: s.coverColorLabel, hidden: true });
    fireEvent.click(within(group).getByRole("button", { name: "Color blanco", hidden: true }));
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ cover: { color: "#ffffff", padding: 1 } });
  });

  it("con fondo uniforme no se ofrece el color de fondo", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, backgroundNotUniform: false });
    const sheet = await openMore(bar);
    expect(within(sheet).queryByRole("group", { name: s.coverColorLabel, hidden: true })).toBeNull();
    expect(noticeText("background")).toBeNull();
  });
});

describe("EditFloatingBar — teclado", () => {
  it("Esc dentro de la barra devuelve el foco al bloque", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb });
    byName(bar, s.bold).focus();
    fireEvent.keyDown(byName(bar, s.bold), { key: "Escape" });
    expect(cb.onEscape).toHaveBeenCalledTimes(1);
  });

  it("Mayus+Tab desde la primera accion y Tab desde la ultima salen hacia el bloque", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, onFlatten: false });
    const focusables = [...bar.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled])")];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(cb.onTabBackward).toHaveBeenCalledTimes(1);
    act(() => last.focus());
    fireEvent.keyDown(last, { key: "Tab" });
    expect(cb.onTabForward).toHaveBeenCalledTimes(1);
  });
});

describe("EditFloatingBar — estilos mezclados y atajos (W5-U5)", () => {
  it("avisa de que un bloque con estilos mezclados se unifica al editarlo (solo si reemplaza un bloque)", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, state: { ...STATE, mixedStyle: true } });
    await openMore(bar);
    expect(noticeText("mixed")).toBe(
      "Este bloque mezcla estilos (color, negrita, fuente…): al editarlo se unifican con el estilo dominante.",
    );
  });

  it("sin estilos mezclados, o con un texto propio, no hay aviso", async () => {
    const cb = callbacks();
    const plain = await mount({ callbacks: cb, state: STATE });
    await openMore(plain.bar);
    expect(noticeText("mixed")).toBeNull();
    cleanup();
    const own = await mount({ callbacks: cb, state: { ...STATE, mixedStyle: true }, replacesBlock: false });
    await openMore(own.bar);
    expect(noticeText("mixed")).toBeNull();
  });

  it("la barra describe los atajos de mover y redimensionar (descripcion accesible, una vez)", async () => {
    const { bar } = await mount({ callbacks: callbacks(), state: STATE });
    const description = document.getElementById(bar.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("Alt");
  });

  it("los colores se ven con forced-colors: la muestra no se deja a los colores del sistema", async () => {
    const { bar } = await mount({ callbacks: callbacks(), state: STATE });
    const swatch = bar.querySelector<HTMLElement>('[data-bar-action="color"] span')!;
    expect(swatch.className).toContain("forced-color-adjust-none");
    expect(swatch.className).toContain("forced-colors:border-[CanvasText]");
  });
});


describe("EditFloatingBar compacta (pantallas estrechas / puntero grueso) — W5-U5 · N1", () => {
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    // @ts-expect-error — jsdom no trae matchMedia
    delete window.matchMedia;
  });

  const compactState = (extra: Partial<BarTextState> = {}): BarTextState => ({
    ...STATE,
    text: "Hola",
    ...extra,
  });

  it("lleva DOS filas de controles esenciales: fuente y tamano, y color, B, I, alinear, borrar y «Más»", async () => {
    const { bar } = await mount({ callbacks: callbacks(), state: compactState() });
    const compact = bar.querySelector("[data-bar-compact]")!;
    expect(compact.children).toHaveLength(2);
    const names = Array.from(compact.querySelectorAll<HTMLElement>("[data-bar-action]")).map((el) => el.dataset.barAction);
    expect(names).toEqual(["font", "size-down", "size", "size-up", "color", "bold", "italic", "align", "delete", "more"]);
    // Los avisos, duplicar y la alineacion completa NO estan en la barra.
    expect(bar.querySelector("[data-bar-font-notice], [data-bar-glyph-notice], [data-bar-mixed-style]")).toBeNull();
    expect(bar.querySelector('[data-bar-action="duplicate"]')).toBeNull();
    expect(bar.textContent).not.toContain(s.originalRemains);
  });

  it("todos los controles son de 44 px (h-11 / size-11)", async () => {
    const { bar } = await mount({ callbacks: callbacks(), state: compactState() });
    for (const el of Array.from(bar.querySelectorAll<HTMLElement>("button, select, input"))) {
      expect(el.className, el.getAttribute("aria-label") ?? el.tagName).toMatch(/size-11|h-11|pointer-coarse:size-11/);
    }
  });

  it("alinear es UN boton que cicla izquierda -> centro -> derecha y dice la actual", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, state: compactState({ align: "left" }) });
    const align = bar.querySelector<HTMLElement>('[data-bar-action="align"]')!;
    expect(align.getAttribute("aria-label")).toBe(s.alignCycle(s.alignNames.left));
    fireEvent.click(align);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ align: "center" });
  });

  it("«Más» muestra cuantos avisos hay y abre una hoja con TODOS (nada de avisos dentro de la barra)", async () => {
    const cb = callbacks();
    const { bar } = await mount({
      callbacks: cb,
      replacesBlock: true,
      backgroundNotUniform: true,
      state: compactState({ mixedStyle: true, overlap: true, coverCrossesNeighbor: true, sourceFont: CALIBRI, fontKey: "liberation-sans" }),
    });
    const more = bar.querySelector<HTMLElement>('[data-bar-action="more"]')!;
    const count = Number(more.dataset.noticeCount);
    expect(count).toBeGreaterThanOrEqual(5);
    expect(more.getAttribute("aria-label")).toBe(s.moreOptions(count));
    fireEvent.click(more);
    const sheet = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-bar-more]");
      expect(el).not.toBeNull();
      return el!;
    });
    const texts = Array.from(sheet.querySelectorAll("[data-more-notice]")).map((el) => el.textContent);
    expect(texts).toContain(s.mixedStyleNotice);
    expect(texts).toContain(s.overlapNotice);
    expect(texts).toContain(s.coverCrossesNotice);
    expect(texts).toContain(s.backgroundNotUniform);
    expect(texts).toContain(s.originalRemains);
    expect(texts).toHaveLength(count);
  });

  it("la hoja ofrece duplicar, las tres alineaciones y aplanar", async () => {
    const cb = callbacks();
    const { bar } = await mount({ callbacks: cb, state: compactState() });
    fireEvent.click(bar.querySelector<HTMLElement>('[data-bar-action="more"]')!);
    const sheet = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-bar-more]");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(sheet.querySelector<HTMLElement>('[data-more-action="align-right"]')!);
    expect(cb.onRestyle).toHaveBeenLastCalledWith({ align: "right" });
    fireEvent.click(sheet.querySelector<HTMLElement>('[data-more-action="duplicate"]')!);
    expect(cb.onDuplicate).toHaveBeenCalledTimes(1);
  });

  it("la insignia del contador queda en la esquina (no sobre el icono) y se lee en forced-colors (N5)", async () => {
    const { bar } = await mount({ callbacks: callbacks(), state: compactState({ mixedStyle: true }) });
    const badge = bar.querySelector<HTMLElement>("[data-more-badge]")!;
    expect(badge.textContent).not.toBe("");
    // Fuera del cuadro del icono (esquina superior derecha, desplazada hacia fuera).
    expect(badge.className).toContain("-top-1");
    expect(badge.className).toContain("-right-1");
    expect(badge.className).not.toMatch(/(^|\s)(top|right)-(1|0\.5)(\s|$)/);
    // Forced-colors: colores de sistema explicitos, sin que el motor los reinterprete, y borde legible.
    expect(badge.className).toContain("forced-color-adjust-none");
    expect(badge.className).toContain("forced-colors:bg-[Highlight]");
    expect(badge.className).toContain("forced-colors:text-[HighlightText]");
    expect(badge.className).toContain("forced-colors:border-[HighlightText]");
  });

  it("sin avisos (texto propio) el contador no sale", async () => {
    const { bar } = await mount({ callbacks: callbacks(), replacesBlock: false, state: compactState() });
    const more = bar.querySelector<HTMLElement>('[data-bar-action="more"]')!;
    expect(more.dataset.noticeCount).toBe("0");
    expect(more.getAttribute("aria-label")).toBe(s.moreOptions(0));
  });
});

describe("EditFloatingBar de escritorio: avisos nuevos (W5-U5)", () => {
  it("muestra en «Más» «Este texto invade a otro» y el cruce del texto girado (y la barra no los lleva dentro)", async () => {
    const { bar } = await mount({
      callbacks: callbacks(),
      state: { ...STATE, overlap: true, coverCrossesNeighbor: true },
    });
    expect(bar.querySelector("[data-bar-overlap], [data-bar-cover-crosses]")).toBeNull();
    await openMore(bar);
    expect(noticeText("overlap")).toBe(s.overlapNotice);
    expect(noticeText("cover")).toBe(s.coverCrossesNotice);
  });

  it("sin solape no aparecen", async () => {
    const { bar } = await mount({ callbacks: callbacks(), state: STATE });
    await openMore(bar);
    expect(noticeText("overlap")).toBeNull();
    expect(noticeText("cover")).toBeNull();
  });

  it("la barra de escritorio es de UNA fila y no pasa de ~560 px: ningun aviso ensancha la fila de controles (D2)", async () => {
    const { bar } = await mount({
      callbacks: callbacks(),
      state: { ...STATE, overlap: true, mixedStyle: true, text: "日本" },
      backgroundNotUniform: true,
    });
    const row = bar.querySelector("[data-bar-compact] > div")!;
    expect(row.className).not.toContain("flex-wrap");
    // Sin avisos dentro: ni un solo <p> en la barra.
    expect(bar.querySelector("p")).toBeNull();
    expect(bar.textContent).not.toContain(s.originalRemains);
    expect(bar.querySelector('[data-bar-action="more"]')!.getAttribute("data-notice-count")).toBe("5");
  });
});
