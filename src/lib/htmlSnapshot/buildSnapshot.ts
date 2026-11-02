import { defaultTreeAdapter, html as parse5Html, serialize, type DefaultTreeAdapterMap } from "parse5";
import { decodeText } from "@/lib/htmlSnapshot/decodeText";
import {
  decodeIdentifierEscapes,
  escapeForStyleElement,
  normalizeCssNewlines,
  scanCss,
  TRANSPARENT_PIXEL,
} from "@/lib/htmlSnapshot/cssScan";
import { parseGuarded } from "@/lib/htmlSnapshot/guardedParse";
import { checkHtmlComplexity } from "@/lib/htmlSnapshot/preParse";
import { SnapshotError, SNAPSHOT_LIMITS, type SnapshotNote } from "@/lib/htmlSnapshot/types";

/**
 * Construye la «instantanea»: UNA pagina HTML autocontenida y ya saneada a partir del HTML descargado.
 *
 * Que hace, en orden:
 *   1. Analiza el HTML con parse5 (analizador HTML5 conforme a la especificacion, el mismo algoritmo que un navegador;
 *      NO se sanea con expresiones regulares sobre el texto).
 *   2. Recorre el arbol y ELIMINA: `<script>`, `<noscript>`, marcos, `<object>/<embed>`, audio/video, `<base>`, `<meta>`,
 *      `<template>`, MathML, animaciones SVG, y todos los `<link>` que no sean hojas de estilo; DESENVUELVE los
 *      `<form>` (sin formulario no hay envio posible) y quita `on*`, `srcdoc`, `action`, `formaction`, `target`,
 *      `javascript:` y cualquier URL que no sea http(s)/fragmento (enlaces) o data: de imagen.
 *   3. Incrusta las HOJAS DE ESTILO (`<link rel=stylesheet>`, `<style>`, `@import`, maximo 10) y las IMAGENES (`<img>`,
 *      `srcset` -> una sola, `background-image` y demas `url()`, maximo 30 distintas) como `<style>` y data URIs, pidiendo
 *      cada recurso por `fetchResource` (que es `guardedFetch`: todas las defensas anti-SSRF). Lo que no se puede
 *      incrustar (tipografias, URL externas) se DESCARTA: la pagina resultante no referencia nada de fuera.
 *   4. Si el resultado pasa del tope (~3,5 MB) omite imagenes, las mas grandes primero, hasta que quepa.
 *   5. Comprueba el resultado volviendo a analizarlo (`assertClean`): si algo peligroso sobreviviera, falla cerrado.
 *
 * Tambien el navegador vuelve a sanear este HTML (`sanitizeHtml` de `htmlToPdf`) y lo monta en un iframe sin scripts con
 * una CSP que solo admite `data:`: son capas independientes de esta.
 */

type Node = DefaultTreeAdapterMap["childNode"];
type ChildNode = DefaultTreeAdapterMap["childNode"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];
type Attribute = Element["attrs"][number];

export type FetchedResource =
  | { ok: true; bytes: Uint8Array; mime: string; contentType: string; url: string }
  | { ok: false };

export type ResourceFetcher = (url: string, kind: "css" | "image") => Promise<FetchedResource>;

export type BuildInput = {
  /** HTML ya decodificado a texto. */
  html: string;
  /** Direccion final de la pagina (base para resolver URL relativas). */
  pageUrl: string;
  fetchResource: ResourceFetcher;
  /** Instante limite (ms desde epoch) para el presupuesto de tiempo cooperativo; por defecto, 10 s desde ahora. */
  deadline?: number;
};

export type BuildOutput = { html: string; title: string; notes: SnapshotNote[] };

/* ------------------------------------------------------------------ *
 * Listas
 * ------------------------------------------------------------------ */

/** Elementos que se eliminan con todo su contenido. */
const REMOVE_ELEMENTS = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "noembed",
  "noframes",
  "audio",
  "video",
  "track",
  "source",
  "param",
  "bgsound",
  "meta",
  "template",
  "base",
  "math",
  "foreignobject",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "discard",
  "feimage",
  "title",
  "keygen",
  "dialog",
]);

/** De los anteriores, los que cuentan como «contenido incrustado» que se avisa al usuario. */
const EMBED_ELEMENTS = new Set(["iframe", "frame", "frameset", "object", "embed", "applet", "portal", "audio", "video"]);

/** Se quita la etiqueta y se conserva el contenido: sin `<form>` no hay envio posible. */
const UNWRAP_ELEMENTS = new Set(["form"]);

/** Atributos que siempre se quitan. */
const DROP_ATTRIBUTES = new Set([
  "srcdoc",
  "ping",
  "action",
  "formaction",
  "formtarget",
  "formmethod",
  "formenctype",
  "form",
  "target",
  "http-equiv",
  "manifest",
  "integrity",
  "nonce",
  "autofocus",
  "contenteditable",
  "crossorigin",
  "referrerpolicy",
  "download",
  "is",
  "loading",
  "decoding",
  "fetchpriority",
  "poster",
  "data",
  "background",
  "cite",
  "longdesc",
  "codebase",
  "profile",
  "icon",
  "usemap",
  "dynsrc",
  "lowsrc",
  "ismap",
]);

