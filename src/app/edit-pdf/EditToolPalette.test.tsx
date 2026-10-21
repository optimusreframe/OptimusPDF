import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MousePointer2, Redo2, Type, Undo2 } from "lucide-react";
import { EditToolPalette, type PaletteAction, type PaletteTool } from "@/app/edit-pdf/EditToolPalette";
import { paletteItemClass } from "@/app/sign-pdf/ToolPalette";

const TOOLS: PaletteTool[] = [
  { id: "select", icon: MousePointer2, label: "Seleccionar", shortcut: "v" },
  { id: "text", icon: Type, label: "Añadir texto", shortcut: "t" },
];

function actions(overrides: Partial<Record<"undo" | "redo", Partial<PaletteAction>>> = {}): PaletteAction[] {
  return [
    {
      id: "undo",
      icon: Undo2,
      label: "Deshacer",
      keyShortcuts: "Control+Z Meta+Z",
      shortcutLabel: "Ctrl+Z",
      disabled: false,
      onClick: vi.fn(),
      ...overrides.undo,
    },
    {
      id: "redo",
      icon: Redo2,
      label: "Rehacer",
      keyShortcuts: "Control+Shift+Z Meta+Shift+Z Control+Y",
      disabled: true,
      onClick: vi.fn(),
      ...overrides.redo,
    },
  ];
}

function setup(tool = "select", acts = actions(), onToolChange = vi.fn()) {
  render(
    <EditToolPalette tool={tool} tools={TOOLS} onToolChange={onToolChange} actions={acts} label="Herramientas de edición" />,
  );
  return { onToolChange, acts };
}

