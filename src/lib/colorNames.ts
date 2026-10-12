/*
 * Nombre legible de un color para los lectores de pantalla. Las muestras de color son botones sin texto: su nombre
 * accesible no puede ser un codigo hexadecimal («#0d4bff»), que no se entiende ni esta traducido.
 *
 * Los colores de las paletas del producto tienen su nombre propio (tinta del documento y de la firma). Cualquier otro
 * valor recibe un nombre aproximado a partir de su tono, saturacion y luminosidad.
 */

export type ColorLanguage = "es" | "en";

type Names = Record<ColorLanguage, string>;

const KNOWN: Record<string, Names> = {
  // Tintas del documento (`INK_COLORS`).
  "#000000": { es: "Negro", en: "Black" },
  "#5b6470": { es: "Gris", en: "Grey" },
  "#c0c6cf": { es: "Gris claro", en: "Light grey" },
  "#0d4bff": { es: "Azul", en: "Blue" },
  "#0f9d68": { es: "Verde", en: "Green" },
  "#e11d48": { es: "Rojo", en: "Red" },
  "#f59e0b": { es: "Ámbar", en: "Amber" },
  "#ffffff": { es: "Blanco", en: "White" },
  // Tintas de la firma.
  "#0b0b0c": { es: "Negro", en: "Black" },
  "#12327d": { es: "Azul marino", en: "Navy blue" },
  "#3d3d42": { es: "Gris oscuro", en: "Dark grey" },
};

const HUES: ReadonlyArray<{ upTo: number; es: string; en: string }> = [
  { upTo: 15, es: "Rojo", en: "Red" },
  { upTo: 45, es: "Naranja", en: "Orange" },
  { upTo: 70, es: "Amarillo", en: "Yellow" },
  { upTo: 160, es: "Verde", en: "Green" },
  { upTo: 195, es: "Turquesa", en: "Teal" },
  { upTo: 255, es: "Azul", en: "Blue" },
  { upTo: 290, es: "Violeta", en: "Purple" },
  { upTo: 340, es: "Rosa", en: "Pink" },
  { upTo: 361, es: "Rojo", en: "Red" },
];

function parseHex(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length === 3) digits = digits.replace(/./g, (digit) => digit + digit);
  const number = Number.parseInt(digits, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function approximate(rgb: [number, number, number], language: ColorLanguage): string {
  const [r, g, b] = rgb.map((channel) => channel / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  const es = language === "es";
  if (lightness < 0.1) return es ? "Negro" : "Black";
  if (lightness > 0.95) return es ? "Blanco" : "White";
  if (saturation < 0.12) {
    if (lightness < 0.35) return es ? "Gris oscuro" : "Dark grey";
    if (lightness > 0.7) return es ? "Gris claro" : "Light grey";
    return es ? "Gris" : "Grey";
  }
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta + 6) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  const base = HUES.find((entry) => hue < entry.upTo) ?? HUES[0];
  const name = es ? base.es : base.en;
  if (lightness < 0.3) return es ? `${name} oscuro` : `Dark ${name.toLowerCase()}`;
  if (lightness > 0.75) return es ? `${name} claro` : `Light ${name.toLowerCase()}`;
  return name;
}

/** «Azul», «Gris claro»... Para un valor que no es un color, devuelve el propio valor. */
export function colorName(value: string, language: ColorLanguage): string {
  const known = KNOWN[value.trim().toLowerCase()];
  if (known) return known[language];
  const rgb = parseHex(value);
  return rgb ? approximate(rgb, language) : value;
}
