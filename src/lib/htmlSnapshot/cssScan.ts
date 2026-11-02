/**
 * Lector minimo de CSS para incrustar recursos. NO es un analizador completo: recorre el texto respetando comentarios y
 * cadenas y separa las tres cosas que importan para la incrustacion:
 *
 *   - `url(...)`          -> pieza `url` (la direccion cruda; luego se resuelve y se cambia por un data URI);
 *   - `@import ...;`      -> pieza `import` (direccion y lista de medios);
 *   - `@font-face {...}`  -> se ELIMINA el bloque entero (las tipografias propias no se incluyen);
 *   - `image-set(...)`, `cross-fade(...)`, `element(...)`, `src(...)` -> `none` (referencian recursos por cadena de texto y
 *     no pasarian por la incrustacion).
 * Los comentarios se descartan. Todo lo demas pasa tal cual en piezas `text`.
 *
 * Es seguro ante CSS hostil: no ejecuta nada, recorre una sola vez (lineal) y, si algo viene mal cerrado, descarta el
 * resto en lugar de adivinar.
 */

export type CssPiece =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string }
  | { kind: "import"; value: string; media: string };

export type CssScanResult = { pieces: CssPiece[]; fontFaceBlocks: number };

function skipString(css: string, start: number): number {
  const quote = css[start];
  let index = start + 1;
  while (index < css.length) {
    const char = css[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    // Un salto de linea sin escapar cierra la cadena (CSS: cadena mal formada).
    if (char === "\n") return index;
    index += 1;
  }
  return css.length;
}

function skipWhitespace(css: string, start: number): number {
  let index = start;
  while (index < css.length && /\s/.test(css[index])) index += 1;
  return index;
}

/** Lee el contenido de un `url(` que empieza en `open` (la posicion del parentesis). Devuelve valor y posicion tras `)`. */
function readUrlToken(css: string, open: number): { value: string; end: number } | null {
  let index = skipWhitespace(css, open + 1);
  const quote = css[index];
  let value: string;
  if (quote === '"' || quote === "'") {
    const end = skipString(css, index);
    value = css.slice(index + 1, css[end - 1] === quote ? end - 1 : end);
    index = skipWhitespace(css, end);
  } else {
    const begin = index;
    while (index < css.length && css[index] !== ")") {
      if (css[index] === "\\") index += 1;
      index += 1;
    }
    value = css.slice(begin, index).trim();
  }
  if (css[index] !== ")") return null;
  return { value: value.replace(/\\(.)/g, "$1"), end: index + 1 };
}

function skipBalanced(css: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < css.length) {
    const char = css[index];
    if (char === '"' || char === "'") {
      index = skipString(css, index);
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return css.length;
}

const FUNCTION_TO_NONE = /^(?:-webkit-)?(?:image-set|cross-fade|element|src)\(/i;

export function scanCss(input: string): CssScanResult {
  const css = input.replace(/<!--|-->/g, " ");
  const pieces: CssPiece[] = [];
  let buffer = "";
  let fontFaceBlocks = 0;
  let index = 0;

  const flush = () => {
    if (buffer !== "") {
      pieces.push({ kind: "text", value: buffer });
      buffer = "";
    }
  };

  while (index < css.length) {
    const char = css[index];

    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = skipString(css, index);
      buffer += css.slice(index, end);
      index = end;
      continue;
    }
    if (char === "\\") {
      buffer += css.slice(index, index + 2);
      index += 2;
      continue;
    }

    if (char === "@") {
      const name = /^@([a-zA-Z-]+)/.exec(css.slice(index, index + 32))?.[1].toLowerCase() ?? "";

      if (name === "import") {
        let cursor = skipWhitespace(css, index + "@import".length);
        let target: string | null = null;
        if (/^url\(/i.test(css.slice(cursor, cursor + 4))) {
          const token = readUrlToken(css, cursor + 3);
          if (token) {
            target = token.value;
            cursor = token.end;
          }
        } else if (css[cursor] === '"' || css[cursor] === "'") {
          const end = skipString(css, cursor);
          target = css.slice(cursor + 1, css[end - 1] === css[cursor] ? end - 1 : end);
          cursor = end;
        }
        // Resto de la sentencia (lista de medios, `layer(...)`, `supports(...)`) hasta el `;`.
        let tailEnd = cursor;
        while (tailEnd < css.length && css[tailEnd] !== ";" && css[tailEnd] !== "}") {
          if (css[tailEnd] === '"' || css[tailEnd] === "'") tailEnd = skipString(css, tailEnd);
          else if (css[tailEnd] === "(") tailEnd = skipBalanced(css, tailEnd);
          else tailEnd += 1;
        }
        const tail = css.slice(cursor, tailEnd).trim();
        flush();
        if (target !== null) pieces.push({ kind: "import", value: target, media: tail });
        index = css[tailEnd] === ";" ? tailEnd + 1 : tailEnd;
        continue;
      }

      if (name === "font-face") {
        let cursor = index;
        while (cursor < css.length && css[cursor] !== "{") cursor += 1;
        let depth = 0;
        while (cursor < css.length) {
          const current = css[cursor];
          if (current === '"' || current === "'") {
            cursor = skipString(css, cursor);
            continue;
          }
          if (current === "{") depth += 1;
          if (current === "}") {
            depth -= 1;
            if (depth === 0) {
              cursor += 1;
              break;
            }
          }
          cursor += 1;
        }
        fontFaceBlocks += 1;
        index = cursor;
        continue;
      }

      if (name === "charset") {
        const end = css.indexOf(";", index);
        index = end === -1 ? css.length : end + 1;
        continue;
      }
    }

    // `url(` no precedido de un caracter de identificador (no es parte de `-foo-url(`).
    if ((char === "u" || char === "U") && /^url\(/i.test(css.slice(index, index + 4)) && !/[\w-]/.test(css[index - 1] ?? "")) {
      const token = readUrlToken(css, index + 3);
      if (!token) {
        // `url(` sin cerrar: se descarta el resto en vez de adivinar.
        break;
      }
      flush();
      pieces.push({ kind: "url", value: token.value });
      index = token.end;
      continue;
    }

    if (/[a-zA-Z-]/.test(char) && !/[\w-]/.test(css[index - 1] ?? "")) {
      const head = css.slice(index, index + 18);
      const match = FUNCTION_TO_NONE.exec(head);
      if (match) {
        index = skipBalanced(css, index + match[0].length - 1);
        buffer += "none";
        continue;
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return { pieces, fontFaceBlocks };
}

/** Texto final de una pieza `url` ya resuelta. `null` = recurso omitido: se pone un GIF transparente de 1x1 para que la regla siga siendo valida. */
export const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Evita que el contenido salga de su `<style>` o abra comentarios HTML al volver a analizarse. */
export function escapeForStyleElement(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}
