import JSZip from "jszip";
import { uniqueZipName } from "@/lib/pdf/entryNames";
import {
  PdfError,
  isPdfFile,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor "PDFs a ZIP".
 *
 * A diferencia de `merge.ts` (que fusiona el CONTENIDO de varios PDF en un
 * documento nuevo con pdf-lib), aqui no se toca el contenido de ningun
 * archivo: cada PDF se agrega al ZIP con sus bytes originales sin parsear
 * ni reinterpretar, asi que el resultado es byte a byte identico al
 * original. Es solo empaquetado (ver comentario junto a `zip.file` sobre
 * por que se leen los bytes explicitamente en vez de pasar el `File` tal
 * cual, a diferencia de como lo hace `pdfToImages.ts`).
 */

/**
 * Presupuesto local de esta herramienta. `pdfToImages.ts` (el otro motor de
 * este repo que genera un ZIP con jszip) no define ningun tope reutilizable:
 * agrupa imagenes JPG ya generadas por el propio motor, nunca archivos que
 * el usuario suba directamente. Aqui el usuario puede arrastrar decenas de
 * PDF pesados de una sola vez, asi que hace falta un limite propio para no
 * intentar materializar un ZIP absurdamente grande (y agotar la memoria de
 * la pestana) antes siquiera de llegar a `generateAsync`. 100 archivos y
 * 500 MB acumulados son generosos para el caso de uso real (agrupar varios
 * documentos) sin dejar pasar un caso patologico.
 */
import { MAX_ZIP_FILES, MAX_ZIP_TOTAL_BYTES } from "@/lib/pdf/zipLimits";
export { MAX_ZIP_FILES, MAX_ZIP_TOTAL_BYTES };

export { uniqueZipName, zipNameKey, type UniqueZipNameOptions } from "@/lib/pdf/entryNames";

/**
 * Empaqueta varios PDF en un unico ZIP, sin re-parsear ni fusionar su
 * contenido. Necesita al menos 2 archivos: con uno solo no tiene sentido
 * empaquetar (mismo criterio y mismo codigo de error que `mergePdfFiles`
 * en `merge.ts`).
 */
export async function pdfsToZip(
  files: File[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Blob> {
  if (files.length === 0) throw new PdfError("empty");
  if (files.length < 2) throw new PdfError("needTwo");
  if (files.length > MAX_ZIP_FILES) throw new PdfError("tooLarge");

  for (const file of files) {
    if (!isPdfFile(file)) throw new PdfError("invalidType");
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_ZIP_TOTAL_BYTES) throw new PdfError("tooLarge");

  try {
    const zip = new JSZip();
    const usedNames = new Set<string>();

    for (let index = 0; index < files.length; index += 1) {
      throwIfAborted(signal);
      const file = files[index];
      const name = uniqueZipName(file.name, usedNames);
      // jszip acepta un File/Blob directamente (`zip.file(name, file)`), y
      // eso es lo que hace `pdfToImages.ts` con los JPG que genera. Aqui se
      // pasan en cambio los bytes crudos (`arrayBuffer` -> `Uint8Array`):
      // JSZip resuelve la lectura de un Blob real via FileReader, que solo
      // existe en el navegador (funcionaria en produccion, pero rompe en
      // cualquier entorno Node sin FileReader — el mismo limite ya
      // documentado en `pdfToImages.test.ts`). Pasar los bytes ya leidos
      // evita esa dependencia sin reinterpretar ni re-procesar el
      // contenido: siguen siendo los mismos bytes del PDF original.
      zip.file(name, new Uint8Array(await file.arrayBuffer()));
      onProgress?.(((index + 1) / files.length) * 0.9);
    }

    // `generateAsync` no es cancelable a medio camino: se comprueba la
    // senal justo antes de arrancarlo (mejor esfuerzo), pero una
    // cancelacion durante la compresion en si no se puede cortar. Mismo
    // criterio que `pdfToPowerpoint.ts`/`pdfToExcel.ts` con su ultimo paso
    // de empaquetado.
    throwIfAborted(signal);
    const blob = await zip.generateAsync({ type: "blob" });
    onProgress?.(1);
    return blob;
  } catch (error) {
    throw toPdfError(error);
  }
}
