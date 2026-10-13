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
 *
 * Antialiasing del texto (W9-B5, medido en Linux con Docker):
 *  - `"grayscale"` (por defecto): el lienzo se crea con un contexto 2D NO opaco
 *    (`alpha: true`), igual que `renderPageRaster` (`src/lib/pdf/pageRaster.ts`).
 *    El texto sale en escala de grises y es identico al de la aplicacion en
 *    macOS y en Linux (SSIM 1, 0 pixeles distintos).
 *  - `"pdfjs"`: no se crea el contexto y pdf.js crea el suyo, el de su visor
 *    (`{ alpha: false, willReadFrequently: true }`). Un lienzo opaco recibe
 *    antialiasing LCD (subpixel RGB) en Chromium para Linux (fontconfig de
 *    Ubuntu, `10-sub-pixel-rgb.conf`) y Windows: el texto sale con franjas de
 *    color, y al pasarlo a luminancia es mas borroso en horizontal. NO sirve
 *    para comparar con la aplicacion (en el runner de CI daba SSIM 0,989, dif.
 *    2,23, nitidez 1,16); queda solo para medirlo.
 */
let pdfjsSource: Promise<string> | null = null;

function loadPdfjsSource(): Promise<string> {
  if (!pdfjsSource) {
    pdfjsSource = readFile(path.resolve(process.cwd(), "node_modules/pdfjs-dist/build/pdf.mjs"), "utf8");
  }
  return pdfjsSource;
}

export type NativeReferenceOptions = {
  /** Ver la cabecera del archivo. Por defecto `"grayscale"`. */
  antialiasing?: "grayscale" | "pdfjs";
};

export async function renderNativeReference(
  page: Page,
  bytes: Uint8Array | Buffer,
  pageNumber: number,
  widthPx: number,
  options: NativeReferenceOptions = {},
): Promise<Gray> {
  const source = await loadPdfjsSource();
  const dataUrl = await page.evaluate(
    async ({ source: code, base64, pageNumber: number, widthPx: width, antialiasing }) => {
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
      // El ancho es el pedido (entero, el del bitmap de la aplicacion; `floor` del flotante podria dar uno menos por
      // redondeo) y el alto se trunca como lo hace `renderPageRaster`.
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.floor(viewport.height + 1e-6));
      // El contexto se crea ANTES de dibujar: si no existe, pdf.js crea el suyo (opaco, con antialiasing LCD en
      // Linux/Windows).
      if (antialiasing === "grayscale") canvas.getContext("2d", { alpha: true });
      await pdfPage.render({ canvas, viewport, intent: "print" }).promise;
      const out = canvas.toDataURL("image/png");
      await task.destroy();
      URL.revokeObjectURL(url);
      return out;
    },
    {
      source,
      base64: Buffer.from(bytes).toString("base64"),
      pageNumber,
      widthPx,
      antialiasing: options.antialiasing ?? "grayscale",
    },
  );
  return decodePngGray(Buffer.from(dataUrl.split(",")[1], "base64"));
}
