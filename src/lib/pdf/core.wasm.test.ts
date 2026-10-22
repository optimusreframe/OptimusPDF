import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDF_STANDARD_FONTS_URL, PDF_WASM_URL, openPdfDocument } from "@/lib/pdf/core";
import { buildImagesCorpus } from "@/lib/pdf/extractAssets/__fixtures__/images/corpus";
import { jbig2SampleBitmap, jpxExpectedPixel, JPX_HEIGHT, JPX_WIDTH } from "@/lib/pdf/extractAssets/__fixtures__/images/codecs";
import { findImageAssets, renderImageAsset } from "@/lib/pdf/extractAssets/images";
import { blobBytes, decodePng, openLegacy } from "@/lib/pdf/extractAssets/images.testUtils";
import nextConfig from "../../../next.config";

/**
 * U7.0 — decodificadores WASM de pdf.js (`openjpeg.wasm`, `jbig2.wasm`, `qcms_bg.wasm`).
 *
 * Sin `wasmUrl`, pdf.js no sabe de donde cargarlos y las imagenes JPX / JBIG2 (tipicas de escaneos) NO se decodifican:
 * «OpenJPEG failed to initialize» / «JBig2 failed to initialize». Estas pruebas fijan: (1) los archivos servidos son
 * byte a byte los de la version instalada de pdfjs-dist, (2) la aplicacion los pasa a `getDocument`, (3) con ellos las
 * imagenes se decodifican EXACTAMENTE y sin ellos no (el control que prueba que la configuracion hace algo), (4) el CSP
 * y las cabeceras los permiten sin abrir ninguna conexion externa.
 */

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, "node_modules", "pdfjs-dist", "wasm");
const SERVED = path.join(ROOT, "public", "pdfjs-wasm");
const WASM_FILES = ["openjpeg.wasm", "jbig2.wasm", "qcms_bg.wasm"];
const FALLBACK_FILES = ["openjpeg_nowasm_fallback.js", "jbig2_nowasm_fallback.js"];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("archivos servidos de public/pdfjs-wasm", () => {
  it("la ruta termina en barra (lo exige pdf.js) y cuelga de la raiz del sitio", () => {
    expect(PDF_WASM_URL).toBe("/pdfjs-wasm/");
    expect(PDF_WASM_URL.endsWith("/")).toBe(true);
    expect(PDF_STANDARD_FONTS_URL).toBe("/standard_fonts/");
  });

  it.each([...WASM_FILES, ...FALLBACK_FILES])("%s es identico al de pdfjs-dist instalado (refrescar al subir de version)", (file) => {
    const served = fs.readFileSync(path.join(SERVED, file));
    const installed = fs.readFileSync(path.join(SOURCE, file));
    expect(served.length).toBeGreaterThan(1000);
    expect(served.equals(installed)).toBe(true);
  });

  it("los WASM son modulos WebAssembly de verdad (cabecera \\0asm) y se pueden compilar", async () => {
    for (const file of WASM_FILES) {
      const bytes = fs.readFileSync(path.join(SERVED, file));
      expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
      expect(WebAssembly.validate(bytes)).toBe(true);
    }
  });

  it("las licencias de los decodificadores viajan con ellos", () => {
    const licenses = fs.readdirSync(SERVED).filter((name) => name.startsWith("LICENSE_"));
    expect(licenses.sort()).toEqual(["LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_QCMS", "LICENSE_QCMS"]);
  });
});

describe("openPdfDocument pasa wasmUrl a pdf.js", () => {
  it("getDocument recibe wasmUrl y standardFontDataUrl (y ninguna URL externa)", async () => {
    vi.resetModules();
    const getDocument = vi.fn(() => ({ promise: Promise.resolve({ numPages: 1 }), destroy: vi.fn() }));
    vi.doMock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument }));
    const core = await import("@/lib/pdf/core");
    await core.openPdfDocument(new Uint8Array([37, 80, 68, 70]));
    expect(getDocument).toHaveBeenCalledTimes(1);
    const params = (getDocument.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.wasmUrl).toBe("/pdfjs-wasm/");
    expect(params.standardFontDataUrl).toBe("/standard_fonts/");
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && /^(https?:)?\/\//.test(value)) throw new Error(`${key} apunta fuera: ${value}`);
    }
    vi.doUnmock("pdfjs-dist");
    vi.resetModules();
    expect(typeof openPdfDocument).toBe("function");
  });
});

describe("decodificacion real de JPX y JBIG2 con los WASM servidos", () => {
  it("JPX: los pixeles salen EXACTOS con wasmUrl y no hay ninguna peticion de red", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("red prohibida"));
    const entry = (await buildImagesCorpus()).find((item) => item.name === "jpx")!;
    const opened = await openLegacy(entry.bytes);
    try {
      const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes: entry.bytes });
      expect(result.warnings).toEqual([]);
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].pixel).toEqual({ width: JPX_WIDTH, height: JPX_HEIGHT, hasAlpha: false });
      const png = decodePng(await blobBytes(await renderImageAsset(opened.doc, result.assets[0], "png")));
      for (let y = 0; y < JPX_HEIGHT; y += 1) {
        for (let x = 0; x < JPX_WIDTH; x += 1) {
          expect([...png.data.subarray((y * JPX_WIDTH + x) * 4, (y * JPX_WIDTH + x) * 4 + 4)]).toEqual([...jpxExpectedPixel(x, y), 255]);
        }
      }
    } finally {
      await opened.close();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("JBIG2: la «F» sale exacta con wasmUrl", async () => {
    const entry = (await buildImagesCorpus()).find((item) => item.name === "jbig2")!;
    const opened = await openLegacy(entry.bytes);
    try {
      const result = await findImageAssets(opened.doc, { ops: opened.ops, bytes: entry.bytes });
      expect(result.warnings).toEqual([]);
      const png = decodePng(await blobBytes(await renderImageAsset(opened.doc, result.assets[0], "png")));
      const bitmap = jbig2SampleBitmap();
      for (let y = 0; y < 12; y += 1) {
        for (let x = 0; x < 16; x += 1) {
          const value = bitmap[y][x] ? 0 : 255;
          expect([...png.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)]).toEqual([value, value, value, 255]);
        }
      }
    } finally {
      await opened.close();
    }
  });
});

describe("CSP y cabeceras (next.config.ts)", () => {
  it("el CSP permite WebAssembly y cargar los decodificadores del mismo origen, sin abrirse a ningun dominio nuevo", async () => {
    const headers = (await nextConfig.headers!()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    const csp = headers.find((entry) => entry.source === "/(.*)")!.headers.find((header) => header.key === "Content-Security-Policy")!.value;
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toMatch(/connect-src 'self' /);
    expect(csp).toMatch(/worker-src 'self' blob:/);
    expect(csp).toMatch(/script-src 'self'/);
    // Los WASM se piden del propio sitio (`'self'`): nada de `pdfjs`, CDN o dominio nuevo en la directiva.
    expect(csp).not.toMatch(/pdfjs|unpkg|cdnjs/);
  });

  it("los decodificadores se sirven con cache larga y por una ruta propia", async () => {
    const headers = (await nextConfig.headers!()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    const entry = headers.find((item) => item.source === "/pdfjs-wasm/:path*");
    expect(entry).toBeDefined();
    expect(entry!.headers).toContainEqual({ key: "Cache-Control", value: "public, max-age=2592000" });
  });
});
