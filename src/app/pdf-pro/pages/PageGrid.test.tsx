import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PageGrid, edgeScrollSpeed, type GridCommand, type GridItem, type PageGridHandle } from "@/app/pdf-pro/pages/PageGrid";
import { computeGrid, itemPosition } from "@/app/pdf-pro/pages/pagesLayout";

const STRINGS = {
  dragHandle: "Arrastrar",
  dragStart: (n: number) => `Arrastrando ${n}`,
  dragCancel: "Cancelado",
  loading: "Cargando",
};

const makeItems = (count: number): GridItem[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    number: index + 1,
    kind: "existing" as const,
    rotation: 0,
    aspect: 0.75,
    thumb: `data:image/png;base64,${index}`,
    detail: "",
    ariaLabel: `Pagina ${index + 1} de ${count}`,
  }));

type Recorded = {
  commands: GridCommand[];
  drops: { ids: string[]; insertBefore: number }[];
  announcements: string[];
  selections: string[][];
};

function Harness({
  count = 8,
  items: given,
  recorded,
  draggable = true,
  initialSelection = [],
  handleRef,
  withCommands = true,
}: {
  count?: number;
  items?: GridItem[];
  recorded: Recorded;
  draggable?: boolean;
  initialSelection?: string[];
  handleRef?: { current: PageGridHandle | null };
  withCommands?: boolean;
}) {
  const items = given ?? makeItems(count);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set(initialSelection));
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const internal = useRef<PageGridHandle>(null);
  return (
    <PageGrid
      ref={(value) => {
        internal.current = value;
        if (handleRef) handleRef.current = value;
      }}
      items={items}
      selection={selection}
      anchorId={anchor}
      focusId={focus}
      label="Paginas"
      strings={STRINGS}
      draggable={draggable}
      onSelectionChange={(ids, nextAnchor, nextFocus) => {
        recorded.selections.push(ids);
        setSelection(new Set(ids));
        setAnchor(nextAnchor);
        setFocus(nextFocus);
      }}
      onFocusChange={setFocus}
      onCommand={withCommands ? (command) => recorded.commands.push(command) : undefined}
      onDrop={(ids, insertBefore) => recorded.drops.push({ ids, insertBefore })}
      announce={(text) => recorded.announcements.push(text)}
    />
  );
}

const fresh = (): Recorded => ({ commands: [], drops: [], announcements: [], selections: [] });
const options = () => screen.getAllByRole("option");
const card = (index: number) => screen.getByRole("option", { name: new RegExp(`^Pagina ${index + 1} de`) });
const selectedIds = () => options().filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.getAttribute("data-page-id"));

afterEach(cleanup);

