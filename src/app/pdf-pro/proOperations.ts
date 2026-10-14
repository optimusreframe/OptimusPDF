import { rotatePdfToBytes } from "@/lib/pdf/rotate";
import { compressOperation, DOCUMENT_OPERATIONS } from "@/app/pdf-pro/ops/docOperations";
import type { ProOperation, ProOperationContext, ProOperationResult } from "@/app/pdf-pro/proTypes";
import { pagesApplyOperation } from "@/app/pdf-pro/pages/pagesOperation";
import { asEngineFile } from "@/app/pdf-pro/ops/opUtils";

/** `compress` vive con las demas operaciones de documento (U5); se reexporta para no romper importaciones. */
export { compressOperation };

/**
 * Registro de operaciones de PDF Pro (Wave 7 · U2). Hoy solo hay DOS de ejemplo, ya funcionales,
 * que prueban el adaptador de extremo a extremo (`File` → motor → bytes → snapshot):
 *  - `rotate-all`: gira todas las paginas (por defecto 90°) con `rotate.ts`.
 *  - `compress`: recomprime con `compress.ts` (si no pesa menos, avisa `unchanged` y no hay snapshot).
 *
 * Las unidades siguientes AMPLIAN `PRO_OPERATIONS`: una operacion es un objeto `ProOperation` con
 * `id`, `labelKey` (clave de `PRO_STRINGS[lang].operations`, en es y en), `kind` y `run`.
 * `preservesPageCount: true` evita recontar paginas al confirmar.
 */

export type RotateAllOptions = { degrees?: 90 | 180 | 270 };

export const rotateAllOperation: ProOperation<RotateAllOptions | undefined> = {
  id: "rotate-all",
  labelKey: "rotateAll90",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx: ProOperationContext): Promise<ProOperationResult> {
    const degrees = options?.degrees ?? 90;
    return { bytes: await rotatePdfToBytes(asEngineFile(bytes), { base: degrees }, ctx.onProgress) };
  },
};

/** Todas las operaciones registradas, en el orden en que se ofrecen. */
export const PRO_OPERATIONS: readonly ProOperation<unknown>[] = [
  rotateAllOperation as ProOperation<unknown>,
  compressOperation as ProOperation<unknown>,
  // Wave 7 · U5: operaciones de documento con opciones (marca de agua, numerar, recortar, metadatos...).
  ...DOCUMENT_OPERATIONS,
  // Wave 7 · U4: «Aplicar» del organizador de paginas (reordenar, girar, eliminar, duplicar, insertar).
  pagesApplyOperation as ProOperation<unknown>,
];

/** Acciones que se pueden lanzar de un toque, sin opciones (las de `ProHomePanel`). */
export const QUICK_OPERATION_IDS: readonly string[] = ["rotate-all", "compress"];

export function getProOperation(id: string): ProOperation<unknown> | undefined {
  return PRO_OPERATIONS.find((operation) => operation.id === id);
}
