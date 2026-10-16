import { PACKAGE_LIMITS, PackageError } from "@/lib/backup/types";

/**
 * JSON estricto para lo que viene de un paquete ajeno: tope de bytes ANTES de
 * decodificar, UTF-8 valido (sin BOM), tope de profundidad medido con un
 * recorrido lineal ANTES de `JSON.parse` (un `[[[[...` de millones de niveles
 * no llega a construirse) y sintaxis JSON estandar. Lanza `PackageError`
 * (`invalidJson`); nunca otra cosa.
 *
 * Las claves duplicadas no se detectan (`JSON.parse` se queda con la ultima):
 * ningun lector del respaldo copia objetos enteros, todos leen campos por
 * nombre y descartan el resto, asi que una clave repetida o `__proto__` no
 * puede colarse en un objeto de la aplicacion.
 */
export function parseStrictJson(
  bytes: Uint8Array,
  maxBytes: number,
  maxDepth: number = PACKAGE_LIMITS.maxJsonDepth,
): unknown {
  if (bytes.byteLength > maxBytes) throw new PackageError("invalidJson");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PackageError("invalidJson");
  }
  if (!withinDepth(text, maxDepth)) throw new PackageError("invalidJson");
  try {
    return JSON.parse(text);
  } catch {
    throw new PackageError("invalidJson");
  }
}

/** `true` si ningun `{`/`[` (fuera de cadenas) anida mas de `maxDepth` niveles. */
function withinDepth(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i += 1; // barra invertida: salta el escapado
      else if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x7b || ch === 0x5b) {
      depth += 1;
      if (depth > maxDepth) return false;
    } else if (ch === 0x7d || ch === 0x5d) depth -= 1;
  }
  return true;
}