describe("PageGrid: estructura y accesibilidad", () => {
  it("es un listbox de seleccion multiple con nombre", () => {
    render(<Harness recorded={fresh()} />);
    const list = screen.getByRole("listbox", { name: "Paginas" });
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("cada pagina es una opcion con posicion y total (aria-posinset / aria-setsize)", () => {
    render(<Harness recorded={fresh()} count={6} />);
    const third = card(2);
    expect(third.getAttribute("aria-posinset")).toBe("3");
    expect(third.getAttribute("aria-setsize")).toBe("6");
  });

  it("solo UNA tarjeta esta en el orden de tabulacion (la primera por defecto)", () => {
    render(<Harness recorded={fresh()} />);
    const tabbable = options().filter((o) => o.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(card(0));
  });

  it("muestra la miniatura de cada tarjeta y el numero de pagina", () => {
    render(<Harness recorded={fresh()} count={3} />);
    expect(within(card(1)).getByText("2")).toBeTruthy();
    expect(card(1).querySelector("img")?.getAttribute("src")).toContain("base64,1");
  });

  it("sin miniatura muestra un marcador de carga con nombre accesible", () => {
    const items = makeItems(2).map((item) => ({ ...item, thumb: undefined }));
    render(<Harness recorded={fresh()} items={items} />);
    expect(within(card(0)).getByRole("img", { name: "Cargando" })).toBeTruthy();
  });

  it("una pagina girada se dibuja con su giro y muestra la insignia", () => {
    const items = makeItems(2);
    items[0] = { ...items[0], rotation: 90 };
    render(<Harness recorded={fresh()} items={items} />);
    const image = card(0).querySelector("img") as HTMLImageElement;
    expect(image.style.transform).toContain("rotate(90deg)");
    expect(card(0).textContent).toContain("90°");
  });

  it("una pagina en blanco se dibuja como hoja blanca sin imagen", () => {
    const items = makeItems(2);
    items[1] = { ...items[1], kind: "blank", thumb: undefined, detail: "en blanco" };
    render(<Harness recorded={fresh()} items={items} />);
    expect(card(1).querySelector("[data-blank]")).not.toBeNull();
    expect(card(1).querySelector("img")).toBeNull();
    expect(card(1).textContent).toContain("en blanco");
  });

  it("la tarjeta seleccionada lo dice con aria-selected y con un icono de marca", () => {
    render(<Harness recorded={fresh()} initialSelection={["p1"]} />);
    expect(card(1).getAttribute("aria-selected")).toBe("true");
    expect(card(1).querySelector("[data-check]")).not.toBeNull();
    expect(card(0).getAttribute("aria-selected")).toBe("false");
  });

  it("la seleccion se ve tambien con forced-colors (borde del sistema en la tarjeta)", () => {
    render(<Harness recorded={fresh()} initialSelection={["p0"]} />);
    expect(card(0).className).toContain("forced-colors:data-[selected=true]:border-[Highlight]");
  });

  it("las tarjetas llevan un asa de arrastre oculta a lectores y visible con puntero grueso", () => {
    render(<Harness recorded={fresh()} />);
    const handle = card(0).querySelector("[data-drag-handle]") as HTMLElement;
    expect(handle.getAttribute("aria-hidden")).toBe("true");
    expect(handle.className).toContain("pointer-coarse:size-11");
    expect(handle.className).toContain("touch-none");
  });

  it("sin arrastre no hay asa", () => {
    render(<Harness recorded={fresh()} draggable={false} />);
    expect(card(0).querySelector("[data-drag-handle]")).toBeNull();
  });
});

describe("PageGrid: virtualizacion", () => {
  it("con 500 paginas solo pinta unas decenas de tarjetas", () => {
    render(<Harness recorded={fresh()} count={500} />);
    expect(options().length).toBeGreaterThan(0);
    expect(options().length).toBeLessThan(60);
  });

  it("el contenido reserva el alto de las 500 paginas", () => {
    const { container } = render(<Harness recorded={fresh()} count={500} />);
    const content = container.querySelector("[data-pages-grid] > div") as HTMLElement;
    const metrics = computeGrid(360, 500);
    expect(parseFloat(content.style.height)).toBe(metrics.totalHeight);
  });

  it("al desplazarse se pintan otras tarjetas y se sueltan las lejanas", () => {
    const { container } = render(<Harness recorded={fresh()} count={500} />);
    const scroller = container.querySelector("[data-pages-grid]") as HTMLElement;
    const first = options()[0].getAttribute("data-page-id");
    act(() => {
      scroller.scrollTop = 20_000;
      fireEvent.scroll(scroller);
    });
    const ids = options().map((o) => o.getAttribute("data-page-id"));
    expect(ids).not.toContain(first);
    expect(options().length).toBeLessThan(60);
  });

  it("cada tarjeta se coloca en su posicion de cuadricula", () => {
    render(<Harness recorded={fresh()} count={10} />);
    const metrics = computeGrid(360, 10);
    const position = itemPosition(metrics, 3);
    expect((card(3) as HTMLElement).style.left).toBe(`${position.x}px`);
    expect((card(3) as HTMLElement).style.top).toBe(`${position.y}px`);
  });

  it("la tarjeta con el foco sigue pintada aunque se salga de la ventana", () => {
    const { container } = render(<Harness recorded={fresh()} count={500} />);
    act(() => card(0).focus());
    const scroller = container.querySelector("[data-pages-grid]") as HTMLElement;
    act(() => {
      scroller.scrollTop = 30_000;
      fireEvent.scroll(scroller);
    });
    expect(screen.getByRole("option", { name: /^Pagina 1 de/ })).toBeTruthy();
  });
});

describe("PageGrid: seleccion con raton", () => {
  it("un clic selecciona solo esa pagina", () => {
    render(<Harness recorded={fresh()} />);
    fireEvent.click(card(2));
    expect(selectedIds()).toEqual(["p2"]);
    fireEvent.click(card(4));
    expect(selectedIds()).toEqual(["p4"]);
  });

  it("Ctrl/Cmd+clic alterna sin perder las demas", () => {
    render(<Harness recorded={fresh()} />);
    fireEvent.click(card(1));
    fireEvent.click(card(3), { ctrlKey: true });
    expect(selectedIds()).toEqual(["p1", "p3"]);
    fireEvent.click(card(1), { metaKey: true });
    expect(selectedIds()).toEqual(["p3"]);
  });

  it("Mayus+clic selecciona el rango desde el ancla", () => {
    render(<Harness recorded={fresh()} />);
    fireEvent.click(card(1));
    fireEvent.click(card(4), { shiftKey: true });
    expect(selectedIds()).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("Mayus+clic hacia atras tambien da el rango", () => {
    render(<Harness recorded={fresh()} />);
    fireEvent.click(card(5));
    fireEvent.click(card(2), { shiftKey: true });
    expect(selectedIds()).toEqual(["p2", "p3", "p4", "p5"]);
  });

  it("Ctrl+Mayus+clic AMPLIA la seleccion con el rango", () => {
    render(<Harness recorded={fresh()} />);
    fireEvent.click(card(0));
    fireEvent.click(card(2), { ctrlKey: true });
    fireEvent.click(card(5), { ctrlKey: true, shiftKey: true });
    expect(selectedIds()).toEqual(["p0", "p2", "p3", "p4", "p5"]);
  });

  it("con el dedo, un toque ALTERNA la seleccion (sin modificadores)", () => {
    render(<Harness recorded={fresh()} />);
    fireEvent.pointerDown(card(1), { pointerType: "touch", pointerId: 1, isPrimary: true, button: 0 });
    fireEvent.click(card(1));
    fireEvent.pointerDown(card(3), { pointerType: "touch", pointerId: 1, isPrimary: true, button: 0 });
    fireEvent.click(card(3));
    expect(selectedIds()).toEqual(["p1", "p3"]);
    fireEvent.pointerDown(card(1), { pointerType: "touch", pointerId: 1, isPrimary: true, button: 0 });
    fireEvent.click(card(1));
    expect(selectedIds()).toEqual(["p3"]);
  });

  it("enfocar una tarjeta (clic o teclado) la marca como enfocada y la pone en el orden de tabulacion", () => {
    render(<Harness recorded={fresh()} />);
    act(() => card(3).focus());
    expect(card(3).getAttribute("tabindex")).toBe("0");
    expect(card(0).getAttribute("tabindex")).toBe("-1");
  });
});

describe("PageGrid: teclado", () => {
  const press = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(target, { key, ...init });

  it("las flechas mueven el foco entre tarjetas SIN cambiar la seleccion", () => {
    render(<Harness recorded={fresh()} />);
    act(() => card(0).focus());
    press(card(0), "ArrowRight");
    expect(document.activeElement).toBe(card(1));
    expect(selectedIds()).toEqual([]);
    press(card(1), "ArrowLeft");
    expect(document.activeElement).toBe(card(0));
  });

  it("abajo/arriba saltan una fila entera", () => {
    render(<Harness recorded={fresh()} />);
    const columns = computeGrid(360, 8).columns;
    act(() => card(0).focus());
    press(card(0), "ArrowDown");
    expect(document.activeElement).toBe(card(columns));
    press(card(columns), "ArrowUp");
    expect(document.activeElement).toBe(card(0));
  });

  it("Inicio y Fin van a la primera y a la ultima", () => {
    render(<Harness recorded={fresh()} count={6} />);
    act(() => card(2).focus());
    press(card(2), "End");
    expect(document.activeElement).toBe(card(5));
    press(card(5), "Home");
    expect(document.activeElement).toBe(card(0));
  });

  it("en los extremos la flecha no hace nada", () => {
    render(<Harness recorded={fresh()} count={3} />);
    act(() => card(0).focus());
    press(card(0), "ArrowLeft");
    expect(document.activeElement).toBe(card(0));
  });

  it("Espacio alterna la seleccion de la tarjeta enfocada", () => {
    render(<Harness recorded={fresh()} />);
    act(() => card(1).focus());
    press(card(1), " ");
    expect(selectedIds()).toEqual(["p1"]);
    press(card(1), " ");
    expect(selectedIds()).toEqual([]);
  });

  it("Enter selecciona solo la enfocada", () => {
    render(<Harness recorded={fresh()} />);
    act(() => card(1).focus());
    press(card(1), " ");
    act(() => card(3).focus());
    press(card(3), "Enter");
    expect(selectedIds()).toEqual(["p3"]);
  });

  it("Mayus+flecha amplia la seleccion desde el ancla", () => {
    render(<Harness recorded={fresh()} />);
    act(() => card(1).focus());
    press(card(1), " ");
    press(card(1), "ArrowRight", { shiftKey: true });
    press(card(2), "ArrowRight", { shiftKey: true });
    expect(selectedIds()).toEqual(["p1", "p2", "p3"]);
  });

  it("Mayus+Espacio selecciona el rango hasta la enfocada", () => {
    render(<Harness recorded={fresh()} />);
    act(() => card(0).focus());
    press(card(0), " ");
    act(() => card(3).focus());
    press(card(3), " ", { shiftKey: true });
    expect(selectedIds()).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("Supr y Retroceso piden eliminar", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    act(() => card(0).focus());
    press(card(0), "Delete");
    press(card(0), "Backspace");
    expect(recorded.commands).toEqual([{ type: "delete" }, { type: "delete" }]);
  });

  it("R gira a la derecha y Mayus+R a la izquierda; D duplica", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    act(() => card(0).focus());
    press(card(0), "r");
    press(card(0), "R", { shiftKey: true });
    press(card(0), "d");
    expect(recorded.commands).toEqual([
      { type: "rotate", degrees: 90 },
      { type: "rotate", degrees: -90 },
      { type: "duplicate" },
    ]);
  });

  it("Ctrl/Cmd+A selecciona todo (no deja que el navegador lo haga)", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    act(() => card(0).focus());
    const notPrevented = fireEvent.keyDown(card(0), { key: "a", ctrlKey: true });
    expect(notPrevented).toBe(false);
    expect(recorded.commands).toEqual([{ type: "selectAll" }]);
  });

  it("Escape borra la seleccion solo si hay", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} initialSelection={["p1"]} />);
    act(() => card(1).focus());
    press(card(1), "Escape");
    expect(recorded.commands).toEqual([{ type: "clear" }]);
  });

  it("Escape sin seleccion no hace nada (deja cerrar hojas)", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    act(() => card(1).focus());
    const notPrevented = fireEvent.keyDown(card(1), { key: "Escape" });
    expect(notPrevented).toBe(true);
    expect(recorded.commands).toEqual([]);
  });

  it("Ctrl+Mayus+flechas MUEVEN las paginas (alternativa a arrastrar)", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    act(() => card(2).focus());
    press(card(2), "ArrowLeft", { ctrlKey: true, shiftKey: true });
    press(card(2), "ArrowRight", { metaKey: true, shiftKey: true });
    press(card(2), "ArrowUp", { ctrlKey: true, shiftKey: true });
    press(card(2), "ArrowDown", { ctrlKey: true, shiftKey: true });
    expect(recorded.commands).toEqual([
      { type: "shift", direction: -1 },
      { type: "shift", direction: 1 },
      { type: "shift", direction: -1 },
      { type: "shift", direction: 1 },
    ]);
  });

  it("sin manejador de comandos, Supr y R no se interceptan en la hoja de eleccion", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} withCommands={false} initialSelection={["p0"]} />);
    act(() => card(0).focus());
    press(card(0), "Escape");
    press(card(0), "Delete");
    expect(recorded.commands).toEqual([]);
  });

  it("el foco por teclado nunca cae a <body>: mover a una tarjeta lejana la pinta y la enfoca", () => {
    const handle: { current: PageGridHandle | null } = { current: null };
    render(<Harness recorded={fresh()} count={500} handleRef={handle} />);
    act(() => handle.current?.focusItem("p400"));
    expect(document.activeElement?.getAttribute("data-page-id")).toBe("p400");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("el manejador imperativo enfoca la primera tarjeta con `focusGrid`", () => {
    const handle: { current: PageGridHandle | null } = { current: null };
    render(<Harness recorded={fresh()} handleRef={handle} />);
    act(() => handle.current?.focusGrid());
    expect(document.activeElement).toBe(card(0));
  });
});

