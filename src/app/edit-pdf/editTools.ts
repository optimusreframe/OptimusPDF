import {
  Check,
  Circle,
  Highlighter,
  ImagePlus,
  Minus,
  MousePointer2,
  Square,
  Type,
  X,
} from "lucide-react";
import type { PaletteTool } from "@/app/edit-pdf/EditToolPalette";
import type { DrawTool } from "@/app/edit-pdf/editElements";
import type { EditStrings } from "@/app/edit-pdf/strings";
import type { CheckMark } from "@/lib/pdf/editPdf";

/*
 * Herramientas de la paleta del editor inline (W5-U4a/b): una sola lista, con su
 * orden, icono, etiqueta (es/en) y atajo de UNA letra. Los atajos solo actuan
 * fuera de los campos de texto (ver `onRootKeyDown` del lienzo), asi que no
 * chocan con la escritura; con un bloque de texto enfocado, teclear una letra
 * empieza a editarlo, como siempre.
 */

export type Tool = "select" | "text" | "image" | DrawTool;

/** Orden de la paleta. Seleccionar (la primera) es la herramienta por defecto. */
export const TOOL_ORDER: readonly Tool[] = [
  "select",
  "text",
  "image",
  "rect",
  "ellipse",
  "line",
  "highlight",
  "check",
];

/** Letra de cada herramienta (V seleccionar, T texto, I imagen, R rectangulo, E elipse, L linea, H resaltado, M marca). */
export const TOOL_KEYS: Readonly<Record<Tool, string>> = {
  select: "v",
  text: "t",
  image: "i",
  rect: "r",
  ellipse: "e",
  line: "l",
  highlight: "h",
  check: "m",
};

/** Letra -> herramienta. */
export const TOOL_SHORTCUTS: Readonly<Record<string, Tool>> = Object.fromEntries(
  TOOL_ORDER.map((tool) => [TOOL_KEYS[tool], tool]),
);

export function isTool(id: string): id is Tool {
  return (TOOL_ORDER as readonly string[]).includes(id);
}

/** Lista de la paleta; el boton de la marca ensena el simbolo activo (visto o aspa). */
export function buildPaletteTools(strings: EditStrings, checkMark: CheckMark): PaletteTool[] {
  const s = strings.inline;
  const labels: Record<Tool, string> = {
    select: s.toolSelect,
    text: s.toolText,
    image: strings.typeLabels.image,
    rect: strings.typeLabels.rect,
    ellipse: strings.typeLabels.ellipse,
    line: strings.typeLabels.line,
    highlight: strings.typeLabels.highlight,
    check: strings.typeLabels.check,
  };
  const icons = {
    select: MousePointer2,
    text: Type,
    image: ImagePlus,
    rect: Square,
    ellipse: Circle,
    line: Minus,
    highlight: Highlighter,
    check: checkMark === "cross" ? X : Check,
  } as const;
  return TOOL_ORDER.map((tool) => ({
    id: tool,
    icon: icons[tool],
    label: labels[tool],
    shortcut: TOOL_KEYS[tool],
  }));
}
