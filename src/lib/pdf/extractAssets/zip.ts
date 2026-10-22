import { PdfError } from "@/lib/pdf/core";
import { uniqueZipName, zipNameKey } from "@/lib/pdf/entryNames";
import { loadJSZip } from "@/lib/pdf/lazyZip";
import { MAX_ZIP_TOTAL_BYTES } from "@/lib/pdf/zipLimits";

/**
 * ZIP de los elementos extraidos (F7 · U7.4): «Descargar seleccionados (.zip)». Solo empaqueta; los nombres
 * (`p03-firma-01.png`) los decide la interfaz. jszip se carga bajo demanda (no pesa en el paquete inicial de la pagina).
 *
 * Los nombres se sanean (sin rutas ni caracteres de control) y se desambiguan sin distinguir mayusculas ni forma
 * Unicode, como hacen Windows y macOS al extraer: jszip, si no, dejaria solo la ultima entrada con el mismo nombre.
 */

export type ZipEntry = { name: string; blob: Blob };

export type AssetsZip = {
  blob: Blob;
  /** Nombres FINALES de las entradas, en el orden recibido. */
  names: string[];
  bytes: number;
};

export type ZipOptions = {
  signal?: AbortSignal;
  /** `done` de `total` entradas ya anadidas. */
  onProgress?: (done: number, total: number) => void;
  /** Fecha de las entradas (por defecto, ahora). Las pruebas fijan una para comparar bytes. */
  date?: Date;
};

/** Tope de entradas de un ZIP de elementos (el de la extraccion). */
export const MAX_ZIP_ENTRIES = 500;

// Caracteres de control (U+0000-U+001F y U+007F) y los que Windows no admite en un nombre.
const UNSAFE = new RegExp("[\\\\/:*?\"<>|\\u0000-\\u001f\\u007f]+", "g");

/** Nombre de entrada seguro: sin rutas (`../`), sin caracteres invalidos, sin puntos ni espacios al borde. */
export function sanitizeZipName(name: string): string {
  const cleaned = name.replace(UNSAFE, "-").replace(/^[\s.-]+|[\s.]+$/g, "");
  return cleaned || "archivo";
}

export async function buildAssetsZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Promise<AssetsZip> {
  if (entries.length === 0) throw new PdfError("empty");
  if (entries.length > MAX_ZIP_ENTRIES) throw new PdfError("tooLarge");
  const total = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
  if (total > MAX_ZIP_TOTAL_BYTES) throw new PdfError("tooLarge");
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const used = new Set<string>();
  const names: string[] = [];
  const date = options.date ?? new Date();
  for (let index = 0; index < entries.length; index += 1) {
    if (options.signal?.aborted) throw new PdfError("cancelled");
    const entry = entries[index];
    const name = uniqueZipName(sanitizeZipName(entry.name), used, { key: zipNameKey });
    names.push(name);
    // Los bytes ya leidos (no el Blob): jszip lee un Blob con FileReader, que no existe fuera del navegador.
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    // PNG y JPG ya vienen comprimidos: se guardan tal cual; el texto y el SVG si se comprimen.
    const compressible = /\.(svg|txt)$/i.test(name);
    zip.file(name, bytes, { date, compression: compressible ? "DEFLATE" : "STORE" });
    options.onProgress?.(index + 1, entries.length);
  }
  if (options.signal?.aborted) throw new PdfError("cancelled");
  const out = await zip.generateAsync({ type: "uint8array" });
  return { blob: new Blob([out as unknown as BlobPart], { type: "application/zip" }), names, bytes: out.byteLength };
}
