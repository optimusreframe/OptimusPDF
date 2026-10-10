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
): Promise<Gray> {
  const source = await loadPdfjsSource();
  const dataUrl = await page.evaluate(
    async ({ source: code, base64, pageNumber: number, widthPx: width }) => {
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
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await pdfPage.render({ canvas, viewport, intent: "print" }).promise;
      const out = canvas.toDataURL("image/png");
      await task.destroy();
      URL.revokeObjectURL(url);
      return out;
    },
    { source, base64: Buffer.from(bytes).toString("base64"), pageNumber, widthPx },
  );
  return decodePngGray(Buffer.from(dataUrl.split(",")[1], "base64"));
}
