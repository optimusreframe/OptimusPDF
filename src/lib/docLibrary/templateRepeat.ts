import { RECT_EPSILON, TEMPLATE_LIMITS, type InitialsLayout, type Rect, type TemplateSignField, type TemplateSource, type Variant } from "./templateTypes";

/**
 * «Mismo lugar en todas las páginas» para las INICIALES (Fase 2, U2.2; plan §11-§12). Funciones puras: no modifican su
 * entrada y no dependen de IndexedDB.
 *
 * Disposición del usuario (§12): con dos firmantes las iniciales van UNA AL LADO DE LA OTRA sobre la línea de iniciales,
 * el firmante 1 a la izquierda y el 2 a la derecha. `base` es el rectángulo de TODA la línea (donde cabrían las dos); se
 * parte en dos mitades iguales separadas por un hueco (`gap`, fracción del ancho de `base`). Con un firmante, las
 * iniciales ocupan `base` entero.
 */

/** Hueco por defecto entre las iniciales de los dos firmantes: 10 % del ancho de la línea. */
export const DEFAULT_INITIALS_GAP = 0.1;

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

function assertRect(rect: Rect): void {
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) throw new RangeError("rect: números no finitos");
  if (rect.width <= 0 || rect.height <= 0) throw new RangeError("rect: tamaño no positivo");
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 + RECT_EPSILON || rect.y + rect.height > 1 + RECT_EPSILON) {
    throw new RangeError("rect: fuera de 0..1");
  }
}

/** Mueve un rectángulo (dx, dy) sin salirse de la página: si no cabe, se queda pegado al borde (no se encoge). */
export function shiftRect(rect: Rect, dx: number, dy: number): Rect {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new RangeError("ajuste: números no finitos");
  const x = Math.min(Math.max(rect.x + dx, 0), Math.max(0, 1 - rect.width));
  const y = Math.min(Math.max(rect.y + dy, 0), Math.max(0, 1 - rect.height));
  return { x: round(x), y: round(y), width: rect.width, height: rect.height };
}

/**
 * Los rectángulos de las iniciales sobre la línea `base`: `[firmante 1]` o `[firmante 1 (izquierda), firmante 2
 * (derecha)]`. `gap` = fracción del ancho de `base` que queda libre entre ambos (0..0,5).
 */
export function initialsRects(base: Rect, signers: 1 | 2, gap: number = DEFAULT_INITIALS_GAP): Rect[] {
  assertRect(base);
  if (signers === 1) return [{ ...base }];
  if (!(gap >= 0 && gap <= 0.5)) throw new RangeError("gap: debe estar entre 0 y 0,5");
  const space = base.width * gap;
  const width = (base.width - space) / 2;
  return [
    { x: round(base.x), y: base.y, width: round(width), height: base.height },
    { x: round(base.x + width + space), y: base.y, width: round(width), height: base.height },
  ];
}

export type PageAdjust = { dx: number; dy: number };

export type RepeatInitialsOptions = {
  /** Primera página (0-based; por defecto 0). Se ignora si `toPage` es una lista. */
  fromPage?: number;
  /** Última página (incluida), `"all"` (hasta la última del documento: pide `pageCount`) o la lista exacta de páginas. */
  toPage?: number | "all" | readonly number[];
  /** Páginas del documento: las páginas ≥ `pageCount` se omiten y se devuelven en `skippedPages`. Obligatorio con `"all"`. */
  pageCount?: number;
  signers: 1 | 2;
  /** Línea de iniciales (rectángulo que cubre a TODOS los firmantes). */
  base: Rect;
  /** Hueco entre iniciales de los dos firmantes (fracción del ancho de `base`; por defecto 0,1). */
  gap?: number;
  /** Ajuste fino por página (índice de página → desplazamiento en fracciones de página). */
  perPageAdjust?: Record<number, PageAdjust>;
  /** `true` (por defecto): sustituye las iniciales que ya hubiera en esas páginas para esos firmantes. `false`: esa página se deja como está. */
  replaceExisting?: boolean;
  /** Valor de `required` de los campos creados (por defecto `true`). */
  required?: boolean;
  /** Origen anotado en los campos creados (por defecto `"manual"`). */
  source?: TemplateSource;
};

export type RepeatInitialsResult = {
  /** La variante resultante (la entrada no se modifica). */
  variant: Variant;
  /** Páginas donde se colocaron iniciales. */
  pages: number[];
  /** Páginas pedidas que no existen (≥ `pageCount`). */
  skippedPages: number[];
  /** Páginas que ya tenían iniciales y se respetaron (`replaceExisting: false`). */
  keptPages: number[];
  /** Cómo se hizo, para guardarlo en `template.layout.initials` y poder volver a editarlo. */
  layout: InitialsLayout;
};

function resolvePages(options: RepeatInitialsOptions): { requested: number[]; fromPage: number } {
  const fromPage = options.fromPage ?? 0;
  if (!Number.isInteger(fromPage) || fromPage < 0) throw new RangeError("fromPage inválida");
  const to = options.toPage ?? "all";
  let requested: number[];
  if (to === "all") {
    const count = options.pageCount;
    if (count === undefined || !Number.isInteger(count) || count < 1) throw new RangeError('toPage "all" necesita pageCount');
    requested = [];
    for (let page = fromPage; page < count; page += 1) requested.push(page);
  } else if (typeof to === "number") {
    if (!Number.isInteger(to) || to < fromPage) throw new RangeError("toPage inválida");
    if (to - fromPage + 1 > TEMPLATE_LIMITS.maxFieldsPerVariant) throw new RangeError("demasiadas páginas");
    requested = [];
    for (let page = fromPage; page <= to; page += 1) requested.push(page);
  } else {
    if (to.length > TEMPLATE_LIMITS.maxFieldsPerVariant) throw new RangeError("demasiadas páginas");
    if (!to.every((page) => Number.isInteger(page) && page >= 0)) throw new RangeError("lista de páginas inválida");
    requested = [...new Set(to)].sort((a, b) => a - b);
  }
  return { requested, fromPage };
}

