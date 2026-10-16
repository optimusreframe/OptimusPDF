/*
 * Corpus SINTETICO del automapeo (versionado, para CI): contratos de ejemplo generados con pdf-lib, con su verdad de
 * terreno. Todo se disena en FRACCIONES de la pagina (posicion y tamano de letra), asi el mismo contrato se genera en
 * cualquier tamano de papel, ampliado o reducido y con la pagina girada (`/Rotate`) sin cambiar el diseno.
 *
 * Los textos son relleno legal inventado (no copian ningun contrato real). Casos:
 *  - iniciales sin etiqueta repetidas en la esquina; iniciales con «(INITIALS) ____» en cada pagina;
 *  - bloques de firma de 1 y 2 firmantes en columnas, apilados y numerados; ES y EN;
 *  - rayas compartidas («Firma ... Fecha» bajo una sola raya), casillas de iniciales, rayas muy cortas;
 *  - senuelos que NO deben detectarse: subrayados decorativos, tablas, papel pautado, reglas de cabecera y pie, prosa
 *    con las palabras «sign»/«initial»;
 *  - paginas sin ninguna raya, paginas escaneadas (solo imagen).
 */

import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from "@cantoo/pdf-lib";
import type { EvalItem } from "@/lib/pdf/testing/autoMapEval";

export type Pt = [number, number];

export type Rot = 0 | 90 | 180 | 270;

/** Elemento de diseno; `x`, `y` (desde ARRIBA) y tamanos son fracciones de la pagina; `size` es fraccion del ANCHO. */
export type Item =
  | { t: "text"; x: number; y: number; text: string; size?: number; bold?: boolean; serif?: boolean }
  | { t: "hline"; x0: number; x1: number; y: number; thick?: number; dash?: boolean }
  | { t: "vline"; x: number; y0: number; y1: number; thick?: number }
  | { t: "rect"; x: number; y: number; w: number; h: number; fill?: number }
  | { t: "image"; x: number; y: number; w: number; h: number; pixels?: number };

export type TruthItem = { kind: "initials" | "signature"; rect: { x: number; y: number; width: number; height: number } };
export type PageSpec = { items: Item[]; truth?: TruthItem[]; scanned?: boolean };

export type SyntheticDoc = {
  name: string;
  signers: 1 | 2;
  pages: PageSpec[];
  /** Paginas (0-based) en las que NO se permite ninguna propuesta `high` de iniciales o firma. */
  decoyPages?: number[];
};

export const FONT_FRACTION = 0.0165;

/** Letras de relleno legal inventado (generico), para llenar parrafos sin copiar ningun contrato. */
const FILLER = [
  "The parties agree that the services described herein will be performed in a workmanlike manner and in accordance with applicable law.",
  "Any dispute arising under this agreement shall first be submitted to good faith negotiation before any further proceedings are started.",
  "Payment is due within thirty days of the invoice date and late balances may accrue a monthly finance charge as permitted by statute.",
  "This agreement constitutes the entire understanding between the parties and supersedes all prior discussions, whether written or oral.",
  "If any provision is held unenforceable the remaining provisions shall continue in full force and effect without modification.",
  "The customer authorizes the company to communicate with the carrier regarding the status of the claim and the scope of the repairs.",
  "Notices under this agreement must be in writing and delivered by hand, by certified mail or by a recognized overnight courier.",
  "The company is not responsible for delays caused by weather, supply shortages, or circumstances beyond its reasonable control.",
];

export function fillerLines(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, index) => FILLER[(index + offset) % FILLER.length]);
}

/** Texto corrido: `count` renglones desde `y0` con paso `step` (fracciones), a la izquierda `x`. */
export function paragraph(y0: number, count: number, opts: { x?: number; step?: number; offset?: number; size?: number; width?: number } = {}): Item[] {
  const { x = 0.1, step = 0.0215, offset = 0, size = FONT_FRACTION, width = 0.8 } = opts;
  return fillerLines(count, offset).map((text, index) => ({ t: "text" as const, x, y: y0 + index * step, text: fit(text, width, size), size, serif: true }));
}

/** Recorta una frase a un ancho dado (aproximacion por caracteres: 0,46 del tamano de letra). */
function fit(text: string, width: number, size: number): string {
  const max = Math.floor(width / (0.46 * size));
  return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, "");
}

