import { makeRng } from "@/lib/scan/__fixtures__/rng";
import {
  PAGE_H,
  PAGE_W,
  TITLES,
  canvasToRgba,
  renderBlankPage,
  renderBookSpread,
  renderDamagePhoto,
  renderFormPage,
  renderIdCard,
  renderReceipt,
  renderCeilingStains,
  renderFullBleedPage,
  renderRoofTiles,
  renderTextPage,
  renderWallFrame,
  renderWhiteboard,
  renderWhiteWithRect,
  type PageRender,
  type TruthLine,
} from "@/lib/scan/__fixtures__/pages";
import { composeScene, type DeskKind, type SceneParams } from "@/lib/scan/__fixtures__/scene";
import type { Rgba } from "@/lib/scan/pixels";
import type { QuadCorners } from "@/lib/scan/perspective";
import type { ScanMode } from "@/lib/scan/types";

/**
 * CORPUS SINTETICO del Escaner (reproducible: todo sale de semillas fijas): fotos de documentos de texto con ruido, sombras,
 * perspectiva y giros 0/90/180/270, brillo, desenfoque, hojas en blanco con sello pequeno, paginas casi identicas pero
 * distintas (mismo formulario con otros datos), tarjetas, recibos largos, libros abiertos y pizarras. Cada elemento lleva
 * su VERDAD (cuadrilatero, giro correcto, titulo, fecha, blanca, repetida...). Solo para pruebas.
 */

export type CorpusKind = "text" | "form" | "blank" | "receipt" | "idcard" | "book" | "whiteboard" | "photo";

export type CorpusTruth = {
  hasDocument: boolean;
  quad: QuadCorners | null;
  /** Giro horario que deja el texto derecho; `null` si no hay orientacion (hoja en blanco, foto). */
  neededRotation: 0 | 90 | 180 | 270 | null;
  title: string | null;
  /** Fecha ISO escrita en el documento. */
  date: string | null;
  blank: boolean;
  /** Casi vacia: casi nada pero algo (sello, numero de pagina...). NO es una hoja en blanco. */
  sparse?: boolean;
  /** Mismo valor = misma hoja capturada dos veces (repetidas). */
  duplicateGroup: string | null;
  /** Misma plantilla de formulario con datos distintos: NO son repetidas. */
  formFamily: number | null;
  sharp: boolean;
  glare: boolean;
  dark: boolean;
  /** Lineas de texto con su tamano (para el OCR de mentira) en coordenadas de la pagina impresa. */
  lines: TruthLine[];
  pageWidth: number;
  pageHeight: number;
  /** Libro: posicion del lomo (0..1) en la hoja enderezada. */
  spine: number | null;
};

export type CorpusItem = {
  id: string;
  kind: CorpusKind;
  mode: ScanMode;
  image: Rgba;
  /** La hoja SIN foto (papel limpio), para medir contra el original. */
  page: Rgba;
  truth: CorpusTruth;
};

type Build = { kind: CorpusKind; mode: ScanMode; render: PageRender & { width?: number; height?: number }; scene: SceneParams; extra?: Partial<CorpusTruth> };

function item(id: string, build: Build): CorpusItem {
  const { render } = build;
  const pageWidth = render.width ?? PAGE_W;
  const pageHeight = render.height ?? PAGE_H;
  const photo = build.kind === "photo";
  const scene = composeScene(render.canvas, { ...build.scene, ...(photo ? { scale: 0.99, angleDeg: 0, keystone: 0 } : {}) });
  const orientationKnown = !render.blank && build.kind !== "photo" && render.lines.length > 0;
  return {
    id,
    kind: build.kind,
    mode: build.mode,
    image: scene.image,
    page: canvasToRgba(render.canvas),
    truth: {
      hasDocument: !photo,
      quad: photo ? null : scene.quad,
      neededRotation: orientationKnown || build.kind === "whiteboard" || build.kind === "idcard" ? scene.neededRotation : null,
      title: render.title,
      date: render.date,
      blank: render.blank,
      duplicateGroup: null,
      formFamily: null,
      sharp: (build.scene.blur ?? 0) === 0,
      glare: !!build.scene.glare,
      dark: (build.scene.light ?? 1) < 0.5,
      lines: render.lines,
      pageWidth,
      pageHeight,
      spine: build.kind === "book" ? 0.5 : null,
      ...build.extra,
    },
  };
}

const DESKS: DeskKind[] = ["dark", "wood", "light", "blue"];
const DATES = ["2026-03-12", "2026-07-04", "2025-11-29", "2026-01-18"];

