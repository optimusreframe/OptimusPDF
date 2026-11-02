/**
 * Punto de entrada que `html-pdf-lab.ts` empaqueta con Vite (IIFE) y mete en una pagina REAL de la app para ejecutar el motor
 * «HTML a PDF» de verdad en Chromium (iframe aislado, html2canvas, jsPDF) sobre paginas SINTETICAS. Solo lo usan las pruebas E2E.
 */
import { htmlToPdf, type HtmlLayoutReport, type HtmlToPdfOptions } from "../../src/lib/pdf/htmlToPdf";

async function convert(html: string, options: Partial<HtmlToPdfOptions> = {}): Promise<{ base64: string; report: HtmlLayoutReport }> {
  const file = new File([html], "prueba.html", { type: "text/html" });
  let report: HtmlLayoutReport | null = null;
  const blob = await htmlToPdf(
    file,
    { pageSize: "letter", orientation: "portrait", margin: "small", ...options },
    undefined,
    undefined,
    (value) => {
      report = value;
    },
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  if (!report) throw new Error("el motor no devolvio el informe de distribucion");
  return { base64: btoa(binary), report };
}

(window as unknown as { HtmlPdfLab: { convert: typeof convert } }).HtmlPdfLab = { convert };
