/**
 * Fotos que no se pudieron anadir: que paso con cada una (por su nombre) y por que.
 * Funciones puras: la lista vive en `useScanSession` y el aviso en `ImportProblemsBanner`.
 */
export type ImportProblemKind = "notImage" | "heic" | "damaged";

export type ImportProblem = {
  /** Nombre del archivo; vacio si viene de la camara (no tiene). */
  name: string;
  kind: ImportProblemKind;
};

const HEIC_TYPE = /^image\/hei[cf]/i;
const HEIC_NAME = /\.(heic|heif|hif)$/i;
const IMAGE_NAME = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?|jfif)$/i;

export function blobName(blob: Blob): string {
  const name = (blob as File).name;
  return typeof name === "string" ? name : "";
}

/** Por que fallo una foto: HEIC que este navegador no sabe leer, algo que no es una imagen, o una imagen danada. */
export function classifyImportFailure(blob: Blob): ImportProblem {
  const name = blobName(blob);
  const type = blob.type || "";
  if (HEIC_TYPE.test(type) || HEIC_NAME.test(name)) return { name, kind: "heic" };
  const looksLikeImage = type.startsWith("image/") || IMAGE_NAME.test(name);
  return { name, kind: looksLikeImage ? "damaged" : "notImage" };
}

/** Un archivo descartado antes de intentar leerlo (no pasa el filtro de tipos). */
export function rejectedFile(file: File): ImportProblem {
  const classified = classifyImportFailure(file);
  return classified.kind === "damaged" ? { name: file.name, kind: "notImage" } : classified;
}

/** Une listas sin repetir el mismo (nombre, motivo) y con un tope para que el aviso no crezca sin limite. */
export function mergeProblems(current: ImportProblem[], extra: ImportProblem[], limit = 50): ImportProblem[] {
  const seen = new Set(current.map((problem) => `${problem.kind}|${problem.name}`));
  const merged = [...current];
  for (const problem of extra) {
    const key = `${problem.kind}|${problem.name}`;
    // Las fotos de la camara no tienen nombre: cada una cuenta.
    if (problem.name && seen.has(key)) continue;
    seen.add(key);
    merged.push(problem);
  }
  return merged.slice(0, limit);
}