describe("EditToolPalette", () => {
  it("es una unica toolbar APG con las herramientas como botones de alternancia", () => {
    setup("text");
    const toolbar = screen.getByRole("toolbar", { name: "Herramientas de edición" });
    expect(toolbar.hasAttribute("data-tool-palette")).toBe(true);
    expect(screen.getByRole("button", { name: "Añadir texto" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Seleccionar" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("anuncia el atajo de cada herramienta en aria-keyshortcuts y en el tooltip", () => {
    setup();
    const text = screen.getByRole("button", { name: "Añadir texto" });
    expect(text.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(text.getAttribute("title")).toBe("Añadir texto (T)");
  });

  it("deshacer y rehacer llevan aria-keyshortcuts y su estado deshabilitado es aria-disabled (siguen enfocables)", () => {
    setup();
    const undo = screen.getByRole("button", { name: "Deshacer" });
    const redo = screen.getByRole("button", { name: "Rehacer" });
    expect(undo.getAttribute("aria-keyshortcuts")).toBe("Control+Z Meta+Z");
    expect(redo.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+Z Meta+Shift+Z Control+Y");
    expect(undo.getAttribute("aria-disabled")).toBe("false");
    expect(redo.getAttribute("aria-disabled")).toBe("true");
    expect((redo as HTMLButtonElement).disabled).toBe(false);
    act(() => redo.focus());
    expect(document.activeElement).toBe(redo);
  });

  it("una accion deshabilitada no se dispara y una habilitada si", () => {
    const { acts } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Rehacer" }));
    expect(acts[1].onClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }));
    expect(acts[0].onClick).toHaveBeenCalledTimes(1);
  });

  it("elegir una herramienta la activa y volver a pulsarla regresa a la primera", () => {
    const onToolChange = vi.fn();
    setup("select", actions(), onToolChange);
    fireEvent.click(screen.getByRole("button", { name: "Añadir texto" }));
    expect(onToolChange).toHaveBeenLastCalledWith("text");
    onToolChange.mockClear();
    const { unmount } = render(
      <EditToolPalette tool="text" tools={TOOLS} onToolChange={onToolChange} actions={[]} label="x" />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Añadir texto" })[1]);
    expect(onToolChange).toHaveBeenLastCalledWith("select");
    unmount();
  });

  it("tabindex itinerante: una sola parada de Tab, la herramienta activa", () => {
    setup("text");
    const buttons = screen.getAllByRole("button");
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Añadir texto" }).tabIndex).toBe(0);
  });

  it("flechas, Inicio y Fin mueven el foco con vuelta al principio y al final", () => {
    setup("select");
    const [select, text, undo, redo] = screen.getAllByRole("button");
    act(() => select.focus());
    fireEvent.keyDown(select, { key: "ArrowRight" });
    expect(document.activeElement).toBe(text);
    fireEvent.keyDown(text, { key: "ArrowDown" });
    expect(document.activeElement).toBe(undo);
    fireEvent.keyDown(undo, { key: "End" });
    expect(document.activeElement).toBe(redo);
    fireEvent.keyDown(redo, { key: "ArrowRight" });
    expect(document.activeElement).toBe(select);
    fireEvent.keyDown(select, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(redo);
    fireEvent.keyDown(redo, { key: "Home" });
    expect(document.activeElement).toBe(select);
  });

  it("el boton enfocado pasa a ser la parada de Tab", () => {
    setup("select");
    const undo = screen.getByRole("button", { name: "Deshacer" });
    act(() => undo.focus());
    expect(undo.tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Seleccionar" }).tabIndex).toBe(-1);
  });

  it("reutiliza el aspecto de la paleta de Firmar (misma funcion de clases)", () => {
    expect(paletteItemClass(true)).toContain("bg-signal/25");
    expect(paletteItemClass(false, true)).toContain("opacity-40");
    expect(paletteItemClass(false)).toContain("focus-visible:outline-2");
  });

  it("(W10-C-A3) deja pasar `style` (variables de colocacion que mide quien la monta) a la barra de herramientas", () => {
    render(
      <EditToolPalette
        tool="select"
        tools={TOOLS}
        onToolChange={vi.fn()}
        actions={actions()}
        label="Herramientas de edición"
        style={{ "--edit-palette-bottom": "168px" } as CSSProperties}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Herramientas de edición" });
    expect(toolbar.style.getPropertyValue("--edit-palette-bottom")).toBe("168px");
  });
});

/* (M6 · b) Bandeja del telefono: UNA fila desplazable con desvanecido en el borde con mas herramientas. */
describe("EditToolPalette · fila desplazable de la bandeja", () => {
  function row(overrides: { scrollWidth?: number; clientWidth?: number } = {}) {
    render(<EditToolPalette tool="select" tools={TOOLS} onToolChange={vi.fn()} actions={[]} label="Herramientas de edición" scrollRow />);
    const toolbar = screen.getByRole("toolbar", { name: "Herramientas de edición" });
    Object.defineProperty(toolbar, "scrollWidth", { configurable: true, value: overrides.scrollWidth ?? 500 });
    Object.defineProperty(toolbar, "clientWidth", { configurable: true, value: overrides.clientWidth ?? 300 });
    return toolbar;
  }

  it("sin tarjeta propia, en una fila que se desplaza, con botones de 44 px que no se encogen", () => {
    const toolbar = row();
    expect(toolbar.className).toContain("overflow-x-auto");
    expect(toolbar.className).not.toContain("material-thick");
    expect(toolbar.className).toContain("gap-2");
    for (const button of Array.from(toolbar.querySelectorAll<HTMLElement>("button"))) {
      expect(button.className).toContain("w-11");
      expect(button.className).toContain("flex-none");
    }
  });

  it("desvanece el borde derecho cuando hay mas por ver y el izquierdo tras desplazarse", () => {
    const toolbar = row();
    act(() => {
      toolbar.dispatchEvent(new Event("scroll"));
    });
    expect(toolbar.className).toContain("mask-image:linear-gradient(to_right,black_calc(100%-1.75rem),transparent)");
    toolbar.scrollLeft = 120;
    act(() => {
      toolbar.dispatchEvent(new Event("scroll"));
    });
    expect(toolbar.className).toContain("transparent,black_1.75rem");
    toolbar.scrollLeft = 200;
    act(() => {
      toolbar.dispatchEvent(new Event("scroll"));
    });
    expect(toolbar.className).toContain("mask-image:linear-gradient(to_left,black_calc(100%-1.75rem),transparent)");
  });

  it("sin desbordar (caben todas) no hay desvanecido", () => {
    const toolbar = row({ scrollWidth: 300, clientWidth: 300 });
    act(() => {
      toolbar.dispatchEvent(new Event("scroll"));
    });
    expect(toolbar.className).not.toContain("mask-image");
  });

  it("la paleta normal (columna/rejilla) lleva 8 px entre botones con el dedo en tablet (VI-07)", () => {
    setup();
    expect(screen.getByRole("toolbar").className).toContain("pointer-coarse:md:gap-2");
    expect(screen.getByRole("toolbar").className).not.toContain("overflow-x-auto");
  });
});
