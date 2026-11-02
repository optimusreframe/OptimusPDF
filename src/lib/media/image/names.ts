import { stripExtension, withSuffix } from "@/lib/pdf/core";

/**
 * Nombres de los archivos de salida. `foto.png` + sufijo «convertida» + `jpg` -> `foto-convertida.jpg` (el mismo patron
 * `withSuffix` que usan las demas herramientas). Dos entradas distintas pueden dar el mismo nombre (`a.png` y `a.jpg` ->
 * `a-convertida.webp` las dos): dentro de un ZIP la segunda pisaria a la primera, asi que se numeran.
 */

/** Solo el nombre (sin ruta: un nombre no puede escribir fuera del ZIP), sin caracteres de control ni puntos al principio. */
function safeBase(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? "";
  const clean = stripExtension(leaf).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.replace(/^\.+/, "").trim() || "imagen";
}

export function outputFileName(inputName: string, suffix: string, extension: string): string {
  // `withSuffix` quita la ultima extension: se le da una ficticia para que no se coma la parte final de un nombre con puntos («foto.v2»).
  return withSuffix(`${safeBase(inputName)}.src`, suffix, extension);
}

/** Pone `name (2).ext` a los repetidos (sin distinguir mayusculas: Windows y macOS tampoco las distinguen). */
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    let counter = 2;
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${base} (${counter})${extension}`;
      counter += 1;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
