import { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, decodePDFRawStream } from "@cantoo/pdf-lib";
import { createCanvas } from "@napi-rs/canvas";

/**
 * Contratos SINTÉTICOS para las pruebas de la huella (Node: pdf-lib + `@napi-rs/canvas`). Ningún documento real: el
 * texto sale de plantillas de frases y listas de palabras elegidas por un generador pseudoaleatorio con semilla, así
 * que la misma semilla da SIEMPRE el mismo contrato y semillas distintas dan contratos distintos (con algo de texto
 * compartido a propósito, como pasa con los contratos reales: cláusulas comunes de cortesía y firma).
 */

/** Generador pseudoaleatorio determinista (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PARTIES = ["el contratista", "la aseguradora", "el asegurado", "el ajustador", "la empresa de servicios", "el propietario", "el proveedor", "el representante autorizado"];
const VERBS = ["se obliga a ejecutar", "se compromete a entregar", "acepta revisar", "autoriza la realización de", "garantiza la calidad de", "responde por los daños de", "reconoce haber recibido", "asume el costo de", "debe notificar por escrito", "podrá suspender"];
const OBJECTS = [
  "los trabajos de reparación del inmueble",
  "las labores de mitigación de agua",
  "la reposición del techo dañado",
  "el secado estructural de las paredes",
  "la limpieza posterior a la pérdida",
  "los materiales aprobados en el presupuesto",
  "la inspección técnica de los daños",
  "el retiro de escombros del lugar",
  "las mejoras acordadas en el anexo",
  "la documentación fotográfica del siniestro",
  "los equipos de deshumidificación instalados",
  "la pintura y acabados de las áreas afectadas",
];
const CONDITIONS = [
  "siempre que exista aprobación previa de la aseguradora",
  "dentro de los plazos fijados en el calendario de obra",
  "salvo causa de fuerza mayor debidamente comprobada",
  "conforme a las normas locales de construcción vigentes",
  "una vez recibido el pago inicial pactado entre las partes",
  "previa verificación del alcance de cobertura de la póliza",
  "sin que ello implique renuncia a derechos posteriores",
  "bajo la supervisión de un representante designado",
  "de acuerdo con las especificaciones técnicas del fabricante",
  "con sujeción a las condiciones generales de este documento",
];
const CLOSERS = [
  "Cualquier modificación deberá constar por escrito y firmada por ambas partes.",
  "La falta de pago en el plazo indicado generará intereses moratorios.",
  "Las partes se someten a la jurisdicción de los tribunales del domicilio del asegurado.",
  "Este apartado sobrevivirá a la terminación del presente contrato.",
  "El incumplimiento reiterado facultará a la parte afectada para rescindir el acuerdo.",
  "Las notificaciones se enviarán a los domicilios señalados en la carátula.",
];
const TOPICS = ["alcance de los trabajos", "forma de pago", "plazo de ejecución", "garantía", "responsabilidad", "confidencialidad", "cesión de derechos", "seguros y fianzas", "cambios de obra", "terminación anticipada", "resolución de controversias", "autorización de cobro directo"];

/** Cláusulas comunes que aparecen TAL CUAL en muchos contratos distintos (cortesía, privacidad, firma). */
export const COMMON_CLAUSES = [
  "Las partes declaran haber leído y comprendido el presente documento y lo firman de conformidad en la fecha indicada al calce.",
  "El firmante autoriza el uso de copias digitales de este contrato, las cuales tendrán la misma validez que el original impreso.",
  "Los datos personales proporcionados serán tratados únicamente para la ejecución del presente contrato y no se compartirán con terceros ajenos.",
  "Ninguna de las partes podrá ceder total o parcialmente los derechos derivados de este contrato sin el consentimiento escrito de la otra.",
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

/** Un párrafo de ~55-75 palabras determinado por `seed`. */
export function makeParagraph(seed: number, clauseNumber: number): string {
  const random = rng(seed * 7919 + clauseNumber * 104729 + 17);
  const heading = `${clauseNumber}. ${pick(random, TOPICS).replace(/^./, (c) => c.toUpperCase())}.`;
  const sentences: string[] = [];
  const count = 3 + Math.floor(random() * 2);
  for (let index = 0; index < count; index += 1) {
    const sentence = `${pick(random, PARTIES)} ${pick(random, VERBS)} ${pick(random, OBJECTS)}, ${pick(random, CONDITIONS)}.`;
    sentences.push(sentence.replace(/^./, (c) => c.toUpperCase()));
  }
  sentences.push(pick(random, CLOSERS));
  return `${heading} ${sentences.join(" ")}`;
}

export type ContractModel = {
  title: string;
  /** Párrafos por página. */
  pages: string[][];
};

export type ContractSpec = {
  seed: number;
  pages: number;
  /** Párrafos por página (por defecto 5, ≈ 330 palabras). */
  paragraphsPerPage?: number;
  title?: string;
  /** Con `true` una cláusula de cada página es una de `COMMON_CLAUSES` (texto compartido entre contratos distintos). */
  shareCommon?: boolean;
};

export function buildContractModel(spec: ContractSpec): ContractModel {
  const perPage = spec.paragraphsPerPage ?? 5;
  const random = rng(spec.seed * 31 + 5);
  const pages: string[][] = [];
  let clause = 1;
  for (let page = 0; page < spec.pages; page += 1) {
    const paragraphs: string[] = [];
    for (let index = 0; index < perPage; index += 1) {
      if (spec.shareCommon && index === perPage - 1) {
        paragraphs.push(`${clause}. ${pick(random, COMMON_CLAUSES)}`);
      } else {
        paragraphs.push(makeParagraph(spec.seed * 1000 + page * 10 + index, clause));
      }
      clause += 1;
    }
    pages.push(paragraphs);
  }
  return { title: spec.title ?? `CONTRATO DE SERVICIOS ${spec.seed}`, pages };
}

/** Copia del modelo con un párrafo sustituido por otro generado con `newSeed`. */
export function changeParagraph(model: ContractModel, page: number, index: number, newSeed: number): ContractModel {
  const pages = model.pages.map((paragraphs) => [...paragraphs]);
  pages[page][index] = makeParagraph(newSeed, 900 + index);
  return { ...model, pages };
}

/** Copia del modelo con una frase de `words` palabras añadida al final de un párrafo (cambio pequeño). */
export function appendSentence(model: ContractModel, page: number, index: number, text: string): ContractModel {
  const pages = model.pages.map((paragraphs) => [...paragraphs]);
  pages[page][index] = `${pages[page][index]} ${text}`;
  return { ...model, pages };
}

export type ContractExtras = {
  /** «15 de octubre de 2026», «10/15/2026»… Va en la cabecera y en una línea del cuerpo. */
  date?: string;
  /** Folio por página (cambia por ejemplar). */
  folio?: string;
  policy?: string;
  /** Tamaño de página en puntos; por defecto carta. */
  size?: [number, number];
  metadata?: { title?: string; author?: string; producer?: string };
  useObjectStreams?: boolean;
  /** Fuente: Helvetica (por defecto) o Times. El texto es el mismo; la apariencia no. */
  font?: "helvetica" | "times";
};

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Dibuja el modelo con pdf-lib. */
export async function renderContract(model: ContractModel, extras: ContractExtras = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [width, height] = extras.size ?? [612, 792];
  const font = await doc.embedFont(extras.font === "times" ? StandardFonts.TimesRoman : StandardFonts.Helvetica);
  const bold = await doc.embedFont(extras.font === "times" ? StandardFonts.TimesRomanBold : StandardFonts.HelveticaBold);
  const date = extras.date ?? "15 de octubre de 2026";
  const folio = extras.folio ?? "00012345";
  const policy = extras.policy ?? "CLM-2026-77412";
  const total = model.pages.length;
  model.pages.forEach((paragraphs, pageIndex) => {
    const page = doc.addPage([width, height]);
    page.drawText(model.title, { x: 54, y: height - 54, size: 13, font: bold });
    page.drawText(`Folio: ${folio}${pageIndex}   Poliza No. ${policy}   Fecha: ${date}`, { x: 54, y: height - 72, size: 9, font });
    let y = height - 100;
    for (const paragraph of paragraphs) {
      for (const line of wrap(paragraph, 92)) {
        page.drawText(line, { x: 54, y, size: 10, font });
        y -= 13;
      }
      y -= 8;
    }
    page.drawText("Firma del asegurado: ____________________      Fecha: ____________", { x: 54, y: 70, size: 10, font });
    page.drawText(`Pagina ${pageIndex + 1} de ${total}`, { x: width - 120, y: 36, size: 9, font });
  });
  if (extras.metadata?.title) doc.setTitle(extras.metadata.title);
  if (extras.metadata?.author) doc.setAuthor(extras.metadata.author);
  if (extras.metadata?.producer) doc.setProducer(extras.metadata.producer);
  return doc.save({ useObjectStreams: extras.useObjectStreams ?? true });
}

/** Contrato completo en un paso. */
export async function makeContractPdf(spec: ContractSpec, extras: ContractExtras = {}): Promise<Uint8Array> {
  return renderContract(buildContractModel(spec), extras);
}

/* ------------------------------------------------------------------ *
 * Variantes «misma cosa, otros bytes»
 * ------------------------------------------------------------------ */

/** Carga y vuelve a guardar con pdf-lib (bytes distintos, mismo contenido). */
export async function resave(bytes: Uint8Array, options: { useObjectStreams?: boolean; title?: string; author?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  if (options.title) doc.setTitle(options.title);
  if (options.author) doc.setAuthor(options.author);
  doc.setModificationDate(new Date(2030, 0, 1));
  return doc.save({ useObjectStreams: options.useObjectStreams ?? false });
}

/** Copia las páginas a un documento nuevo en orden inverso de creación de objetos: numeración y disposición distintas. */
export async function reorderObjects(bytes: Uint8Array): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes);
  const target = await PDFDocument.create();
  const indexes = source.getPageIndices();
  // Se copian de atrás hacia delante y luego se reordenan: los objetos nacen en otro orden.
  const copied = await target.copyPages(source, [...indexes].reverse());
  for (const page of copied.reverse()) target.addPage(page);
  return target.save({ useObjectStreams: false });
}

