import { SNAPSHOT_LIMITS } from "@/lib/htmlSnapshot/types";

/**
 * Filtro BARATO (lineal) del HTML antes de entregarlo a parse5. NO es la defensa contra el coste del analizador: esa esta
 * DENTRO del analizador (`guardedParse.ts`: elementos creados y profundidad de la pila). Aqui solo se acota lo que el
 * `treeAdapter` no ve, el coste del TOKENIZADOR con una etiqueta que lleva decenas de miles de atributos (parse5 compara cada
 * atributo nuevo con todos los anteriores: 120 000 atributos = 15 s), y de paso el numero total de etiquetas.
 *
 * El recuento de atributos sigue la maquina de estados del tokenizador de HTML (no una aproximacion): un atributo empieza tras un
 * espacio, tras `/` y tras cerrar las comillas de otro (`a="1"b="2"`, `a/b/c` son atributos separados); las comillas solo
 * delimitan un valor justo despues de `=` (en un nombre, `a"b` son letras). Se rechaza una etiqueta con mas de `maxAttributes`
 * atributos o con mas de `maxTagBytes` bytes fuera del contenido de sus valores entre comillas (un valor largo, como un
 * `data:` de una imagen, es lineal y legitimo).
 *
 * Que se salta, a proposito SOLO lo que el tokenizador tambien trata como texto: comentarios (incluidos los abruptos `<!-->`,
 * `<!--->` y el cierre `--!>`), declaraciones y el contenido de `script`, `style`, `textarea`, `title`, `xmp`, `iframe`,
 * `noembed` y `noframes` FUERA de `<svg>`/`<math>` (dentro, el contenido es marcado normal). Ante la duda NO se salta: contar
 * de mas solo puede rechazar una pagina rara, nunca dejar pasar una etiqueta que parse5 si vera.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen", "command"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noembed", "noframes", "iframe"]);

const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isNameChar = (code: number) => isLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58 || code === 95;
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

export type HtmlComplexity = { tags: number; maxTagBytes: number; maxAttributes: number };

type Limits = { maxTags: number; maxAttributes: number; maxTagBytes: number };
const DEFAULT_LIMITS: Limits = {
  maxTags: SNAPSHOT_LIMITS.maxTags,
  maxAttributes: SNAPSHOT_LIMITS.maxAttributesPerTag,
  maxTagBytes: SNAPSHOT_LIMITS.maxTagBytes,
};

const enum State {
  BeforeName,
  Name,
  AfterName,
  BeforeValue,
  DoubleQuoted,
  SingleQuoted,
  Unquoted,
  AfterQuoted,
}

/** Recorre una etiqueta desde `start` (justo tras su nombre) con los estados del tokenizador. */
function scanTag(html: string, start: number, limits: Limits): { end: number; attributes: number; bytes: number; over: boolean } {
  const length = html.length;
  let state: State = State.BeforeName;
  let attributes = 0;
  let bytes = 0; // bytes fuera del contenido de valores entre comillas
  let index = start;
  while (index < length) {
    const code = html.charCodeAt(index);
    switch (state) {
      case State.BeforeName:
        if (isSpace(code) || code === 47) break;
        if (code === 62) return { end: index, attributes, bytes, over: false };
        attributes += 1;
        state = State.Name; // un `=` aqui tambien es parte del nombre
        break;
      case State.Name:
        if (isSpace(code)) state = State.AfterName;
        else if (code === 47) state = State.BeforeName;
        else if (code === 62) return { end: index, attributes, bytes, over: false };
        else if (code === 61) state = State.BeforeValue;
        break;
      case State.AfterName:
        if (isSpace(code)) break;
        if (code === 47) state = State.BeforeName;
        else if (code === 61) state = State.BeforeValue;
        else if (code === 62) return { end: index, attributes, bytes, over: false };
        else {
          attributes += 1;
          state = State.Name;
        }
        break;
      case State.BeforeValue:
        if (isSpace(code)) break;
        if (code === 34) state = State.DoubleQuoted;
        else if (code === 39) state = State.SingleQuoted;
        else if (code === 62) return { end: index, attributes, bytes, over: false };
        else state = State.Unquoted;
        break;
      case State.DoubleQuoted:
      case State.SingleQuoted: {
        // El contenido del valor no cuenta (es lineal): se salta de golpe hasta la comilla de cierre.
        const close = html.indexOf(state === State.DoubleQuoted ? '"' : "'", index);
        index = close === -1 ? length : close;
        state = State.AfterQuoted;
        bytes += 1;
        break;
      }
      case State.Unquoted:
        if (isSpace(code)) state = State.BeforeName;
        else if (code === 62) return { end: index, attributes, bytes, over: false };
        break;
      case State.AfterQuoted:
        if (isSpace(code) || code === 47) state = State.BeforeName;
        else if (code === 62) return { end: index, attributes, bytes, over: false };
        else {
          state = State.BeforeName; // `a="1"b="2"`: se reprocesa como inicio de un atributo nuevo
          continue;
        }
        break;
    }
    bytes += 1;
    index += 1;
    if (attributes > limits.maxAttributes || bytes > limits.maxTagBytes) return { end: index, attributes, bytes, over: true };
  }
  return { end: length, attributes, bytes, over: false };
}

