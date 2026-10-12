import { PAGE_ASSEMBLY_LIMITS, readPageInfo } from "@/lib/pdf/pageAssembly";
import { PdfError, readFileBytes, toPdfError, type PdfErrorCode } from "@/lib/pdf/core";
import type { InputGuard } from "@/lib/pdf/inputGuard";
import { checkProInput, decryptProFile } from "@/app/pdf-pro/proAdapter";
import { MAX_PAGES_PDF_SOURCES, type PagesStore } from "@/app/pdf-pro/pages/pagesStore";

/**
 * Lectura de los documentos e imagenes que se suman al organizador (Wave 7 · U4). El plan NUNCA se
 * construye antes de leer el archivo de verdad: las paginas de un PDF externo se conocen cuando
 * `readPageInfo` termina (leccion de W6-D: un plan derivado de un recuento asincrono, o de un
 * archivo a medio leer, perdia paginas en silencio). Hasta entonces la fuente esta en `reading`
 * y la interfaz no deja aplicar.
 */

export type SourceDeps = {
  store: PagesStore;
  guard?: InputGuard;
};

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|avif|gif|bmp)$/i;

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || (file.type === "" && IMAGE_EXTENSION.test(file.name));
}

let counter = 0;
export function newSourceId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Lee y valida un PDF externo, ya sumado en estado `reading`. */
async function finishPdf(store: PagesStore, id: string, file: File, wasEncrypted: boolean): Promise<void> {
  try {
    if (file.size > PAGE_ASSEMBLY_LIMITS.maxExternalBytes) throw new PdfError("tooLarge");
    const bytes = await readFileBytes(file);
    const infos = await readPageInfo(bytes);
    if (infos.length === 0) throw new PdfError("corrupt");
    store.patchSource(id, {
      status: "ready",
      data: bytes,
      infos,
      pageCount: infos.length,
      decrypted: wasEncrypted,
      error: undefined,
    });
  } catch (error) {
    store.patchSource(id, { status: "error", error: toPdfError(error).code });
  }
}

/** Suma archivos PDF: devuelve los ids de las fuentes creadas (las que superan el limite no se crean). */
export function addPdfFiles(deps: SourceDeps, files: readonly File[]): { ids: string[]; rejected: number } {
  const { store, guard } = deps;
  const ids: string[] = [];
  let rejected = 0;
  for (const file of files) {
    if (store.pdfSourceCount() >= MAX_PAGES_PDF_SOURCES) {
      rejected += 1;
      continue;
    }
    const id = newSourceId("pdf");
    store.addSource({ id, kind: "pdf", name: file.name, size: file.size, status: "reading", file });
    ids.push(id);
    void (async () => {
      try {
        const checked = await checkProInput(file, guard ?? (async () => ({ status: "ok" })));
        if (checked.status === "ready") {
          await finishPdf(store, id, checked.file, checked.wasEncrypted);
        } else if (checked.status === "password") {
          store.patchSource(id, { status: "password", file: checked.file });
        } else {
          store.patchSource(id, { status: "error", error: checked.code });
        }
      } catch (error) {
        store.patchSource(id, { status: "error", error: toPdfError(error).code });
      }
    })();
  }
  return { ids, rejected };
}

/** Descifra un PDF externo con la contrasena (en memoria; no se guarda). */
export async function unlockPdfSource(
  deps: SourceDeps,
  id: string,
  password: string,
): Promise<"ready" | "wrongPassword" | "failed"> {
  const source = deps.store.getState().sources[id];
  if (!source?.file) return "failed";
  const result = await decryptProFile(source.file, password);
  if (result.status === "ready") {
    deps.store.patchSource(id, { status: "reading" });
    await finishPdf(deps.store, id, result.file, true);
    return "ready";
  }
  if (result.status === "wrongPassword") return "wrongPassword";
  deps.store.patchSource(id, { status: "error", error: result.status === "unsupported" ? result.code : result.code });
  return "failed";
}

/** Tamano natural de una imagen, o `null` si no se puede medir (sin decodificador, error). */
function measureImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const image = new Image();
    const timer = window.setTimeout(() => resolve(null), 4000);
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    image.src = url;
  });
}

/** Suma imagenes: las que no lo son o pesan demasiado quedan en error (visible), no se descartan. */
export function addImageFiles(deps: SourceDeps, files: readonly File[]): { ids: string[] } {
  const { store } = deps;
  const ids: string[] = [];
  for (const file of files) {
    const id = newSourceId("img");
    ids.push(id);
    let error: PdfErrorCode | null = null;
    if (!isImageFile(file)) error = "invalidType";
    else if (file.size === 0) error = "emptyFile";
    else if (file.size > PAGE_ASSEMBLY_LIMITS.maxExternalBytes) error = "tooLarge";
    if (error) {
      store.addSource({ id, kind: "image", name: file.name, size: file.size, status: "error", error });
      continue;
    }
    let previewUrl: string | undefined;
    try {
      previewUrl = URL.createObjectURL(file);
    } catch {
      previewUrl = undefined;
    }
    store.addSource({
      id,
      kind: "image",
      name: file.name,
      size: file.size,
      status: "ready",
      blob: file,
      previewUrl,
      pageCount: 1,
    });
    if (previewUrl) {
      void measureImage(previewUrl).then((size) => {
        if (size) store.patchSource(id, { infos: [{ width: size.width, height: size.height, rotation: 0 }] });
      });
    }
  }
  return { ids };
}
