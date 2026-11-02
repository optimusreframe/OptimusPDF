/**
 * Bytes -> texto respetando el juego de caracteres: BOM, luego el `charset` de la cabecera `Content-Type`, luego el
 * `<meta charset>` / `<meta http-equiv>` del HTML (o `@charset` del CSS) y, sin pistas, UTF-8. Un nombre desconocido
 * recae en UTF-8 (nunca lanza).
 */
function labelFromBom(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

export function decodeText(bytes: Uint8Array, contentType: string, kind: "html" | "css"): string {
  let label =
    labelFromBom(bytes) ?? /charset\s*=\s*["']?\s*([a-z0-9_:.+-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? null;

  if (!label) {
    // El nombre del juego de caracteres es ASCII: basta con mirar el comienzo como Latin-1.
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    label =
      (kind === "html"
        ? (/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.+-]+)/i.exec(head)?.[1] ?? null)
        : (/^@charset\s+["']([a-z0-9_:.+-]+)["']/i.exec(head)?.[1] ?? null)
      )?.toLowerCase() ?? null;
  }

  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