/**
 * Atributos de PRESENTACION (SVG y heredados de HTML) cuyo valor es CSS: `fill="url(http://...)"` pide un recurso externo igual
 * que un `style`. Solo se admiten referencias a un fragmento (`url(#degradado)`); cualquier otra se quita.
 */
const PRESENTATION_URL_ATTRIBUTES = new Set([
  "fill",
  "stroke",
  "filter",
  "mask",
  "clip-path",
  "marker",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
  "clip",
  "color-profile",
  "mask-image",
  "list-style-image",
  "background-image",
]);

/** Atributos de carga perezosa de imagenes y sus alternativas. */
const LAZY_SRC_ATTRIBUTES = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-url"];
const LAZY_SRCSET_ATTRIBUTES = ["data-srcset", "data-lazy-srcset"];
const IMAGE_HOUSEKEEPING_ATTRIBUTES = new Set([
  "srcset",
  "sizes",
  ...LAZY_SRC_ATTRIBUTES,
  ...LAZY_SRCSET_ATTRIBUTES,
]);

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** Texto que delata un SVG con scripts o referencias externas: se descarta en vez de intentar sanearlo. */
const HOSTILE_SVG =
  /<\s*script|<\s*foreignObject|<\s*iframe|<\s*object|<\s*embed|<!ENTITY|javascript:|vbscript:|\son[a-z]+\s*=|<\s*(?:animate|set)\b|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/|data:text)/i;

/** CSS peligroso en navegadores antiguos: se neutraliza aunque hoy no funcione. */
function neutralizeLegacyCss(css: string): string {
  return css
    .replace(/expression\s*\(/gi, "blocked(")
    .replace(/javascript\s*:/gi, "blocked:")
    .replace(/vbscript\s*:/gi, "blocked:")
    .replace(/-moz-binding/gi, "x-binding")
    .replace(/behavior\s*:/gi, "x-blocked:");
}

/* ------------------------------------------------------------------ *
 * Imagenes: validacion de bytes
 * ------------------------------------------------------------------ */

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** Comprueba que los bytes son de verdad lo que dice el tipo (una imagen «image/png» que es HTML se descarta). */
export function validateImageBytes(mime: string, bytes: Uint8Array): string | null {
  const type = mime === "image/vnd.microsoft.icon" ? "image/x-icon" : mime;
  if (!IMAGE_MIMES.has(mime) || bytes.length === 0) return null;
  switch (type) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ? type : null;
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]) ? type : null;
    case "image/gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ? type : null;
    case "image/webp":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8) ? type : null;
    case "image/bmp":
      return startsWith(bytes, [0x42, 0x4d]) ? type : null;
    case "image/x-icon":
      return startsWith(bytes, [0, 0, 1, 0]) || startsWith(bytes, [0, 0, 2, 0]) ? type : null;
    case "image/avif":
      return startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) ? type : null;
    case "image/svg+xml": {
      const text = new TextDecoder("utf-8").decode(bytes);
      if (!/<\s*svg[\s>]/i.test(text) || HOSTILE_SVG.test(text)) return null;
      return type;
    }
    default:
      return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * `data:` ya incrustado en la pagina (o en su CSS): solo imagenes, con tope. Se DECODIFICA, se valida igual que una imagen
 * descargada (firma de bytes; los SVG sin nada sospechoso) y se vuelve a escribir en base64: asi nunca queda una comilla,
 * un `<` ni nada raro dentro del atributo o del `url("...")`.
 */
export function normalizeInlineDataUri(raw: string): string | null {
  const value = raw.trim();
  if (value.length > 200_000) return null;
  const match = /^data:([a-z]+\/[a-z0-9.+-]+)([^,]*),/i.exec(value);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const base64 = /;\s*base64/i.test(match[2]);
  if (!base64 && mime !== "image/svg+xml") return null;
  const payload = value.slice(match[0].length);
  let bytes: Uint8Array;
  try {
    if (base64) {
      bytes = Buffer.from(payload.replace(/\s+/g, ""), "base64");
    } else {
      let text = payload;
      try {
        text = decodeURIComponent(payload);
      } catch {
        /* un % suelto dentro de un SVG sin codificar: se usa tal cual */
      }
      bytes = new TextEncoder().encode(text);
    }
  } catch {
    return null;
  }
  const valid = validateImageBytes(mime, bytes);
  return valid ? `data:${valid};base64,${toBase64(bytes)}` : null;
}

/* ------------------------------------------------------------------ *
 * srcset
 * ------------------------------------------------------------------ */

type SrcsetCandidate = { url: string; score: number };

/** Espacio segun HTML (no `\s`: sin regex). */
const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