describe("PageGrid: arrastrar y soltar", () => {
  const mouse = (clientX: number, clientY: number, extra: Record<string, unknown> = {}) => ({
    clientX,
    clientY,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    ...extra,
  });
  const centreOf = (index: number) => {
    const metrics = computeGrid(360, 8);
    const { x, y } = itemPosition(metrics, index);
    return { x: x + metrics.cardWidth / 2, y: y + metrics.cardHeight / 2, metrics };
  };

  it("arrastrar una tarjeta a otro hueco emite el movimiento con su posicion de insercion", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(0);
    const to = itemPosition(computeGrid(360, 8), 4);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 30, from.y + 30));
    fireEvent.pointerMove(window, mouse(to.x + 5, to.y + 20));
    fireEvent.pointerUp(window, mouse(to.x + 5, to.y + 20));
    expect(recorded.drops).toEqual([{ ids: ["p0"], insertBefore: 4 }]);
  });

  it("un movimiento menor que el umbral es un clic, no un arrastre", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(1);
    fireEvent.pointerDown(card(1), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 2, from.y + 1));
    fireEvent.pointerUp(window, mouse(from.x + 2, from.y + 1));
    expect(recorded.drops).toEqual([]);
    fireEvent.click(card(1));
    expect(selectedIds()).toEqual(["p1"]);
  });

  it("al arrastrar una tarjeta sin seleccionar, queda seleccionada (solo ella)", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(2);
    fireEvent.pointerDown(card(2), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 40, from.y));
    expect(selectedIds()).toEqual(["p2"]);
    fireEvent.pointerUp(window, mouse(from.x + 40, from.y));
  });

  it("arrastrar una seleccionada lleva TODA la seleccion en el orden del documento", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} initialSelection={["p3", "p1"]} />);
    const from = centreOf(3);
    fireEvent.pointerDown(card(3), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x, from.y + 60));
    fireEvent.pointerUp(window, mouse(5, 5));
    expect(recorded.drops[0].ids).toEqual(["p1", "p3"]);
    expect(recorded.drops[0].insertBefore).toBe(0);
  });

  it("durante el arrastre hay barra de insercion y fantasma con el numero de paginas", () => {
    render(<Harness recorded={fresh()} initialSelection={["p0", "p1"]} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 40, from.y + 40));
    expect(document.querySelector("[data-drop-marker]")).not.toBeNull();
    expect(document.querySelector("[data-drag-ghost]")?.textContent).toBe("2");
    fireEvent.pointerUp(window, mouse(from.x + 40, from.y + 40));
    expect(document.querySelector("[data-drop-marker]")).toBeNull();
  });

  it("las tarjetas que se arrastran se atenuan", () => {
    render(<Harness recorded={fresh()} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 40, from.y + 40));
    expect(card(0).className).toContain("opacity-45");
    fireEvent.pointerUp(window, mouse(from.x + 40, from.y + 40));
  });

  it("Escape cancela el arrastre sin mover nada y lo anuncia", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 60, from.y + 60));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, mouse(from.x + 60, from.y + 60));
    expect(recorded.drops).toEqual([]);
    expect(recorded.announcements).toContain("Cancelado");
    expect(document.querySelector("[data-drop-marker]")).toBeNull();
  });

  it("pointercancel cancela el arrastre", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 60, from.y + 60));
    fireEvent.pointerCancel(window, mouse(from.x + 60, from.y + 60));
    expect(recorded.drops).toEqual([]);
  });

  it("anuncia el inicio del arrastre con el numero de paginas", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} initialSelection={["p0", "p1", "p2"]} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 60, from.y + 60));
    expect(recorded.announcements).toContain("Arrastrando 3");
    fireEvent.pointerUp(window, mouse(from.x + 60, from.y + 60));
  });

  it("el clic que sigue a soltar un arrastre NO cambia la seleccion", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 80, from.y + 80));
    fireEvent.pointerUp(window, mouse(from.x + 80, from.y + 80));
    const before = recorded.selections.length;
    fireEvent.click(card(0), { ctrlKey: true });
    expect(recorded.selections.length).toBe(before);
  });

  it("el boton derecho no arrastra", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y, { button: 2 }));
    fireEvent.pointerMove(window, mouse(from.x + 90, from.y + 90));
    fireEvent.pointerUp(window, mouse(from.x + 90, from.y + 90));
    expect(recorded.drops).toEqual([]);
  });

  it("con el dedo solo se arrastra desde el asa; el resto de la tarjeta deja desplazar", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(0);
    const touch = { pointerType: "touch" };
    fireEvent.pointerDown(card(0), mouse(from.x, from.y, touch));
    fireEvent.pointerMove(window, mouse(from.x + 90, from.y + 90, touch));
    fireEvent.pointerUp(window, mouse(from.x + 90, from.y + 90, touch));
    expect(recorded.drops).toEqual([]);

    const handle = card(0).querySelector("[data-drag-handle]") as HTMLElement;
    const to = itemPosition(computeGrid(360, 8), 5);
    fireEvent.pointerDown(handle, mouse(from.x, from.y, touch));
    fireEvent.pointerMove(window, mouse(to.x + 4, to.y + 20, touch));
    fireEvent.pointerUp(window, mouse(to.x + 4, to.y + 20, touch));
    expect(recorded.drops).toEqual([{ ids: ["p0"], insertBefore: 5 }]);
  });

  it("sin `draggable` nada se arrastra", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} draggable={false} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 90, from.y + 90));
    fireEvent.pointerUp(window, mouse(from.x + 90, from.y + 90));
    expect(recorded.drops).toEqual([]);
  });

  it("soltar al final de la cuadricula inserta al final", () => {
    const recorded = fresh();
    render(<Harness recorded={recorded} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 40, from.y + 40));
    fireEvent.pointerUp(window, mouse(100, 9999));
    expect(recorded.drops).toEqual([{ ids: ["p0"], insertBefore: 8 }]);
  });

  it("no deja oyentes de ventana tras desmontar a mitad de arrastre", () => {
    const recorded = fresh();
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Harness recorded={recorded} />);
    const from = centreOf(0);
    fireEvent.pointerDown(card(0), mouse(from.x, from.y));
    fireEvent.pointerMove(window, mouse(from.x + 40, from.y + 40));
    unmount();
    const removed = removeSpy.mock.calls.map((call) => call[0]);
    expect(removed).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel", "keydown"]));
    removeSpy.mockRestore();
  });
});

