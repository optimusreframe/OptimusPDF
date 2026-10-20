/**
 * Punto de entrada que el spec `settings-package` empaqueta con Vite (IIFE) y mete en una pagina REAL de la app para
 * PREPARAR y LEER estado (firmas del baul, biblioteca, recuentos): nunca para exportar ni importar (eso se hace SIEMPRE con la
 * interfaz). Los PNG de las firmas se pintan en la pagina con un canvas, asi que son imagenes que el navegador decodifica de
 * verdad (la importacion los comprueba). Solo lo usan las pruebas E2E.
 */
export * from "./documents-entry";
export { clearVault, deleteVaultEntry, listVault, saveVaultEntry, updateVaultEntry } from "../../src/app/sign-pdf/signVault";
import { listVault, saveVaultEntry } from "../../src/app/sign-pdf/signVault";
import { listDrafts, listSessionDrafts } from "../../src/app/sign-pdf/signDrafts";
import { listEditDrafts } from "../../src/app/edit-pdf/editDrafts";
import { listProDrafts } from "../../src/app/pdf-pro/proDrafts";
import { listDocuments } from "../../src/lib/docLibrary/store";
import { listTemplates } from "../../src/lib/docLibrary/templatesStore";

/** Un PNG de firma (garabato azul sobre transparente) distinto para cada `seed`, pintado en un canvas del navegador. */
export async function pngFor(seed: number, width = 240, height = 90) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  context.strokeStyle = "rgb(20,48,138)";
  context.lineWidth = 4;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(8, height * 0.6);
  for (let step = 1; step <= 24; step += 1) {
    const t = step / 24;
    context.lineTo(8 + t * (width - 16), height * 0.5 + Math.sin(t * Math.PI * (2 + (seed % 5))) * height * 0.3);
  }
  context.stroke();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("sin PNG"))), "image/png"));
  const png = new Uint8Array(await blob.arrayBuffer());
  return { png, ratio: height / width, width, height };
}

export type SeedSignature = { name: string; role?: string; seed: number; initials?: boolean };

/** Guarda firmas (y, si se pide, iniciales) en el baul REAL con las funciones de siempre. */
export async function seedSignatures(rows: SeedSignature[]): Promise<number> {
  let saved = 0;
  for (const row of rows) {
    const result = await saveVaultEntry({
      signerName: row.name,
      ...(row.role ? { role: row.role } : {}),
      sourceDocument: "",
      signature: await pngFor(row.seed),
      initials: row.initials === false ? null : await pngFor(row.seed + 100, 90, 90),
    });
    if (result.ok) saved += 1;
  }
  return saved;
}

/** Lo que hay en cada almacen ahora (solo lectura). */
export async function counts() {
  const vault = await listVault();
  return {
    signatures: vault.entries.length,
    documents: (await listDocuments()).documents.length,
    templates: (await listTemplates()).templates.length,
    drafts: (await listDrafts()).length + (await listSessionDrafts()).length + (await listEditDrafts()).length + (await listProDrafts()).length,
  };
}
