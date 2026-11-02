import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPrintMedia,
  buildBaseCss,
  collectBreakConstraints,
  neutralizeFloatingElements,
  prepareDocumentForPdf,
  rewriteViewportUnits,
} from "@/lib/pdf/htmlToPdfLayout";
import { sanitizeHtml } from "@/lib/pdf/htmlToPdf";

/**
 * jsdom (sin motor de maquetacion): la geometria se SIMULA con `getBoundingClientRect` y `Range.getClientRects`, que
 * devuelven las cajas que cada prueba declara. Que de verdad se midan bien en un navegador lo cubre el E2E
 * (`e2e/specs/html-to-pdf-layout.spec.ts`, Chromium real).
 */

type Rect = { top: number; bottom: number; left?: number; width?: number };
const toRect = (rect: Rect): DOMRect =>
  ({ top: rect.top, bottom: rect.bottom, left: rect.left ?? 0, right: (rect.left ?? 0) + (rect.width ?? 600), width: rect.width ?? 600, height: rect.bottom - rect.top, x: 0, y: rect.top }) as DOMRect;

const rectsByText = new Map<string, Rect[]>();
const rectsByElement = new Map<Element, Rect>();

function installGeometry() {
  // jsdom no implementa `Range.getClientRects`: se define para la prueba y se retira al terminar.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    writable: true,
    value: function (this: Range) {
      const found = rectsByText.get(this.toString().trim()) ?? [];
      const list = found.map(toRect);
      return Object.assign(list, { item: (index: number) => list[index] }) as unknown as DOMRectList;
    },
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const known = rectsByElement.get(this);
    return known ? toRect(known) : toRect({ top: 0, bottom: 0, width: 0 });
  });
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Documento CON ventana (el de jsdom): lo que necesitan `getComputedStyle` y `defaultView`, como el iframe real. */
function load(html: string): Document {
  const parsed = parse(html);
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  return document;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (Range.prototype as unknown as Record<string, unknown>).getClientRects;
  rectsByText.clear();
  rectsByElement.clear();
});

describe("applyPrintMedia", () => {
  it("print pasa a all (con y sin condiciones) y deja lo demas como esta", () => {
    expect(applyPrintMedia("@media print{a{display:none}}")).toBe("@media all{a{display:none}}");
    expect(applyPrintMedia("@media print and (min-width: 600px){a{x:1}}")).toBe("@media all and (min-width: 600px){a{x:1}}");
    expect(applyPrintMedia("@media only print{a{x:1}}")).toBe("@media only all{a{x:1}}");
    expect(applyPrintMedia("@media screen, print{a{x:1}}")).toBe("@media screen, all{a{x:1}}");
    expect(applyPrintMedia("@media screen{a{x:1}}")).toBe("@media screen{a{x:1}}");
    expect(applyPrintMedia("@media not print{a{x:1}}")).toBe("@media not print{a{x:1}}");
    expect(applyPrintMedia("@media (max-width:600px){a{x:1}} @media print{b{x:2}}")).toBe("@media (max-width:600px){a{x:1}} @media all{b{x:2}}");
  });
});

describe("rewriteViewportUnits", () => {
  it("vh/dvh/svh/lvh se convierten en px de una pagina", () => {
    expect(rewriteViewportUnits("a{min-height:100vh}", 1000)).toBe("a{min-height:1000px}");
    expect(rewriteViewportUnits("a{height:50.5vh;top:-10dvh}", 800)).toBe("a{height:404px;top:-80px}");
    expect(rewriteViewportUnits("a{height:calc(100svh - 20px)}", 1000)).toBe("a{height:calc(1000px - 20px)}");
    expect(rewriteViewportUnits("a{width:100vw;height:10px}", 1000)).toBe("a{width:100vw;height:10px}");
  });
});

