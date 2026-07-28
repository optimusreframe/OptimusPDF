import { describe, expect, it } from "vitest";
import {
  CAPTURE_SCALE_MAX,
  CAPTURE_SCALE_MIN,
  DEFAULT_HTML_TO_PDF_OPTIONS,
  MAX_CANVAS_DIMENSION,
  MAX_HTML_BYTES,
  PX_PER_PT,
  decodeHtml,
  htmlToPdf,
  isHtmlFile,
  isSafeResourceUrl,
  isSafeSrcset,
  planCaptureChunks,
  planPageSlices,
  resolveCaptureScale,
  resolvePageGeometry,
  sniffHtmlCharset,
  type HtmlToPdfOptions,
} from "@/lib/pdf/htmlToPdf";

/**
 * QUE SE PUEDE PROBAR AQUI Y QUE NO.
 *
 * `vitest.config.ts` usa `environment: "node"`: no hay DOM, ni `<iframe>`,
 * ni `<canvas>`, ni `DOMParser`. La mitad "de render" del motor depende
 * por definicion de un navegador real:
 *
 *   - `sanitizeHtml` / `sanitizeDocument` necesitan `DOMParser` (Node no
 *     lo expone; no se puede anadir `jsdom`/`happy-dom` sin tocar
 *     `package.json`, que esta fuera del alcance de este workstream).
 *   - `mountSandboxedFrame` necesita `document.createElement("iframe")`,
 *     el ciclo de carga de `srcdoc` y el propio motor de maquetacion.
 *   - `html2canvas` necesita DOM + `getComputedStyle` + canvas, y el
 *     troceado de bandas necesita `canvas.getContext("2d")` y
 *     `toDataURL`.
 *   - `jsPDF` se importa dinamicamente solo cuando ya hay canvas.
 *
 * Por eso este archivo cubre exclusivamente la logica PURA, que es la que
 * decide el resultado geometrico y de seguridad del motor:
 *
 *   1. validacion de entrada (`isHtmlFile` + los guardas de `htmlToPdf`,
 *      que fallan antes de tocar el DOM),
 *   2. deteccion de charset y decodificacion de bytes,
 *   3. geometria de pagina y escala de captura,
 *   4. paginacion (troceado de captura y bandas de pagina),
 *   5. la politica de URLs del saneador (`isSafeResourceUrl` /
 *      `isSafeSrcset`), que es codigo de seguridad y no depende del DOM.
 *
 * Lo que NO cubre —que el `<iframe sandbox>` impide de verdad la
 * ejecucion de scripts, que html2canvas produce el pixel correcto y que
 * el PDF resultante abre— se verifica manualmente en navegador con
 * ficheros reales (incluida una sonda `<script>alert(1)</script>`), igual
 * que en el resto de motores dependientes de DOM del repositorio.
 */

/* ------------------------------------------------------------------ *
 * Entrada
 * ------------------------------------------------------------------ */

function makeFile(
  name: string,
  content = "<html></html>",
  type = "text/html",
): File {
  return new File([content], name, { type });
}

describe("isHtmlFile — src/lib/pdf/htmlToPdf.ts", () => {
  it("acepta por extension aunque el navegador no informe MIME", () => {
    expect(isHtmlFile(makeFile("pagina.html", "<p>x</p>", ""))).toBe(true);
    expect(isHtmlFile(makeFile("PAGINA.HTM", "<p>x</p>", ""))).toBe(true);
    expect(isHtmlFile(makeFile("doc.xhtml", "<p>x</p>", ""))).toBe(true);
  });

  it("acepta por MIME aunque la extension no lo diga", () => {
    expect(isHtmlFile(makeFile("descarga", "<p>x</p>", "text/html"))).toBe(true);
  });

  it("rechaza cualquier otra cosa", () => {
    expect(isHtmlFile(makeFile("documento.pdf", "%PDF-", "application/pdf"))).toBe(
      false,
    );
    expect(isHtmlFile(makeFile("script.js", "alert(1)", "text/javascript"))).toBe(
      false,
    );
  });
});

