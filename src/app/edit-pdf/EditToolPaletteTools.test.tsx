import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Redo2, Undo2 } from "lucide-react";
import { EditToolPalette } from "@/app/edit-pdf/EditToolPalette";
import { TOOL_KEYS, TOOL_ORDER, TOOL_SHORTCUTS, buildPaletteTools, isTool } from "@/app/edit-pdf/editTools";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";

/** La paleta unica con las ocho herramientas (W5-U4b): orden, atajos, nombres es/en y patron APG. */

afterEach(cleanup);

function mount(language: "es" | "en" = "es", tool = "select", checkMark: "check" | "cross" = "check") {
  const onToolChange = vi.fn();
  const strings = EDIT_STRINGS[language];
  render(
    <EditToolPalette
      tool={tool}
      tools={buildPaletteTools(strings, checkMark)}
      onToolChange={onToolChange}
      actions={[
        { id: "undo", icon: Undo2, label: "Deshacer", disabled: false, onClick: vi.fn() },
        { id: "redo", icon: Redo2, label: "Rehacer", disabled: true, onClick: vi.fn() },
      ]}
      label={strings.inline.paletteLabel}
    />,
  );
  return { onToolChange };
}

const item = (id: string) => document.querySelector<HTMLElement>(`[data-palette-item="${id}"]`)!;

describe("editTools", () => {
  it("el orden es Seleccionar (por defecto), Texto, Imagen, Rectangulo, Elipse, Linea, Resaltador, Marca", () => {
    expect(TOOL_ORDER).toEqual(["select", "text", "image", "rect", "ellipse", "line", "highlight", "check"]);
  });

  it("cada herramienta tiene una letra distinta y el mapa inverso la devuelve", () => {
    const keys = Object.values(TOOL_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const tool of TOOL_ORDER) expect(TOOL_SHORTCUTS[TOOL_KEYS[tool]]).toBe(tool);
  });

  it("ningun atajo choca con las teclas de navegacion ni con el deshacer", () => {
    const reserved = ["[", "]", "+", "-", "=", "z", "y"];
    for (const key of Object.values(TOOL_KEYS)) expect(reserved).not.toContain(key);
  });

  it("isTool reconoce solo las herramientas", () => {
    expect(isTool("rect")).toBe(true);
    expect(isTool("undo")).toBe(false);
  });
});

describe("EditToolPalette con las ocho herramientas", () => {
  it("las etiquetas son las de cada idioma", () => {
    mount("es");
    for (const name of ["Seleccionar", "Añadir texto", "Imagen", "Rectángulo", "Elipse", "Línea", "Resaltado", "Marca"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    cleanup();
    mount("en");
    for (const name of ["Select", "Add text", "Image", "Rectangle", "Ellipse", "Line", "Highlight", "Mark"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("cada boton anuncia su atajo en aria-keyshortcuts y en el tooltip", () => {
    mount();
    const expected: Record<string, string> = { select: "V", text: "T", image: "I", rect: "R", ellipse: "E", line: "L", highlight: "H", check: "M" };
    for (const [id, key] of Object.entries(expected)) {
      expect(item(id).getAttribute("aria-keyshortcuts"), id).toBe(key);
      expect(item(id).getAttribute("title"), id).toMatch(new RegExp(`\\(${key}\\)$`));
    }
  });

  it("solo la herramienta activa esta pulsada", () => {
    mount("es", "ellipse");
    const pressed = TOOL_ORDER.filter((id) => item(id).getAttribute("aria-pressed") === "true");
    expect(pressed).toEqual(["ellipse"]);
  });

  it("tabindex itinerante: una sola parada de Tab, en la herramienta activa", () => {
    mount("es", "line");
    const stops = Array.from(document.querySelectorAll<HTMLElement>("[data-palette-item]")).filter((el) => el.tabIndex === 0);
    expect(stops).toEqual([item("line")]);
  });

  it("las flechas recorren las diez paradas (8 herramientas y 2 acciones) y dan la vuelta", () => {
    mount();
    item("select").focus();
    const visited: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      visited.push((document.activeElement as HTMLElement).dataset.paletteItem!);
    }
    expect(visited).toEqual(["text", "image", "rect", "ellipse", "line", "highlight", "check", "undo", "redo", "select"]);
  });

  it("Inicio y Fin saltan a los extremos; ArrowUp desde la primera va a la ultima", () => {
    mount();
    item("rect").focus();
    fireEvent.keyDown(item("rect"), { key: "End" });
    expect(document.activeElement).toBe(item("redo"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(item("select"));
    fireEvent.keyDown(item("select"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(item("redo"));
  });

  it("moverse con las flechas NO cambia de herramienta; Intro/clic si", () => {
    const { onToolChange } = mount();
    item("select").focus();
    fireEvent.keyDown(item("select"), { key: "ArrowDown" });
    expect(onToolChange).not.toHaveBeenCalled();
    fireEvent.click(item("rect"));
    expect(onToolChange).toHaveBeenCalledWith("rect");
  });

  it("volver a pulsar la herramienta activa regresa a Seleccionar", () => {
    const { onToolChange } = mount("es", "highlight");
    fireEvent.click(item("highlight"));
    expect(onToolChange).toHaveBeenCalledWith("select");
  });

  it("el boton de la marca ensena el simbolo activo", () => {
    mount("es", "select", "check");
    const check = item("check").innerHTML;
    cleanup();
    mount("es", "select", "cross");
    expect(item("check").innerHTML).not.toBe(check);
  });

  it("deshacer agotado sigue siendo enfocable (aria-disabled), asi el foco no cae a <body>", () => {
    mount();
    expect(item("redo").getAttribute("aria-disabled")).toBe("true");
    expect(item("redo").hasAttribute("disabled")).toBe(false);
    act(() => item("redo").focus());
    expect(document.activeElement).toBe(item("redo"));
  });
});
