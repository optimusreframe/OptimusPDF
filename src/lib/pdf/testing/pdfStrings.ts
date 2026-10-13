import { inflateSync } from "node:zlib";

/**
 * Busqueda de cadenas en un PDF visto desde fuera de cualquier motor (Wave 9 · lote 2): los bytes del archivo y el contenido
 * descomprimido de CADA flujo (flujos de objetos y de contenido incluidos), y las tres formas en que un PDF escribe un texto.
 * Sirve para comprobar que lo quitado ya no esta dentro del archivo y que lo que se conserva SI se encuentra (control positivo).
 */

/** Los bytes del archivo y el contenido descomprimido de CADA flujo `FlateDecode`, todo junto en una cadena `latin1`. */
export function rawFileText(bytes: Uint8Array): string {
  const latin = Buffer.from(bytes).toString("latin1");
  const parts = [latin];
  const open = /stream\r?\n/g;
  for (let match = open.exec(latin); match; match = open.exec(latin)) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    try {
      parts.push(inflateSync(Buffer.from(latin.slice(start, end), "latin1")).toString("latin1"));
    } catch {
      /* flujo sin comprimir o ilegible: ya esta en los bytes tal cual */
    }
    open.lastIndex = end + "endstream".length;
  }
  return parts.join("\n");
}

/** Las tres formas de escribir un texto en un PDF: literal `(texto)`, UTF-16 `<FEFF...>` y hexadecimal de un `Tj`. */
export function spellings(text: string): string[] {
  return [
    text,
    Buffer.from(text, "latin1").toString("hex"),
    Buffer.from(`\uFEFF${text}`, "utf16le").swap16().toString("hex"),
  ];
}

/** `true` si `text` aparece en `haystack` escrito de cualquiera de las tres formas (el hexadecimal sin distinguir mayusculas). */
export function occurs(haystack: string, text: string): boolean {
  const upper = haystack.toUpperCase();
  return spellings(text).some((form) => haystack.includes(form) || upper.includes(form.toUpperCase()));
}
