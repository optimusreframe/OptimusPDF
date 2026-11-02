import {
  isSnapshotErrorCode,
  type SnapshotErrorCode,
  type SnapshotNote,
  type SnapshotNoteCode,
  type SnapshotResult,
} from "@/lib/htmlSnapshot/types";

/**
 * Lado NAVEGADOR de «HTML a PDF · Direccion web»: pide la instantanea a `POST /api/html-snapshot` y la convierte en un
 * archivo HTML sintetico que entra por el mismo camino que un archivo subido (`htmlToPdf`). No importa nada de Node.
 */

export const SNAPSHOT_ENDPOINT = "/api/html-snapshot";

/** Errores de la ruta mas los dos que solo existen en el navegador. */
export type SnapshotClientErrorCode = SnapshotErrorCode | "network" | "cancelled" | "bad-response";

export class SnapshotRequestError extends Error {
  readonly code: SnapshotClientErrorCode;
  constructor(code: SnapshotClientErrorCode) {
    super(code);
    this.name = "SnapshotRequestError";
    this.code = code;
  }
}

const NOTE_CODES: readonly SnapshotNoteCode[] = [
  "images-skipped",
  "images-limit",
  "images-budget",
  "styles-skipped",
  "fonts-omitted",
  "scripts-ignored",
  "embeds-omitted",
  "little-content",
];

/** Valida la forma de la respuesta: nunca se confia en ella ciegamente (una ruta distinta o un proxy podrian devolver otra cosa). */
export function parseSnapshotResponse(data: unknown): SnapshotResult | null {
  if (!data || typeof data !== "object") return null;
  const { html, finalUrl, title, notes } = data as Record<string, unknown>;
  if (typeof html !== "string" || html === "" || typeof finalUrl !== "string" || typeof title !== "string") return null;
  const cleanNotes: SnapshotNote[] = [];
  if (Array.isArray(notes)) {
    for (const note of notes) {
      if (!note || typeof note !== "object") continue;
      const { code, count } = note as Record<string, unknown>;
      if (typeof code === "string" && (NOTE_CODES as readonly string[]).includes(code)) {
        cleanNotes.push({
          code: code as SnapshotNoteCode,
          ...(typeof count === "number" && Number.isFinite(count) ? { count: Math.max(0, Math.floor(count)) } : {}),
        });
      }
    }
  }
  return { html, finalUrl, title, notes: cleanNotes };
}

export async function requestSnapshot(address: string, signal?: AbortSignal): Promise<SnapshotResult> {
  let response: Response;
  try {
    response = await fetch(SNAPSHOT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: address }),
      signal,
      // Ni cookies ni referer: la consulta no necesita nada de la sesion de quien la hace.
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new SnapshotRequestError("cancelled");
    throw new SnapshotRequestError("network");
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw new SnapshotRequestError("cancelled");
    throw new SnapshotRequestError(response.ok ? "bad-response" : "unreachable");
  }

  if (!response.ok) {
    const code = (data as { error?: unknown } | null)?.error;
    throw new SnapshotRequestError(isSnapshotErrorCode(code) ? code : "unreachable");
  }
  const parsed = parseSnapshotResponse(data);
  if (!parsed) throw new SnapshotRequestError("bad-response");
  return parsed;
}

/** Nombre de archivo seguro a partir de la direccion: `ejemplo.com-articulo.html`. */
export function snapshotFileName(finalUrl: string): string {
  let base = "pagina-web";
  try {
    const url = new URL(finalUrl);
    const path = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "";
    base = `${url.hostname}${path ? `-${path.replace(/\.[a-z0-9]{1,5}$/i, "")}` : ""}`;
  } catch {
    /* direccion inutilizable: nombre generico */
  }
  const clean = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return `${clean || "pagina-web"}.html`;
}

/** La instantanea como archivo HTML (UTF-8) para el motor de siempre. */
export function snapshotToFile(result: SnapshotResult): File {
  return new File([result.html], snapshotFileName(result.finalUrl), { type: "text/html" });
}