/** Documentos de texto y formularios con los cuatro giros: base de la metrica de orientacion y de deteccion. */
export function buildDocumentSet(): CorpusItem[] {
  const items: CorpusItem[] = [];
  let index = 0;
  for (let base = 0; base < 10; base += 1) {
    const english = base >= 8;
    for (const turns of [0, 1, 2, 3] as const) {
      index += 1;
      const rng = makeRng(900 + index);
      const isForm = base % 5 === 4;
      const render = isForm
        ? renderFormPage({ family: base, fill: base * 7 + turns })
        : renderTextPage({ seed: 40 + base, title: TITLES[base % TITLES.length], english, letterhead: base % 3 === 0, date: base % 2 === 0 ? DATES[base % DATES.length] : undefined });
      items.push(
        item(`doc-${base}-r${turns * 90}`, {
          kind: isForm ? "form" : "text",
          mode: "document",
          render,
          scene: {
            seed: 3000 + index,
            desk: DESKS[(base + turns) % DESKS.length],
            turns,
            shadow: rng.range(0.05, 0.35),
            noise: rng.range(1.5, 4.5),
            // Parte de las fotos con el borde de la hoja mas cerca del limite de la foto.
            scale: rng.range(0.66, 0.84),
          },
        }),
      );
    }
  }
  return items;
}

/** Hojas en blanco (con sello, con numero de pagina, limpias) y hojas casi vacias que NO lo son. */
export function buildBlankSet(): CorpusItem[] {
  const items: CorpusItem[] = [];
  for (let n = 0; n < 6; n += 1) {
    items.push(item(`blank-clean-${n}`, { kind: "blank", mode: "document", render: renderBlankPage({ seed: 200 + n }), scene: { seed: 4000 + n, desk: DESKS[n % 4], shadow: 0.1 + n * 0.04, noise: 2 + n * 0.5 } }));
  }
  for (let n = 0; n < 6; n += 1) {
    items.push(item(`blank-stamp-${n}`, { kind: "blank", mode: "document", render: renderBlankPage({ seed: 300 + n, stamp: true }), scene: { seed: 4100 + n, desk: DESKS[n % 4], shadow: 0.15 }, extra: { blank: false, sparse: true } }));
  }
  for (let n = 0; n < 4; n += 1) {
    items.push(item(`blank-number-${n}`, { kind: "blank", mode: "document", render: renderBlankPage({ seed: 400 + n, pageNumber: true }), scene: { seed: 4200 + n, desk: DESKS[(n + 1) % 4] }, extra: { blank: false, sparse: true } }));
  }
  for (let n = 0; n < 5; n += 1) {
    items.push(item(`short-note-${n}`, { kind: "text", mode: "document", render: renderBlankPage({ seed: 500 + n, shortNote: true }), scene: { seed: 4300 + n, desk: DESKS[n % 4], shadow: 0.2 } }));
  }
  return items;
}

/** Calidad: nitidas vs borrosas, con y sin brillo, oscuras. */
export function buildQualitySet(): CorpusItem[] {
  const items: CorpusItem[] = [];
  for (let n = 0; n < 6; n += 1) {
    const render = () => renderTextPage({ seed: 700 + n, title: TITLES[n % TITLES.length], letterhead: n % 2 === 0 });
    items.push(item(`q-sharp-${n}`, { kind: "text", mode: "document", render: render(), scene: { seed: 5000 + n, noise: 2.5, shadow: 0.1 } }));
    items.push(item(`q-blur-${n}`, { kind: "text", mode: "document", render: render(), scene: { seed: 5100 + n, noise: 2.5, shadow: 0.1, blur: 4 + (n % 3) } }));
    items.push(item(`q-glare-${n}`, { kind: "text", mode: "document", render: render(), scene: { seed: 5200 + n, noise: 2.5, shadow: 0.05, glare: { x: 0.45 + (n % 3) * 0.05, y: 0.4 + (n % 2) * 0.1, radius: 0.16, strength: 1.4 } } }));
    items.push(item(`q-dark-${n}`, { kind: "text", mode: "document", render: render(), scene: { seed: 5300 + n, noise: 3, shadow: 0.1, light: 0.32 } }));
  }
  return items;
}

/**
 * Sesion de prueba para repetidas: 6 hojas capturadas DOS veces (repetidas), 6 plantillas de formulario con 2-3 rellenos
 * distintos (NO repetidas entre si) y 6 hojas unicas.
 */
