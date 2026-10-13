import {
  PDFDict,
  PDFDocument,
  PDFName,
  closePath,
  degrees,
  fillEvenOdd,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  type PDFFont,
  type PDFPage,
} from "@cantoo/pdf-lib";
import {
  PdfError,
  hexToPdfColor,
  loadPdf,
  closePdfDocument,
  openPdfDocument,
  renderPageToCanvas,
  standardFontFor,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  boxPolygon,
  coverCorners,
  coverShape,
  polygonsOverlap,
  type CoverShape,
} from "@/lib/pdf/editCover";

type Polygon = Array<{ x: number; y: number }>;
import { wrapTextWith } from "@/lib/pdf/editPdf";
import {
  CATALOG,
  catalogFontFile,
  effectiveFontKey,
  isEmbeddedFont,
  loadCatalogFont,
  mapSourceFont,
  pickFontForText,
  sanitizeTextForFont,
} from "@/lib/pdf/editFonts";
import { isolateSharedContents, removeOriginalText, type RemoveOutcome } from "@/lib/pdf/editTextRemove";
import type {
  CatalogFontKey,
  EditWarning,
  TextEdit,
  UserBox,
} from "@/lib/pdf/editTypes";

/**
 * Exportacion de las ediciones de texto existente (Wave 5, fase F1:
 * "cubrir y redibujar") y "Aplanar pagina".
 *
 * F1 tapaba el texto viejo con un rectangulo del color del fondo y dibujaba
 * el nuevo encima, dejando el original en el flujo. Desde la Wave 8 (F2),
 * ANTES de cubrir se quitan del flujo de contenido los glifos del bloque
 * reemplazado (`editTextRemove.ts`): el bloque emite `original-text-removed`
 * y el texto viejo deja de poder seleccionarse o extraerse. La cobertura se
 * mantiene igualmente (fondos, restos visuales). Solo cuando no se puede
 * quitar con seguridad (Type3, XObject compartido, flujo ilegible...) se
 * conserva el aviso `original-text-remains` con su `reason`; la salida segura
 * en ese caso sigue siendo `flattenPages`.
 *
 * COORDENADAS: todo (`box`, `coverBox`, `rotation`) esta en el ESPACIO DE
 * USUARIO del PDF (puntos, origen abajo-izquierda, sin `/Rotate`), igual que
 * lo que da pdf.js. Como el contenido de la pagina vive en ese mismo espacio,
 * dibujar en el no necesita compensar `/Rotate` ni el origen del CropBox: una
 * pagina con `/Rotate 90` rota visualmente tambien lo que se dibuja, igual
 * que rota el texto original. `rotation` son grados en sentido ANTIHORARIO
 * (como `atan2(b, a)` del `transform` de pdf.js y como `degrees()` de
 * pdf-lib). Para texto NUEVO colocado sobre la vista de una pagina rotada,
 * quien crea la edicion debe fijar `rotation = geometry.rotation`.
 */

/* ------------------------------------------------------------------ *
 * Constantes y tipos
 * ------------------------------------------------------------------ */

/** Interlineado por defecto, como multiplo del tamano de fuente. */
export const DEFAULT_LINE_HEIGHT = 1.2;

const MIN_LINE_HEIGHT = 0.5;
const MAX_LINE_HEIGHT = 4;
const MIN_FONT_SIZE = 1;
const MAX_FONT_SIZE = 1000;

type FontkitModule = Parameters<PDFDocument["registerFontkit"]>[0];

export type ApplyTextEditsOptions = {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  /**
   * Origen de los bytes de los TTF del catalogo. Por defecto
   * `loadCatalogFont` (fetch en el navegador, disco en Node).
   */
  loadFontBytes?: (
    key: CatalogFontKey,
    bold: boolean,
    italic: boolean,
  ) => Promise<Uint8Array>;
  /** Origen de fontkit; por defecto `import("@pdf-lib/fontkit")` perezoso. */
  loadFontkit?: () => Promise<FontkitModule>;
};

export type ApplyTextEditsResult = {
  bytes: Uint8Array;
  /** Avisos de todo el documento, sin repetidos. */
  warnings: EditWarning[];
  /** Avisos por `TextEdit.id`, para mostrarlos junto a cada bloque. */
  warningsByEdit: Record<string, EditWarning[]>;
  /** Ediciones ignoradas (pagina inexistente, tamano de fuente invalido). */
  skipped: string[];
};