describe("PageGrid: auto-desplazamiento por tiempo (GE-03)", () => {
  it("no hay desplazamiento en el centro de la cuadricula", () => {
    expect(edgeScrollSpeed(300, 100, 400)).toBe(0);
  });

  it("sube cerca del borde de arriba (negativo) y baja cerca del de abajo (positivo)", () => {
    expect(edgeScrollSpeed(110, 100, 400)).toBeLessThan(0);
    expect(edgeScrollSpeed(490, 100, 400)).toBeGreaterThan(0);
  });

  it("es proporcional a lo cerca que esta el dedo del borde y arranca al entrar en la franja", () => {
    const farther = edgeScrollSpeed(100 + 60, 100, 400);
    const nearer = edgeScrollSpeed(100 + 30, 100, 400);
    const atEdge = edgeScrollSpeed(100, 100, 400);
    expect(Math.abs(farther)).toBeGreaterThan(0);
    expect(Math.abs(nearer)).toBeGreaterThan(Math.abs(farther));
    expect(Math.abs(atEdge)).toBeGreaterThan(Math.abs(nearer));
  });

  it("tiene tope en px/s aunque el dedo salga de la cuadricula (antes: 26 px por fotograma = 3 100 px/s a 120 Hz)", () => {
    expect(Math.abs(edgeScrollSpeed(100, 100, 400))).toBeLessThanOrEqual(900);
    expect(Math.abs(edgeScrollSpeed(-5000, 100, 400))).toBeLessThanOrEqual(900);
    expect(Math.abs(edgeScrollSpeed(9000, 100, 400))).toBeLessThanOrEqual(900);
  });

  it("no depende de la tasa de fotogramas: dos pasos de 8 ms equivalen a uno de 16 ms", () => {
    // La velocidad es un dato (px/s); el controlador la multiplica por el tiempo real transcurrido.
    const speed = edgeScrollSpeed(110, 100, 400);
    expect((speed * 16) / 1000).toBeCloseTo(2 * ((speed * 8) / 1000), 6);
  });
});