export function buildSessionSet(): CorpusItem[] {
  const items: CorpusItem[] = [];
  for (let n = 0; n < 6; n += 1) {
    const makePage = () => renderTextPage({ seed: 800 + n, title: TITLES[n % TITLES.length], letterhead: n % 2 === 0 });
    for (const take of [0, 1]) {
      items.push(
        item(`dup-${n}-${take}`, {
          kind: "text",
          mode: "document",
          render: makePage(),
          scene: { seed: 6000 + n * 10 + take, desk: DESKS[(n + take) % 4], angleDeg: take === 0 ? -2 : 3, keystone: take === 0 ? 0.02 : -0.03, scale: take === 0 ? 0.74 : 0.7, shadow: 0.12 + 0.1 * take },
          extra: { duplicateGroup: `dup-${n}` },
        }),
      );
    }
  }
  for (let family = 0; family < 6; family += 1) {
    const fills = family % 2 === 0 ? 3 : 2;
    for (let fill = 0; fill < fills; fill += 1) {
      items.push(
        item(`form-${family}-${fill}`, {
          kind: "form",
          mode: "document",
          render: renderFormPage({ family, fill: family * 10 + fill }),
          scene: { seed: 6200 + family * 10 + fill, desk: DESKS[family % 4], angleDeg: fill - 1, keystone: 0.01 * fill, scale: 0.72 },
          extra: { formFamily: family },
        }),
      );
    }
  }
  for (let n = 0; n < 6; n += 1) {
    items.push(item(`uniq-${n}`, { kind: "text", mode: "document", render: renderTextPage({ seed: 900 + n * 13, title: TITLES[(n + 3) % TITLES.length] }), scene: { seed: 6400 + n } }));
  }
  return items;
}

/** Modos especiales: tarjetas, recibos, libros, pizarras y fotos de danos. */
export function buildSpecialSet(): CorpusItem[] {
  const items: CorpusItem[] = [];
  for (let n = 0; n < 4; n += 1) {
    items.push(item(`id-${n}`, { kind: "idcard", mode: "id-card", render: renderIdCard(10 + n), scene: { seed: 7000 + n, desk: DESKS[n % 4], scale: 0.62, angleDeg: n * 2 - 3, width: 900, height: 700, turns: (n % 2) as 0 | 1 } }));
  }
  for (let n = 0; n < 4; n += 1) {
    items.push(item(`receipt-${n}`, { kind: "receipt", mode: "receipt", render: renderReceipt(20 + n), scene: { seed: 7100 + n, desk: DESKS[(n + 1) % 4], scale: 0.3, angleDeg: n * 2 - 3, keystone: 0.03 } }));
  }
  for (let n = 0; n < 4; n += 1) {
    items.push(item(`book-${n}`, { kind: "book", mode: "book", render: renderBookSpread(30 + n), scene: { seed: 7200 + n, desk: DESKS[n % 4], scale: 0.85, angleDeg: n - 1.5, keystone: 0.02, width: 1100, height: 900 } }));
  }
  for (let n = 0; n < 4; n += 1) {
    items.push(item(`board-${n}`, { kind: "whiteboard", mode: "whiteboard", render: renderWhiteboard(40 + n), scene: { seed: 7300 + n, desk: "dark", scale: 0.8, angleDeg: n - 1.5, width: 1100, height: 850, glare: n % 2 === 0 ? { x: 0.6, y: 0.4, radius: 0.12, strength: 0.5 } : null } }));
  }
  for (let n = 0; n < 3; n += 1) {
    items.push(item(`photo-${n}`, { kind: "photo", mode: "photo", render: renderDamagePhoto(50 + n), scene: { seed: 7400 + n, width: 800, height: 600, noise: 2 } }));
  }
  return items;
}

/**
 * Escenas SIN documento y casos trampa: la foto ES lo unico que hay (techos, paredes, un cuadro) o ya es toda documento (pagina
 * blanca a sangre con un rectangulo rojo dentro). El recorte automatico NO debe aplicarse a ninguna (`hasDocument = false`).
 */
export function buildNoDocumentSet(): CorpusItem[] {
  const items: CorpusItem[] = [];
  // La foto ES la imagen (sin escritorio alrededor): se usa el lienzo tal cual.
  const add = (id: string, render: PageRender & { width: number; height: number }) => {
    const image = canvasToRgba(render.canvas);
    items.push({
      id,
      kind: "photo",
      mode: "document",
      image,
      page: image,
      truth: { hasDocument: false, quad: null, neededRotation: null, title: null, date: null, blank: false, duplicateGroup: null, formFamily: null, sharp: true, glare: false, dark: false, lines: render.lines, pageWidth: render.width, pageHeight: render.height, spine: null },
    });
  };
  for (let n = 0; n < 3; n += 1) add(`roof-${n}`, renderRoofTiles(60 + n));
  for (let n = 0; n < 3; n += 1) add(`ceiling-${n}`, renderCeilingStains(70 + n));
  for (let n = 0; n < 2; n += 1) add(`wall-${n}`, renderWallFrame(80 + n));
  add("white-red-rect", renderWhiteWithRect());
  add("fullbleed-text", renderFullBleedPage(95));
  return items;
}

export type Corpus = {
  documents: CorpusItem[];
  blanks: CorpusItem[];
  quality: CorpusItem[];
  session: CorpusItem[];
  special: CorpusItem[];
  noDocument: CorpusItem[];
};

export function buildCorpus(): Corpus {
  return {
    documents: buildDocumentSet(),
    blanks: buildBlankSet(),
    quality: buildQualitySet(),
    session: buildSessionSet(),
    special: buildSpecialSet(),
    noDocument: buildNoDocumentSet(),
  };
}
