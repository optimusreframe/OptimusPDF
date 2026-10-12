import { describe, expect, it } from "vitest";
import {
  ANNOTATE_TOOL_ORDER,
  TOOL_KEYS,
  TOOL_ORDER,
  TOOL_SHORTCUTS,
  buildPaletteTools,
  isTool,
  shortcutsFor,
} from "@/app/edit-pdf/editTools";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";

/** Paleta de anotacion del modo Anotar de PDF Pro (Wave 7 · U6): la de Editar PDF NO cambia. */

describe("herramientas del modo Anotar", () => {
  it("la paleta de Editar PDF suelta conserva sus 8 herramientas, sin nota", () => {
    expect(TOOL_ORDER).toEqual(["select", "text", "image", "rect", "ellipse", "line", "highlight", "check"]);
    expect(TOOL_ORDER).not.toContain("note");
  });

  it("los atajos de la herramienta suelta no incluyen la N", () => {
    expect(TOOL_SHORTCUTS.n).toBeUndefined();
    expect(Object.keys(TOOL_SHORTCUTS).sort()).toEqual(["e", "h", "i", "l", "m", "r", "t", "v"]);
  });

  it("la paleta de anotacion empieza por Seleccionar y trae resaltador, figuras, marca, texto, nota e imagen", () => {
    expect(ANNOTATE_TOOL_ORDER).toEqual(["select", "highlight", "rect", "ellipse", "line", "check", "text", "note", "image"]);
  });

  it("no repite herramientas y todas son validas", () => {
    expect(new Set(ANNOTATE_TOOL_ORDER).size).toBe(ANNOTATE_TOOL_ORDER.length);
    for (const tool of ANNOTATE_TOOL_ORDER) expect(isTool(tool)).toBe(true);
  });

  it("cada herramienta tiene su letra y las letras no se repiten", () => {
    const keys = ANNOTATE_TOOL_ORDER.map((tool) => TOOL_KEYS[tool]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(TOOL_KEYS.note).toBe("n");
  });

  it("shortcutsFor devuelve letra → herramienta solo de la lista pedida", () => {
    const map = shortcutsFor(ANNOTATE_TOOL_ORDER);
    expect(map.n).toBe("note");
    expect(map.h).toBe("highlight");
    expect(Object.keys(map)).toHaveLength(ANNOTATE_TOOL_ORDER.length);
    expect(shortcutsFor(["select", "rect"])).toEqual({ v: "select", r: "rect" });
  });

  it("isTool reconoce la nota", () => {
    expect(isTool("note")).toBe(true);
    expect(isTool("stamp")).toBe(false);
  });

  it("buildPaletteTools sin orden da la paleta de siempre y con orden la del modo", () => {
    const strings = EDIT_STRINGS.es;
    expect(buildPaletteTools(strings, "check").map((tool) => tool.id)).toEqual([...TOOL_ORDER]);
    const annotate = buildPaletteTools(strings, "check", ANNOTATE_TOOL_ORDER);
    expect(annotate.map((tool) => tool.id)).toEqual([...ANNOTATE_TOOL_ORDER]);
    expect(annotate.find((tool) => tool.id === "note")).toMatchObject({ label: "Nota", shortcut: "n" });
  });

  it("la nota tiene etiqueta en español e ingles", () => {
    expect(EDIT_STRINGS.es.inline.toolNote).toBe("Nota");
    expect(EDIT_STRINGS.en.inline.toolNote).toBe("Note");
    expect(EDIT_STRINGS.es.inline.toolHints.note).toContain("nota");
    expect(EDIT_STRINGS.en.inline.toolHints.note).toContain("note");
  });

  it("la marca enseña el aspa cuando se pide", () => {
    const strings = EDIT_STRINGS.es;
    const withCross = buildPaletteTools(strings, "cross", ANNOTATE_TOOL_ORDER);
    const withCheck = buildPaletteTools(strings, "check", ANNOTATE_TOOL_ORDER);
    expect(withCross.find((tool) => tool.id === "check")!.icon).not.toBe(withCheck.find((tool) => tool.id === "check")!.icon);
  });
});
