import type { ImageLayout } from "@/lib/pdf/imagesToPdf";
import { BLANK_PAGE_SIZES, type PageEntry, type PageInfo } from "@/lib/pdf/pageAssembly";
import { normalizeRotation } from "@/lib/pdf/rotate";
import type { GridItem } from "@/app/pdf-pro/pages/PageGrid";
import type { PagesStrings } from "@/app/pdf-pro/pages/pagesStrings";
import type { PagesSource } from "@/app/pdf-pro/pages/pagesStore";

/**
 * De PLAN a tarjetas (Wave 7 · U4): lo que ve la cuadricula de cada entrada del plan. Puro.
 */

/** Las miniaturas ya hechas, por documento (`"current"` o el id de la fuente) y pagina. */
export type ThumbLookup = (sourceKey: string, pageIndex: number) => string | undefined;

export const CURRENT_SOURCE_KEY = "current";

const A4_ASPECT = BLANK_PAGE_SIZES.a4.width / BLANK_PAGE_SIZES.a4.height;

function aspectOf(info: PageInfo | undefined | null): number {
  return info && info.width > 0 && info.height > 0 ? info.width / info.height : A4_ASPECT;
}

/** Proporcion (ancho / alto) de la pagina que saldra de una imagen con ese formato. */
export function imagePageAspect(layout: Partial<ImageLayout> | undefined, image: PageInfo | undefined | null): number {
  const imageAspect = image && image.width > 0 && image.height > 0 ? image.width / image.height : A4_ASPECT;
  const pageSize = layout?.pageSize ?? "a4";
  if (pageSize === "fit") return imageAspect;
  const base = pageSize === "letter" ? BLANK_PAGE_SIZES.letter : BLANK_PAGE_SIZES.a4;
  const orientation = layout?.orientation ?? "auto";
  const landscape = orientation === "landscape" || (orientation === "auto" && imageAspect > 1);
  return landscape ? base.height / base.width : base.width / base.height;
}

export type GridItemsInput = {
  plan: readonly PageEntry[];
  sources: Readonly<Record<string, PagesSource>>;
  /** Tamano visible de cada pagina del documento actual (cuando ya se ha leido). */
  pageInfos: readonly PageInfo[] | null;
  thumb: ThumbLookup;
  strings: PagesStrings;
};

export function buildGridItems({ plan, sources, pageInfos, thumb, strings }: GridItemsInput): GridItem[] {
  const total = plan.length;
  return plan.map((entry, index) => {
    const number = index + 1;
    const rotation = normalizeRotation(entry.rotation);
    let detail = "";
    let aspect = A4_ASPECT;
    let thumbUrl: string | undefined;

    if (entry.kind === "existing") {
      aspect = aspectOf(pageInfos?.[entry.sourceIndex]);
      thumbUrl = thumb(CURRENT_SOURCE_KEY, entry.sourceIndex);
      if (entry.copy) detail = strings.card.copyOf(entry.sourceIndex + 1);
      else if (entry.sourceIndex !== index) detail = strings.card.original(entry.sourceIndex + 1);
    } else if (entry.kind === "external") {
      const source = sources[entry.sourceId];
      aspect = aspectOf(source?.infos?.[entry.sourceIndex]);
      thumbUrl = thumb(entry.sourceId, entry.sourceIndex);
      detail = strings.card.external(source?.name ?? "PDF", entry.sourceIndex + 1);
    } else if (entry.kind === "blank") {
      aspect = entry.width / entry.height;
      detail = strings.card.blank;
    } else {
      const source = sources[entry.sourceId];
      aspect = imagePageAspect(entry.layout, source?.infos?.[0]);
      thumbUrl = source?.previewUrl;
      detail = strings.card.image(source?.name ?? "");
    }

    return {
      id: entry.id as string,
      number,
      kind: entry.kind,
      rotation,
      aspect,
      thumb: thumbUrl,
      detail,
      ariaLabel: strings.cardLabel(number, total, detail, rotation),
    };
  });
}

/** Para cada documento, las paginas que hay a la vista en la cuadricula (para pedir sus miniaturas). */
export function visiblePagesBySource(
  plan: readonly PageEntry[],
  first: number,
  last: number,
): Record<string, Set<number>> {
  const out: Record<string, Set<number>> = {};
  for (let index = Math.max(0, first); index <= Math.min(plan.length - 1, last); index += 1) {
    const entry = plan[index];
    if (entry.kind === "existing") (out[CURRENT_SOURCE_KEY] ??= new Set()).add(entry.sourceIndex);
    else if (entry.kind === "external") (out[entry.sourceId] ??= new Set()).add(entry.sourceIndex);
  }
  return out;
}