describe("htmlToPdf — guardas de entrada (fallan antes de tocar el DOM)", () => {
  it("un archivo que no es HTML se rechaza con 'invalidType'", async () => {
    await expect(
      htmlToPdf(makeFile("documento.pdf", "%PDF-", "application/pdf")),
    ).rejects.toMatchObject({ code: "invalidType" });
  });

  it("un archivo vacio se rechaza con 'empty'", async () => {
    await expect(htmlToPdf(makeFile("vacio.html", ""))).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("un archivo por encima del limite se rechaza con 'tooLarge'", async () => {
    const huge = makeFile("grande.html", "x");
    // `File.size` es de solo lectura: se sustituye para no materializar
    // 20 MB en memoria solo para comprobar el guarda.
    Object.defineProperty(huge, "size", { value: MAX_HTML_BYTES + 1 });

    await expect(htmlToPdf(huge)).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("una senal ya abortada corta con 'cancelled' sin leer el archivo", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      htmlToPdf(
        makeFile("pagina.html"),
        DEFAULT_HTML_TO_PDF_OPTIONS,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

/* ------------------------------------------------------------------ *
 * Charset
 * ------------------------------------------------------------------ */

function bytesOf(text: string, ...prefix: number[]): Uint8Array {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

describe("sniffHtmlCharset / decodeHtml", () => {
  it("sin pistas asume UTF-8", () => {
    expect(sniffHtmlCharset(bytesOf("<p>hola</p>"))).toBe("utf-8");
  });

  it("el BOM manda por encima de todo", () => {
    expect(sniffHtmlCharset(bytesOf("<p>x</p>", 0xef, 0xbb, 0xbf))).toBe("utf-8");
    expect(sniffHtmlCharset(bytesOf("", 0xff, 0xfe))).toBe("utf-16le");
    expect(sniffHtmlCharset(bytesOf("", 0xfe, 0xff))).toBe("utf-16be");
  });

  it("lee el <meta charset> declarado en la cabecera", () => {
    const html = '<html><head><meta charset="ISO-8859-1"></head><body>x</body></html>';
    expect(sniffHtmlCharset(bytesOf(html))).toBe("iso-8859-1");
  });

  it("lee tambien la forma larga de <meta http-equiv>", () => {
    const html =
      '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">';
    expect(sniffHtmlCharset(bytesOf(html))).toBe("windows-1252");
  });

  it("decodifica latin-1 respetando el charset declarado", () => {
    // 0xF1 es "ñ" en ISO-8859-1 y byte invalido en UTF-8.
    const header = new TextEncoder().encode(
      '<meta charset="iso-8859-1"><p>a',
    );
    const tail = new TextEncoder().encode("o</p>");
    const bytes = new Uint8Array(header.length + 1 + tail.length);
    bytes.set(header, 0);
    bytes[header.length] = 0xf1;
    bytes.set(tail, header.length + 1);

    expect(decodeHtml(bytes)).toContain("año");
  });

  it("un charset desconocido no revienta: recae en UTF-8", () => {
    const bytes = bytesOf('<meta charset="klingon-1"><p>hola</p>');
    expect(decodeHtml(bytes)).toContain("hola");
  });
});

/* ------------------------------------------------------------------ *
 * Geometria
 * ------------------------------------------------------------------ */

describe("resolvePageGeometry", () => {
  it("A4 vertical con margen pequeno deja el area util esperada", () => {
    const geometry = resolvePageGeometry({
      pageSize: "a4",
      orientation: "portrait",
      margin: "small",
    });

    expect(geometry.pageWidth).toBeCloseTo(595.28, 2);
    expect(geometry.pageHeight).toBeCloseTo(841.89, 2);
    expect(geometry.margin).toBe(36);
    expect(geometry.contentWidth).toBeCloseTo(595.28 - 72, 2);
    expect(geometry.contentHeight).toBeCloseTo(841.89 - 72, 2);
  });

  it("horizontal intercambia los lados de la pagina", () => {
    const portrait = resolvePageGeometry({
      pageSize: "letter",
      orientation: "portrait",
      margin: "none",
    });
    const landscape = resolvePageGeometry({
      pageSize: "letter",
      orientation: "landscape",
      margin: "none",
    });

    expect(landscape.pageWidth).toBe(portrait.pageHeight);
    expect(landscape.pageHeight).toBe(portrait.pageWidth);
  });

  it("sin margen el area util es la pagina entera", () => {
    const geometry = resolvePageGeometry({
      pageSize: "a4",
      orientation: "portrait",
      margin: "none",
    });
    expect(geometry.margin).toBe(0);
    expect(geometry.contentWidth).toBeCloseTo(geometry.pageWidth, 5);
    expect(geometry.contentHeight).toBeCloseTo(geometry.pageHeight, 5);
  });

  it("el margen nunca se come la pagina: siempre queda area util positiva", () => {
    for (const pageSize of ["a4", "letter"] as const) {
      for (const orientation of ["portrait", "landscape"] as const) {
        for (const margin of ["none", "small", "large"] as const) {
          const geometry = resolvePageGeometry({ pageSize, orientation, margin });
          expect(geometry.contentWidth).toBeGreaterThan(0);
          expect(geometry.contentHeight).toBeGreaterThan(0);
          expect(geometry.margin * 2).toBeLessThan(geometry.pageWidth);
          expect(geometry.margin * 2).toBeLessThan(geometry.pageHeight);
        }
      }
    }
  });

  it("las opciones por defecto son A4 vertical con margen pequeno", () => {
    const defaults: HtmlToPdfOptions = DEFAULT_HTML_TO_PDF_OPTIONS;
    expect(defaults).toEqual({
      pageSize: "a4",
      orientation: "portrait",
      margin: "small",
    });
  });

  it("PX_PER_PT convierte puntos a pixeles CSS a 96 dpi", () => {
    expect(PX_PER_PT).toBeCloseTo(96 / 72, 10);
    expect(72 * PX_PER_PT).toBeCloseTo(96, 10);
  });
});

/* ------------------------------------------------------------------ *
 * Escala de captura
 * ------------------------------------------------------------------ */

describe("resolveCaptureScale", () => {
  it("respeta el valor pedido cuando cabe en el presupuesto", () => {
    expect(resolveCaptureScale(700, 1.5)).toBeCloseTo(1.5, 5);
  });

  it("acota por arriba y por abajo al rango soportado", () => {
    expect(resolveCaptureScale(700, 99)).toBe(CAPTURE_SCALE_MAX);
    expect(resolveCaptureScale(700, 0.1)).toBe(CAPTURE_SCALE_MIN);
  });

  it("un ancho enorme baja la escala para no pasarse del lado maximo", () => {
    const scale = resolveCaptureScale(20_000, 2);
    expect(scale * 20_000).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION);
  });

  it("tolera entradas degeneradas sin devolver NaN", () => {
    expect(Number.isFinite(resolveCaptureScale(0, Number.NaN))).toBe(true);
    expect(resolveCaptureScale(0, Number.NaN)).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Paginacion
 * ------------------------------------------------------------------ */

describe("planCaptureChunks", () => {
  it("un documento que cabe entero produce un unico trozo", () => {
    const chunks = planCaptureChunks(1500, 1000, 8000);
    expect(chunks).toEqual([{ y: 0, height: 1500 }]);
  });

  it("cada trozo mide un numero entero de paginas", () => {
    const chunks = planCaptureChunks(10_000, 1000, 3500);
    // floor(3500 / 1000) = 3 paginas por trozo -> 3000 px CSS.
    expect(chunks.slice(0, 3)).toEqual([
      { y: 0, height: 3000 },
      { y: 3000, height: 3000 },
      { y: 6000, height: 3000 },
    ]);
    expect(chunks[chunks.length - 1]).toEqual({ y: 9000, height: 1000 });
  });

  it("los trozos son contiguos y suman la altura total", () => {
    const chunks = planCaptureChunks(7321, 1026, 4200);
    let cursor = 0;
    for (const chunk of chunks) {
      expect(chunk.y).toBe(cursor);
      expect(chunk.height).toBeGreaterThan(0);
      cursor += chunk.height;
    }
    expect(cursor).toBe(7321);
  });

  it("si ni una pagina cabe en el presupuesto, se emite una pagina por trozo", () => {
    const chunks = planCaptureChunks(3000, 1000, 10);
    expect(chunks).toEqual([
      { y: 0, height: 1000 },
      { y: 1000, height: 1000 },
      { y: 2000, height: 1000 },
    ]);
  });

  it("nunca devuelve una lista vacia ni entra en bucle con alturas cero", () => {
    expect(planCaptureChunks(0, 0, 0)).toEqual([{ y: 0, height: 1 }]);
  });
});

describe("planPageSlices", () => {
  it("reparte el canvas en bandas contiguas sin solape ni hueco", () => {
    const slices = planPageSlices(2500, 1000);
    expect(slices).toEqual([
      { y: 0, height: 1000 },
      { y: 1000, height: 1000 },
      { y: 2000, height: 500 },
    ]);
  });

  it("con bandas fraccionarias los limites no acumulan error", () => {
    const sliceHeight = 1026.52;
    const slices = planPageSlices(4106, sliceHeight);

    let cursor = 0;
    for (const slice of slices) {
      expect(slice.y).toBe(cursor);
      cursor += slice.height;
    }
    // La ultima banda cierra exactamente en el borde del canvas.
    expect(cursor).toBe(4106);
    expect(slices.length).toBe(4);
  });

  it("un canvas mas corto que una pagina produce una sola banda", () => {
    expect(planPageSlices(300, 1000)).toEqual([{ y: 0, height: 300 }]);
  });

  it("un canvas sin altura no produce paginas", () => {
    expect(planPageSlices(0, 1000)).toEqual([]);
    expect(planPageSlices(-5, 1000)).toEqual([]);
  });

  it("descarta la banda residual de menos de un pixel", () => {
    // 2000 / 999.6 = 2.0008 -> la tercera banda mediria 0 px reales.
    const slices = planPageSlices(2000, 999.6);
    expect(slices.every((slice) => slice.height >= 1)).toBe(true);
    expect(slices[slices.length - 1].y + slices[slices.length - 1].height).toBe(
      2000,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Politica de URLs del saneador (codigo de seguridad, sin DOM)
 * ------------------------------------------------------------------ */

describe("isSafeResourceUrl", () => {
  it("acepta relativas, fragmentos y http(s)", () => {
    for (const url of [
      "",
      "#seccion",
      "imagen.png",
      "./assets/logo.svg",
      "/static/a.css",
      "//cdn.example.com/a.png",
      "http://example.com/a.png",
      "HTTPS://EXAMPLE.COM/a.png",
    ]) {
      expect(isSafeResourceUrl(url)).toBe(true);
    }
  });

  it("rechaza javascript: y vbscript: en cualquier caja", () => {
    expect(isSafeResourceUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeResourceUrl("JaVaScRiPt:alert(1)")).toBe(false);
    expect(isSafeResourceUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("rechaza javascript: camuflado con espacios y caracteres de control", () => {
    expect(isSafeResourceUrl("  javascript:alert(1)")).toBe(false);
    expect(isSafeResourceUrl("java\nscript:alert(1)")).toBe(false);
    expect(isSafeResourceUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeResourceUrl(" javascript:alert(1)")).toBe(false);
  });

  it("solo deja pasar data: de imagen, nunca data:text/html", () => {
    expect(isSafeResourceUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isSafeResourceUrl("data:image/svg+xml;utf8,<svg/>")).toBe(true);
    expect(isSafeResourceUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
    expect(isSafeResourceUrl("data:application/javascript,alert(1)")).toBe(false);
  });

  it("rechaza esquemas que escapan del sandbox del navegador", () => {
    expect(isSafeResourceUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeResourceUrl("blob:https://example.com/abc")).toBe(false);
    expect(isSafeResourceUrl("filesystem:https://example.com/temporary/a")).toBe(
      false,
    );
  });
});

describe("isSafeSrcset", () => {
  it("acepta un srcset cuyos candidatos son todos seguros", () => {
    expect(isSafeSrcset("a.png 1x, https://cdn.example.com/b.png 2x")).toBe(true);
  });

  it("basta un candidato peligroso para descartar el atributo entero", () => {
    expect(isSafeSrcset("a.png 1x, javascript:alert(1) 2x")).toBe(false);
  });
});