/** Numero decimal corto de un descriptor (`400w`, `1.5x`): como mucho 9 cifras enteras y 3 decimales; sin regex con retroceso. */
function readDescriptorNumber(text: string, unit: "w" | "x"): number | null {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== (unit === "w" ? 119 : 120) && text.charCodeAt(index) !== (unit === "w" ? 87 : 88)) continue;
    // Hacia atras: las cifras (y un punto) que preceden a la unidad.
    let start = index;
    while (start > 0 && start > index - 13 && /[0-9.]/.test(text[start - 1])) start -= 1;
    if (start === index) continue;
    const value = Number(text.slice(start, index));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Lee un `srcset`. ACOTADO a proposito: un atributo hostil de decenas de miles de caracteres no puede costar mas que su
 * longitud (antes, 80 000 cifras en un descriptor tardaban 21,8 s en una regex y 80 000 comas 3 s): se ignora un `srcset` de mas
 * de `maxSrcsetLength` caracteres, se leen como mucho `maxSrcsetCandidates` candidatos y cada descriptor mide <= 64 caracteres.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  const length = value.length;
  if (length > SNAPSHOT_LIMITS.maxSrcsetLength) return out;
  let index = 0;
  while (index < length && out.length < SNAPSHOT_LIMITS.maxSrcsetCandidates) {
    while (index < length && (isSpace(value.charCodeAt(index)) || value.charCodeAt(index) === 44)) index += 1;
    if (index >= length) break;
    const start = index;
    while (index < length && !isSpace(value.charCodeAt(index))) index += 1;
    let end = index;
    let descriptors = "";
    if (value.charCodeAt(end - 1) === 44) {
      while (end > start && value.charCodeAt(end - 1) === 44) end -= 1;
    } else {
      const descriptorStart = index;
      let depth = 0;
      while (index < length && index - descriptorStart < 64) {
        const code = value.charCodeAt(index);
        if (code === 40) depth += 1;
        else if (code === 41) depth -= 1;
        else if (code === 44 && depth === 0) break;
        index += 1;
      }
      // Un descriptor de mas de 64 caracteres no es un descriptor: se salta hasta la siguiente coma.
      if (index - descriptorStart >= 64) {
        while (index < length && value.charCodeAt(index) !== 44) index += 1;
      } else {
        descriptors = value.slice(descriptorStart, index);
      }
    }
    const url = value.slice(start, end);
    if (url === "") continue;
    const width = readDescriptorNumber(descriptors, "w");
    const density = readDescriptorNumber(descriptors, "x");
    // Referencia: una hoja carta a 96 ppp mide 816 px; con densidad 2x harian falta ~1632.
    const score = width !== null ? width : density !== null ? density * 800 : 800;
    out.push({ url, score });
  }
  return out;
}

/** Elige UN candidato: el mas grande que no pase de ~1700 px de ancho; si todos pasan, el mas pequeno. */
export function chooseSrcsetCandidate(candidates: SrcsetCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const fitting = candidates.filter((candidate) => candidate.score <= 1700);
  if (fitting.length > 0) return fitting.reduce((best, current) => (current.score > best.score ? current : best)).url;
  return candidates.reduce((best, current) => (current.score < best.score ? current : best)).url;
}

/* ------------------------------------------------------------------ *
 * Piezas de CSS ya resueltas
 * ------------------------------------------------------------------ */

type RenderPiece = { k: "s"; v: string } | { k: "u"; v: string };

function renderPieces(pieces: RenderPiece[], images: Map<string, string>): string {
  let out = "";
  for (const piece of pieces) {
    out += piece.k === "s" ? piece.v : `url("${images.get(piece.v) ?? TRANSPARENT_PIXEL}")`;
  }
  return neutralizeLegacyCss(out);
}

type StyleTask = {
  element: Element;
  pieces: RenderPiece[];
};

type AttrStyleTask = {
  element: Element;
  pieces: RenderPiece[];
};

type ImageTask = {
  element: Element;
  /** Atributo donde va (o iba) la direccion: `src` en `<img>`, `href` en `<image>` de SVG. */
  attr: "src" | "href";
  url: string;
};

type Counters = {
  scripts: number;
  embeds: number;
  stylesSkipped: number;
  fontFaces: number;
  imagesSkipped: number;
  imagesLimit: number;
  imagesBudget: number;
};

