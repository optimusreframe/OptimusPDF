/** Ayudas de las pruebas del motor de anotaciones: ejecutar el motor sobre un PDF del corpus y espiar la pagina. */

import { findAnnotationAssets } from "../../annotations";
import type { AnnotationContext, AnnotationExtraction, PdfDocument } from "../../annotationsTypes";
import type { ExtractedAsset } from "../../types";
import { getLegacyOps, napiSurfaceFactory, withLegacyDocument } from "./nodeEnv";
import type { AnnotFixture } from "./generate";

export async function runOn(
  fixture: Pick<AnnotFixture, "bytes">,
  extra: Partial<AnnotationContext> & { withBytes?: boolean } = {},
): Promise<AnnotationExtraction> {
  const ops = await getLegacyOps();
  const { withBytes = true, ...ctx } = extra;
  return withLegacyDocument(fixture.bytes, (doc) => findAnnotationAssets(doc, { ops, createSurface: napiSurfaceFactory, ...(withBytes ? { bytes: fixture.bytes } : {}), ...ctx }));
}

/** Documento que cuenta las llamadas a `page.cleanup()` y puede fallar a voluntad (todo lo demas pasa al documento real). */
export function spyDocument(
  doc: PdfDocument,
  hooks: {
    cleaned?: number[];
    failPage?: (pageNumber: number) => Error | null;
    failAnnotations?: (pageNumber: number) => Error | null;
    failOperators?: (pageNumber: number) => Error | null;
  } = {},
): PdfDocument {
  return new Proxy(doc, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop !== "getPage") return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      return async (pageNumber: number) => {
        const failure = hooks.failPage?.(pageNumber);
        if (failure) throw failure;
        const page = (await target.getPage(pageNumber)) as unknown as Record<string, (...args: unknown[]) => unknown>;
        return new Proxy(page, {
          get(pageTarget, pageProp) {
            const member = Reflect.get(pageTarget, pageProp, pageTarget) as unknown;
            if (typeof member !== "function") return member;
            const fn = member as (...args: unknown[]) => unknown;
            if (pageProp === "cleanup") return (...args: unknown[]) => (hooks.cleaned?.push(pageNumber), fn.apply(pageTarget, args));
            if (pageProp === "getAnnotations") {
              return async (...args: unknown[]) => {
                const failure = hooks.failAnnotations?.(pageNumber);
                if (failure) throw failure;
                return fn.apply(pageTarget, args);
              };
            }
            if (pageProp === "getOperatorList") {
              return async (...args: unknown[]) => {
                const failure = hooks.failOperators?.(pageNumber);
                if (failure) throw failure;
                return fn.apply(pageTarget, args);
              };
            }
            return fn.bind(pageTarget);
          },
        });
      };
    },
  }) as unknown as PdfDocument;
}

export function bySource(assets: ExtractedAsset[], source: ExtractedAsset["source"]): ExtractedAsset[] {
  return assets.filter((asset) => asset.source === source);
}