function adjustFor(adjust: Record<number, PageAdjust> | undefined, page: number): PageAdjust | undefined {
  if (!adjust || !Object.hasOwn(adjust, String(page))) return undefined;
  const entry = adjust[page];
  if (!entry || !Number.isFinite(entry.dx) || !Number.isFinite(entry.dy)) throw new RangeError("ajuste inválido");
  return entry;
}

/** Id determinista de las iniciales de un rol en una página (volver a repetir las SUSTITUYE, no las duplica). */
export function initialsFieldId(pageIndex: number, roleIndex: number): string {
  return `ini-p${pageIndex}-r${roleIndex}`;
}

/**
 * Coloca iniciales en cada página pedida con la disposición de §12. No toca las firmas ni los campos de texto, ni las
 * iniciales de otros roles que no se están colocando (con `signers: 1` solo se sustituyen las del rol 0).
 */
export function repeatInitials(variant: Variant, options: RepeatInitialsOptions): RepeatInitialsResult {
  if (options.signers !== 1 && options.signers !== 2) throw new RangeError("signers debe ser 1 o 2");
  const { requested, fromPage } = resolvePages(options);
  const rects = initialsRects(options.base, options.signers, options.gap);
  const replace = options.replaceExisting ?? true;
  const required = options.required ?? true;
  const source = options.source ?? "manual";
  const pages: number[] = [];
  const skippedPages: number[] = [];
  const keptPages: number[] = [];
  const created: TemplateSignField[] = [];
  const replacedPages = new Set<number>();

  for (const page of requested) {
    if (options.pageCount !== undefined && page >= options.pageCount) {
      skippedPages.push(page);
      continue;
    }
    if (page > TEMPLATE_LIMITS.maxPageIndex) {
      skippedPages.push(page);
      continue;
    }
    const hasExisting = variant.fields.some((field) => field.type === "initials" && field.pageIndex === page && field.roleIndex < options.signers);
    if (hasExisting && !replace) {
      keptPages.push(page);
      continue;
    }
    const adjust = adjustFor(options.perPageAdjust, page);
    rects.forEach((rect, roleIndex) => {
      created.push({
        id: initialsFieldId(page, roleIndex),
        roleIndex,
        pageIndex: page,
        type: "initials",
        rect: adjust ? shiftRect(rect, adjust.dx, adjust.dy) : { ...rect },
        required,
        source,
      });
    });
    replacedPages.add(page);
    pages.push(page);
  }

  const survivors = variant.fields.filter((field) => !(field.type === "initials" && replacedPages.has(field.pageIndex) && field.roleIndex < options.signers));
  const fields = [...survivors, ...created].sort((a, b) => a.pageIndex - b.pageIndex || a.roleIndex - b.roleIndex || (a.type === b.type ? 0 : a.type === "signature" ? -1 : 1));
  if (fields.length + variant.textFields.length > TEMPLATE_LIMITS.maxFieldsPerVariant) throw new RangeError("demasiados campos en la variante");

  const toPage: InitialsLayout["toPage"] = options.toPage === undefined ? "all" : typeof options.toPage === "object" ? [...options.toPage] : options.toPage;
  const adjustList: InitialsLayout["adjust"] = [];
  if (options.perPageAdjust) {
    for (const page of pages) {
      const entry = adjustFor(options.perPageAdjust, page);
      if (entry && (entry.dx !== 0 || entry.dy !== 0)) adjustList.push({ page, dx: entry.dx, dy: entry.dy });
    }
  }
  const layout: InitialsLayout = { fromPage, toPage, base: { ...options.base }, adjust: adjustList };
  if (options.gap !== undefined) layout.gap = options.gap;

  return { variant: { fields, textFields: variant.textFields.map((field) => ({ ...field })) }, pages, skippedPages, keptPages, layout };
}

export type PageAdjustOptions = {
  /** Qué campos se mueven (por defecto `"initials"`). */
  type?: "initials" | "signature";
  /** Solo los de este rol. */
  roleIndex?: number;
};

/**
 * Ajuste fino por página de campos ya colocados: mueve (dx, dy) los campos del tipo pedido de cada página citada, sin
 * salirse de la página. Devuelve otra variante; las páginas sin ajuste y los demás campos no cambian.
 */
export function applyPageAdjust(variant: Variant, adjust: Record<number, PageAdjust>, options: PageAdjustOptions = {}): Variant {
  const type = options.type ?? "initials";
  return {
    fields: variant.fields.map((field) => {
      if (field.type !== type) return { ...field };
      if (options.roleIndex !== undefined && field.roleIndex !== options.roleIndex) return { ...field };
      const entry = adjustFor(adjust, field.pageIndex);
      if (!entry) return { ...field };
      return { ...field, rect: shiftRect(field.rect, entry.dx, entry.dy) };
    }),
    textFields: variant.textFields.map((field) => ({ ...field })),
  };
}
