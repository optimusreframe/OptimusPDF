import type { PDFPageProxy } from "pdfjs-dist";

/*
 * Huella de UNA pagina (Wave 7 · U3): decide si el render ya hecho de una pagina sigue valiendo cuando el
 * documento de trabajo cambia de snapshot. Dos paginas con la misma huella se dibujan igual, asi que tras
 * girar una pagina, borrar otra o deshacer, las demas reutilizan su bitmap en vez de dibujarse otra vez.
 *
 * Huella = objeto de pagina (`ref`) + caja visible (`view`) + giro (`rotate`) + resumen de la lista de
 * operaciones de dibujo (texto, trazados, imagenes por nombre y tamano, anotaciones). Si no se puede calcular
 * a tiempo (pagina enorme o error) se usa una huella ligada al snapshot: solo vale para ese snapshot.
 *
 * Limite conocido: una imagen sustituida por otra del MISMO nombre y tamano (p. ej. recomprimir) no cambia la
 * lista de operaciones; el bitmap viejo se reutiliza hasta que cambie el zoom o se reabra el documento.
 */

/** Operaciones maximas que se resumen; por encima, la huella queda ligada al snapshot. */
export const SIGNATURE_MAX_OPS = 60_000;
/** Plazo (ms) para resumir una pagina antes de rendirse. */
export const SIGNATURE_BUDGET_MS = 40;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a de 32 bits sobre enteros (acumulador mutable en `state.h`). */
class Hasher {
  h = FNV_OFFSET;
  int(value: number): void {
    // 4 bytes de un entero de 32 bits.
    let v = value | 0;
    for (let i = 0; i < 4; i += 1) {
      this.h ^= v & 0xff;
      this.h = Math.imul(this.h, FNV_PRIME);
      v >>>= 8;
    }
  }
  number(value: number): void {
    if (Number.isInteger(value)) this.int(value);
    else this.int(Math.round(value * 1000));
  }
  string(value: string): void {
    this.int(value.length);
    const step = value.length > 64 ? Math.ceil(value.length / 64) : 1;
    for (let i = 0; i < value.length; i += step) this.int(value.charCodeAt(i));
  }
  hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, "0");
  }
}

/**
 * pdf.js nombra los objetos comunes (fuentes, imagenes) `g_d<documento>_<nombre>`: el prefijo cuenta los
 * documentos abiertos y el numero de la fuente (`f1`, `f2`) sigue el orden en que se fueron cargando. Ninguno
 * de los dos dice nada del contenido de la pagina, asi que se quitan antes de resumirla.
 */
export function normalizeObjectName(name: string): string {
  if (!name.startsWith("g_d")) return name;
  return name.replace(/^g_d\d+_/, "").replace(/^f\d+$/, "f");
}

function hashValue(hasher: Hasher, value: unknown, depth: number): void {
  if (value === null || value === undefined) {
    hasher.int(0);
    return;
  }
  switch (typeof value) {
    case "number":
      hasher.number(value);
      return;
    case "string":
      hasher.string(normalizeObjectName(value));
      return;
    case "boolean":
      hasher.int(value ? 1 : 2);
      return;
    case "object": {
      if (depth <= 0) {
        hasher.int(7);
        return;
      }
      if (ArrayBuffer.isView(value)) {
        const view = value as unknown as ArrayLike<number>;
        hasher.int(view.length);
        const step = Math.max(1, Math.floor(view.length / 48));
        for (let i = 0; i < view.length; i += step) hasher.number(view[i]);
        return;
      }
      if (Array.isArray(value)) {
        hasher.int(value.length);
        const limit = Math.min(value.length, 64);
        for (let i = 0; i < limit; i += 1) hashValue(hasher, value[i], depth - 1);
        return;
      }
      const record = value as Record<string, unknown>;
      // Glifos de texto (`unicode`, `fontChar`) y similares: lo que cambia al editar un texto.
      if ("unicode" in record || "fontChar" in record) {
        hashValue(hasher, record.unicode, 0);
        hashValue(hasher, record.fontChar, 0);
        hashValue(hasher, record.width, 0);
        return;
      }
      const keys = Object.keys(record);
      hasher.int(keys.length);
      return;
    }
    default:
      hasher.int(9);
  }
}

/** Resume una lista de operaciones de pdf.js; `null` si es demasiado grande o tarda demasiado. */
export function digestOperatorList(
  list: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  now: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  budgetMs: number = SIGNATURE_BUDGET_MS,
  maxOps: number = SIGNATURE_MAX_OPS,
): string | null {
  const { fnArray, argsArray } = list;
  if (fnArray.length > maxOps) return null;
  const deadline = now() + budgetMs;
  const hasher = new Hasher();
  hasher.int(fnArray.length);
  for (let i = 0; i < fnArray.length; i += 1) {
    hasher.int(fnArray[i]);
    hashValue(hasher, argsArray[i], 3);
    if ((i & 255) === 255 && now() > deadline) return null;
  }
  return hasher.hex();
}

type SignaturePage = Pick<PDFPageProxy, "getOperatorList"> & {
  ref?: { num: number; gen: number } | null;
  view?: readonly number[];
  rotate?: number;
};

/**
 * Huella de la pagina. `fallback` (huella ligada al snapshot) se devuelve si la lista de operaciones no se puede
 * resumir. Nunca lanza.
 */
export async function pageSignature(
  page: SignaturePage,
  fallback: string,
  options: { now?: () => number; budgetMs?: number; maxOps?: number } = {},
): Promise<string> {
  try {
    if (typeof page.getOperatorList !== "function") return fallback;
    const list = await page.getOperatorList({ intent: "print" } as never);
    const digest = digestOperatorList(
      list as unknown as { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
      options.now,
      options.budgetMs,
      options.maxOps,
    );
    if (digest === null) return fallback;
    const ref = page.ref ? `${page.ref.num}.${page.ref.gen}` : "x";
    const view = (page.view ?? []).map((value) => Math.round(value * 100) / 100).join(",");
    return `p${ref}:${(page.rotate ?? 0) % 360}:${view}:${digest}`;
  } catch {
    return fallback;
  }
}

/** Huellas ya calculadas, por snapshot y pagina: deshacer/rehacer no vuelve a analizar nada. */
export class SignatureMemo {
  private readonly bySnapshot = new Map<string, Map<number, string>>();
  constructor(private readonly maxSnapshots = 6) {}

  get(snapshotId: string, index: number): string | undefined {
    return this.bySnapshot.get(snapshotId)?.get(index);
  }

  set(snapshotId: string, index: number, signature: string): void {
    let map = this.bySnapshot.get(snapshotId);
    if (!map) {
      map = new Map();
      this.bySnapshot.set(snapshotId, map);
      while (this.bySnapshot.size > this.maxSnapshots) {
        const oldest = this.bySnapshot.keys().next().value;
        if (oldest === undefined) break;
        this.bySnapshot.delete(oldest);
      }
    } else {
      // Marca el snapshot como el mas reciente.
      this.bySnapshot.delete(snapshotId);
      this.bySnapshot.set(snapshotId, map);
    }
    map.set(index, signature);
  }

  clear(): void {
    this.bySnapshot.clear();
  }
}

/** Huella de reserva: solo vale para esa pagina de ese snapshot. */
export function snapshotScopedSignature(snapshotId: string, index: number): string {
  return `s:${snapshotId}:${index}`;
}

/** Memoria de huellas unica del visor (se vacia al cerrar el documento). */
export const viewerSignatureMemo = new SignatureMemo();
