import type { SignatureFieldType } from "@/lib/pdf/sign";
import type { DetectedFieldType } from "@/lib/pdf/detectFields";

/*
 * Herramientas de la paleta del paso "Documento" (W2-B). La herramienta
 * activa decide que crea un toque o un arrastre sobre la pagina; "select"
 * (por defecto) no crea nada: toca, mueve y edita lo que ya hay.
 *
 * "Iniciales de texto" (`DetectedFieldType` = "initials") NO es una
 * herramienta de la paleta: junto a "Iniciales" (el hueco que firma cada
 * persona) llevaria a confusion y la paleta no cabe a 375 px con siete
 * botones mas dos de navegacion. Se elige despues, en la barra flotante del
 * campo (cuando `richFieldTypes` esta activo).
 */
export type PlacementTool =
  | "select"
  | "signature"
  | "initials"
  | "text"
  | "checkbox"
  | "date"
  /** Editar el texto ORIGINAL del PDF en el sitio (W6-A): no crea huecos ni campos. */
  | "editText";

export type CreationTool = Exclude<PlacementTool, "select" | "editText">;

export const PLACEMENT_TOOLS: readonly PlacementTool[] = [
  "select",
  "signature",
  "initials",
  "text",
  "checkbox",
  "date",
  "editText",
];

export type ToolCreates =
  | { kind: "slot"; slotType: SignatureFieldType }
  | { kind: "text"; fieldType: DetectedFieldType };

/** Que elemento crea cada herramienta. */
export const TOOL_CREATES: Record<CreationTool, ToolCreates> = {
  signature: { kind: "slot", slotType: "signature" },
  initials: { kind: "slot", slotType: "initials" },
  text: { kind: "text", fieldType: "text" },
  checkbox: { kind: "text", fieldType: "checkbox" },
  date: { kind: "text", fieldType: "date" },
};

/**
 * Atajos de una letra (los mismos en espanol e ingles, para no cambiar la
 * memoria muscular al cambiar de idioma). Solo funcionan con el foco dentro
 * del paso o sin foco en ningun control (WCAG 2.1.4) y nunca mientras se
 * escribe: ver `isTypingTarget` en `DocumentCanvas`.
 */
export const TOOL_SHORTCUTS: Record<PlacementTool, string> = {
  select: "v",
  signature: "f",
  initials: "i",
  text: "t",
  checkbox: "c",
  date: "d",
  editText: "e",
};

export function toolFromShortcut(key: string): PlacementTool | null {
  const lower = key.toLowerCase();
  return PLACEMENT_TOOLS.find((tool) => TOOL_SHORTCUTS[tool] === lower) ?? null;
}

/**
 * Herramientas utilizables ahora: firma e iniciales necesitan al menos un
 * firmante; casilla y fecha dependen del ajuste `richFieldTypes`. En el modo
 * "Solo yo" (`solo`) la firma esta siempre (es la propia) y las iniciales no
 * existen: ese modo solo coloca una firma.
 */
export function availableTools(options: {
  hasSigners: boolean;
  richFieldTypes: boolean;
  solo?: boolean;
  /** «Editar texto» existe (ajuste `editExistingText` activo o ya hay ediciones). */
  editText?: boolean;
}): PlacementTool[] {
  return PLACEMENT_TOOLS.filter((tool) => {
    if (tool === "editText") return options.editText === true;
    if (options.solo) {
      if (tool === "signature") return true;
      if (tool === "initials") return false;
    }
    if (tool === "signature" || tool === "initials") return options.hasSigners;
    if (tool === "checkbox" || tool === "date") return options.richFieldTypes;
    return true;
  });
}

/** Ancho y alto por defecto (fraccion de pagina) de un campo de texto nuevo; `null` = cuadrado. */
export const TEXT_FIELD_DEFAULTS: Record<
  DetectedFieldType,
  { width: number; height: number | null }
> = {
  text: { width: 0.28, height: 0.045 },
  date: { width: 0.22, height: 0.045 },
  initials: { width: 0.1, height: 0.045 },
  checkbox: { width: 0.034, height: null },
};

/* ------------------------------------------------------------------ *
 * Conversion de valores al cambiar el tipo de un campo
 * ------------------------------------------------------------------ */

/** Maximo de letras de unas iniciales (el `maxLength` del editor en linea). */
export const INITIALS_MAX_LENGTH = 4;

/**
 * Iniciales a partir de un texto: se recortan los espacios de los extremos y
 * se parte por palabras. Con varias, la inicial de cada una ("Hola mundo" ->
 * "HM", "  Ana  Maria  " -> "AM"); con una sola, sus primeras letras
 * ("Ana" -> "ANA", "Supercalifragilistico" -> "SUPE"), porque quien escribe
 * una palabra suelta ya esta escribiendo las iniciales. Siempre en
 * mayusculas y con un maximo de 4 letras; se cuentan caracteres Unicode
 * completos, no unidades UTF-16.
 */
export function formatInitials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words.map((word) => Array.from(word)[0]).join("")
      : (words[0] ?? "");
  return Array.from(letters.toUpperCase()).slice(0, INITIALS_MAX_LENGTH).join("");
}

/** Fecha ISO `AAAA-MM-DD` valida (la que guarda el `<input type="date">`). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Valor de un campo tras cambiar su tipo. Se CONSERVA cuando el tipo nuevo lo
 * admite (texto <-> iniciales con el formato de las iniciales; una fecha
 * valida a texto) y solo se BORRA (`cleared`) cuando no tendria sentido: un
 * texto cualquiera como fecha o como casilla, o el "true" de una casilla como
 * texto. Quien llama ofrece "Deshacer" cuando `cleared`.
 */
export function convertValueForType(
  value: string,
  from: DetectedFieldType,
  to: DetectedFieldType,
): { value: string; cleared: boolean } {
  if (!value || from === to) return { value, cleared: false };
  if (to === "checkbox") {
    return value === "true" ? { value, cleared: false } : { value: "", cleared: true };
  }
  if (from === "checkbox") return { value: "", cleared: true };
  if (to === "initials") return { value: formatInitials(value), cleared: false };
  if (to === "date") {
    return isIsoDate(value) ? { value, cleared: false } : { value: "", cleared: true };
  }
  return { value, cleared: false };
}
