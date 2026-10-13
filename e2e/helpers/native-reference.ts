import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { decodePngGray, type Gray } from "./image-metrics";

/**
 * Referencia de nitidez DENTRO del mismo navegador (W6-A): renderiza la pagina
 * con el pdf.js nativo (el mismo paquete y el mismo worker que sirve la app) a
 * un canvas del tamano EXACTO en pixeles de dispositivo, para que la unica
 * diferencia con lo que pinta la aplicacion sea la nitidez (no el rasterizador
 * de texto de Node). Requiere un contexto con `bypassCSP: true`.
 */
let pdfjsSource: Promise<string> | null = null;

function loadPdfjsSource(): Promise<string> {
  if (!pdfjsSource) {
    pdfjsSource = readFile(path.resolve(process.cwd(), "node_modules/pdfjs-dist/build/pdf.mjs"), "utf8");
  }
  return pdfjsSource;
}

export async function renderNativeReference(
  page: Page,
  bytes: Uint8Array | Buffer,
  pageNumber: number,
  widthPx: number,
  options: { sameCanvasAsApp?: boolean } = {},
): Promise<Gray> {
  const source = await loadPdfjsSource();
  const dataUrl = await page.evaluate(
    async ({ source: code, base64, pageNumber: number, widthPx: width, sameCanvasAsApp }) => {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const pdfjs = await import(/* @vite-ignore */ url);
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const task = pdfjs.getDocument({ data, standardFontDataUrl: "/standard_fonts/" });
      const pdf = await task.promise;
      const pdfPage = await pdf.getPage(number);
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: width / base.width });
      const canvas = document.createElement("canvas");
      // `sameCanvasAsApp`: el canvas se crea como en `renderPageRaster` (contexto 2D por defecto ANTES de dibujar y
      // medidas con `floor`). Si no, pdf.js crea el contexto con sus atributos (`alpha: false`, `willReadFrequently`) y
      // en un navegador con rasterizado por software (el runner de CI) el texto sale con otro antialiasing que el de la
      // aplicacion (medido: SSIM 0,989 y nitidez 1,16 a DPR 1) aunque el motor y el PDF sean los mismos.
      canvas.width = sameCanvasAsApp ? Math.max(1, Math.floor(viewport.width)) : Math.round(viewport.width);
      canvas.height = sameCanvasAsApp ? Math.max(1, Math.floor(viewport.height)) : Math.round(viewport.height);
      if (sameCanvasAsApp) canvas.getContext("2d");
      await pdfPage.render({ canvas, viewport, intent: "print" }).promise;
      const out = canvas.toDataURL("image/png");
      await task.destroy();
      URL.revokeObjectURL(url);
      return out;
    },
    { source, base64: Buffer.from(bytes).toString("base64"), pageNumber, widthPx, sameCanvasAsApp: options.sameCanvasAsApp === true },
  );
  return decodePngGray(Buffer.from(dataUrl.split(",")[1], "base64"));
}