describe("PageGrid: foco tras reordenar (GE-03)", () => {
  /** Reordena (la pagina 1 pasa al final) y pide el foco EN EL MISMO turno, como hace «Aplicar» el arrastre al soltar. */
  function Reorder({ count, handleRef }: { count: number; handleRef: { current: PageGridHandle | null } }) {
    const [items, setItems] = useState(() => makeItems(count));
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setItems((current) => [...current.slice(1), current[0]]);
            handleRef.current?.focusItem("p0");
          }}
        >
          Mover la primera al final
        </button>
        <PageGrid
          ref={(value) => {
            handleRef.current = value;
          }}
          items={items}
          selection={new Set()}
          anchorId={null}
          focusId={null}
          label="Paginas"
          strings={STRINGS}
          onSelectionChange={() => undefined}
          onFocusChange={() => undefined}
        />
      </>
    );
  }

  it("la pagina movida queda a la vista: la cuadricula NO salta a donde estaba antes de moverla", () => {
    const handle: { current: PageGridHandle | null } = { current: null };
    render(<Reorder count={60} handleRef={handle} />);
    const scroller = screen.getByRole("listbox") as HTMLDivElement;
    expect(scroller.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Mover la primera al final" }));
    // La pagina 1 ahora es la ultima (indice 59): el desplazamiento la lleva a la vista, no se queda arriba.
    expect(scroller.scrollTop).toBeGreaterThan(1000);
    expect(document.activeElement?.getAttribute("data-page-id")).toBe("p0");
    expect(document.activeElement?.getAttribute("aria-posinset")).toBe("60");
  });
});
