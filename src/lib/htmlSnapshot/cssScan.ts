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
    // Un salto de linea sin escapar cierra la cadena (CSS: cadena mal formada). En CSS son saltos de linea \n, \r y \f (y \r\n):
    // si aqui solo cerrara \n, un `\f` dentro de una cadena haria que este lector siguiera "dentro" de ella mientras el navegador
    // ya salio, y lo que viene despues (`u\72l(http://...)`) pasaria sin verse.
    if (char === "\n" || char === "\r" || char === "\f") return index;
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

/**
 * En CSS son saltos de linea `\n`, `\r`, `\r\n` y `\f`: todos se llevan a `\n` para que ningun lector de este modulo (ni el
 * navegador, que si los trata asi) discrepe en donde acaba una cadena. Se aplica al INICIO de `scanCss` y de la comprobacion de salida.
 */
export function normalizeCssNewlines(css: string): string {
  return css.replace(/\r\n?|\f/g, "\n");
}

/**
 * Decodifica los escapes CSS que escriben una LETRA (o `-`/`_`): `u\72l(` y `\75rl(` son `url(`, `@\69mport` es `@import`,
 * `\69mage-set(` es `image-set(`. El navegador los entiende igual que si estuvieran escritos normales, asi que el lector tiene que
 * verlos igual o se cuelan por debajo de las comprobaciones (se vio en la revision de seguridad). Los demas escapes (`\:`, `\/`,
 * `\31 0`: los de los nombres de clase de Tailwind) NO se tocan. Respeta comentarios y cadenas. Sigue la sintaxis de CSS: de 1 a
 * 6 digitos hexadecimales y UN espacio opcional de cierre; `\` + letra no hexadecimal es esa letra.
 *
 * Con `everywhere`, decodifica TAMBIEN dentro de cadenas y comentarios (sobre-decodificar solo hace que la comprobacion final
 * vea MAS cosas sospechosas, nunca menos): es lo que usa la comprobacion de salida, que no puede fiarse de donde empieza y
 * acaba una cadena.
 */
export function decodeIdentifierEscapes(css: string, everywhere = false): string {
  if (!css.includes("\\")) return css;
  const parts: string[] = [];
  let last = 0;
  let index = 0;
  const length = css.length;
  const isHex = (char: string) => (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F");
  const isLetter = (char: string) => (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");

  while (index < length) {
    const char = css[index];
    if (!everywhere && char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }
    if (!everywhere && (char === '"' || char === "'")) {
      index = skipString(css, index);
      continue;
    }
    if (char !== "\\") {
      index += 1;
      continue;
    }
    const next = css[index + 1] ?? "";
    let decoded = "";
    let end = index + 2;
    if (isHex(next)) {
      let digits = 1;
      end = index + 2;
      while (end < length && digits < 6 && isHex(css[end])) {
        end += 1;
        digits += 1;
      }
      const code = parseInt(css.slice(index + 1, end), 16);
      // Un espacio (o CRLF) detras cierra el escape y se consume con el.
      if (css[end] === "\r" && css[end + 1] === "\n") end += 2;
      else if (end < length && /[ \t\n\r\f]/.test(css[end])) end += 1;
      const letter = code < 128 ? String.fromCharCode(code) : "";
      if (isLetter(letter) || letter === "-" || letter === "_") decoded = letter;
    } else if (isLetter(next)) {
      decoded = next;
    }
    if (decoded !== "") {
      parts.push(css.slice(last, index), decoded);
      last = end;
    }
    index = end;
  }
  parts.push(css.slice(last));
  return parts.join("");
}

export function scanCss(input: string): CssScanResult {
  const css = decodeIdentifierEscapes(normalizeCssNewlines(input)).replace(/<!--|-->/g, " ");
  const pieces: CssPiece[] = [];
  let buffer = "";
  let fontFaceBlocks = 0;
  let index = 0;
  // Los caracteres normales se acumulan como UN tramo (`plainStart`..`to`) y se copian con `slice` al llegar algo especial:
  // `buffer += char` caracter a caracter creaba una cadena de cons de ~32 bytes por caracter (1,4 MB de `a` = ~44 MB por hoja).
  let plainStart = -1;
  const commit = (to: number) => {
    if (plainStart !== -1) {
      buffer += css.slice(plainStart, to);
      plainStart = -1;
    }
  };

  const flush = (to: number) => {
    commit(to);
    if (buffer !== "") {
      pieces.push({ kind: "text", value: buffer });
      buffer = "";
    }
  };

  while (index < css.length) {
    const char = css[index];

    if (char === "/" && css[index + 1] === "*") {
      commit(index);
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      commit(index);
      const end = skipString(css, index);
      buffer += css.slice(index, end);
      index = end;
      continue;
    }
    if (char === "\\") {
      commit(index);
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
        flush(index);
        if (target !== null) pieces.push({ kind: "import", value: target, media: tail });
        index = css[tailEnd] === ";" ? tailEnd + 1 : tailEnd;
        continue;
      }

      if (name === "font-face") {
        commit(index);
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
        commit(index);
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
        commit(index);
        break;
      }
      flush(index);
      pieces.push({ kind: "url", value: token.value });
      index = token.end;
      continue;
    }

    if (/[a-zA-Z-]/.test(char) && !/[\w-]/.test(css[index - 1] ?? "")) {
      const head = css.slice(index, index + 18);
      const match = FUNCTION_TO_NONE.exec(head);
      if (match) {
        commit(index);
        index = skipBalanced(css, index + match[0].length - 1);
        buffer += "none";
        continue;
      }
    }

    if (plainStart === -1) plainStart = index;
    index += 1;
  }

  flush(css.length > index ? index : css.length);
  return { pieces, fontFaceBlocks };
}

/** Texto final de una pieza `url` ya resuelta. `null` = recurso omitido: se pone un GIF transparente de 1x1 para que la regla siga siendo valida. */
export const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Evita que el contenido salga de su `<style>` o abra comentarios HTML al volver a analizarse. */
export function escapeForStyleElement(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}