export function measureHtmlComplexity(html: string, limits: Limits = DEFAULT_LIMITS): HtmlComplexity & { within: boolean } {
  const length = html.length;
  let lower: string | null = null;
  let tags = 0;
  let foreign = 0; // `<svg>`/`<math>` abiertos: dentro, ningun elemento cambia el modo del tokenizador
  let maxTagBytes = 0;
  let maxAttributes = 0;
  let index = 0;
  let nextClose = -2; // -2: aun sin buscar
  let nextBang = -2;

  const result = (within: boolean) => ({ tags, maxTagBytes, maxAttributes, within });

  while ((index = html.indexOf("<", index)) !== -1) {
    const next = html.charCodeAt(index + 1);

    if (next === 33 /* ! */) {
      if (html.startsWith("<!--", index)) {
        const after = index + 4;
        if (html.charCodeAt(after) === 62) index = after + 1; // `<!-->`
        else if (html.startsWith("->", after)) index = after + 2; // `<!--->`
        else {
          // Las busquedas fallidas se recuerdan (-1 = no hay mas): repetirlas en cada comentario recorreria el resto del
          // documento una y otra vez (150 000 comentarios `<!--x-->` = cuadratico).
          if (nextClose !== -1 && nextClose < after) nextClose = html.indexOf("-->", after);
          if (nextBang !== -1 && nextBang < after) nextBang = html.indexOf("--!>", after);
          if (nextClose === -1 && nextBang === -1) index = length;
          else if (nextBang === -1 || (nextClose !== -1 && nextClose < nextBang)) index = nextClose + 3;
          else index = nextBang + 4;
        }
      } else {
        const end = html.indexOf(">", index + 2);
        index = end === -1 ? length : end + 1;
      }
      continue;
    }
    if (next === 63 /* ? */) {
      const end = html.indexOf(">", index + 2);
      index = end === -1 ? length : end + 1;
      continue;
    }

    const closing = next === 47; /* / */
    const nameStart = closing ? index + 2 : index + 1;
    if (!isLetter(html.charCodeAt(nameStart))) {
      index += 1; // un `<` suelto en el texto, no una etiqueta
      continue;
    }
    let nameEnd = nameStart + 1;
    while (nameEnd < length && isNameChar(html.charCodeAt(nameEnd))) nameEnd += 1;

    tags += 1;
    if (tags > limits.maxTags) return result(false);
    const name = html.slice(nameStart, nameEnd).toLowerCase();

    const tag = scanTag(html, nameEnd, limits);
    maxAttributes = Math.max(maxAttributes, tag.attributes);
    maxTagBytes = Math.max(maxTagBytes, tag.bytes);
    if (tag.over) return result(false);
    const selfClosing = html.charCodeAt(tag.end - 1) === 47;
    index = tag.end + 1;

    if (name === "svg" || name === "math") {
      if (closing) foreign = Math.max(0, foreign - 1);
      else if (!selfClosing) foreign += 1;
      continue;
    }
    if (!closing && foreign === 0 && RAW_TEXT.has(name) && !VOID.has(name)) {
      // Contenido de texto hasta el cierre: se salta (el `<` de dentro no abre etiquetas).
      lower ??= html.toLowerCase();
      const end = lower.indexOf(`</${name}`, index);
      index = end === -1 ? length : end;
    }
  }
  return result(true);
}

/** `true` si el HTML cabe en los topes baratos del tokenizador. */
export function checkHtmlComplexity(html: string): boolean {
  return measureHtmlComplexity(html).within;
}
