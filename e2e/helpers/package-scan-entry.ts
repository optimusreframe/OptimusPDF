/**
 * Punto de entrada que el spec `settings-package-scan` empaqueta con Vite (IIFE) y mete en una pagina REAL de la app para
 * PREPARAR y LEER estado (firmas del baul y sesiones del Escaner): nunca para exportar ni importar (eso se hace SIEMPRE con la
 * interfaz). Las fotos de las sesiones se pintan en la pagina con un canvas, asi que son JPEG que el navegador decodifica de
 * verdad (la importacion los comprueba y el motor del Escaner las abre). Solo lo usan las pruebas E2E.
 */
export * from "./package-entry";
export { clearScanSessions, listScanSessionSummaries, scanSessionStore } from "../../src/lib/scan/sessionStore";
import { DEFAULT_SCAN_SETTINGS, type ScanPage, type ScanSession } from "../../src/lib/scan/types";
import { newScanSessionId, scanSessionStore, listScanSessionSummaries } from "../../src/lib/scan/sessionStore";

/** Una foto de un documento SINTETICA (hoja con lineas y una marca que cambia con `seed`), JPEG de verdad pintado en un canvas. */
export async function scanPhoto(seed: number, width = 480, height = 640): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  context.fillStyle = "#3a3f47";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(width * 0.08, height * 0.05, width * 0.84, height * 0.9);
  context.fillStyle = "#111111";
  for (let line = 0; line < 14; line += 1) context.fillRect(width * 0.14, height * (0.12 + line * 0.052), width * (0.3 + ((seed * 7 + line * 13) % 40) / 100), height * 0.014);
  context.fillStyle = `hsl(${(seed * 47) % 360} 70% 45%)`;
  context.fillRect(width * 0.14, height * 0.86, width * (0.2 + (seed % 5) * 0.1), height * 0.04);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("sin JPEG"))), "image/jpeg", 0.85));
}

export type SeedScan = { name: string; pages: number; seed: number };

/** Guarda sesiones del Escaner con el almacen REAL (`scanSessionStore.save`) y devuelve sus ids, en el orden de `rows`. */
export async function seedScanSessions(rows: SeedScan[]): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const pages: ScanPage[] = [];
    for (let index = 0; index < row.pages; index += 1) {
      pages.push({
        id: `pg-${row.seed}-${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 9, 26, 10, index)).toISOString(),
        source: "library",
        original: await scanPhoto(row.seed * 10 + index),
        originalWidth: 480,
        originalHeight: 640,
        corners: index % 2 === 0 ? { topLeft: { x: 0.08, y: 0.05 }, topRight: { x: 0.92, y: 0.05 }, bottomRight: { x: 0.92, y: 0.95 }, bottomLeft: { x: 0.08, y: 0.95 } } : null,
        rotation: index === 1 ? 90 : 0,
        filter: index === 1 ? "bw" : "auto",
        adjust: { brightness: index === 1 ? 0.25 : 0, contrast: 0 },
        processed: null,
        thumb: null,
        flags: {},
        mode: "document",
      });
    }
    const session: ScanSession = {
      id: newScanSessionId(),
      createdAt: new Date(Date.UTC(2026, 9, 26, 9, 0)).toISOString(),
      updatedAt: new Date().toISOString(),
      name: row.name,
      pages,
      settings: { ...DEFAULT_SCAN_SETTINGS },
    };
    const saved = await scanSessionStore.save(session);
    if (!saved.ok) throw new Error(`no se pudo guardar la sesion de prueba: ${saved.reason}`);
    ids.push(session.id);
  }
  return ids;
}

export type ScanSnapshot = {
  id: string;
  name: string;
  pages: Array<{ id: string; sha256: string; rotation: number; filter: string; corners: boolean; bytes: number; type: string }>;
};

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lo que hay guardado: cada sesion con el SHA-256 de cada original (solo lectura), ordenado por nombre. */
export async function scanSnapshot(): Promise<ScanSnapshot[]> {
  const out: ScanSnapshot[] = [];
  for (const summary of await listScanSessionSummaries()) {
    const session = await scanSessionStore.load(summary.id);
    if (!session) continue;
    const pages = [];
    for (const page of session.pages) {
      pages.push({ id: page.id, sha256: await sha256(page.original), rotation: page.rotation, filter: page.filter, corners: page.corners !== null, bytes: page.original.size, type: page.original.type });
    }
    out.push({ id: session.id, name: session.name, pages });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
