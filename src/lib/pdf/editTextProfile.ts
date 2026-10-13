/**
 * Wave 8 · F2: perfil de glifos del texto ORIGINAL de un bloque. Sirve para
 * validar que lo que el exportador quito del flujo de contenido corresponde de
 * verdad al bloque editado (ni faltan glifos ni sobran). Solo guarda cuentas,
 * nunca el texto: asi un borrador no conserva copia de lo que se reemplazo.
 */

export type GlyphProfile = {
  /** Caracteres NO blancos del texto original (NFKC, por punto de codigo). */
  chars: number;
  /** Cuantos de esos caracteres pueden venir fundidos en una ligadura (ffi, fl...). */
  ligatures: number;
};

const BLANK = new RegExp("[\\s\\u00ad\\u200b-\\u200f\\u2028\\u2029\\ufeff]", "u");

/** Cuenta los puntos de codigo no blancos de `text` ya normalizado. */
export function countNonBlank(text: string): number {
  let n = 0;
  for (const ch of text.normalize("NFKC")) if (!BLANK.test(ch)) n += 1;
  return n;
}

export function glyphProfile(text: string): GlyphProfile {
  const normal = text.normalize("NFKC");
  let ligatures = 0;
  for (const m of normal.matchAll(/ffi|ffl|ff|fi|fl/g)) ligatures += m[0].length - 1;
  return { chars: countNonBlank(normal), ligatures };
}
