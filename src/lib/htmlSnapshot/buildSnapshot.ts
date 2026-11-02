import { defaultTreeAdapter, html as parse5Html, parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { decodeText } from "@/lib/htmlSnapshot/decodeText";
import { escapeForStyleElement, scanCss, TRANSPARENT_PIXEL } from "@/lib/htmlSnapshot/cssScan";
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

export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  const length = value.length;
  let index = 0;
  while (index < length) {
    while (index < length && /[\s,]/.test(value[index])) index += 1;
    if (index >= length) break;
    const start = index;
    while (index < length && !/\s/.test(value[index])) index += 1;
    let url = value.slice(start, index);
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      const descriptorStart = index;
      let depth = 0;
      while (index < length) {
        const char = value[index];
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        else if (char === "," && depth === 0) break;
        index += 1;
      }
      descriptors = value.slice(descriptorStart, index);
    }
    if (url === "") continue;
    const width = /(\d+(?:\.\d+)?)\s*w\b/i.exec(descriptors);
    const density = /(\d+(?:\.\d+)?)\s*x\b/i.exec(descriptors);
    // Referencia: una hoja carta a 96 ppp mide 816 px; con densidad 2x harian falta ~1632.
    const score = width ? Number(width[1]) : density ? Number(density[1]) * 800 : 800;
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

function detach(node: Node): void {
  const parent = node.parentNode as ParentNode | null;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node as never);
  if (index !== -1) parent.childNodes.splice(index, 1);
  node.parentNode = null;
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
  private readonly styleTasks: Array<Promise<StyleTask | null>> = [];
  private readonly attrStyles: AttrStyleTask[] = [];
  private readonly imageTasks: ImageTask[] = [];
  title = "";

  constructor(
    private readonly document: DefaultTreeAdapterMap["document"],
    private readonly pageUrl: URL,
    private readonly fetchResource: ResourceFetcher,
  ) {
    this.base = pageUrl;
  }

  /* -------------------------- 1. recorrido -------------------------- */

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
    while (containers.length > 0) {
      const { container, depth } = containers.pop()!;
      let index = 0;
      while (index < container.childNodes.length) {
        const child = container.childNodes[index];

        if (child.nodeName === "#comment") {
          detach(child);
          continue;
        }
        if (!isElement(child)) {
          index += 1;
          continue;
        }

        const name = child.tagName.toLowerCase();

        if (REMOVE_ELEMENTS.has(name)) {
          if (name === "script") this.counters.scripts += 1;
          if (EMBED_ELEMENTS.has(name)) this.counters.embeds += 1;
          detach(child);
          continue;
        }

        if (UNWRAP_ELEMENTS.has(name)) {
          // Los hijos ocupan el sitio del elemento y se procesan en esta misma vuelta.
          const children = child.childNodes;
          container.childNodes.splice(index, 1, ...children);
          for (const grandchild of children) grandchild.parentNode = container;
          child.parentNode = null;
          child.childNodes = [];
          continue;
        }

        if (depth + 1 > SNAPSHOT_LIMITS.maxDepth) {
          detach(child);
          continue;
        }

        if (name === "link") {
          const replacement = this.handleLink(child);
          if (replacement) {
            container.childNodes.splice(index, 1, replacement);
            replacement.parentNode = container;
            child.parentNode = null;
            index += 1;
          } else {
            detach(child);
          }
          continue;
        }

        if (name === "style") {
          this.handleStyleElement(child);
          index += 1;
          continue;
        }

        this.cleanAttributes(child, name);
        if (name === "img") this.handleImg(child);
        else if (name === "image") this.handleSvgImage(child);

        // Hijos: `<template>` ya se elimino; el resto se recorre.
        containers.push({ container: child, depth: depth + 1 });
        index += 1;
      }
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
    this.styleTasks.push(
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
    this.styleTasks.push(
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

  private expandInlineStyle(css: string): { pieces: RenderPiece[] } {
    const { pieces } = scanCss(css);
    const out: RenderPiece[] = [];
    for (const piece of pieces) {
      if (piece.kind === "text") out.push({ k: "s", v: piece.value });
      else if (piece.kind === "url") out.push(this.resolveCssUrl(piece.value, this.base));
    }
    return { pieces: out };
  }

  private async expandCss(css: string, base: URL, depth: number): Promise<RenderPiece[]> {
    const { pieces, fontFaceBlocks } = scanCss(css);
    this.counters.fontFaces += fontFaceBlocks;

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

    const fetched = new Map<string, string>(); // url -> data URI
    const queue = [...wanted];
    const worker = async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        const result = await this.fetchResource(url, "image");
        const mime = result.ok ? validateImageBytes(result.mime, result.bytes) : null;
        if (!result.ok || !mime) {
          this.counters.imagesSkipped += 1;
          continue;
        }
        fetched.set(url, `data:${mime};base64,${toBase64(result.bytes)}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker));

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
    const baseBytes = Buffer.byteLength(serialize(this.document), "utf-8");
    const room = SNAPSHOT_LIMITS.maxResponseBytes - baseBytes - 64 * 1024;
    if (room < 0) throw new SnapshotError("too-large");

    const cost = (url: string) => (fetched.get(url)?.length ?? 0) * (occurrences.get(url) ?? 1);
    const included = new Map<string, string>();
    let used = 0;
    // Las mas pequenas primero: se omiten antes las mas grandes.
    for (const url of [...fetched.keys()].sort((a, b) => cost(a) - cost(b))) {
      if (used + cost(url) > room) {
        this.counters.imagesBudget += 1;
        continue;
      }
      used += cost(url);
      included.set(url, fetched.get(url)!);
    }

    apply(included);
    let html = serialize(this.document);
    // Margen de seguridad: si por la codificacion aun pasa del tope, se van quitando las mas grandes.
    while (Buffer.byteLength(html, "utf-8") > SNAPSHOT_LIMITS.maxResponseBytes && included.size > 0) {
      const largest = [...included.keys()].sort((a, b) => cost(b) - cost(a))[0];
      included.delete(largest);
      this.counters.imagesBudget += 1;
      apply(included);
      html = serialize(this.document);
    }
    if (Buffer.byteLength(html, "utf-8") > SNAPSHOT_LIMITS.maxResponseBytes) throw new SnapshotError("too-large");

    assertClean(html);

    const littleContent = this.counters.scripts > 0 && this.visibleTextLength() < 120;
    return { html, title: this.title, notes: this.notes(littleContent) };
  }

  private pruneEmptyStyles(keep: Set<Element>): void {
    const stack: ParentNode[] = [this.document];
    while (stack.length > 0) {
      const container = stack.pop()!;
      for (const child of [...container.childNodes]) {
        if (!isElement(child)) continue;
        if (child.tagName.toLowerCase() === "style" && !keep.has(child)) detach(child);
        else stack.push(child);
      }
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

/** Todo `url(...)` apunta a un data URI o a un fragmento, y no queda ningun `@import`. */
function cssIsSelfContained(css: string): boolean {
  const rest = css.replace(/url\("(?:data:|#)[^"]*"\)/gi, "");
  return !/url\s*\(|@import|image-set\s*\(/i.test(rest);
}

/**
 * Vuelve a analizar el resultado (lo que veria un navegador) y falla si queda algo de lo que se elimino. Es la red de
 * seguridad frente a un analisis/serializacion que no sean simetricos (mXSS): nunca deberia saltar.
 */
export function assertClean(html: string): void {
  const reparsed = parse(html, { scriptingEnabled: false });
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
        if (attrName === "style" && !cssIsSelfContained(attribute.value)) throw new SnapshotError("unreachable");
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
  const document = parse(input.html, { scriptingEnabled: false });
  const builder = new Builder(document, pageUrl, input.fetchResource);
  builder.sanitizeTree();
  return builder.finish();
}
