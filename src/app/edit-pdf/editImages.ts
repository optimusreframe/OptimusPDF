import { bytesToBase64, detectImageMime } from "@/app/edit-pdf/editSession";

/**
 * Validacion y lectura de la imagen que se anade al documento (W5-U4b).
 *
 * El motor (`editPdf.ts`) solo embebe PNG y JPG, y los reconoce por la FIRMA de
 * los bytes, no por la extension ni por el `type` del archivo: un `.png` que en
 * realidad es un GIF, o un SVG con el tipo cambiado, se rechaza aqui con un
 * motivo claro en vez de fallar al exportar. Limites (el legado no tenia
 * ninguno; aqui evitan que una foto de 80 MP agote la memoria del navegador):
 *  - `MAX_IMAGE_BYTES`: tamano del archivo.
 *  - `MAX_IMAGE_PIXELS`: ancho x alto (un PNG se descodifica a RGBA completo al embeberlo).
 */

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Lado mayor (px) de la vista previa que se guarda en la sesion. */
export const PREVIEW_MAX_SIDE = 1600;

export type ImageRejection = "type" | "size" | "pixels" | "unreadable" | "empty";

export type ReadImage = {
  bytes: Uint8Array;
  /** Data URL (reducida si la imagen es grande) para la vista previa. */
  previewUrl: string;
  /** alto / ancho de la imagen original. */
  ratio: number;
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg";
};

export type ReadImageResult =
  | { ok: true; image: ReadImage }
  | { ok: false; reason: ImageRejection };

export type ImageDeps = {
  /** Dimensiones reales de la imagen, o `null` si no se puede descodificar. */
  measure: (dataUrl: string) => Promise<{ width: number; height: number } | null>;
  /**
   * Prepara la foto para el PDF (reduce una foto grande, hornea la orientacion EXIF; ver `src/lib/image/prepareForPdf.ts`).
   * `null` = incrustar el archivo tal cual. Nunca lanza.
   */
  prepare: (file: Blob) => Promise<{ bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null>;
  /** Vista previa reducida; `null` = usar el original. */
  downscale: (
    dataUrl: string,
    mime: "image/png" | "image/jpeg",
    size: { width: number; height: number },
  ) => Promise<string | null>;
};

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

/** Dimensiones por descodificacion real (un PNG corrupto con firma valida falla aqui). */
export async function measureImageDimensions(
  dataUrl: string,
): Promise<{ width: number; height: number } | null> {
  const image = await loadImage(dataUrl);
  if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/** Reduce una imagen grande a `PREVIEW_MAX_SIDE` para no mantener megas en la vista previa. */
export async function downscalePreview(
  dataUrl: string,
  mime: "image/png" | "image/jpeg",
  size: { width: number; height: number },
): Promise<string | null> {
  const longest = Math.max(size.width, size.height);
  if (longest <= PREVIEW_MAX_SIDE) return null;
  if (typeof document === "undefined") return null;
  const image = await loadImage(dataUrl);
  if (!image) return null;
  const factor = PREVIEW_MAX_SIDE / longest;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * factor));
  canvas.height = Math.max(1, Math.round(size.height * factor));
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL(mime === "image/png" ? "image/png" : "image/jpeg", 0.85);
  canvas.width = 0;
  canvas.height = 0;
  return url;
}

/**
 * Politica por defecto de la imagen que se anade: la MISMA calidad de imagen que Imagenes a PDF (la recordada en este
 * dispositivo, «Equilibrada» por defecto). Una foto grande se reduce y se reencoda solo si ahorra >= 15 %; una firma, un
 * logo o un PNG con transparencia pasan intactos; y una foto de movil con orientacion EXIF se hornea derecha (el motor de
 * Editar incrusta los pixeles guardados y no sabe girarlos). Con «Original» los bytes no cambian (salvo esa orientacion).
 */
export async function prepareImageForEditing(
  file: Blob,
): Promise<{ bytes: Uint8Array; mime: "image/png" | "image/jpeg" } | null> {
  try {
    const [{ prepareImageForPdf }, { readStoredImagePreset }] = await Promise.all([
      import("@/lib/image/prepareBrowser"),
      import("@/lib/image/imageQualityPref"),
    ]);
    const prepared = await prepareImageForPdf(file, readStoredImagePreset(), { bakeOrientation: true });
    if (!prepared.changed) return null;
    return { bytes: prepared.bytes, mime: prepared.format === "jpeg" ? "image/jpeg" : "image/png" };
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: ImageDeps = {
  measure: measureImageDimensions,
  downscale: downscalePreview,
  prepare: prepareImageForEditing,
};

/**
 * Lee y valida un archivo de imagen. Nunca lanza: un fallo es un `reason` que la
 * interfaz traduce a un mensaje amable.
 */
export async function readImageFile(
  file: Blob,
  deps: Partial<ImageDeps> = {},
): Promise<ReadImageResult> {
  const { measure, downscale, prepare } = { ...DEFAULT_DEPS, ...deps };
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, reason: "size" };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  let mime = detectImageMime(bytes);
  if (!mime) return { ok: false, reason: "type" };

  // Foto grande o con orientacion EXIF: version ligera y derecha (si ahorra); lo demas pasa tal cual.
  const prepared = await prepare(file);
  if (prepared) {
    bytes = prepared.bytes;
    mime = prepared.mime;
  }

  // Data URL propia (no `FileReader`): usa el tipo REAL de los bytes y funciona igual fuera del navegador.
  let dataUrl: string;
  try {
    dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const size = await measure(dataUrl);
  if (!size || size.width <= 0 || size.height <= 0) return { ok: false, reason: "unreadable" };
  if (size.width * size.height > MAX_IMAGE_PIXELS) return { ok: false, reason: "pixels" };

  let previewUrl = dataUrl;
  try {
    previewUrl = (await downscale(dataUrl, mime, size)) ?? dataUrl;
  } catch {
    previewUrl = dataUrl;
  }
  return {
    ok: true,
    image: {
      bytes,
      previewUrl,
      ratio: size.height / size.width,
      width: size.width,
      height: size.height,
      mime,
    },
  };
}

/** Primer archivo de imagen de una lista (soltar varios: se coloca el primero valido por tipo). */
export function firstImageCandidate(files: ArrayLike<File> | null | undefined): File | null {
  if (!files || files.length === 0) return null;
  const list = Array.from(files);
  return (
    list.find((file) => /^image\/(png|jpe?g)$/i.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) ??
    list[0] ??
    null
  );
}