/* ------------------------------------------------------------------ *
 * Utilidades de arbol
 * ------------------------------------------------------------------ */

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function getAttr(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function setAttr(element: Element, name: string, value: string): void {
  const existing = element.attrs.find((attribute) => attribute.name.toLowerCase() === name && !attribute.prefix);
  if (existing) existing.value = value;
  else element.attrs.push({ name, value });
}

function removeAttr(element: Element, name: string): void {
  element.attrs = element.attrs.filter((attribute) => attribute.name.toLowerCase() !== name);
}

function textOf(element: Element): string {
  let text = "";
  for (const child of element.childNodes) if (child.nodeName === "#text") text += (child as TextNode).value;
  return text;
}

function setText(element: Element, text: string): void {
  element.childNodes = [];
  if (text !== "") defaultTreeAdapter.insertText(element, text);
}

function httpUrl(raw: string, base: URL): URL | null {
  try {
    const url = new URL(raw.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Constructor
 * ------------------------------------------------------------------ */

class Builder {
  readonly counters: Counters = {
    scripts: 0,
    embeds: 0,
    stylesSkipped: 0,
    fontFaces: 0,
    imagesSkipped: 0,
    imagesLimit: 0,
    imagesBudget: 0,
  };
  private base: URL;
  private cssTickets = 0;
  private cssBudget = 0;
  private readonly styleTasks: Array<Promise<StyleTask | null>> = [];
  private readonly attrStyles: AttrStyleTask[] = [];
  private readonly imageTasks: ImageTask[] = [];
  title = "";

  constructor(
    private readonly document: DefaultTreeAdapterMap["document"],
    private readonly pageUrl: URL,
    private readonly fetchResource: ResourceFetcher,
    private readonly deadline: number,
  ) {
    this.base = pageUrl;
  }

  /**
   * Presupuesto de tiempo COOPERATIVO. El analizador y los recorridos son sincronos: un temporizador (`AbortSignal.timeout`)
   * no se dispara mientras el hilo esta ocupado, asi que se mira el reloj entre fases y cada ~1000 nodos y se aborta con
   * `timeout`. No interrumpe una sola llamada larga (de ahi los topes de `checkHtmlComplexity`), solo evita encadenar fases.
   */
  checkpoint(): void {
    if (Date.now() > this.deadline) throw new SnapshotError("timeout");
  }

  /* -------------------------- 1. recorrido -------------------------- */

  /**
   * Guarda una tarea de hoja de estilo. Se marca como "atendida" desde ya: si algo la rechaza (tope de CSS, plazo) antes de que
   * `finish()` la espere, Node no la ve como rechazo sin atender (que tumba el proceso); el error le llega a `finish()` igual.
   */
  private trackStyle(task: Promise<StyleTask | null>): void {
    task.catch(() => undefined);
    this.styleTasks.push(task);
  }

  /** `<base href>`: se respeta SOLO para resolver direcciones relativas; el elemento se elimina. */
  private findBase(): void {
    const stack: ParentNode[] = [this.document];
    while (stack.length > 0) {
      const container = stack.pop()!;
      for (const child of container.childNodes) {
        if (!isElement(child)) continue;
        const name = child.tagName.toLowerCase();
        if (name === "base") {
          const href = getAttr(child, "href");
          const resolved = href ? httpUrl(href, this.pageUrl) : null;
          if (resolved) {
            this.base = resolved;
            return;
          }
        } else if (name === "head" || name === "html") {
          stack.push(child);
        }
      }
    }
  }

  private findTitle(): void {
    const stack: ParentNode[] = [this.document];
    while (stack.length > 0) {
      const container = stack.pop()!;
      for (const child of container.childNodes) {
        if (!isElement(child)) continue;
        const name = child.tagName.toLowerCase();
        if (name === "title" && child.namespaceURI === parse5Html.NS.HTML) {
          this.title = textOf(child).replace(/\s+/g, " ").trim().slice(0, 200);
          return;
        }
        if (name === "head" || name === "html") stack.push(child);
      }
    }
  }

  sanitizeTree(): void {
    this.findBase();
    this.findTitle();

    const containers: Array<{ container: ParentNode; depth: number }> = [{ container: this.document, depth: 0 }];
    let visited = 0;
    while (containers.length > 0) {
      const { container, depth } = containers.pop()!;
      // UNA sola pasada por los hijos: se construye la lista nueva en vez de quitar uno a uno con `indexOf` + `splice`
      // (cuadratico: 200 000 `<meta>` tardaban 14,6 s). Los hijos de un `<form>` desenvuelto vuelven a la cola, en su sitio.
      const pending: ChildNode[] = container.childNodes.slice().reverse();
      const kept: ChildNode[] = [];
      while (pending.length > 0) {
        const child = pending.pop()!;
        visited += 1;
        if ((visited & 1023) === 0) this.checkpoint();

        if (child.nodeName === "#comment") continue;
        if (!isElement(child)) {
          kept.push(child);
          continue;
        }

        const name = child.tagName.toLowerCase();

        if (REMOVE_ELEMENTS.has(name)) {
          if (name === "script") this.counters.scripts += 1;
          if (EMBED_ELEMENTS.has(name)) this.counters.embeds += 1;
          child.parentNode = null;
          continue;
        }

        if (UNWRAP_ELEMENTS.has(name)) {
          for (let index = child.childNodes.length - 1; index >= 0; index -= 1) pending.push(child.childNodes[index]);
          child.parentNode = null;
          child.childNodes = [];
          continue;
        }

        if (depth + 1 > SNAPSHOT_LIMITS.maxDepth) {
          child.parentNode = null;
          continue;
        }

        if (name === "link") {
          const replacement = this.handleLink(child);
          child.parentNode = null;
          if (replacement) {
            replacement.parentNode = container;
            kept.push(replacement);
          }
          continue;
        }

        if (name === "style") {
          this.handleStyleElement(child);
          child.parentNode = container;
          kept.push(child);
          continue;
        }

        this.cleanAttributes(child, name);
        if (name === "img") this.handleImg(child);
        else if (name === "image") this.handleSvgImage(child);

        // Hijos: `<template>` ya se elimino; el resto se recorre.
        child.parentNode = container;
        kept.push(child);
        containers.push({ container: child, depth: depth + 1 });
      }
      container.childNodes = kept;
    }
  }

  private handleLink(element: Element): Element | null {
    const rel = (getAttr(element, "rel") ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet") || rel.includes("alternate")) return null;
    if (getAttr(element, "disabled") !== undefined) return null;
    const href = getAttr(element, "href");
    const target = href ? httpUrl(href, this.base) : null;
    if (!target) return null;

    if (this.cssTickets >= SNAPSHOT_LIMITS.maxStylesheets) {
      this.counters.stylesSkipped += 1;
      return null;
    }
    this.cssTickets += 1;

    const style = defaultTreeAdapter.createElement("style", parse5Html.NS.HTML, []);
    const media = (getAttr(element, "media") ?? "").trim();
    this.trackStyle(
      (async () => {
        const result = await this.fetchResource(target.href, "css");
        if (!result.ok || result.mime !== "text/css") {
          this.counters.stylesSkipped += 1;
          return null;
        }
        const css = decodeText(result.bytes, result.contentType, "css");
        const pieces = await this.expandCss(css, new URL(result.url), 1);
        return { element: style, pieces: this.wrapMedia(media, pieces) };
      })(),
    );
    return style;
  }

  private handleStyleElement(element: Element): void {
    const media = (getAttr(element, "media") ?? "").trim();
    const css = textOf(element);
    element.attrs = [];
    setText(element, "");
    this.trackStyle(
      this.expandCss(css, this.base, 0).then((pieces) => ({ element, pieces: this.wrapMedia(media, pieces) })),
    );
  }

  private wrapMedia(media: string, pieces: RenderPiece[]): RenderPiece[] {
    if (media === "" || /^all$/i.test(media) || /[{};]/.test(media)) return pieces;
    return [{ k: "s", v: `@media ${media}{` }, ...pieces, { k: "s", v: "}" }];
  }

  /** Atributos: quita lo peligroso y normaliza los enlaces. */
  private cleanAttributes(element: Element, name: string): void {
    const kept: Attribute[] = [];
    for (const attribute of element.attrs) {
      const attrName = attribute.name.toLowerCase();

      if (attrName.startsWith("on") || DROP_ATTRIBUTES.has(attrName) || (attrName.startsWith("xmlns:") && attrName !== "xmlns:xlink")) {
        continue;
      }
      if (attrName === "style") {
        const { pieces } = this.expandInlineStyle(attribute.value);
        this.attrStyles.push({ element, pieces });
        continue; // se vuelve a poner al final, ya resuelto
      }
      if (PRESENTATION_URL_ATTRIBUTES.has(attrName)) {
        // Los escapes CSS (`u\72l(`) valen igual en estos atributos: se comprueba el valor ya decodificado.
        if (cssIsSelfContained(attribute.value)) kept.push(attribute);
        continue;
      }
      if (attrName === "href") {
        if (name === "a" || name === "area") {
          const value = attribute.value.trim();
          if (value.startsWith("#")) kept.push(attribute);
          else {
            const resolved = httpUrl(value, this.base);
            if (resolved) kept.push({ ...attribute, value: resolved.href });
          }
        } else if (name === "use") {
          if (attribute.value.trim().startsWith("#")) kept.push(attribute);
        } else if (name === "image") {
          kept.push(attribute); // lo trata handleSvgImage
        }
        continue;
      }
      if (attrName === "src" || attrName === "srcset" || IMAGE_HOUSEKEEPING_ATTRIBUTES.has(attrName)) {
        if (name === "img") kept.push(attribute); // lo trata handleImg
        continue;
      }
      kept.push(attribute);
    }
    element.attrs = kept;
  }

  private handleImg(element: Element): void {
    const srcset = getAttr(element, "srcset") ?? LAZY_SRCSET_ATTRIBUTES.map((n) => getAttr(element, n)).find(Boolean);
    const src = getAttr(element, "src");
    const lazy = LAZY_SRC_ATTRIBUTES.map((n) => getAttr(element, n)).find((value) => value && value.trim() !== "");

    let raw: string | null = null;
    if (srcset) raw = chooseSrcsetCandidate(parseSrcset(srcset));
    if (!raw && lazy) raw = lazy;
    if (!raw && src) raw = src;
    // `src` es un marcador diminuto (GIF 1x1) y hay una direccion de carga perezosa: manda la perezosa.
    if (raw === src && lazy && src && /^data:/i.test(src.trim()) && src.length < 2048) raw = lazy;

    for (const housekeeping of IMAGE_HOUSEKEEPING_ATTRIBUTES) removeAttr(element, housekeeping);
    removeAttr(element, "src");
    if (!raw) return;

    const inline = /^\s*data:/i.test(raw) ? normalizeInlineDataUri(raw) : null;
    if (inline) {
      setAttr(element, "src", inline);
      return;
    }
    const target = httpUrl(raw, this.base);
    if (target) this.imageTasks.push({ element, attr: "src", url: target.href });
  }

  private handleSvgImage(element: Element): void {
    const raw = getAttr(element, "href");
    removeAttr(element, "href");
    if (!raw) return;
    const inline = /^\s*data:/i.test(raw) ? normalizeInlineDataUri(raw) : null;
    if (inline) {
      setAttr(element, "href", inline);
      return;
    }
    const target = httpUrl(raw, this.base);
    if (target) this.imageTasks.push({ element, attr: "href", url: target.href });
  }

  /* -------------------------- 2. CSS -------------------------- */

  private resolveCssUrl(raw: string, base: URL): RenderPiece {
    const value = raw.trim();
    if (value === "") return { k: "s", v: `url("${TRANSPARENT_PIXEL}")` };
    if (value.startsWith("#")) return { k: "s", v: `url("${value.replace(/["\\\n\r]/g, "")}")` };
    if (/^data:/i.test(value)) {
      const inline = normalizeInlineDataUri(value);
      return { k: "s", v: `url("${inline ?? TRANSPARENT_PIXEL}")` };
    }
    const target = httpUrl(value, base);
    return target ? { k: "u", v: target.href } : { k: "s", v: `url("${TRANSPARENT_PIXEL}")` };
  }

  /**
   * Presupuesto de CSS EXPANDIDO del snapshot entero (`maxCssExpanded`, 3 MB): texto + lo que ocupara cada `url()` una vez
   * resuelta (un `url(a)` de 6 caracteres pasa a `url("data:image/gif;base64,...")`, ~90: 10 hojas de 1 MB llenas de `url()` se
   * expandian a ~1,3 GB). Se carga ANTES de construir nada, a partir del recuento del lector, y al pasarse es `too-large`.
   */
  private chargeCss(pieces: ReadonlyArray<{ kind: string; value?: string }>): void {
    let cost = 0;
    for (const piece of pieces) cost += piece.kind === "text" ? (piece.value?.length ?? 0) : TRANSPARENT_PIXEL.length + 8;
    this.cssBudget += cost;
    if (this.cssBudget > SNAPSHOT_LIMITS.maxCssExpanded) throw new SnapshotError("too-large");
  }

  /** Rechaza ANTES de escanear lo que ya no cabe en el presupuesto de CSS (el escaner reserva memoria proporcional al texto). */
  private precheckCss(css: string): void {
    if (this.cssBudget + css.length > SNAPSHOT_LIMITS.maxCssExpanded) throw new SnapshotError("too-large");
  }

  private expandInlineStyle(css: string): { pieces: RenderPiece[] } {
    this.precheckCss(css);
    const { pieces } = scanCss(css);
    this.chargeCss(pieces);
    const out: RenderPiece[] = [];
    for (const piece of pieces) {
      if (piece.kind === "text") out.push({ k: "s", v: piece.value });
      else if (piece.kind === "url") out.push(this.resolveCssUrl(piece.value, this.base));
    }
    return { pieces: out };
  }

  private async expandCss(css: string, base: URL, depth: number): Promise<RenderPiece[]> {
    this.precheckCss(css);
    const { pieces, fontFaceBlocks } = scanCss(css);
    this.counters.fontFaces += fontFaceBlocks;
    this.chargeCss(pieces);

    const parts = await Promise.all(
      pieces.map(async (piece): Promise<RenderPiece[]> => {
        if (piece.kind === "text") return [{ k: "s", v: piece.value }];
        if (piece.kind === "url") return [this.resolveCssUrl(piece.value, base)];

        // @import: el boleto se toma ANTES de esperar, para que el orden (y el tope de 10) sea el del documento.
        const target = httpUrl(piece.value, base);
        if (!target || depth >= SNAPSHOT_LIMITS.maxImportDepth || this.cssTickets >= SNAPSHOT_LIMITS.maxStylesheets) {
          this.counters.stylesSkipped += 1;
          return [];
        }
        this.cssTickets += 1;
        const result = await this.fetchResource(target.href, "css");
        if (!result.ok || result.mime !== "text/css") {
          this.counters.stylesSkipped += 1;
          return [];
        }
        const inner = await this.expandCss(decodeText(result.bytes, result.contentType, "css"), new URL(result.url), depth + 1);
        // `layer(...)`/`supports(...)` no se pueden envolver en @media: se incrusta sin condicion.
        const media = /\b(?:layer|supports)\b/i.test(piece.media) ? "" : piece.media.trim();
        return this.wrapMedia(media, inner);
      }),
    );
    return parts.flat();
  }

  /* -------------------------- 3. ensamblado -------------------------- */

  async finish(): Promise<BuildOutput> {
    this.checkpoint();
    const styleResults = (await Promise.all(this.styleTasks)).filter((task): task is StyleTask => task !== null);
    // Las hojas que fallaron dejan su `<style>` vacio; se retiran para no ensuciar el HTML.
    // (Un `<link>` fallido ya sumo en stylesSkipped.)

    // ----- Imagenes: lista distinta, `<img>` primero, luego estilos en linea, luego hojas de estilo.
    const occurrences = new Map<string, number>();
    const order: string[] = [];
    const note = (url: string) => {
      if (!occurrences.has(url)) order.push(url);
      occurrences.set(url, (occurrences.get(url) ?? 0) + 1);
    };
    for (const task of this.imageTasks) note(task.url);
    for (const task of this.attrStyles) for (const piece of task.pieces) if (piece.k === "u") note(piece.v);
    for (const task of styleResults) for (const piece of task.pieces) if (piece.k === "u") note(piece.v);

    const wanted = order.slice(0, SNAPSHOT_LIMITS.maxImages);
    this.counters.imagesLimit = order.length - wanted.length;

    // url -> bytes ya validados. El base64 se calcula SOLO para las imagenes que al final se incluyen: pasar a base64 (x1,33) las
    // 30 imagenes de 2,5 MB para descartar despues casi todas cuesta ~100 MB de cadenas.
    const fetched = new Map<string, { mime: string; bytes: Uint8Array; dataLength: number }>();
    const queue = [...wanted];
    const worker = async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        const result = await this.fetchResource(url, "image");
        const mime = result.ok ? validateImageBytes(result.mime, result.bytes) : null;
        if (!result.ok || !mime) {
          this.counters.imagesSkipped += 1;
          continue;
        }
        const dataLength = `data:${mime};base64,`.length + Math.ceil(result.bytes.length / 3) * 4;
        // Una imagen que ya sola no cabe en la respuesta no se guarda ni se pasa a base64.
        if (dataLength > SNAPSHOT_LIMITS.maxResponseBytes - 100_000) {
          this.counters.imagesBudget += 1;
          continue;
        }
        fetched.set(url, { mime, bytes: result.bytes, dataLength });
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker));
    this.checkpoint();

    // ----- Tamano: primero SIN imagenes, para saber cuanto sitio queda.
    const apply = (included: Map<string, string>) => {
      for (const task of styleResults) setText(task.element, escapeForStyleElement(renderPieces(task.pieces, included)));
      for (const task of this.attrStyles) {
        const value = renderPieces(task.pieces, included);
        removeAttr(task.element, "style");
        if (value.trim() !== "") setAttr(task.element, "style", value);
      }
      for (const task of this.imageTasks) {
        removeAttr(task.element, task.attr);
        const data = included.get(task.url);
        if (data) setAttr(task.element, task.attr, data);
      }
    };

    // Los `<style>` de enlaces fallidos o vacios sobran.
    const styleElements = new Set(styleResults.map((task) => task.element));
    this.pruneEmptyStyles(styleElements);

    apply(new Map());
    this.prepareHead();
    // El tope es sobre la RESPUESTA JSON, no sobre el HTML crudo: `JSON.stringify` duplica comillas y saltos de linea y escribe
    // un caracter de control como 6 (una pagina de 1,4 MB de `"` ya ocupa 2,8 MB). Se deja margen para titulo, direccion y avisos.
    const htmlBudget = SNAPSHOT_LIMITS.maxResponseBytes - 24_000;
    const jsonBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf-8");
    const baseBytes = jsonBytes(serialize(this.document));
    this.checkpoint();
    const room = htmlBudget - baseBytes - 64 * 1024;
    if (room < 0) throw new SnapshotError("too-large");

    const cost = (url: string) => (fetched.get(url)?.dataLength ?? 0) * (occurrences.get(url) ?? 1);
    const included = new Map<string, string>();
    let used = 0;
    // Las mas pequenas primero: se omiten antes las mas grandes.
    for (const url of [...fetched.keys()].sort((a, b) => cost(a) - cost(b))) {
      if (used + cost(url) > room) {
        this.counters.imagesBudget += 1;
        continue;
      }
      used += cost(url);
      const image = fetched.get(url)!;
      included.set(url, `data:${image.mime};base64,${toBase64(image.bytes)}`);
    }

    apply(included);
    let html = serialize(this.document);
    // Margen de seguridad: si por la codificacion aun pasa del tope, se van quitando las mas grandes.
    while (jsonBytes(html) > htmlBudget && included.size > 0) {
      const largest = [...included.keys()].sort((a, b) => cost(b) - cost(a))[0];
      included.delete(largest);
      this.counters.imagesBudget += 1;
      apply(included);
      html = serialize(this.document);
      this.checkpoint();
    }
    if (jsonBytes(html) > htmlBudget) throw new SnapshotError("too-large");

    assertClean(html);
    this.checkpoint();

    const littleContent = this.counters.scripts > 0 && this.visibleTextLength() < 120;
    return { html, title: this.title, notes: this.notes(littleContent) };
  }

  private pruneEmptyStyles(keep: Set<Element>): void {
    const stack: ParentNode[] = [this.document];
    while (stack.length > 0) {
      const container = stack.pop()!;
      const kept: ChildNode[] = [];
      for (const child of container.childNodes) {
        if (isElement(child) && child.tagName.toLowerCase() === "style" && !keep.has(child)) {
          child.parentNode = null;
          continue;
        }
        kept.push(child);
        if (isElement(child)) stack.push(child);
      }
      container.childNodes = kept;
    }
  }

  /** `<meta charset>` primero en `<head>` (el HTML se serializa siempre en UTF-8). */
  private prepareHead(): void {
    const html = this.document.childNodes.find((node): node is Element => isElement(node) && node.tagName === "html");
    const head = html?.childNodes.find((node): node is Element => isElement(node) && node.tagName === "head");
    if (!head) return;
    const meta = defaultTreeAdapter.createElement("meta", parse5Html.NS.HTML, [{ name: "charset", value: "utf-8" }]);
    head.childNodes.unshift(meta);
    meta.parentNode = head;
  }

  private visibleTextLength(): number {
    let total = 0;
    const stack: ParentNode[] = [this.document];
    while (stack.length > 0 && total < 120) {
      const container = stack.pop()!;
      for (const child of container.childNodes) {
        if (child.nodeName === "#text") total += (child as TextNode).value.replace(/\s+/g, " ").trim().length;
        else if (isElement(child) && !["style", "head", "svg"].includes(child.tagName.toLowerCase())) stack.push(child);
      }
    }
    return total;
  }

  private notes(littleContent: boolean): SnapshotNote[] {
    const c = this.counters;
    const notes: SnapshotNote[] = [];
    if (c.scripts > 0) notes.push({ code: "scripts-ignored", count: c.scripts });
    if (littleContent) notes.push({ code: "little-content" });
    if (c.embeds > 0) notes.push({ code: "embeds-omitted", count: c.embeds });
    if (c.stylesSkipped > 0) notes.push({ code: "styles-skipped", count: c.stylesSkipped });
    if (c.fontFaces > 0) notes.push({ code: "fonts-omitted", count: c.fontFaces });
    if (c.imagesSkipped > 0) notes.push({ code: "images-skipped", count: c.imagesSkipped });
    if (c.imagesLimit > 0) notes.push({ code: "images-limit", count: c.imagesLimit });
    if (c.imagesBudget > 0) notes.push({ code: "images-budget", count: c.imagesBudget });
    return notes;
  }
}

/* ------------------------------------------------------------------ *
 * Comprobacion final
 * ------------------------------------------------------------------ */

const FORBIDDEN_AFTER = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "link",
  "form",
  "template",
  "math",
  "audio",
  "video",
]);

/**
 * Todo `url(...)` apunta a un data URI o a un fragmento, y no queda ningun `@import` ni `image-set`. Se comprueba sobre el texto
 * con los saltos de linea NORMALIZADOS y los escapes de letras DECODIFICADOS en todas partes, tambien dentro de cadenas y
 * comentarios (`u\72l(http://x)` es `url(http://x)`; un `\f` dentro de una cadena CSS la cierra): sobre-decodificar solo hace
 * ver MAS cosas sospechosas. Falla cerrado ante cualquier forma camuflada.
 *
 * Recorrido LINEAL a mano (una regex `url\(\s*["']?(?:data:|#)[^"')]*...` era cuadratica con `url(#url(#url(#...`: 200 KB = 7,5 s):
 * cada `url(` consume hasta su `)`, y el primer `url(` que no encaje devuelve `false` sin seguir.
 */
function cssIsSelfContained(css: string): boolean {
  const text = decodeIdentifierEscapes(normalizeCssNewlines(css), true).toLowerCase();
  if (text.includes("@import") || /image-set\s*\(/.test(text)) return false;

  const length = text.length;
  let index = 0;
  while ((index = text.indexOf("url", index)) !== -1) {
    let cursor = index + 3;
    while (cursor < length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] !== "(") {
      index += 3; // la palabra `url` suelta (un nombre, una cadena): no es una funcion
      continue;
    }
    cursor += 1;
    while (cursor < length && /\s/.test(text[cursor])) cursor += 1;
    const quote = text[cursor] === '"' || text[cursor] === "'" ? text[cursor] : "";
    if (quote) cursor += 1;
    if (!(text.startsWith("data:", cursor) || text[cursor] === "#")) return false;
    // Hasta el cierre: sin parentesis ni comillas distintas dentro (un `url(` anidado o un valor raro no es seguro).
    for (; cursor < length; cursor += 1) {
      const char = text[cursor];
      if (char === ")" || char === '"' || char === "'" || char === "(") break;
    }
    if (cursor >= length) return false;
    if (text[cursor] === '"' || text[cursor] === "'") {
      if (text[cursor] !== quote) return false;
      cursor += 1;
      while (cursor < length && /\s/.test(text[cursor])) cursor += 1;
    }
    if (text[cursor] !== ")") return false;
    index = cursor + 1;
  }
  return true;
}

/**
 * Vuelve a analizar el resultado (lo que veria un navegador) y falla si queda algo de lo que se elimino. Es la red de
 * seguridad frente a un analisis/serializacion que no sean simetricos (mXSS): nunca deberia saltar.
 */
export function assertClean(html: string): void {
  const reparsed = parseGuarded(html);
  const stack: ParentNode[] = [reparsed];
  while (stack.length > 0) {
    const container = stack.pop()!;
    for (const child of container.childNodes) {
      if (!isElement(child)) continue;
      const name = child.tagName.toLowerCase();
      if (FORBIDDEN_AFTER.has(name)) throw new SnapshotError("unreachable");
      if (name === "meta" && getAttr(child, "http-equiv") !== undefined) throw new SnapshotError("unreachable");
      for (const attribute of child.attrs) {
        const attrName = attribute.name.toLowerCase();
        if (attrName.startsWith("on") || attrName === "srcdoc" || attrName === "formaction" || attrName === "action") {
          throw new SnapshotError("unreachable");
        }
        if (
          (attrName === "href" || attrName === "src") &&
          /^\s*(?:javascript|vbscript|file|blob):/i.test(attribute.value.replace(/[\u0000- ]/g, ""))
        ) {
          throw new SnapshotError("unreachable");
        }
        if (attrName === "src" && /^(?:https?:)?\/\//i.test(attribute.value.trim())) throw new SnapshotError("unreachable");
        if ((attrName === "style" || PRESENTATION_URL_ATTRIBUTES.has(attrName)) && !cssIsSelfContained(attribute.value)) {
          throw new SnapshotError("unreachable");
        }
      }
      if (name === "style" && !cssIsSelfContained(textOf(child))) throw new SnapshotError("unreachable");
      stack.push(child);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Punto de entrada
 * ------------------------------------------------------------------ */

export async function buildSnapshot(input: BuildInput): Promise<BuildOutput> {
  let pageUrl: URL;
  try {
    pageUrl = new URL(input.pageUrl);
  } catch {
    throw new SnapshotError("invalid-url");
  }
  // Tope DURO antes de analizar (el analizador es sincrono y cuadratico con ciertos documentos hostiles).
  if (input.html.length > SNAPSHOT_LIMITS.maxPageBytes || !checkHtmlComplexity(input.html)) throw new SnapshotError("too-large");
  const deadline = input.deadline ?? Date.now() + SNAPSHOT_LIMITS.totalTimeoutMs;
  const document = parseGuarded(input.html);
  if (Date.now() > deadline) throw new SnapshotError("timeout");
  const builder = new Builder(document, pageUrl, input.fetchResource, deadline);
  builder.sanitizeTree();
  builder.checkpoint();
  return builder.finish();
}
