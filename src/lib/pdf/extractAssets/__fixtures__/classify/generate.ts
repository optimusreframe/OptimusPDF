/**
 * CORPUS SINTETICO del clasificador (U7.3 / parte de U7.5): PDFs generados con pdf-lib de forma REPRODUCIBLE (semillas fijas, sin fechas),
 * cada uno con su VERDAD de terreno. Cubre firmas e iniciales como imagen (los PDF que genera `signPdfMulti` con 1 y 2 firmantes,
 * escaneos de firma pegados cerca de «Signature:», transparentes tipo DocuSign), logos repetidos en cabecera y pie, fotos, sellos como
 * imagen, firmas dibujadas como vectores, una pagina escaneada y SENUELOS (tablas, graficos, lineas de firma vacias, QR, codigo de
 * barras, un logo junto a la etiqueta de firma...). Nada de datos reales: textos inventados y firmas generadas por formula.
 *
 * Solo para pruebas (Vitest y la inyeccion E2E): no lo importa la aplicacion.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "@cantoo/pdf-lib";
import { encodePngBytes } from "@/lib/image/inkPng";
import type { AssetKind, NormRect } from "../../types";
import {
  BLACK_PEN,
  dividerRaster,
  emptyBoxRaster,
  emptyRingRaster,
  envelopeIconRaster,
  BLUE_PEN,
  blank,
  fillRect,
  initialsRaster,
  inkSignatureRaster,
  logoRaster,
  mulberry32,
  photoRaster,
  scannedPageRaster,
  signaturePoints,
  stampRaster,
  type Raster,
} from "./rasters";

/* ---------------------------------------------------------------------------------------------------------------- */
/* Verdad                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Clase de metrica. `signature`/`initials`/`logo`/`stamp`/`photo` son IMAGENES; `vector` es la firma dibujada con trazos (beta). */
export type ClassifyClass = "signature" | "initials" | "logo" | "vector" | "stamp" | "photo";

export type TruthItem = {
  cls: ClassifyClass;
  /** Descripcion humana (sale en el informe). */
  tag: string;
  kind: AssetKind;
  /** Paginas (0-based) donde aparece. */
  pages: number[];
  /** Caja de la primera aparicion (normalizada, origen arriba-izquierda). */
  rect: NormRect;
  /** Rango de confianza esperado. */
  minConfidence?: number;
  maxConfidence?: number;
  /** Debe haber un motivo que contenga este texto (minusculas). */
  reasonIncludes?: string;
};

export type EmbeddedTruth = { page: number; rect: NormRect };

export type ClassifyFixture = {
  name: string;
  description: string;
  bytes: Uint8Array;
  truth: TruthItem[];
  /** Todas las imagenes incrustadas (pagina y caja): el recall tras la fusion debe ser 100 %. */
  embedded: EmbeddedTruth[];
  /** Senuelo: no debe salir ninguna firma ni iniciales. */
  decoy?: boolean;
  scannedPages?: number[];
  /** Cuantos elementos senuelo lleva (la tasa de falsas firmas se mide por elemento senuelo). */
  decoyElements?: number;
};

/* ---------------------------------------------------------------------------------------------------------------- */
/* Utilidades                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

export const W = 612;
export const H = 792;

export type Box = { x: number; y: number; width: number; height: number };
const norm = (box: Box): NormRect => ({ x: box.x / W, y: box.y / H, width: box.width / W, height: box.height / H });
const round2 = (n: number): number => Math.round(n * 100) / 100;

type Builder = {
  doc: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  embedded: EmbeddedTruth[];
  truth: TruthItem[];
};

async function newBuilder(): Promise<Builder> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setProducer("OptimusPDF fixtures");
  doc.setCreator("OptimusPDF fixtures");
  return { doc, font: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), embedded: [], truth: [] };
}

const BODY_ES = [
  "El presente documento regula las condiciones generales de la poliza de ejemplo entre las partes.",
  "La aseguradora se compromete a indemnizar los danos cubiertos hasta el limite de la suma asegurada.",
  "El asegurado debe comunicar cualquier siniestro en un plazo maximo de siete dias naturales.",
  "Las exclusiones se detallan en el anexo y forman parte integrante de este contrato de prueba.",
  "Este texto es inventado y solo sirve para dar cuerpo a la pagina del corpus sintetico.",
  "La prima se pagara por anticipado y no es reembolsable salvo cancelacion por causa justificada.",
  "Ambas partes aceptan someterse a la jurisdiccion de los tribunales competentes del domicilio.",
  "Cualquier modificacion deberá constar por escrito y estar firmada por ambas partes.",
];

const BODY_EN = [
  "This document sets out the general terms of the sample policy between the parties.",
  "The carrier agrees to indemnify covered damages up to the limit of the insured amount.",
  "The insured must report any loss within a maximum period of seven calendar days.",
  "Exclusions are listed in the annex and form an integral part of this test contract.",
  "This text is invented and only gives body to the page of the synthetic corpus.",
  "The premium is paid in advance and is non-refundable except for justified cancellation.",
  "Both parties agree to submit to the jurisdiction of the competent courts of residence.",
  "Any amendment must be in writing and signed by both parties.",
];

/** Pagina de contrato con titulo y lineas de texto (el fondo de todo). `topSpace` deja libre la parte alta para una cabecera. */
function contractPage(b: Builder, title: string, lang: "es" | "en" = "es", options: { lines?: number; startTop?: number } = {}): PDFPage {
  const page = b.doc.addPage([W, H]);
  const body = lang === "es" ? BODY_ES : BODY_EN;
  const start = options.startTop ?? 96;
  page.drawText(title, { x: 56, y: H - start, size: 16, font: b.bold, color: rgb(0.1, 0.1, 0.12) });
  const lines = options.lines ?? 10;
  for (let i = 0; i < lines; i += 1) page.drawText(body[i % body.length], { x: 56, y: H - (start + 34 + i * 18), size: 9.5, font: b.font, color: rgb(0.16, 0.16, 0.2) });
  return page;
}