/* ------------------------------------------------------------------ *
 * Geometria
 * ------------------------------------------------------------------ */

function snapTrig(angleDeg: number): { cos: number; sin: number } {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    cos: Math.abs(cos) < 1e-9 ? 0 : cos,
    sin: Math.abs(sin) < 1e-9 ? 0 : sin,
  };
}

/**
 * Tamano del rectangulo SIN rotar cuya caja envolvente (la que guarda
 * `TextEdit.box`) mide `box.width` x `box.height` tras girar `angle` grados.
 * Es la inversa de `rotatedBounds` de `core.ts`: con dos ecuaciones
 * (ancho y alto envolventes) y dos incognitas tiene solucion salvo cerca de
 * 45 grados, donde se asume un cuadrado.
 */
export function unrotatedSize(
  box: Pick<UserBox, "width" | "height">,
  angle: number,
): { width: number; height: number } {
  const { cos, sin } = snapTrig(angle);
  const c = Math.abs(cos);
  const s = Math.abs(sin);
  const det = c * c - s * s;
  let width: number;
  let height: number;
  if (Math.abs(det) < 0.05) {
    const side = (box.width + box.height) / 2 / Math.max(1e-6, c + s);
    width = side;
    height = side;
  } else {
    width = (box.width * c - box.height * s) / det;
    height = (box.height * c - box.width * s) / det;
  }
  if (!(width > 0) || !(height > 0)) {
    width = Math.max(1, Math.max(box.width, box.height));
    height = Math.max(1, Math.min(box.width, box.height));
  }
  return { width, height };
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/* ------------------------------------------------------------------ *
 * Fuentes del documento
 * ------------------------------------------------------------------ */

type FontContext = {
  document: PDFDocument;
  fonts: Map<string, Promise<PDFFont>>;
  options: ApplyTextEditsOptions;
};

const contexts = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();
const fontkitRegistered = new WeakSet<PDFDocument>();

/**
 * Nombre PostScript con etiqueta de subconjunto ("ABCDEF+LiberationSans-Bold"),
 * como pide la especificacion de PDF para una fuente embebida parcialmente. La
 * etiqueta (6 mayusculas) se deriva de la fuente y el estilo: determinista y
 * unica por fuente dentro de un documento.
 */
export function subsetFontName(key: CatalogFontKey, bold: boolean, italic: boolean): string {
  const file = catalogFontFile(key, bold, italic) ?? key;
  const stem = file.replace(/\.ttf$/i, "").replace(/-Regular$/, "");
  let hash = 2166136261;
  for (const char of `${key}|${bold ? 1 : 0}${italic ? 1 : 0}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  let tag = "";
  for (let i = 0; i < 6; i += 1) {
    tag += String.fromCharCode(65 + (hash % 26));
    hash = Math.imul(hash, 1664525) + 1013904223 >>> 0;
  }
  return `${tag}+${stem}`;
}

async function defaultFontkit(): Promise<FontkitModule> {
  const loaded = (await import("@pdf-lib/fontkit")) as unknown as {
    default?: FontkitModule;
  };
  return loaded.default ?? (loaded as unknown as FontkitModule);
}

async function getFont(
  context: FontContext,
  key: CatalogFontKey,
  bold: boolean,
  italic: boolean,
): Promise<PDFFont> {
  const cacheKey = `${key}|${bold ? 1 : 0}${italic ? 1 : 0}`;
  const cached = context.fonts.get(cacheKey);
  if (cached) return cached;

  const entry = CATALOG[key];
  const pending = (async () => {
    if (entry.standard) {
      return context.document.embedFont(
        standardFontFor(entry.standard, bold, italic),
      );
    }
    // Embebida: fontkit + TTF, ambos perezosos (solo si el documento los usa).
    if (!fontkitRegistered.has(context.document)) {
      const fontkit = await (context.options.loadFontkit ?? defaultFontkit)();
      context.document.registerFontkit(fontkit);
      fontkitRegistered.add(context.document);
    }
    const loader = context.options.loadFontBytes ?? loadCatalogFont;
    const bytes = await loader(key, bold, italic);
    return context.document.embedFont(bytes, {
      subset: true,
      customName: subsetFontName(key, bold, italic),
    });
  })();
  // Un fallo (red, TTF corrupto) no debe quedar cacheado.
  pending.catch(() => context.fonts.delete(cacheKey));
  context.fonts.set(cacheKey, pending);
  return pending;
}

type ResolvedFont = {
  font: PDFFont;
  key: CatalogFontKey;
  text: string;
  warnings: EditWarning[];
};

/** Elige la fuente final de una edicion y calcula sus avisos de fuente. */
async function resolveFont(
  context: FontContext,
  edit: TextEdit,
): Promise<ResolvedFont> {
  const warnings: EditWarning[] = [];
  const requested = edit.fontKey;
  const pick = pickFontForText(requested, edit.text);

  let key = effectiveFontKey(pick.key);
  let font: PDFFont | null = null;
  const attempts: CatalogFontKey[] = [key];
  const standardFallback = CATALOG[key].fallbackKey;
  if (isEmbeddedFont(key) && standardFallback) attempts.push(standardFallback);

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      font = await getFont(context, attempt, edit.bold, edit.italic);
      key = attempt;
      break;
    } catch (error) {
      throwIfAborted(context.options.signal);
      lastError = error;
    }
  }
  if (!font) throw toPdfError(lastError);

  const cleaned = sanitizeTextForFont(key, edit.text);

  // Por que la fuente dibujada no es la pedida (un solo aviso, el mas util).
  const glyphDriven = pick.changed && key === effectiveFontKey(pick.key);
  const sourceInexact =
    edit.blockId !== undefined && edit.sourceFont !== undefined
      ? (() => {
          const mapped = mapSourceFont(edit.sourceFont);
          return !mapped.exact && mapped.key === requested;
        })()
      : false;

  if (glyphDriven) {
    warnings.push({
      kind: "glyph-missing",
      chars: pick.outsidePreferred,
      fallbackKey: key,
    });
  }
  if (sourceInexact && edit.sourceFont) {
    warnings.push({
      kind: "font-substituted",
      from: edit.sourceFont.pdfName,
      to: key,
    });
  } else if (!glyphDriven && key !== requested) {
    warnings.push({ kind: "font-substituted", from: requested, to: key });
  }
  if (cleaned.unsupported.length > 0) {
    warnings.push({ kind: "glyph-missing", chars: cleaned.unsupported });
  }

  return { font, key, text: cleaned.text, warnings };
}

/* ------------------------------------------------------------------ *
 * Dibujo
 * ------------------------------------------------------------------ */

function drawCover(page: PDFPage, edit: TextEdit, shape: CoverShape | null): boolean {
  if (!shape) return false;
  const color = hexToPdfColor(edit.cover.color ?? "#ffffff");
  if (shape.kind === "oriented") {
    if (!(shape.width > 0) || !(shape.height > 0)) return false;
    if (shape.holes.length === 0) {
      // pdf-lib gira el rectangulo alrededor de su esquina (x, y).
      page.drawRectangle({
        x: shape.origin.x,
        y: shape.origin.y,
        width: shape.width,
        height: shape.height,
        rotate: degrees(shape.rotation),
        color,
        borderWidth: 0,
        opacity: 1,
      });
      return true;
    }
    // Rectangulo girado MENOS las cajas de los vecinos que lo cruzan: un solo
    // trazado con relleno par-impar (cada hueco queda dentro del rectangulo),
    // sin costuras entre piezas.
    const corners = coverCorners(shape);
    const ring = (points: ReadonlyArray<{ x: number; y: number }>) => [
      moveTo(points[0].x, points[0].y),
      ...points.slice(1).map((p) => lineTo(p.x, p.y)),
      closePath(),
    ];
    page.pushOperators(
      pushGraphicsState(),
      setFillingColor(color),
      ...ring(corners),
      ...shape.holes.flatMap((hole) => ring(hole.polygon)),
      fillEvenOdd(),
      popGraphicsState(),
    );
    return true;
  }
  const { box } = shape;
  if (!(box.width > 0) || !(box.height > 0)) return false;
  page.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    color,
    borderWidth: 0,
    opacity: 1,
  });
  return true;
}

/**
 * Ancho maximo que una palabra puede ocupar a lo largo del texto: el de la
 * pagina visible. Solo una palabra mas ancha que la PAGINA se parte.
 */
function pageLimitAlong(page: PDFPage, angle: number): number {
  const crop = page.getCropBox();
  const { cos, sin } = snapTrig(angle);
  if (Math.abs(sin) < 1e-6) return crop.width;
  if (Math.abs(cos) < 1e-6) return crop.height;
  return Math.min(crop.width, crop.height);
}

/** Esquinas (antihorarias, en espacio de usuario) de un rectangulo local (centro + extremos) girado. */
function localRectToPolygon(
  center: { x: number; y: number },
  rect: { x0: number; y0: number; x1: number; y1: number },
  trig: { cos: number; sin: number },
): Array<{ x: number; y: number }> {
  return [
    [rect.x0, rect.y0],
    [rect.x1, rect.y0],
    [rect.x1, rect.y1],
    [rect.x0, rect.y1],
  ].map(([lx, ly]) => ({
    x: center.x + lx * trig.cos - ly * trig.sin,
    y: center.y + lx * trig.sin + ly * trig.cos,
  }));
}

/**
 * Dibuja el texto de una edicion y devuelve el rectangulo ORIENTADO (cuatro
 * esquinas, espacio de usuario) que ocupa la tinta dibujada, o `null` si no
 * dibujo nada. Girado, NO es su caja envolvente: asi un vecino que solo cae
 * dentro de la envolvente no cuenta como solape.
 */
function drawEditText(
  page: PDFPage,
  edit: TextEdit,
  resolved: ResolvedFont,
): Polygon | null {
  const { font, text } = resolved;
  if (text.trim().length === 0) return null;

  const size = edit.fontSize;
  const angle = finite(edit.rotation, 0);
  const trig = snapTrig(angle);
  const { cos, sin } = trig;
  const { width, height } = unrotatedSize(edit.box, angle);
  // Una palabra mas ancha que la caja pero que cabe en la pagina se deja
  // entera (sobresale) en vez de partirla; solo se parte si no cabe en la pagina.
  const lines = wrapTextWith(
    font,
    text,
    size,
    Math.max(1, width),
    (raw) => raw.trim(),
    Math.max(width, pageLimitAlong(page, angle)),
  );
  if (lines.length === 0) return null;

  const lineHeight =
    size *
    Math.min(
      MAX_LINE_HEIGHT,
      Math.max(MIN_LINE_HEIGHT, finite(edit.lineHeight ?? DEFAULT_LINE_HEIGHT, DEFAULT_LINE_HEIGHT)),
    );
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = Math.max(0, font.heightAtSize(size) - ascent);
  // Mismo reparto de "half-leading" que aplica el navegador en la vista
  // previa, para que lo dibujado caiga donde el usuario lo ve.
  const baselineFromTop = (lineHeight - (ascent + descent)) / 2 + ascent;

  const center = {
    x: edit.box.x + edit.box.width / 2,
    y: edit.box.y + edit.box.height / 2,
  };
  const color = hexToPdfColor(edit.color);
  let ink: { x0: number; y0: number; x1: number; y1: number } | null = null;

  lines.forEach((line, index) => {
    if (line.length === 0) return;
    const lineWidth = font.widthOfTextAtSize(line, size);
    let localX = -width / 2;
    if (edit.align === "center") localX = -lineWidth / 2;
    else if (edit.align === "right") localX = width / 2 - lineWidth;
    const localY = height / 2 - (index * lineHeight + baselineFromTop);

    page.drawText(line, {
      x: center.x + localX * cos - localY * sin,
      y: center.y + localX * sin + localY * cos,
      size,
      font,
      color,
      rotate: degrees(angle),
    });
    const line0 = {
      x0: localX,
      y0: localY - descent,
      x1: localX + lineWidth,
      y1: localY + ascent,
    };
    ink = ink
      ? {
          x0: Math.min(ink.x0, line0.x0),
          y0: Math.min(ink.y0, line0.y0),
          x1: Math.max(ink.x1, line0.x1),
          y1: Math.max(ink.y1, line0.y1),
        }
      : line0;
  });
  return ink ? localRectToPolygon(center, ink, trig) : null;
}

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function validBox(box: UserBox | undefined, optional: boolean): boolean {
  if (box === undefined) return optional;
  return (
    !!box &&
    finiteNumber(box.x) &&
    finiteNumber(box.y) &&
    finiteNumber(box.width) &&
    finiteNumber(box.height) &&
    box.width > 0 &&
    box.height > 0
  );
}

/**
 * Por que una edicion no se puede dibujar (y se omite), o `null` si es valida.
 * Cubre pagina fuera de rango, tamano de fuente, texto y TODO campo numerico
 * (cajas, cobertura, orientada, giro, interlineado, margen) no finito o con
 * dimensiones negativas o cero.
 */
export function invalidEditReason(
  edit: TextEdit,
  pageCount: number,
): "page" | "font-size" | "text" | "geometry" | null {
  if (!Number.isInteger(edit.pageIndex) || edit.pageIndex < 0 || edit.pageIndex >= pageCount) {
    return "page";
  }
  if (
    !finiteNumber(edit.fontSize) ||
    edit.fontSize < MIN_FONT_SIZE ||
    edit.fontSize > MAX_FONT_SIZE
  ) {
    return "font-size";
  }
  if (typeof edit.text !== "string") return "text";
  const oriented = edit.coverOriented;
  const orientedOk =
    oriented === undefined ||
    (!!oriented &&
      !!oriented.origin &&
      finiteNumber(oriented.origin.x) &&
      finiteNumber(oriented.origin.y) &&
      finiteNumber(oriented.width) &&
      finiteNumber(oriented.height) &&
      oriented.width > 0 &&
      oriented.height > 0 &&
      finiteNumber(oriented.rotation));
  const obstaclesOk =
    (edit.obstacles ?? []).every((o) => !!o && validBox(o.box, false)) &&
    (edit.coverClip ?? []).every((b) => validBox(b, false));
  if (
    !validBox(edit.box, false) ||
    !validBox(edit.coverBox, true) ||
    !orientedOk ||
    !obstaclesOk ||
    !finiteNumber(edit.rotation) ||
    !edit.cover ||
    !finiteNumber(edit.cover.padding) ||
    (edit.lineHeight !== undefined && !finiteNumber(edit.lineHeight))
  ) {
    return "geometry";
  }
  return null;
}

function sameWarning(a: EditWarning, b: EditWarning): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------------------------------------------ *
 * applyTextEdits
 * ------------------------------------------------------------------ */

/**
 * Aplica las ediciones de texto y devuelve el PDF resultante.
 *
 * Por pagina primero se pintan TODAS las coberturas y despues TODOS los
 * textos (cada edicion sigue cubriendo antes de escribir, y el texto de un
 * bloque nunca queda tapado por la cobertura de otro vecino). Las paginas
 * sin ediciones no se tocan. Una edicion con texto vacio y cobertura borra
 * el bloque; sin cobertura ni texto no hace nada.
 *
 * Fuente: `fontKey` si dibuja todo el texto; si no, un respaldo del catalogo
 * con los glifos (aviso `glyph-missing` con `fallbackKey`); lo que ninguna
 * fuente dibuje sale como "?" y tambien se avisa. El ajuste de linea colapsa
 * espacios repetidos y respeta los saltos explicitos.
 *
 * Un `/Contents` que es un array INDIRECTO compartido con otra pagina se
 * convierte en un array propio de la pagina antes de dibujar (si no, pdf-lib
 * anadiria la cobertura y el texto nuevo tambien a la otra pagina).
 *
 * Acepta bytes o un `PDFDocument` ya cargado (se modifica en su sitio). Lanza
 * `PdfError` (`cancelled` si `signal` se aborta, `encrypted` si el PDF esta
 * cifrado...). Un TTF que no se pueda cargar NO aborta: la edicion se dibuja
 * con la fuente base equivalente y se avisa `font-substituted`.
 */
export async function applyTextEdits(
  pdf: Uint8Array | ArrayBuffer | PDFDocument,
  edits: readonly TextEdit[],
  options: ApplyTextEditsOptions = {},
): Promise<ApplyTextEditsResult> {
  try {
    throwIfAborted(options.signal);
    const document =
      pdf instanceof PDFDocument
        ? pdf
        : await loadPdf(pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf));
    throwIfAborted(options.signal);
    options.onProgress?.(0.1);

    const pages = document.getPages();
    if (pages.length === 0) throw new PdfError("corrupt");

    let fonts = contexts.get(document);
    if (!fonts) {
      fonts = new Map();
      contexts.set(document, fonts);
    }
    const context: FontContext = {
      document,
      fonts,
      options,
    };

    const warningsByEdit: Record<string, EditWarning[]> = {};
    const warnings: EditWarning[] = [];
    const skipped: string[] = [];
    const note = (editId: string, warning: EditWarning) => {
      const list = (warningsByEdit[editId] ??= []);
      if (!list.some((existing) => sameWarning(existing, warning))) {
        list.push(warning);
      }
      if (!warnings.some((existing) => sameWarning(existing, warning))) {
        warnings.push(warning);
      }
    };

    const byPage = new Map<number, TextEdit[]>();
    for (const edit of edits) {
      const reason = invalidEditReason(edit, pages.length);
      if (reason) {
        // Una edicion inservible se omite y se cuenta; nunca aborta la exportacion.
        skipped.push(edit.id);
        note(String(edit.id), { kind: "edit-skipped", reason });
        continue;
      }
      const list = byPage.get(edit.pageIndex) ?? [];
      list.push(edit);
      byPage.set(edit.pageIndex, list);
    }

    const targets = [...byPage.keys()].sort((a, b) => a - b);
    let done = 0;
    for (const pageIndex of targets) {
      throwIfAborted(options.signal);
      const page = pages[pageIndex];
      const pageEdits = byPage.get(pageIndex) ?? [];

      // Un `/Contents` que es un array indirecto compartido con otra pagina se vuelve propio de esta ANTES de
      // dibujar: pdf-lib anade la cobertura y el texto nuevo a ese array, y si no la otra pagina los recibiria.
      isolateSharedContents(document, page);

      // 0) F2: quitar del flujo el texto original de los bloques reemplazados.
      const replacing = pageEdits.filter((edit) => edit.blockId !== undefined);
      const removal = new Map<string, RemoveOutcome>();
      if (replacing.length > 0) {
        for (const outcome of removeOriginalText(document, page, replacing)) {
          removal.set(outcome.editId, outcome);
        }
      }

      // 1) Coberturas de toda la pagina.
      for (const edit of pageEdits) {
        const shape = coverShape(edit);
        drawCover(page, edit, shape);
        if (shape?.kind === "oriented") {
          // El vecino que cruza el texto girado no se borra: queda un resto del original bajo el hueco.
          for (const hole of shape.holes) {
            note(edit.id, { kind: "cover-overlaps-neighbor", with: hole.id });
          }
        }
        // F2: el texto del bloque reemplazado se quito del flujo, o se avisa por que no.
        if (edit.blockId !== undefined) {
          const outcome = removal.get(edit.id);
          if (outcome?.removed) note(edit.id, { kind: "original-text-removed" });
          else note(edit.id, { kind: "original-text-remains", reason: outcome?.reason ?? "unreadable" });
        }
        // Cobertura de un fondo que no era liso: puede notarse un borde.
        if (edit.cover.color !== null && edit.cover.uniform === false) {
          note(edit.id, { kind: "background-not-uniform" });
        }
      }

      // 2) Textos.
      const inks: Array<{ edit: TextEdit; ink: Polygon }> = [];
      for (const edit of pageEdits) {
        throwIfAborted(options.signal);
        if (edit.text.trim().length === 0) continue;
        const resolved = await resolveFont(context, edit);
        throwIfAborted(options.signal);
        for (const warning of resolved.warnings) note(edit.id, warning);
        const ink = drawEditText(page, edit, resolved);
        if (ink) inks.push({ edit, ink });
      }

      // 3) Avisos de solape: el texto dibujado pisa un bloque vecino u otra edicion.
      // Un vecino que tambien se edita se compara por su texto nuevo (abajo), no por su caja vieja.
      const editedBlocks = new Set(
        pageEdits.flatMap((edit) => (edit.blockId !== undefined ? [edit.blockId] : [])),
      );
      for (const { edit, ink } of inks) {
        for (const obstacle of edit.obstacles ?? []) {
          if (editedBlocks.has(obstacle.id)) continue;
          if (polygonsOverlap(ink, boxPolygon(obstacle.box), Math.max(0.75, edit.fontSize * 0.2))) {
            note(edit.id, { kind: "overlap", with: obstacle.id });
          }
        }
      }
      for (let i = 0; i < inks.length; i += 1) {
        for (let j = i + 1; j < inks.length; j += 1) {
          const slack = Math.max(0.75, Math.min(inks[i].edit.fontSize, inks[j].edit.fontSize) * 0.2);
          if (polygonsOverlap(inks[i].ink, inks[j].ink, slack)) {
            note(inks[i].edit.id, { kind: "overlap", with: inks[j].edit.id });
            note(inks[j].edit.id, { kind: "overlap", with: inks[i].edit.id });
          }
        }
      }

      done += 1;
      options.onProgress?.(0.1 + (done / targets.length) * 0.8);
    }

    throwIfAborted(options.signal);
    const bytes = await document.save({ useObjectStreams: true });
    options.onProgress?.(1);
    return { bytes, warnings, warningsByEdit, skipped };
  } catch (error) {
    throw toPdfError(error);
  }
}

/* ------------------------------------------------------------------ *
 * Aplanar pagina (salida segura)
 * ------------------------------------------------------------------ */

/** Pagina ya rasterizada. `width`/`height` en puntos PDF, con `/Rotate`. */
export type RasterizedPage = {
  bytes: Uint8Array;
  format: "jpeg" | "png";
  width: number;
  height: number;
};

/** Rasterizador de las paginas de UN documento (se cierra al terminar). */
export type PageRasterizer = {
  rasterize(
    pageIndex: number,
    scale: number,
    quality: number,
  ): Promise<RasterizedPage>;
  close(): Promise<void>;
};

export type FlattenOptions = {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  /** Pixeles por punto PDF. Por defecto `FLATTEN_SCALE` (2 = 144 ppp). */
  scale?: number;
  /** Calidad JPEG 0..1. Por defecto `FLATTEN_QUALITY` (0,9). */
  quality?: number;
  /**
   * Se llama (antes de rasterizar) con lo que el aplanado va a perder del
   * documento y no se ve: formularios y marcadores (D14).
   */
  onWarnings?: (warnings: EditWarning[]) => void;
  /**
   * Fabrica del rasterizador. Por defecto pdf.js + canvas del navegador;
   * las pruebas en Node inyectan pdfjs legacy + `@napi-rs/canvas`.
   */
  createRasterizer?: (pdfBytes: Uint8Array) => Promise<PageRasterizer>;
};

/** 144 ppp: texto nitido al ampliar sin dispararse el peso (4000 px de lado maximo). */
export const FLATTEN_SCALE = 2;
/** JPEG 0,9: sin bandas visibles alrededor del texto fino. */
export const FLATTEN_QUALITY = 0.9;
const FLATTEN_MAX_SIDE = 4000;

/** Rasterizador por defecto: pdf.js sobre un canvas del DOM. */
async function createBrowserRasterizer(
  pdfBytes: Uint8Array,
): Promise<PageRasterizer> {
  const viewer = await openPdfDocument(pdfBytes);
  return {
    async rasterize(pageIndex, scale, quality) {
      const page = await viewer.getPage(pageIndex + 1);
      try {
        const base = page.getViewport({ scale: 1 });
        const longest = Math.max(base.width, base.height, 1);
        const safeScale = Math.max(
          0.1,
          Math.min(scale, FLATTEN_MAX_SIDE / longest),
        );
        // "print": rasterizado fuera de pantalla (no depende de rAF).
        const canvas = await renderPageToCanvas(page, {
          scale: safeScale,
          intent: "print",
        });
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (result) =>
              result
                ? resolve(result)
                : reject(new PdfError("unknown", "canvas.toBlob returned null")),
            "image/jpeg",
            quality,
          );
        });
        canvas.width = 0;
        canvas.height = 0;
        return {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          format: "jpeg",
          width: base.width,
          height: base.height,
        };
      } finally {
        page.cleanup();
      }
    },
    close: () => closePdfDocument(viewer),
  };
}

/**
 * Lo que `flattenPages` descarta de TODO el documento (se construye uno
 * nuevo) y no se ve en la pagina: campos de formulario (AcroForm) y marcadores
 * (Outlines). `null` si no hay nada de eso.
 */
export function inspectFlattenLoss(source: PDFDocument): EditWarning | null {
  let forms = false;
  try {
    forms = source.getForm().getFields().length > 0;
  } catch {
    // Un AcroForm roto no se puede contar: se asume que hay formulario.
    forms = source.catalog.has(PDFName.of("AcroForm"));
  }
  let outlines = false;
  try {
    const root = source.catalog.lookup(PDFName.of("Outlines"));
    outlines = root instanceof PDFDict && root.has(PDFName.of("First"));
  } catch {
    outlines = source.catalog.has(PDFName.of("Outlines"));
  }
  return forms || outlines ? { kind: "flatten-drops-forms", forms, outlines } : null;
}

/**
 * "Aplanar pagina": sustituye las paginas indicadas por una imagen de lo que
 * se ve, de modo que su texto original (y el que cubre una edicion F1) deja
 * de existir en el archivo. Mismo patron que `redactPdf`: se construye un
 * documento NUEVO y se copian las demas paginas, de forma que ningun objeto
 * de la pagina original (contenido, fuentes, anotaciones) llega a la salida.
 *
 * Coste: las paginas aplanadas pierden texto seleccionable, enlaces y
 * campos. Tambien se pierden, en TODO el documento, los formularios y los
 * marcadores: `options.onWarnings` recibe `flatten-drops-forms` si los habia.
 * Hay que aplicarlo DESPUES de `applyTextEdits` para hornear las ediciones.
 * Conserva titulo, autor, asunto y palabras clave. Por defecto rasteriza a
 * 144 ppp (`FLATTEN_SCALE` 2) en JPEG 0,9 (`FLATTEN_QUALITY`).
 */
export async function flattenPages(
  pdfBytes: Uint8Array,
  pageIndexes: readonly number[],
  options: FlattenOptions = {},
): Promise<Uint8Array> {
  let rasterizer: PageRasterizer | null = null;
  try {
    throwIfAborted(options.signal);
    const source = await loadPdf(pdfBytes);
    const total = source.getPageCount();
    if (total === 0) throw new PdfError("corrupt");

    const targets = new Set(
      pageIndexes.filter(
        (index) => Number.isInteger(index) && index >= 0 && index < total,
      ),
    );
    if (targets.size === 0) throw new PdfError("nothingSelected");

    const loss = inspectFlattenLoss(source);
    if (loss) options.onWarnings?.([loss]);

    rasterizer = await (options.createRasterizer ?? createBrowserRasterizer)(
      pdfBytes,
    );
    const scale = options.scale ?? FLATTEN_SCALE;
    const quality = options.quality ?? FLATTEN_QUALITY;

    const output = await PDFDocument.create();
    for (let index = 0; index < total; index += 1) {
      throwIfAborted(options.signal);
      if (!targets.has(index)) {
        const [copied] = await output.copyPages(source, [index]);
        output.addPage(copied);
      } else {
        const raster = await rasterizer.rasterize(index, scale, quality);
        throwIfAborted(options.signal);
        const image =
          raster.format === "png"
            ? await output.embedPng(raster.bytes)
            : await output.embedJpg(raster.bytes);
        const target = output.addPage([raster.width, raster.height]);
        target.drawImage(image, {
          x: 0,
          y: 0,
          width: raster.width,
          height: raster.height,
        });
      }
      options.onProgress?.(((index + 1) / total) * 0.92);
    }

    const title = source.getTitle();
    if (title) output.setTitle(title);
    const author = source.getAuthor();
    if (author) output.setAuthor(author);
    const subject = source.getSubject();
    if (subject) output.setSubject(subject);
    const keywords = source.getKeywords();
    if (keywords) output.setKeywords([keywords]);

    const bytes = await output.save({ useObjectStreams: true });
    options.onProgress?.(1);
    return bytes;
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (rasterizer) await rasterizer.close();
  }
}