/** Quita la compresión Flate de todos los flujos (contenido sin comprimir). */
export async function decompressStreams(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const flate = PDFName.of("FlateDecode");
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const filter = object.dict.get(PDFName.of("Filter"));
    if (filter !== flate) continue;
    const decoded = decodePDFRawStream(object).decode();
    const dict = object.dict.clone(doc.context);
    dict.delete(PDFName.of("Filter"));
    dict.delete(PDFName.of("DecodeParms"));
    dict.set(PDFName.of("Length"), PDFNumber.of(decoded.length));
    doc.context.assign(ref, PDFRawStream.of(dict, decoded));
  }
  return doc.save({ useObjectStreams: false });
}

/** PDF cifrado. Con `userPassword` vacío solo restringe permisos (se abre sin contraseña). */
export async function encryptWithPassword(bytes: Uint8Array, password: string, userPassword: string = password): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  doc.encrypt({
    userPassword,
    ownerPassword: password,
    permissions: { printing: "highResolution", modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true },
  });
  return doc.save({ useObjectStreams: false });
}

/** PDF truncado a la mitad (xref perdida). */
export function truncate(bytes: Uint8Array, fraction = 0.5): Uint8Array {
  return bytes.slice(0, Math.max(8, Math.floor(bytes.length * fraction)));
}