/** Texto con su borde SUPERIOR a `top` puntos del borde de arriba. */
function label(b: Builder, page: PDFPage, text: string, x: number, top: number, size = 10, bold = false): void {
  page.drawText(text, { x, y: H - top - size * 0.85, size, font: bold ? b.bold : b.font, color: rgb(0.1, 0.1, 0.12) });
}

function hline(page: PDFPage, x0: number, x1: number, top: number): void {
  page.drawLine({ start: { x: x0, y: H - top }, end: { x: x1, y: H - top }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
}

async function png(raster: Raster): Promise<Uint8Array> {
  return encodePngBytes(raster);
}

async function place(b: Builder, page: PDFPage, image: PDFImage, box: Box, pageIndex: number): Promise<void> {
  page.drawImage(image, { x: box.x, y: H - box.y - box.height, width: box.width, height: box.height });
  b.embedded.push({ page: pageIndex, rect: norm(box) });
}

async function save(b: Builder): Promise<Uint8Array> {
  return b.doc.save({ useObjectStreams: false });
}

/** Caja con la proporcion de un raster, ancha `width` puntos. */
function boxFor(raster: Raster, x: number, y: number, width: number): Box {
  return { x, y, width, height: round2((width * raster.height) / raster.width) };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* PDFs firmados con signPdfMulti                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

async function signWithOptimus(original: Uint8Array, placements: Array<{ png: Uint8Array; pageIndex: number; box: Box }>): Promise<Uint8Array> {
  const { signPdfMulti } = await import("@/lib/pdf/sign");
  const blob = await signPdfMulti(new File([original as unknown as BlobPart], "contrato.pdf", { type: "application/pdf" }), {
    placements: placements.map((placement) => ({ kind: "image" as const, png: placement.png, pageIndex: placement.pageIndex, rect: norm(placement.box) })),
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Contrato de 3 paginas, un firmante: firma en la ultima y las iniciales en el pie de CADA pagina (como las coloca OptimusPDF). */
export async function makeOptimusOneSigner(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  for (let p = 0; p < 3; p += 1) {
    const page = contractPage(b, `Contrato de servicios, pagina ${p + 1}`);
    label(b, page, "Iniciales:", 470, 752, 9);
  }
  const page3 = b.doc.getPage(2);
  hline(page3, 72, 300, 712);
  label(b, page3, "Firma del Asegurado:", 72, 716);
  const original = await save(b);
  const signature = inkSignatureRaster({ seed: 11, ink: BLUE_PEN });
  const initials = initialsRaster({ seed: 12 });
  const sigBox = boxFor(signature, 80, 654, 183.6);
  const iniBox = boxFor(initials, 524, 724, 54);
  const placements = [
    { png: await png(signature), pageIndex: 2, box: sigBox },
    ...[0, 1, 2].map(async (pageIndex) => ({ png: await png(initials), pageIndex, box: iniBox })),
  ];
  const resolved = await Promise.all(placements);
  const bytes = await signWithOptimus(original, resolved);
  return {
    name: "optimus-1signer",
    description: "PDF firmado por signPdfMulti, un firmante: firma en la pagina 3 sobre la raya y las iniciales en el pie de las 3 paginas.",
    bytes,
    embedded: [
      { page: 2, rect: norm(sigBox) },
      ...[0, 1, 2].map((page) => ({ page, rect: norm(iniBox) })),
    ],
    truth: [
      { cls: "signature", tag: "firma del asegurado (OptimusPDF)", kind: "signature", pages: [2], rect: norm(sigBox), minConfidence: 0.85, reasonIncludes: "cerca de" },
      { cls: "initials", tag: "iniciales en el pie de las 3 paginas", kind: "initials", pages: [0, 1, 2], rect: norm(iniBox), minConfidence: 0.85 },
    ],
  };
}

/** Dos firmantes con firma e iniciales cada uno (4 imagenes distintas). */
export async function makeOptimusTwoSigners(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  for (let p = 0; p < 3; p += 1) {
    const page = contractPage(b, `Contrato de servicios con dos firmantes, pagina ${p + 1}`);
    label(b, page, "Iniciales Asegurado:", 56, 752, 9);
    label(b, page, "Iniciales Co-asegurado:", 330, 752, 9);
  }
  const page3 = b.doc.getPage(2);
  hline(page3, 56, 270, 712);
  hline(page3, 330, 550, 712);
  label(b, page3, "Firma del Asegurado:", 56, 716);
  label(b, page3, "Firma del Co-asegurado:", 330, 716);
  const original = await save(b);
  const sigA = inkSignatureRaster({ seed: 21, ink: BLUE_PEN });
  const sigB = inkSignatureRaster({ seed: 22, ink: BLACK_PEN, words: 2 });
  const iniA = initialsRaster({ seed: 23 });
  const iniB = initialsRaster({ seed: 24, ink: BLACK_PEN });
  const boxSigA = boxFor(sigA, 70, 654, 183.6);
  const boxSigB = boxFor(sigB, 350, 654, 183.6);
  const boxIniA = boxFor(iniA, 160, 724, 54);
  const boxIniB = boxFor(iniB, 470, 724, 54);
  const pngs = { sigA: await png(sigA), sigB: await png(sigB), iniA: await png(iniA), iniB: await png(iniB) };
  const placements: Array<{ png: Uint8Array; pageIndex: number; box: Box }> = [
    { png: pngs.sigA, pageIndex: 2, box: boxSigA },
    { png: pngs.sigB, pageIndex: 2, box: boxSigB },
  ];
  for (const pageIndex of [0, 1, 2]) {
    placements.push({ png: pngs.iniA, pageIndex, box: boxIniA }, { png: pngs.iniB, pageIndex, box: boxIniB });
  }
  const bytes = await signWithOptimus(original, placements);
  return {
    name: "optimus-2signers",
    description: "PDF firmado por signPdfMulti con DOS firmantes: dos firmas en la pagina 3 y dos juegos de iniciales en el pie de las 3 paginas.",
    bytes,
    embedded: placements.map((placement) => ({ page: placement.pageIndex, rect: norm(placement.box) })),
    truth: [
      { cls: "signature", tag: "firma del asegurado", kind: "signature", pages: [2], rect: norm(boxSigA), minConfidence: 0.85 },
      { cls: "signature", tag: "firma del co-asegurado", kind: "signature", pages: [2], rect: norm(boxSigB), minConfidence: 0.85 },
      { cls: "initials", tag: "iniciales del asegurado", kind: "initials", pages: [0, 1, 2], rect: norm(boxIniA), minConfidence: 0.85 },
      { cls: "initials", tag: "iniciales del co-asegurado", kind: "initials", pages: [0, 1, 2], rect: norm(boxIniB), minConfidence: 0.85 },
    ],
  };
}

/** Firma estampada por OptimusPDF en un documento SIN ninguna etiqueta cerca: se ofrece, pero solo como «posible». */
export async function makeOptimusNoLabels(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  contractPage(b, "Acta de entrega sin casillas de firma", "es", { lines: 6 });
  const original = await save(b);
  const signature = inkSignatureRaster({ seed: 31, ink: BLUE_PEN });
  const box = boxFor(signature, 300, 520, 183.6);
  const bytes = await signWithOptimus(original, [{ png: await png(signature), pageIndex: 0, box }]);
  return {
    name: "optimus-no-labels",
    description: "Firma de OptimusPDF en un documento sin etiqueta de firma cerca: se ofrece como posible (sin la etiqueta no llega a probable).",
    bytes,
    embedded: [{ page: 0, rect: norm(box) }],
    truth: [{ cls: "signature", tag: "firma sin etiqueta cerca", kind: "signature", pages: [0], rect: norm(box), minConfidence: 0.5, maxConfidence: 0.84 }],
  };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Firmas pegadas como imagen                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Escaneos de firma (papel casi blanco con ruido, tinta negra o azul) pegados junto a «Signature:» (etiqueta a la izquierda) y «Firma del cliente» (debajo). */
export async function makePastedScans(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const p1 = contractPage(b, "Service agreement", "en");
  hline(p1, 72, 330, 690);
  label(b, p1, "Signature:", 72, 672);
  const scanA = inkSignatureRaster({ seed: 41, ink: BLACK_PEN, background: "paper", words: 2 });
  const boxA = boxFor(scanA, 150, 636, 180);
  const imgA = await b.doc.embedPng(await png(scanA));
  await place(b, p1, imgA, boxA, 0);
  const p2 = contractPage(b, "Acuerdo de servicio", "es");
  const scanB = inkSignatureRaster({ seed: 42, ink: BLUE_PEN, background: "paper" });
  const boxB = boxFor(scanB, 90, 600, 176);
  const imgB = await b.doc.embedPng(await png(scanB));
  await place(b, p2, imgB, boxB, 1);
  hline(p2, 72, 330, 656);
  label(b, p2, "Firma del cliente", 72, 660);
  return {
    name: "pasted-scans",
    description: "Dos escaneos de firma opacos (papel con ruido) pegados: junto a «Signature:» y encima de «Firma del cliente».",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [
      { cls: "signature", tag: "escaneo junto a Signature:", kind: "signature", pages: [0], rect: norm(boxA), minConfidence: 0.85, reasonIncludes: "signature" },
      { cls: "signature", tag: "escaneo sobre Firma del cliente", kind: "signature", pages: [1], rect: norm(boxB), minConfidence: 0.8 },
    ],
  };
}

/** Estilo DocuSign: PNG transparente azul junto a «Signature», iniciales junto a «Initials», y «X ____» con la firma encima. */
export async function makeDocuSignLike(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const p1 = contractPage(b, "Insured agreement", "en");
  label(b, p1, "Insured Signature", 72, 690);
  hline(p1, 72, 300, 686);
  const sig = inkSignatureRaster({ seed: 51, ink: [10, 45, 140], width: 330, height: 100, words: 2 });
  const sigBox = boxFor(sig, 76, 632, 190);
  const sigImg = await b.doc.embedPng(await png(sig));
  await place(b, p1, sigImg, sigBox, 0);
  label(b, p1, "Initials", 480, 746, 9);
  const ini = initialsRaster({ seed: 52, ink: [10, 45, 140] });
  const iniBox = boxFor(ini, 530, 722, 52);
  const iniImg = await b.doc.embedPng(await png(ini));
  await place(b, p1, iniImg, iniBox, 0);
  const p2 = contractPage(b, "Assured acknowledgement", "en", { lines: 8 });
  label(b, p2, "X ______________________", 72, 680);
  const sig2 = inkSignatureRaster({ seed: 53, ink: [10, 45, 140], width: 330, height: 100 });
  const sig2Box = boxFor(sig2, 96, 628, 170);
  const sig2Img = await b.doc.embedPng(await png(sig2));
  await place(b, p2, sig2Img, sig2Box, 1);
  const iniImg2 = iniImg;
  label(b, p2, "Initials", 480, 746, 9);
  await place(b, p2, iniImg2, iniBox, 1);
  return {
    name: "docusign-like",
    description: "Firmas transparentes (estilo DocuSign) junto a «Insured Signature», sobre «X ____» y iniciales junto a «Initials» en 2 paginas.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [
      { cls: "signature", tag: "firma junto a Insured Signature", kind: "signature", pages: [0], rect: norm(sigBox), minConfidence: 0.85 },
      { cls: "signature", tag: "firma sobre X ____", kind: "signature", pages: [1], rect: norm(sig2Box), minConfidence: 0.85 },
      { cls: "initials", tag: "iniciales junto a Initials", kind: "initials", pages: [0, 1], rect: norm(iniBox), minConfidence: 0.85 },
    ],
  };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Logos, fotos y sellos                                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

/** 5 paginas con un logo de color en la cabecera y otro (pequeno) en el pie de todas, y una firma pegada en la ultima. */
export async function makeLogoHeaderFooter(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const header = logoRaster({ seed: 61 });
  const footer = logoRaster({ seed: 62, width: 160, height: 40, palette: [[160, 30, 60], [60, 150, 80], [30, 30, 36]] });
  const headerImg = await b.doc.embedPng(await png(header));
  const footerImg = await b.doc.embedPng(await png(footer));
  const headerBox = boxFor(header, 56, 26, 132);
  const footerBox = boxFor(footer, 56, 738, 90);
  for (let p = 0; p < 5; p += 1) {
    const page = contractPage(b, `Informe tecnico, pagina ${p + 1}`, "es", { startTop: 110 });
    await place(b, page, headerImg, headerBox, p);
    await place(b, page, footerImg, footerBox, p);
  }
  const last = b.doc.getPage(4);
  hline(last, 72, 330, 640);
  label(b, last, "Firma:", 72, 644);
  const scan = inkSignatureRaster({ seed: 63, ink: BLUE_PEN, background: "paper" });
  const sigBox = boxFor(scan, 100, 590, 176);
  await place(b, last, await b.doc.embedPng(await png(scan)), sigBox, 4);
  return {
    name: "logo-header-footer",
    description: "Logo de colores en la cabecera y logo pequeno en el pie de las 5 paginas; firma escaneada en la ultima.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [
      { cls: "logo", tag: "logo de cabecera", kind: "logo", pages: [0, 1, 2, 3, 4], rect: norm(headerBox), minConfidence: 0.85 },
      { cls: "logo", tag: "logo de pie", kind: "logo", pages: [0, 1, 2, 3, 4], rect: norm(footerBox), minConfidence: 0.85 },
      { cls: "signature", tag: "firma escaneada tras logos", kind: "signature", pages: [4], rect: norm(sigBox), minConfidence: 0.8 },
    ],
  };
}

/** Un logo solo arriba en la primera pagina (no se repite): logo «posible». */
export async function makeLogoFirstPage(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const logo = logoRaster({ seed: 71, width: 240, height: 80 });
  const logoImg = await b.doc.embedPng(await png(logo));
  const box = boxFor(logo, 56, 30, 120);
  const p1 = contractPage(b, "Carta de presentacion", "es", { startTop: 120 });
  await place(b, p1, logoImg, box, 0);
  contractPage(b, "Anexo", "es");
  contractPage(b, "Anexo II", "es");
  return {
    name: "logo-first-page",
    description: "Logo solo arriba en la pagina 1.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [{ cls: "logo", tag: "logo de la primera pagina", kind: "logo", pages: [0], rect: norm(box), minConfidence: 0.4, maxConfidence: 0.84 }],
  };
}

/** Una foto grande opaca en el cuerpo (pagina 2) y un logo pequeno arriba de la pagina 1. */
export async function makePhoto(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const p1 = contractPage(b, "Informe de peritaje", "es", { startTop: 120 });
  const logo = logoRaster({ seed: 81, width: 200, height: 60 });
  const logoBox = boxFor(logo, 56, 34, 110);
  await place(b, p1, await b.doc.embedPng(await png(logo)), logoBox, 0);
  const p2 = contractPage(b, "Fotografia del siniestro", "es", { lines: 4 });
  const photo = photoRaster({ seed: 82, width: 320, height: 240 });
  const photoBox = boxFor(photo, 110, 220, 300);
  await place(b, p2, await b.doc.embedPng(await png(photo)), photoBox, 1);
  return {
    name: "photo",
    description: "Foto sintetica opaca en la pagina 2 y un logo pequeno arriba de la 1.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [
      { cls: "photo", tag: "foto del siniestro", kind: "photo", pages: [1], rect: norm(photoBox), minConfidence: 0.7 },
      { cls: "logo", tag: "logo de la primera pagina", kind: "logo", pages: [0], rect: norm(logoBox), minConfidence: 0.4 },
    ],
  };
}

function frameStampRaster(): Raster {
  const raster = blank(200, 96);
  const color = [28, 70, 190] as const;
  fillRect(raster, 0, 0, 200, 5, color);
  fillRect(raster, 0, 91, 200, 5, color);
  fillRect(raster, 0, 0, 5, 96, color);
  fillRect(raster, 195, 0, 5, 96, color);
  fillRect(raster, 28, 30, 144, 14, color);
  fillRect(raster, 52, 54, 96, 10, color);
  return raster;
}

/** Sellos como imagen: uno circular rojo (pagina 1) y uno rectangular azul con marco (pagina 2). */
export async function makeStampImages(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const p1 = contractPage(b, "Resolucion", "es");
  const round = stampRaster({ size: 160 });
  const roundBox = boxFor(round, 400, 540, 100);
  await place(b, p1, await b.doc.embedPng(await png(round)), roundBox, 0);
  const p2 = contractPage(b, "Resolucion (copia)", "es");
  const frame = frameStampRaster();
  const frameBox = boxFor(frame, 70, 520, 150);
  await place(b, p2, await b.doc.embedPng(await png(frame)), frameBox, 1);
  return {
    name: "stamp-images",
    description: "Sello circular rojo y sello rectangular azul, ambos como imagen con fondo transparente.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [
      { cls: "stamp", tag: "sello circular rojo", kind: "stamp", pages: [0], rect: norm(roundBox), minConfidence: 0.5 },
      { cls: "stamp", tag: "sello rectangular azul", kind: "stamp", pages: [1], rect: norm(frameBox), minConfidence: 0.5 },
    ],
  };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Firmas dibujadas como vectores (beta)                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

type Pt = [number, number];

/** Curva Catmull-Rom -> `C` de SVG (puntos cada `step`), en coordenadas de pagina con el origen ARRIBA-izquierda (drawSvgPath con y = H). */
function smoothPath(points: readonly Pt[], step = 5): string {
  const keys = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  if (keys.length < 3) return `M ${keys.map(([x, y]) => `${x} ${y}`).join(" L ")}`;
  let d = `M ${round2(keys[0][0])} ${round2(keys[0][1])}`;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const p0 = keys[Math.max(0, i - 1)];
    const p1 = keys[i];
    const p2 = keys[i + 1];
    const p3 = keys[Math.min(keys.length - 1, i + 2)];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${[c1, c2, p2].map(([x, y]) => `${round2(x)} ${round2(y)}`).join(" ")}`;
  }
  return d;
}

function drawVectorSignature(page: PDFPage, box: Box, seed: number, style: "curves" | "polyline", color = rgb(0.08, 0.16, 0.5), words = 1): void {
  const strokes = signaturePoints(box.width, box.height, { seed, words });
  const rand = mulberry32(seed + 1);
  for (const stroke of strokes) {
    const points: Pt[] = stroke.map(([x, y]) => [box.x + x, box.y + y] as Pt);
    const d =
      style === "curves"
        ? smoothPath(points)
        : `M ${points.map(([x, y]) => `${round2(x + (rand() - 0.5) * 0.4)} ${round2(y + (rand() - 0.5) * 0.4)}`).join(" L ")}`;
    page.drawSvgPath(d, { x: 0, y: H, borderColor: color, borderWidth: 1.6, borderLineCap: 1 });
  }
}

/** Firma «de relleno»: cada trazo es un poligono cerrado (el contorno de la tinta, como lo exportan algunas apps de dibujo) relleno de color. */
function drawFilledSignature(page: PDFPage, box: Box, seed: number): void {
  for (const stroke of signaturePoints(box.width, box.height, { seed })) {
    const points: Pt[] = stroke.filter((_, i) => i % 3 === 0).map(([x, y]) => [box.x + x, box.y + y] as Pt);
    const left: Pt[] = [];
    const right: Pt[] = [];
    points.forEach((point, i) => {
      const next = points[Math.min(points.length - 1, i + 1)];
      const prev = points[Math.max(0, i - 1)];
      const dx = next[0] - prev[0];
      const dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      left.push([point[0] - (dy / len) * 0.9, point[1] + (dx / len) * 0.9]);
      right.push([point[0] + (dy / len) * 0.9, point[1] - (dx / len) * 0.9]);
    });
    const ring = [...left, ...right.reverse()];
    page.drawSvgPath(`M ${ring.map(([x, y]) => `${round2(x)} ${round2(y)}`).join(" L ")} Z`, { x: 0, y: H, color: rgb(0.05, 0.05, 0.08) });
  }
}

/** Firmas dibujadas con curvas: sobre una raya con «Signature:» debajo, como poli-linea de tinta digital junto a «Firma:» y unas iniciales. */
export async function makeVectorSignatures(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const p1 = contractPage(b, "Vector agreement", "en");
  const box1: Box = { x: 150, y: 604, width: 170, height: 50 };
  drawVectorSignature(p1, box1, 91, "curves");
  hline(p1, 140, 340, 662);
  label(b, p1, "Signature:", 140, 666);
  const p2 = contractPage(b, "Acuerdo vectorial", "es");
  const box2: Box = { x: 150, y: 598, width: 190, height: 52 };
  label(b, p2, "Firma:", 90, 632);
  drawVectorSignature(p2, box2, 92, "polyline", rgb(0.05, 0.05, 0.08), 2);
  const p3 = contractPage(b, "Iniciales vectoriales", "es");
  const box3: Box = { x: 130, y: 640, width: 56, height: 38 };
  label(b, p3, "Iniciales:", 72, 654);
  drawVectorSignature(p3, box3, 93, "curves", rgb(0.08, 0.16, 0.5));
  const p4 = contractPage(b, "Firma de relleno", "es");
  const box4: Box = { x: 150, y: 600, width: 170, height: 50 };
  label(b, p4, "Firma del cliente:", 60, 630);
  drawFilledSignature(p4, box4, 94);
  return {
    name: "vector-signatures",
    description: "Cuatro firmas dibujadas con trazos vectoriales: curvas sobre una raya con «Signature:», poli-linea de tinta digital junto a «Firma:», iniciales y contorno relleno.",
    bytes: await save(b),
    embedded: [],
    truth: [
      { cls: "vector", tag: "firma de curvas sobre raya", kind: "signature", pages: [0], rect: norm(box1), minConfidence: 0.4, maxConfidence: 0.7, reasonIncludes: "beta" },
      { cls: "vector", tag: "firma de poli-linea junto a Firma:", kind: "signature", pages: [1], rect: norm(box2), minConfidence: 0.4, maxConfidence: 0.7, reasonIncludes: "beta" },
      { cls: "vector", tag: "iniciales de curvas junto a Iniciales:", kind: "initials", pages: [2], rect: norm(box3), minConfidence: 0.4, maxConfidence: 0.7, reasonIncludes: "beta" },
      { cls: "vector", tag: "firma de contorno relleno", kind: "signature", pages: [3], rect: norm(box4), minConfidence: 0.4, maxConfidence: 0.7, reasonIncludes: "beta" },
    ],
  };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Pagina escaneada                                                                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Pagina escaneada (una sola imagen a pagina completa) con una firma DENTRO: no se separa sola; se ofrece recortar region. */
export async function makeScannedPage(): Promise<ClassifyFixture & { signatureBox: Box }> {
  const b = await newBuilder();
  const { raster, signatureBox } = scannedPageRaster({ seed: 101 });
  const page = b.doc.addPage([W, H]);
  const img = await b.doc.embedPng(await png(raster));
  await place(b, page, img, { x: 0, y: 0, width: W, height: H }, 0);
  return {
    name: "scanned-page",
    description: "Pagina escaneada de una sola imagen con una firma azul abajo a la derecha: no se detecta sola.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [],
    decoy: true,
    decoyElements: 1,
    scannedPages: [0],
    signatureBox,
  };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Senuelos                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Tablas, graficos, linea de firma vacia, casillas, ornamento sin etiqueta y un mapa de miles de rutas: nada de esto es una firma. */
export async function makeVectorDecoys(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const page = b.doc.addPage([W, H]);
  page.drawText("Informe trimestral", { x: 56, y: H - 60, size: 16, font: b.bold });
  // Tabla 4 x 5.
  for (let r = 0; r <= 5; r += 1) hline(page, 56, 356, 90 + r * 20);
  for (let c = 0; c <= 4; c += 1) page.drawLine({ start: { x: 56 + c * 75, y: H - 90 }, end: { x: 56 + c * 75, y: H - 190 }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
  for (let r = 0; r < 5; r += 1) for (let c = 0; c < 4; c += 1) page.drawText(`${r * 4 + c + 1}`, { x: 62 + c * 75, y: H - 104 - r * 20, size: 9, font: b.font });
  // Grafico de barras.
  const bars = [40, 65, 30, 80];
  bars.forEach((h, i) => page.drawRectangle({ x: 400 + i * 30, y: H - 190, width: 20, height: h, color: rgb(0.1, 0.3, 0.7) }));
  // Grafico de lineas con ejes y etiquetas.
  page.drawLine({ start: { x: 60, y: H - 420 }, end: { x: 60, y: H - 280 }, thickness: 0.8, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 60, y: H - 420 }, end: { x: 330, y: H - 420 }, thickness: 0.8, color: rgb(0, 0, 0) });
  const rand = mulberry32(5);
  let yv = 360;
  const series: string[] = [];
  for (let i = 0; i <= 54; i += 1) {
    yv = Math.max(300, Math.min(410, yv + (rand() - 0.5) * 22));
    series.push(`${round2(60 + i * 5)} ${round2(yv)}`);
  }
  page.drawSvgPath(`M ${series.join(" L ")}`, { x: 0, y: H, borderColor: rgb(0.05, 0.2, 0.6), borderWidth: 1.2 });
  ["T1", "T2", "T3", "T4"].forEach((t, i) => page.drawText(t, { x: 90 + i * 70, y: H - 436, size: 8, font: b.font }));
  // Grafico de sectores (curvas rellenas).
  const cx = 470;
  const cy = 360;
  let angle = 0;
  [0.35, 0.25, 0.4].forEach((share, i) => {
    const a0 = angle;
    const a1 = angle + share * 2 * Math.PI;
    angle = a1;
    const p = (a: number): string => `${round2(cx + 60 * Math.cos(a))} ${round2(cy + 60 * Math.sin(a))}`;
    page.drawSvgPath(`M ${cx} ${cy} L ${p(a0)} A 60 60 0 ${share > 0.5 ? 1 : 0} 1 ${p(a1)} Z`, { x: 0, y: H, color: [rgb(0.8, 0.2, 0.2), rgb(0.2, 0.6, 0.3), rgb(0.2, 0.3, 0.8)][i] });
  });
  // Ornamento sinuoso bajo el titulo (sin etiqueta ni raya).
  const orn = signaturePoints(160, 24, { seed: 6 }).map((stroke) => stroke.map(([x, y]) => [200 + x, 500 + y] as Pt));
  for (const stroke of orn.slice(0, 1)) page.drawSvgPath(smoothPath(stroke), { x: 0, y: H, borderColor: rgb(0.25, 0.25, 0.3), borderWidth: 0.9 });
  // Grafico de puntos: marcadores circulares sobre su eje (cuenta como senuelo por la raya del eje).
  hline(page, 400, 560, 560);
  const scatter = mulberry32(12);
  for (let i = 0; i < 14; i += 1) page.drawCircle({ x: 405 + i * 11, y: H - 540 - scatter() * 14, size: 3, borderWidth: 0.9, borderColor: rgb(0.1, 0.1, 0.14) });
  // Linea de firma VACIA con su etiqueta y casillas de verificacion.
  hline(page, 72, 300, 620);
  label(b, page, "Firma:", 72, 624);
  for (let i = 0; i < 3; i += 1) {
    page.drawRectangle({ x: 360, y: H - 600 - i * 22, width: 10, height: 10, borderWidth: 0.8, borderColor: rgb(0, 0, 0) });
    label(b, page, `Opcion ${i + 1}`, 376, 592 + i * 22, 9);
  }
  // Pagina 2: «mapa» de miles de rutas cortas.
  const map = b.doc.addPage([W, H]);
  const r2 = mulberry32(9);
  for (let i = 0; i < 7000; i += 1) {
    const x = 20 + r2() * 560;
    const y = 20 + r2() * 700;
    map.drawLine({ start: { x, y }, end: { x: x + (r2() - 0.5) * 9, y: y + (r2() - 0.5) * 9 }, thickness: 0.3, color: rgb(0.2, 0.2, 0.25) });
  }
  label(b, map, "Firma:", 72, 760);
  return { name: "vector-decoys", description: "Tabla, graficos de barras, lineas, sectores y puntos, ornamento, linea de firma VACIA, casillas y un mapa de 7000 rutas: ninguna firma.", bytes: await save(b), embedded: [], truth: [], decoy: true, decoyElements: 9 };
}

function qrRaster(seed: number, modules = 29, cell = 4): Raster {
  const rand = mulberry32(seed);
  const size = modules * cell;
  const raster = blank(size, size, [255, 255, 255, 255]);
  for (let my = 0; my < modules; my += 1) for (let mx = 0; mx < modules; mx += 1) if (rand() < 0.5) fillRect(raster, mx * cell, my * cell, cell, cell, [0, 0, 0]);
  return raster;
}

function barcodeRaster(seed: number): Raster {
  const rand = mulberry32(seed);
  const raster = blank(220, 64, [255, 255, 255, 255]);
  let x = 6;
  while (x < 212) {
    const w = 1 + Math.floor(rand() * 4);
    if (rand() < 0.55) fillRect(raster, x, 6, w, 52, [0, 0, 0]);
    x += w + 1;
  }
  return raster;
}

function chartRaster(seed: number): Raster {
  const rand = mulberry32(seed);
  const raster = blank(240, 140, [255, 255, 255, 255]);
  fillRect(raster, 20, 10, 2, 110, [60, 60, 60]);
  fillRect(raster, 20, 118, 200, 2, [60, 60, 60]);
  for (let i = 0; i < 7; i += 1) fillRect(raster, 30 + i * 27, 118 - (20 + rand() * 80), 18, 20 + rand() * 80, ([[30, 100, 200], [220, 90, 40], [60, 160, 90]] as const)[i % 3]);
  return raster;
}

/** Imagenes que NO son firmas aunque esten junto a la etiqueta de firma: un logo de colores, un QR, un codigo de barras, un grafico y una foto. */
export async function makeImageDecoys(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const p1 = contractPage(b, "Ficha de cliente", "es", { lines: 6 });
  const logo = logoRaster({ seed: 111, width: 200, height: 64 });
  const logoBox = boxFor(logo, 150, 560, 130);
  await place(b, p1, await b.doc.embedPng(await png(logo)), logoBox, 0);
  hline(p1, 72, 300, 612);
  label(b, p1, "Firma del cliente:", 72, 616);
  const qr = qrRaster(112);
  const qrBox = boxFor(qr, 420, 540, 76);
  await place(b, p1, await b.doc.embedPng(await png(qr)), qrBox, 0);
  const p2 = contractPage(b, "Anexo grafico", "es", { lines: 5 });
  const bar = barcodeRaster(113);
  const barBox = boxFor(bar, 72, 600, 150);
  await place(b, p2, await b.doc.embedPng(await png(bar)), barBox, 1);
  label(b, p2, "Firma del asegurado:", 72, 668);
  const chart = chartRaster(114);
  const chartBox = boxFor(chart, 300, 560, 200);
  await place(b, p2, await b.doc.embedPng(await png(chart)), chartBox, 1);
  const photo = photoRaster({ seed: 115, width: 240, height: 160 });
  const photoBox = boxFor(photo, 72, 280, 200);
  await place(b, p2, await b.doc.embedPng(await png(photo)), photoBox, 1);
  return {
    name: "image-decoys",
    description: "Un logo de colores, un QR, un codigo de barras, un grafico y una foto junto a «Firma del cliente/asegurado»: ninguno es una firma.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [{ cls: "photo", tag: "foto del anexo", kind: "photo", pages: [1], rect: norm(photoBox), minConfidence: 0.7 }],
    decoy: true,
    decoyElements: 5,
  };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Casos DIFICILES                                                                                                   */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Iniciales de rotulador GRUESO (mucho relleno, como las de los contratos reales) en el pie de 3 paginas, estampadas por OptimusPDF, con su etiqueta. */
export async function makeOptimusThickInitials(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  for (let p = 0; p < 3; p += 1) {
    const page = contractPage(b, `Contrato con iniciales gruesas, pagina ${p + 1}`);
    label(b, page, "Iniciales:", 470, 752, 9);
  }
  const original = await save(b);
  const initials = initialsRaster({ seed: 121, size: 120, ink: BLACK_PEN, thickness: 6 });
  const box = boxFor(initials, 524, 724, 52);
  const pngBytes = await png(initials);
  const bytes = await signWithOptimus(original, [0, 1, 2].map((pageIndex) => ({ png: pngBytes, pageIndex, box })));
  return {
    name: "optimus-thick-initials",
    description: "Iniciales de rotulador grueso (mucho relleno) estampadas por signPdfMulti en el pie de 3 paginas, junto a «Iniciales:».",
    bytes,
    embedded: [0, 1, 2].map((page) => ({ page, rect: norm(box) })),
    truth: [{ cls: "initials", tag: "iniciales gruesas con etiqueta", kind: "initials", pages: [0, 1, 2], rect: norm(box), minConfidence: 0.7 }],
  };
}

/** Escaneos de firma dificiles: papel gris con mucho ruido (JPEG malo), boligrafo morado y firma compacta casi cuadrada, todos con etiqueta. */
export async function makeHardScans(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const p1 = contractPage(b, "Acuerdo con escaneo malo", "es");
  hline(p1, 72, 330, 690);
  label(b, p1, "Firma:", 72, 672);
  const noisy = inkSignatureRaster({ seed: 131, ink: [30, 30, 40], background: "paper", noise: 30, paper: 236 });
  const noisyBox = boxFor(noisy, 140, 636, 180);
  await place(b, p1, await b.doc.embedPng(await png(noisy)), noisyBox, 0);
  const p2 = contractPage(b, "Agreement with purple pen", "en");
  label(b, p2, "Signature:", 72, 672);
  const purple = inkSignatureRaster({ seed: 132, ink: [74, 24, 112], width: 160, height: 120, thickness: 3, background: "transparent" });
  const purpleBox = boxFor(purple, 150, 610, 80);
  await place(b, p2, await b.doc.embedPng(await png(purple)), purpleBox, 1);
  return {
    name: "hard-scans",
    description: "Escaneo con mucho ruido sobre papel gris, boligrafo morado y firma compacta casi cuadrada, con etiqueta.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [
      { cls: "signature", tag: "escaneo ruidoso junto a Firma:", kind: "signature", pages: [0], rect: norm(noisyBox), minConfidence: 0.7 },
      { cls: "signature", tag: "firma morada compacta", kind: "signature", pages: [1], rect: norm(purpleBox), minConfidence: 0.7 },
    ],
  };
}

/** Senuelos de imagen que se parecen a una firma: casilla circular y cuadrada VACIAS junto a las etiquetas, un icono de sobre de trazo fino y una cenefa ancha. */
export async function makeIconDecoys(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const page = contractPage(b, "Formulario con iconos", "es", { lines: 5 });
  label(b, page, "Iniciales:", 72, 640);
  const ring = emptyRingRaster(96);
  await place(b, page, await b.doc.embedPng(await png(ring)), boxFor(ring, 124, 626, 44), 0);
  label(b, page, "Firma del asegurado:", 72, 700);
  const box = emptyBoxRaster(240, 80);
  await place(b, page, await b.doc.embedPng(await png(box)), boxFor(box, 200, 672, 150), 0);
  const icon = envelopeIconRaster(80, 60);
  await place(b, page, await b.doc.embedPng(await png(icon)), boxFor(icon, 440, 500, 40), 0);
  const divider = dividerRaster(600, 22);
  await place(b, page, await b.doc.embedPng(await png(divider)), boxFor(divider, 56, 470, 500), 0);
  return {
    name: "icon-decoys",
    description: "Casilla circular y cuadrada vacias junto a las etiquetas, icono de sobre de trazo fino y cenefa ancha: ninguna es una firma.",
    bytes: await save(b),
    embedded: b.embedded,
    truth: [],
    decoy: true,
    decoyElements: 4,
  };
}

/** Formulario SIN imagenes ni trazos: solo etiquetas y rayas de firma vacias. */
export async function makeEmptyForm(): Promise<ClassifyFixture> {
  const b = await newBuilder();
  const page = contractPage(b, "Formulario en blanco", "es");
  for (const [text, top] of [["Firma del asegurado:", 640], ["Iniciales:", 700], ["Firma del representante:", 740]] as const) {
    hline(page, 72, 300, top - 4);
    label(b, page, text, 72, top);
  }
  return { name: "empty-form", description: "Formulario sin firmar: etiquetas y rayas, ninguna imagen ni trazo.", bytes: await save(b), embedded: [], truth: [], decoy: true, decoyElements: 3 };
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Corpus                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Corpus completo, en orden fijo. */
export async function buildClassifyCorpus(): Promise<ClassifyFixture[]> {
  const scanned = await makeScannedPage();
  return [
    await makeOptimusOneSigner(),
    await makeOptimusTwoSigners(),
    await makeOptimusNoLabels(),
    await makeOptimusThickInitials(),
    await makePastedScans(),
    await makeDocuSignLike(),
    await makeLogoHeaderFooter(),
    await makeLogoFirstPage(),
    await makePhoto(),
    await makeStampImages(),
    await makeVectorSignatures(),
    scanned,
    await makeVectorDecoys(),
    await makeImageDecoys(),
    await makeHardScans(),
    await makeIconDecoys(),
    await makeEmptyForm(),
  ];
}