/** Ancho aproximado (fraccion del ancho de pagina) de un texto de Helvetica. */
export function textWidth(text: string, size = FONT_FRACTION, bold = false): number {
  return text.length * size * (bold ? 0.56 : 0.52);
}

type Rendered = { bytes: Uint8Array; truth: EvalItem[]; pageSizes: Pt[] };

export type RenderOptions = {
  page?: Pt;
  /** Ampliacion de TODA la pagina (papel y contenido) respecto a `page`. */
  scale?: number;
  rotate?: Rot;
  /** Escala solo el tamano de letra (no la pagina): un contrato con letra mas grande o mas chica. */
  fontScale?: number;
};

/**
 * Genera el PDF de un contrato sintetico y su verdad de terreno ya en el espacio de la VISTA. Con `rotate` el
 * contenido se dibuja GIRADO en el espacio de usuario para que, con `/Rotate`, se vea derecho (como un contrato
 * apaisado real): el texto es horizontal en la vista.
 */
export async function renderSynthetic(doc: SyntheticDoc, options: RenderOptions = {}): Promise<Rendered> {
  const [baseW, baseH] = options.page ?? [612, 792];
  const scale = options.scale ?? 1;
  // Tamano de la VISTA; el de la pagina en el PDF intercambia ancho y alto con 90/270.
  const W = baseW * scale;
  const H = baseH * scale;
  const rotation = options.rotate ?? 0;
  const swapped = rotation === 90 || rotation === 270;
  const fontScale = options.fontScale ?? 1;
  const pdf = await PDFDocument.create();
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const needsImage = doc.pages.some((spec) => spec.items.some((item) => item.t === "image"));
  const image = needsImage ? await pdf.embedPng(Uint8Array.from(atob(PIXEL_PNG), (ch) => ch.charCodeAt(0))) : undefined;
  const truth: EvalItem[] = [];
  const pageSizes: Pt[] = [];
  doc.pages.forEach((spec, pageIndex) => {
    const page = pdf.addPage(swapped ? [H, W] : [W, H]);
    pageSizes.push(swapped ? [H, W] : [W, H]);
    drawItems(page, spec.items, { W, H, rotation, fontScale, sans, sansBold, serif, image });
    if (rotation !== 0) page.setRotation(degrees(rotation));
    // La verdad de terreno ya esta disenada en la vista: no se transforma.
    for (const item of spec.truth ?? []) truth.push({ pageIndex, kind: item.kind, rect: item.rect, anchoredToLine: true });
  });
  const bytes = await pdf.save();
  return { bytes, truth, pageSizes };
}

type Fonts = { W: number; H: number; rotation: Rot; fontScale: number; sans: PDFFont; sansBold: PDFFont; serif: PDFFont; image?: PDFImage };

/** PNG de 1 x 1 pixel (blanco): una «imagen» real en el contenido, para paginas escaneadas sin texto. */
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Punto de la vista (puntos, origen arriba-izquierda) -> espacio de usuario con `/Rotate` (inverso de `userToView`). */
function toUser(env: Fonts, vx: number, vyTop: number): { x: number; y: number } {
  const vy = env.H - vyTop;
  const userW = env.rotation === 90 || env.rotation === 270 ? env.H : env.W;
  const userH = env.rotation === 90 || env.rotation === 270 ? env.W : env.H;
  switch (env.rotation) {
    case 90:
      return { x: userW - vy, y: vx };
    case 180:
      return { x: userW - vx, y: userH - vy };
    case 270:
      return { x: vy, y: userH - vx };
    default:
      return { x: vx, y: vy };
  }
}