/** PDF de `pages` páginas con una línea de texto distinta por página (para el tope de páginas y el rendimiento). */
export async function makeManyPagesPdf(pages: number, seed = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([612, 792]);
    const paragraphs = [makeParagraph(seed * 100000 + index, 1), makeParagraph(seed * 100000 + index, 2), makeParagraph(seed * 100000 + index + 50000, 3)];
    let y = 740;
    for (const paragraph of paragraphs) {
      for (const line of wrap(paragraph, 92)) {
        page.drawText(line, { x: 54, y, size: 10, font });
        y -= 13;
      }
      y -= 8;
    }
  }
  return doc.save({ useObjectStreams: true });
}

/* ------------------------------------------------------------------ *
 * Escaneados (sin texto)
 * ------------------------------------------------------------------ */

export type ScanSpec = {
  seed: number;
  pages: number;
  /** Desviación típica del ruido gaussiano (niveles de gris). */
  noise?: number;
  /** Desplazamiento de toda la imagen, en píxeles de la imagen (150 ppp: 1275×1650). */
  shift?: { x: number; y: number };
  /** Calidad JPEG 1-100. */
  quality?: number;
};

const SCAN_W = 1275;
const SCAN_H = 1650;

/** Una página «escaneada»: líneas de texto simuladas (barras grises), cabecera, tablas y firma; ruido y desplazamiento opcionales. */
export function drawScanPage(seed: number, page: number, noise = 0, shift = { x: 0, y: 0 }, quality = 72): Uint8Array {
  const random = rng(seed * 977 + page * 13 + 3);
  const canvas = createCanvas(SCAN_W, SCAN_H);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fbfbf8";
  context.fillRect(0, 0, SCAN_W, SCAN_H);
  context.translate(shift.x, shift.y);
  // Cabecera: bloque de «logotipo» y título.
  context.fillStyle = "#222";
  const logoWidth = 120 + Math.floor(random() * 240);
  context.fillRect(100, 90, logoWidth, 70);
  context.fillRect(100 + logoWidth + 40, 110, 300 + Math.floor(random() * 400), 22);
  // Cuerpo: párrafos de líneas con largo irregular.
  let y = 220;
  while (y < SCAN_H - 380) {
    const lines = 3 + Math.floor(random() * 7);
    for (let line = 0; line < lines && y < SCAN_H - 380; line += 1) {
      const last = line === lines - 1;
      const length = last ? 300 + random() * 500 : 900 + random() * 250;
      const indent = line === 0 && random() < 0.5 ? 60 : 0;
      context.fillStyle = "#2a2a2a";
      context.fillRect(100 + indent, y, length - indent, 9);
      y += 26;
    }
    y += 22 + Math.floor(random() * 30);
    if (random() < 0.2) {
      // Tabla: rectángulo hueco con divisiones.
      context.strokeStyle = "#333";
      context.lineWidth = 3;
      const tableHeight = 100 + Math.floor(random() * 120);
      context.strokeRect(100, y, 1075, tableHeight);
      const cols = 2 + Math.floor(random() * 3);
      for (let col = 1; col < cols; col += 1) {
        context.beginPath();
        context.moveTo(100 + (1075 * col) / cols, y);
        context.lineTo(100 + (1075 * col) / cols, y + tableHeight);
        context.stroke();
      }
      y += tableHeight + 40;
    }
  }
  // Pie: línea de firma y fecha.
  context.fillStyle = "#222";
  context.fillRect(100, SCAN_H - 260, 420 + Math.floor(random() * 60), 4);
  context.fillRect(760, SCAN_H - 260, 300, 4);
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (noise > 0) {
    const image = context.getImageData(0, 0, SCAN_W, SCAN_H);
    const noiseRandom = rng(seed * 4099 + page * 31 + 9);
    for (let index = 0; index < image.data.length; index += 4) {
      const gaussian = Math.sqrt(-2 * Math.log(noiseRandom() || 1e-9)) * Math.cos(2 * Math.PI * noiseRandom());
      const delta = gaussian * noise;
      image.data[index] = Math.max(0, Math.min(255, image.data[index] + delta));
      image.data[index + 1] = Math.max(0, Math.min(255, image.data[index + 1] + delta));
      image.data[index + 2] = Math.max(0, Math.min(255, image.data[index + 2] + delta));
    }
    context.putImageData(image, 0, 0);
  }
  return new Uint8Array(canvas.toBuffer("image/jpeg", quality));
}

/** PDF de escaneados: una imagen JPEG a toda página, SIN capa de texto. */
export async function makeScannedPdf(spec: ScanSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < spec.pages; index += 1) {
    const jpeg = await doc.embedJpg(drawScanPage(spec.seed, index, spec.noise ?? 0, spec.shift ?? { x: 0, y: 0 }, spec.quality ?? 72));
    const page = doc.addPage([612, 792]);
    page.drawImage(jpeg, { x: 0, y: 0, width: 612, height: 792 });
  }
  return doc.save({ useObjectStreams: false });
}

/** Una hoja en blanco (sin texto ni imagen). */
export async function makeBlankPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) doc.addPage([612, 792]);
  return doc.save();
}