describe("prepareDocumentForPdf / sanitizeHtml con preparacion", () => {
  const SOURCE = `<html><head>
    <style>.hero{height:100vh} @media print{nav{display:none}}</style>
    <style media="print">.solo-impresion{color:#000}</style>
  </head><body><div style="min-height:100vh">x</div><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></body></html>`;

  it("aplica @media print, convierte vh (hojas y atributos style) e inyecta la hoja base la primera", () => {
    const doc = parse(SOURCE);
    prepareDocumentForPdf(doc, { viewportHeightPx: 1000 });
    const styles = Array.from(doc.querySelectorAll("style"));
    expect(styles[0].getAttribute("data-optimus")).toBe("print-base");
    expect(styles[0].textContent).toBe(buildBaseCss(1000));
    expect(styles[1].textContent).toContain(".hero{height:1000px}");
    expect(styles[1].textContent).toContain("@media all{nav{display:none}}");
    expect(styles[2].hasAttribute("media")).toBe(false);
    expect(doc.querySelector("div")!.getAttribute("style")).toBe("min-height:1000px");
  });

  it("la hoja base ajusta imagenes al ancho, limita su alto, hace crecer html/body y quita animaciones", () => {
    const css = buildBaseCss(1088);
    expect(css).toMatch(/img[^{]*\{max-width:100%!important\}/);
    expect(css).toContain("max-height:1000px!important");
    expect(css).toMatch(/html,body\{height:auto!important/);
    expect(css).toContain("animation-fill-mode:forwards!important");
  });

  it("sanitizeHtml sin preparacion se comporta como siempre (sin hoja base)", () => {
    const out = sanitizeHtml("<html><body><script>1</script><p>x</p></body></html>");
    expect(out).not.toContain("data-optimus");
    expect(out).not.toContain("<script");
  });

  it("sanitizeHtml con preparacion: la hoja base va DESPUES de la CSP y antes de las hojas de la pagina", () => {
    const out = sanitizeHtml(SOURCE, { viewportHeightPx: 1000 });
    const doc = parse(out);
    const head = Array.from(doc.head.children).map((child) => child.localName);
    expect(head.slice(0, 2)).toEqual(["meta", "meta"]);
    expect(doc.head.querySelector("style")!.getAttribute("data-optimus")).toBe("print-base");
    expect(doc.head.firstElementChild!.getAttribute("http-equiv")).toBe("Content-Security-Policy");
  });
});

describe("neutralizeFloatingElements", () => {
  const VIEWPORT = { width: 816, height: 1056 };

  function setup(html: string) {
    return load(html);
  }

  it("sticky pasa al flujo; una barra fija de ancho completo tambien, y el aviso de cookies se oculta", () => {
    installGeometry();
    const doc = setup(`<html><body>
      <header id="top" style="position:fixed;top:0">menu</header>
      <div id="sticky" style="position:sticky;top:0">pegajoso</div>
      <div id="cookie-banner" class="cookie-consent" style="position:fixed;bottom:0">Usamos cookies</div>
      <button id="chat" style="position:fixed;right:10px;bottom:10px">chat</button>
      <footer id="foot" style="position:fixed;bottom:0">pie</footer>
      <p id="text">Contenido normal</p>
    </body></html>`);
    rectsByElement.set(doc.getElementById("top")!, { top: 0, bottom: 60, width: 816 });
    rectsByElement.set(doc.getElementById("cookie-banner")!, { top: 980, bottom: 1056, width: 816 });
    rectsByElement.set(doc.getElementById("chat")!, { top: 990, bottom: 1040, width: 50, left: 750 });
    rectsByElement.set(doc.getElementById("foot")!, { top: 1000, bottom: 1056, width: 816 });

    const result = neutralizeFloatingElements(doc, VIEWPORT);
    expect(result).toEqual({ madeStatic: 3, removed: 2 });
    expect(doc.getElementById("top")!.style.getPropertyValue("position")).toBe("static");
    expect(doc.getElementById("sticky")!.style.getPropertyValue("position")).toBe("static");
    expect(doc.getElementById("foot")!.style.getPropertyValue("position")).toBe("static");
    expect(doc.getElementById("cookie-banner")!.style.getPropertyValue("display")).toBe("none");
    expect(doc.getElementById("chat")!.style.getPropertyValue("display")).toBe("none");
    expect(doc.getElementById("text")!.getAttribute("style")).toBeNull();
  });

  it("una capa fija a pantalla completa con mucho texto (una app) se conserva; un modal vacio se quita", () => {
    installGeometry();
    const doc = setup(`<html><body>
      <main id="app" style="position:fixed;inset:0">${"Texto de la aplicacion. ".repeat(10)}</main>
      <div id="modal" role="dialog" aria-modal="true" style="position:fixed;inset:0">Suscribete</div>
    </body></html>`);
    rectsByElement.set(doc.getElementById("app")!, { top: 0, bottom: 1056, width: 816 });
    rectsByElement.set(doc.getElementById("modal")!, { top: 0, bottom: 1056, width: 816 });
    neutralizeFloatingElements(doc, VIEWPORT);
    expect(doc.getElementById("app")!.style.getPropertyValue("position")).toBe("static");
    expect(doc.getElementById("modal")!.style.getPropertyValue("display")).toBe("none");
  });

  it("sin documento o sin cuerpo no hace nada", () => {
    expect(neutralizeFloatingElements(document.implementation.createHTMLDocument("x"), VIEWPORT)).toEqual({ madeStatic: 0, removed: 0 });
  });
});

describe("collectBreakConstraints", () => {
  it("lineas de texto (con holgura de tinta), imagenes y filas de tabla son duras", () => {
    installGeometry();
    const doc = load(`<html><body><p id="p">Linea uno</p><img id="i" src="x.png"><table><tbody><tr id="r"><td>celda</td></tr></tbody></table></body></html>`);
    rectsByText.set("Linea uno", [{ top: 100, bottom: 120 }]);
    rectsByText.set("celda", [{ top: 400, bottom: 420 }]);
    rectsByElement.set(doc.getElementById("i")!, { top: 200, bottom: 300 });
    rectsByElement.set(doc.getElementById("r")!, { top: 390, bottom: 430 });

    const { hard } = collectBreakConstraints(doc, { pageHeightPx: 1000 });
    expect(hard).toContainEqual([102, 118]); // 20 px de alto, 10 % de holgura por lado
    expect(hard).toContainEqual([200, 300]);
    expect(hard).toContainEqual([390, 430]);
  });

  it("una fila mas alta que una pagina NO es indivisible", () => {
    installGeometry();
    const doc = load(`<html><body><table><tbody><tr id="r"><td>x</td></tr></tbody></table></body></html>`);
    rectsByElement.set(doc.getElementById("r")!, { top: 0, bottom: 2000 });
    const { hard } = collectBreakConstraints(doc, { pageHeightPx: 1000 });
    expect(hard).not.toContainEqual([0, 2000]);
  });

  it("un encabezado se queda con lo que le sigue", () => {
    installGeometry();
    const doc = load(`<html><body><h2 id="h">Titulo</h2><p>Parrafo</p></body></html>`);
    rectsByText.set("Titulo", [{ top: 500, bottom: 530 }]);
    rectsByText.set("Parrafo", [{ top: 545, bottom: 565 }]);
    rectsByElement.set(doc.getElementById("h")!, { top: 500, bottom: 530 });
    const { keep } = collectBreakConstraints(doc, { pageHeightPx: 1000 });
    expect(keep).toEqual([[500, 563]]);
  });

  it("viudas y huerfanas: parrafo de 3 lineas = un bloque; de 6 = dos primeras y dos ultimas", () => {
    installGeometry();
    const doc = load(`<html><body><p id="a">corto</p><p id="b">largo</p></body></html>`);
    const lineRects = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ top: start + i * 24, bottom: start + i * 24 + 20 }));
    rectsByText.set("corto", lineRects(0, 3));
    rectsByText.set("largo", lineRects(200, 6));
    const { orphans } = collectBreakConstraints(doc, { pageHeightPx: 1000 });
    expect(orphans).toContainEqual([0, 68]);
    expect(orphans).toContainEqual([200, 244]);
    expect(orphans).toContainEqual([296, 340]);
    expect(orphans).toHaveLength(3);
  });

  it("break-inside: avoid de la propia pagina hace el bloque indivisible (si cabe en una pagina)", () => {
    installGeometry();
    const doc = load(`<html><head></head><body><div class="card" id="c">a</div><div id="d">b</div></body></html>`);
    rectsByElement.set(doc.getElementById("c")!, { top: 300, bottom: 600 });
    rectsByElement.set(doc.getElementById("d")!, { top: 700, bottom: 800 });
    // jsdom no conoce `break-inside`: se simula el valor calculado de la hoja de la pagina (`.card{break-inside:avoid}`).
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
      const style = original(element);
      return new Proxy(style, {
        get: (target, property) => (property === "breakInside" ? (element.classList.contains("card") ? "avoid" : "auto") : Reflect.get(target, property)),
      });
    });
    const { hard } = collectBreakConstraints(doc, { pageHeightPx: 1000 });
    expect(hard).toContainEqual([300, 600]);
    expect(hard).not.toContainEqual([700, 800]);
  });

  it("documento vacio -> sin restricciones", () => {
    installGeometry();
    expect(collectBreakConstraints(load("<html><body></body></html>"), { pageHeightPx: 1000 })).toEqual({ hard: [], keep: [], orphans: [] });
  });
});