function drawItems(page: PDFPage, items: readonly Item[], env: Fonts): void {
  const { W, H } = env;
  const line = (x0: number, y0: number, x1: number, y1: number, thickness: number, dash = false) => {
    page.drawLine({ start: toUser(env, x0 * W, y0 * H), end: toUser(env, x1 * W, y1 * H), thickness, color: rgb(0, 0, 0), dashArray: dash ? [3, 3] : undefined });
  };
  for (const item of items) {
    switch (item.t) {
      case "text": {
        const font = item.serif ? env.serif : item.bold ? env.sansBold : env.sans;
        const size = (item.size ?? FONT_FRACTION) * W * env.fontScale;
        const origin = toUser(env, item.x * W, item.y * H);
        page.drawText(item.text, { x: origin.x, y: origin.y, size, font, color: rgb(0.08, 0.08, 0.1), rotate: degrees(env.rotation) });
        break;
      }
      case "hline":
        line(item.x0, item.y, item.x1, item.y, (item.thick ?? 0.0009) * W, item.dash);
        break;
      case "vline":
        line(item.x, item.y0, item.x, item.y1, (item.thick ?? 0.0009) * W);
        break;
      case "rect": {
        if (item.fill !== undefined) {
          const a = toUser(env, item.x * W, item.y * H);
          const b = toUser(env, (item.x + item.w) * W, (item.y + item.h) * H);
          page.drawRectangle({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y), color: rgb(item.fill, item.fill, item.fill) });
        } else if (env.rotation === 0) {
          // Rectangulo de verdad (operador `re` + trazo), como lo dibujan casi todos los exportadores.
          page.drawRectangle({ x: item.x * W, y: H - (item.y + item.h) * H, width: item.w * W, height: item.h * H, borderColor: rgb(0, 0, 0), borderWidth: 0.0009 * W });
        } else {
          const t = 0.0009 * W;
          line(item.x, item.y, item.x + item.w, item.y, t);
          line(item.x, item.y + item.h, item.x + item.w, item.y + item.h, t);
          line(item.x, item.y, item.x, item.y + item.h, t);
          line(item.x + item.w, item.y, item.x + item.w, item.y + item.h, t);
        }
        break;
      }
      case "image": {
        // Una pagina «escaneada» es una imagen sin texto; las rayas que tendria las aporta el rasterizador de la prueba.
        const a = toUser(env, item.x * W, item.y * H);
        const b = toUser(env, (item.x + item.w) * W, (item.y + item.h) * H);
        if (env.image) page.drawImage(env.image, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Bloques reutilizables (todas las medidas en fracciones de pagina)
 * ------------------------------------------------------------------ */

/** Rotulo con su raya a la derecha y el hueco esperado encima de la raya. */
export function labelLine(label: string, y: number, x = 0.1, lineLen = 0.32, size = FONT_FRACTION): Item[] {
  const x0 = x + textWidth(label, size) + 0.012;
  return [
    { t: "text", x, y, text: label, size },
    { t: "hline", x0, x1: x0 + lineLen, y: y + 0.004 },
  ];
}

/** Raya con su leyenda debajo; devuelve los items y la raya (para la verdad de terreno). */
export function captionedLine(caption: string, x0: number, x1: number, y: number, size = FONT_FRACTION * 0.9): Item[] {
  return [
    { t: "hline", x0, x1, y },
    { t: "text", x: x0, y: y + 0.0185, text: caption, size },
  ];
}

/** Rectangulo de verdad (iniciales/firma) justo encima de una raya. */
export function aboveLine(x0: number, x1: number, y: number, height: number, kind: TruthItem["kind"]): TruthItem {
  return { kind, rect: { x: x0, y: y - height, width: x1 - x0, height } };
}

/** Iniciales de 1 o 2 firmantes sobre una raya larga: mitades iguales. */
export function initialsTruth(x0: number, x1: number, y: number, signers: 1 | 2, height = 0.04): TruthItem[] {
  if (signers === 1) return [aboveLine(x0, x1, y, height, "initials")];
  const mid = (x0 + x1) / 2;
  return [aboveLine(x0, mid, y, height, "initials"), aboveLine(mid, x1, y, height, "initials")];
}

function header(title: string): Item[] {
  return [{ t: "text", x: 0.1, y: 0.07, text: title, size: FONT_FRACTION * 1.3, bold: true }];
}

/** Pagina de cuerpo con un parrafo y la raya de iniciales SIN etiqueta (esquina inferior derecha). */
function bodyWithCornerLine(index: number, jitter: number, signers: 1 | 2): PageSpec {
  const x0 = 0.74 + jitter;
  const x1 = 0.87 + jitter;
  const y = 0.93 + jitter / 2;
  return {
    items: [...header(`Section ${index + 1}`), ...paragraph(0.12, 30, { offset: index }), { t: "hline", x0, x1, y }],
    truth: initialsTruth(x0, x1, y, signers),
  };
}

/* ------------------------------------------------------------------ *
 * Contratos del corpus
 * ------------------------------------------------------------------ */

/** Bloque de dos firmantes en columnas (leyenda debajo de cada raya) y fecha y nombre debajo. */
function columnsSignaturePage(opts: { left: string; right: string; withDates?: boolean; y?: number }): PageSpec {
  const y = opts.y ?? 0.55;
  const items: Item[] = [
    ...header("Signatures"),
    ...paragraph(0.12, 8),
    ...captionedLine(opts.left, 0.1, 0.42, y),
    ...captionedLine(opts.right, 0.55, 0.88, y),
  ];
  if (opts.withDates) {
    items.push(...captionedLine("Date", 0.1, 0.3, y + 0.1), ...captionedLine("Date", 0.55, 0.75, y + 0.1));
  }
  return {
    items,
    truth: [aboveLine(0.1, 0.42, y, 0.05, "signature"), aboveLine(0.55, 0.88, y, 0.05, "signature")],
  };
}

/** Bloque de firmas apiladas (de arriba abajo = firmante 1, 2) con leyenda debajo. */
function stackedSignaturePage(captions: [string, string], x0 = 0.12, x1 = 0.5): PageSpec {
  const ys = [0.5, 0.64];
  return {
    items: [...header("Signatures"), ...paragraph(0.12, 8), ...captionedLine(captions[0], x0, x1, ys[0]), ...captionedLine(captions[1], x0, x1, ys[1])],
    truth: [aboveLine(x0, x1, ys[0], 0.05, "signature"), aboveLine(x0, x1, ys[1], 0.05, "signature")],
  };
}

export type CorpusEntry = { doc: SyntheticDoc; note: string };

/** Paginas de cuerpo (solo texto, sin rayas) delante del contrato: asi todos tienen entre 3 y 9 paginas. */
function withBody(doc: SyntheticDoc, extra: number): SyntheticDoc {
  const body: PageSpec[] = Array.from({ length: extra }, (_, index) => ({ items: [...header(`Terms ${index + 1}`), ...paragraph(0.12, 32, { offset: index + 3 })] }));
  return { ...doc, pages: [...body, ...doc.pages], decoyPages: doc.decoyPages?.map((page) => page + extra) };
}

/** Contratos del corpus (cada uno con su verdad de terreno). */
export function syntheticCorpus(): CorpusEntry[] {
  const out: CorpusEntry[] = [];

  // 1. Iniciales SIN etiqueta repetidas en la esquina (6 paginas de cuerpo) + firmas en columnas (dos firmantes).
  out.push({
    note: "iniciales repetidas sin etiqueta, firmas en columnas",
    doc: {
      name: "corner-repeat-2",
      signers: 2,
      pages: [0, 1, 2, 3, 4, 5].map((i) => bodyWithCornerLine(i, [0, 0.003, -0.002, 0.004, 0.001, -0.003][i], 2)).concat([columnsSignaturePage({ left: "Signature of Client 1", right: "Signature of Client 2", withDates: true })]),
    },
  });

  // 2. «(INITIALS) ______» con la raya en el texto, en alturas distintas por pagina; firmas apiladas.
  {
    const pages: PageSpec[] = [];
    const heights = [0.9, 0.86, 0.92, 0.88];
    heights.forEach((y, index) => {
      const labelX = 0.7;
      const x0 = labelX + textWidth("(INITIALS)") + 0.012;
      pages.push({
        items: [...header(`Part ${index + 1}`), ...paragraph(0.12, 28, { offset: index }), { t: "text", x: labelX, y, text: "(INITIALS)", size: FONT_FRACTION }, { t: "hline", x0, x1: x0 + 0.1, y: y + 0.004 }],
        truth: initialsTruth(x0, x0 + 0.1, y + 0.004, 2),
      });
    });
    pages.push(stackedSignaturePage(["Signature of Policyholder", "Signature of Policyholder"]));
    out.push({ note: "iniciales etiquetadas con raya, firmas apiladas", doc: { name: "labelled-initials-2", signers: 2, pages } });
  }

  // 3. Espanol, un firmante: «Iniciales: ____», «Firma del cliente», «Fecha».
  {
    const pages: PageSpec[] = [];
    for (let index = 0; index < 3; index += 1) {
      const y = 0.94;
      const x0 = 0.1 + textWidth("Iniciales:") + 0.012;
      pages.push({
        items: [...header(`Cláusula ${index + 1}`), ...paragraph(0.12, 30, { offset: index }), { t: "text", x: 0.1, y, text: "Iniciales:", size: FONT_FRACTION }, { t: "hline", x0, x1: x0 + 0.14, y: y + 0.004 }],
        truth: initialsTruth(x0, x0 + 0.14, y + 0.004, 1),
      });
    }
    pages.push({
      items: [
        ...header("Firmas"),
        ...paragraph(0.12, 8),
        ...captionedLine("Firma del cliente", 0.1, 0.45, 0.5),
        ...captionedLine("Fecha", 0.55, 0.78, 0.5),
        ...captionedLine("Nombre del cliente", 0.1, 0.45, 0.62),
      ],
      truth: [aboveLine(0.1, 0.45, 0.5, 0.05, "signature")],
    });
    out.push({ note: "espanol, un firmante", doc: { name: "es-single", signers: 1, pages } });
  }

  // 4. Firmas numeradas con el orden INVERTIDO en la pagina: las pistas mandan sobre la posicion.
  out.push({
    note: "firmantes numerados (la pista manda sobre la posicion)",
    doc: {
      name: "numbered-hints",
      signers: 2,
      pages: [
        {
          items: [...header("Signatures"), ...paragraph(0.12, 6), ...captionedLine("Signer 2 signature", 0.1, 0.42, 0.55), ...captionedLine("Signer 1 signature", 0.55, 0.88, 0.55)],
          truth: [aboveLine(0.55, 0.88, 0.55, 0.05, "signature"), aboveLine(0.1, 0.42, 0.55, 0.05, "signature")],
        },
      ],
    },
  });

  // 5. Dos columnas Insured / Co-insured.
  out.push({
    note: "columnas Insured / Co-insured",
    doc: { name: "insured-coinsured", signers: 2, pages: [columnsSignaturePage({ left: "Insured Signature", right: "Co-insured Signature", withDates: true })] },
  });

  // 6. Una sola raya larga con «Signature» y «Date» debajo (raya compartida).
  out.push({
    note: "raya compartida firma-fecha",
    doc: {
      name: "shared-line",
      signers: 1,
      pages: [
        {
          items: [
            ...header("Signature"),
            ...paragraph(0.12, 6),
            { t: "hline", x0: 0.1, x1: 0.58, y: 0.6 },
            { t: "text", x: 0.1, y: 0.62, text: "Client Signature", size: FONT_FRACTION * 0.9 },
            { t: "text", x: 0.46, y: 0.62, text: "Date", size: FONT_FRACTION * 0.9 },
          ],
          truth: [aboveLine(0.1, 0.43, 0.6, 0.05, "signature")],
        },
      ],
    },
  });

  // 7. Casilla de iniciales (rectangulo vacio) con «Initials» a la izquierda, 3 paginas.
  {
    const pages: PageSpec[] = [0, 1, 2].map((index) => {
      const bx = 0.78;
      const by = 0.9 - index * 0.01;
      return {
        items: [...header(`Part ${index + 1}`), ...paragraph(0.12, 28, { offset: index }), { t: "text", x: 0.64, y: by + 0.027, text: "Initials", size: FONT_FRACTION }, { t: "rect", x: bx, y: by, w: 0.14, h: 0.04 }],
        truth: [
          { kind: "initials" as const, rect: { x: bx, y: by, width: 0.07, height: 0.04 } },
          { kind: "initials" as const, rect: { x: bx + 0.07, y: by, width: 0.07, height: 0.04 } },
        ],
      };
    });
    out.push({ note: "casilla de iniciales", doc: { name: "initials-box", signers: 2, pages } });
  }

  // 8. Raya de iniciales MUY corta junto a «(Initial)»: dos casillas contiguas dentro del margen.
  {
    const pages: PageSpec[] = [0, 1, 2, 3].map((index) => {
      const labelX = 0.7;
      const x0 = labelX + textWidth("(Initial)") + 0.01;
      const y = 0.9 - index * 0.012;
      return {
        items: [...header(`Part ${index + 1}`), ...paragraph(0.12, 28, { offset: index }), { t: "text", x: labelX, y, text: "(Initial)", size: FONT_FRACTION }, { t: "hline", x0, x1: x0 + 0.075, y: y + 0.004 }],
        truth: [
          { kind: "initials" as const, rect: { x: x0, y: y - 0.036, width: 0.075, height: 0.04 } },
          { kind: "initials" as const, rect: { x: x0 + 0.075, y: y - 0.036, width: 0.075, height: 0.04 } },
        ],
      };
    });
    out.push({ note: "raya de iniciales muy corta", doc: { name: "short-initials-line", signers: 2, pages } });
  }

  // 8b. Recuadro de firma vacio con «Signature» a la izquierda y otro con la leyenda debajo.
  out.push({
    note: "recuadros de firma",
    doc: {
      name: "signature-boxes",
      signers: 2,
      pages: [
        {
          items: [
            ...header("Signatures"),
            ...paragraph(0.12, 6),
            { t: "text", x: 0.1, y: 0.47, text: "Signature:", size: FONT_FRACTION },
            { t: "rect", x: 0.25, y: 0.42, w: 0.4, h: 0.07 },
            { t: "rect", x: 0.25, y: 0.58, w: 0.4, h: 0.07 },
            { t: "text", x: 0.25, y: 0.685, text: "Co-client signature", size: FONT_FRACTION * 0.9 },
          ],
          truth: [
            { kind: "signature", rect: { x: 0.25, y: 0.42, width: 0.4, height: 0.07 } },
            { kind: "signature", rect: { x: 0.25, y: 0.58, width: 0.4, height: 0.07 } },
          ],
        },
      ],
    },
  });

  // 9. Senuelos: no deben dar iniciales ni firmas de nivel `high`.
  {
    const decoys: PageSpec[] = [];
    // 9a. subrayados decorativos de palabras y titulo con regla
    decoys.push({
      items: [
        ...header("General Terms"),
        { t: "hline", x0: 0.1, x1: 0.9, y: 0.09, thick: 0.002 },
        ...paragraph(0.14, 26),
        { t: "hline", x0: 0.1, x1: 0.2, y: 0.15 },
        { t: "hline", x0: 0.3, x1: 0.38, y: 0.215 },
        { t: "hline", x0: 0.5, x1: 0.62, y: 0.3 },
      ],
    });
    // 9b. tabla de precios con cuadricula
    {
      const items: Item[] = [...header("Price List")];
      const x0 = 0.1;
      const x1 = 0.9;
      for (let r = 0; r <= 8; r += 1) items.push({ t: "hline", x0, x1, y: 0.15 + r * 0.045 });
      for (const x of [0.1, 0.4, 0.65, 0.9]) items.push({ t: "vline", x, y0: 0.15, y1: 0.15 + 8 * 0.045 });
      for (let r = 0; r < 8; r += 1) {
        items.push({ t: "text", x: 0.12, y: 0.178 + r * 0.045, text: `Item ${r + 1}`, size: FONT_FRACTION }, { t: "text", x: 0.67, y: 0.178 + r * 0.045, text: `$${r + 1}0.00`, size: FONT_FRACTION });
      }
      decoys.push({ items });
    }
    // 9c. papel pautado
    {
      const items: Item[] = [...header("Notes")];
      for (let r = 0; r < 14; r += 1) items.push({ t: "hline", x0: 0.1, x1: 0.9, y: 0.16 + r * 0.05 });
      decoys.push({ items });
    }
    // 9d. prosa con las palabras clave pero sin etiquetas, con pie de pagina con regla larga
    decoys.push({
      items: [
        ...header("Conditions"),
        { t: "text", x: 0.1, y: 0.15, text: "You may sign this agreement only after reading every section and the initial payment is due on signature day.", size: FONT_FRACTION },
        { t: "text", x: 0.1, y: 0.18, text: "A signature below confirms that the customer has received the initial estimate and the notice of cancellation.", size: FONT_FRACTION },
        ...paragraph(0.24, 22),
        { t: "hline", x0: 0.1, x1: 0.9, y: 0.945 },
        { t: "text", x: 0.1, y: 0.965, text: "Page 4 of 8 - Contractor License 0000", size: FONT_FRACTION * 0.8 },
      ],
    });
    // 9e. pagina sin ninguna raya
    decoys.push({ items: [...header("Definitions"), ...paragraph(0.12, 36)] });
    // 9f. texto subrayado en el pie de cada pagina (misma posicion) que NO son iniciales
    for (let i = 0; i < 3; i += 1) {
      decoys.push({
        items: [...header(`Annex ${i + 1}`), ...paragraph(0.12, 28, { offset: i }), { t: "text", x: 0.62, y: 0.93, text: "www.example.test", size: FONT_FRACTION }, { t: "hline", x0: 0.62, x1: 0.62 + textWidth("www.example.test"), y: 0.9335 }],
      });
    }
    out.push({ note: "senuelos sin iniciales ni firmas", doc: { name: "decoys", signers: 2, pages: decoys, decoyPages: decoys.map((_, index) => index) } });
  }

  // 9b. Un pie con direccion subrayada en CADA pagina, en la misma posicion: es un subrayado de texto, no iniciales.
  {
    const pages: PageSpec[] = [0, 1, 2, 3, 4].map((i) => ({
      items: [
        ...header(`Annex ${i + 1}`),
        ...paragraph(0.12, 28, { offset: i }),
        { t: "text" as const, x: 0.62, y: 0.93, text: "www.example.test", size: FONT_FRACTION },
        { t: "hline" as const, x0: 0.62, x1: 0.62 + textWidth("www.example.test"), y: 0.9335 },
      ],
    }));
    out.push({ note: "subrayado de texto repetido en el pie", doc: { name: "decoy-footer-underline", signers: 2, pages, decoyPages: [0, 1, 2, 3, 4] } });
  }

  // 9b2. Una regla corta de pie de pagina repetida, con el texto del pie JUSTO debajo: separador, no iniciales.
  {
    const pages: PageSpec[] = [0, 1, 2, 3, 4].map((i) => ({
      items: [
        ...header(`Annex ${i + 1}`),
        ...paragraph(0.12, 28, { offset: i }),
        { t: "hline" as const, x0: 0.74, x1: 0.87, y: 0.93 },
        { t: "text" as const, x: 0.74, y: 0.945, text: `Page ${i + 1}`, size: FONT_FRACTION },
      ],
    }));
    out.push({ note: "regla de pie con texto debajo", doc: { name: "decoy-footer-rule", signers: 2, pages, decoyPages: [0, 1, 2, 3, 4] } });
  }

  // 9c. Una raya corta repetida en la parte alta (membrete): no es la raya de iniciales de pie de pagina.
  {
    const pages: PageSpec[] = [0, 1, 2, 3, 4].map((i) => ({ items: [...header(`Part ${i + 1}`), { t: "hline" as const, x0: 0.74, x1: 0.87, y: 0.045 }, ...paragraph(0.12, 28, { offset: i })] }));
    out.push({ note: "raya corta repetida en el membrete", doc: { name: "decoy-letterhead-rule", signers: 2, pages, decoyPages: [0, 1, 2, 3, 4] } });
  }

  // 10. Etiquetas sin raya: una pagina con «Signature» y «Initials» pero sin ninguna linea.
  out.push({
    note: "etiquetas sin raya",
    doc: {
      name: "labels-no-lines",
      signers: 2,
      pages: [{ items: [...header("Signature Page"), { t: "text", x: 0.1, y: 0.5, text: "Signature:", size: FONT_FRACTION }, { t: "text", x: 0.1, y: 0.6, text: "Initials:", size: FONT_FRACTION }] }],
      decoyPages: [0],
    },
  });
  // Los contratos de una sola pagina se rellenan con paginas de cuerpo hasta tener 3.
  return out.map((entry) => (entry.doc.pages.length < 3 ? { ...entry, doc: withBody(entry.doc, 3 - entry.doc.pages.length) } : entry));
}

/** Variantes de un mismo contrato: otros tamanos de papel, ampliaciones, letra distinta y paginas giradas. */
export const SCALE_VARIANTS: ReadonlyArray<{ id: string; options: RenderOptions }> = [
  { id: "letter", options: {} },
  { id: "a4", options: { page: [595, 842] } },
  { id: "small-459x594", options: { page: [458.9, 594] } },
  { id: "a3-x1.4", options: { page: [595, 842], scale: 1.414 } },
  { id: "x0.7", options: { scale: 0.7 } },
  { id: "rot90", options: { rotate: 90 } },
  { id: "rot180", options: { rotate: 180 } },
  { id: "rot270", options: { rotate: 270 } },
  { id: "bigger-font", options: { fontScale: 1.18 } },
];
