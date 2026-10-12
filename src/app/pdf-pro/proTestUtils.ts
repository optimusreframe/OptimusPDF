import { PDFDocument } from "@cantoo/pdf-lib";
import { createProWorkingDoc, type ProWorkingDocOptions } from "@/app/pdf-pro/proWorkingDoc";

/**
 * Utilidades SOLO PARA PRUEBAS de PDF Pro: PDF reales pequenos y un documento de trabajo con
 * dependencias falsas (sin pdf-lib para contar paginas, sin `crypto.subtle`, sin inspeccion).
 * La aplicacion no importa este archivo.
 */

export async function makePdfBytes(pages = 2): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const page = document.addPage([300, 400]);
    page.drawText(`Pagina ${i + 1}`, { x: 40, y: 340, size: 18 });
  }
  return document.save();
}

export function pdfFile(bytes: Uint8Array, name = "informe.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

/** Bytes de mentira (`%PDF-` + n): para el historial no importa que sean un PDF valido. */
export function fakeBytes(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(Math.max(8, size));
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d, seed & 255, 10, 10]);
  return bytes;
}

/** Documento de trabajo que no toca motores: paginas = 3 salvo que se indique, sin huella ni firmas. */
export function fakeDoc(options: ProWorkingDocOptions = {}) {
  let tick = 1_000;
  return createProWorkingDoc({
    now: () => (tick += 10),
    countPages: async () => 3,
    fingerprint: async () => "a".repeat(64),
    inspectSignatures: async () => "none",
    ...options,
  });
}

export function fakeFile(size = 64, name = "doc.pdf"): File {
  return pdfFile(fakeBytes(size), name);
}
