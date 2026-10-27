import path from "node:path";
import { GlobalFonts, createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { makeRng, type Rng } from "@/lib/scan/__fixtures__/rng";
import type { Rgba } from "@/lib/scan/pixels";

/**
 * Paginas SINTETICAS (papel) del corpus del Escaner: documentos de texto, formularios, hojas en blanco con sello, recibos,
 * tarjetas, libros y pizarras. Se dibujan con las fuentes Liberation del proyecto (`public/fonts`) para que el texto sea
 * identico en cualquier maquina. Ningun documento real: todo sale de una semilla.
 */

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  const dir = path.join(process.cwd(), "public", "fonts");
  GlobalFonts.registerFromPath(path.join(dir, "LiberationSans-Regular.ttf"), "ScanSans");
  GlobalFonts.registerFromPath(path.join(dir, "LiberationSans-Bold.ttf"), "ScanSansBold");
  GlobalFonts.registerFromPath(path.join(dir, "LiberationSans-Italic.ttf"), "ScanSansItalic");
  GlobalFonts.registerFromPath(path.join(dir, "LiberationMono-Regular.ttf"), "ScanMono");
  GlobalFonts.registerFromPath(path.join(dir, "LiberationMono-Bold.ttf"), "ScanMonoBold");
  fontsReady = true;
}

export const PAGE_W = 700;
export const PAGE_H = 900;
const PAPER = "rgb(250,248,242)";

export const TITLES = [
  "Contrato de servicio",
  "Informe de siniestro",
  "Factura de reparación",
  "Declaración jurada",
  "Póliza de seguro vehicular",
  "Acta de inspección",
  "Presupuesto de reparación",
  "Carta de reclamación",
  "Service agreement",
  "Claim settlement letter",
] as const;

const WORDS_ES = [
  "el", "asegurado", "declara", "que", "el", "vehículo", "sufrió", "daños", "materiales", "durante", "la", "tormenta", "del", "pasado",
  "mes", "y", "solicita", "la", "cobertura", "correspondiente", "según", "las", "condiciones", "generales", "de", "la", "póliza", "vigente",
  "el", "perito", "realizó", "la", "inspección", "en", "presencia", "del", "titular", "quien", "firmó", "de", "conformidad", "los", "importes",
  "se", "pagarán", "dentro", "de", "los", "treinta", "días", "hábiles", "posteriores", "a", "la", "aprobación", "del", "informe", "técnico",
  "la", "reparación", "incluye", "pintura", "parabrisas", "y", "defensa", "delantera", "todos", "los", "gastos", "adicionales", "quedan",
  "excluidos", "salvo", "autorización", "escrita", "previa", "de", "la", "compañía",
];
const WORDS_EN = [
  "the", "insured", "party", "declares", "that", "the", "vehicle", "suffered", "material", "damage", "during", "the", "storm", "last",
  "month", "and", "requests", "the", "coverage", "under", "the", "general", "terms", "of", "the", "policy", "in", "force", "the", "adjuster",
  "performed", "the", "inspection", "in", "the", "presence", "of", "the", "holder", "who", "signed", "in", "agreement", "payments", "will",
  "be", "made", "within", "thirty", "business", "days", "after", "approval", "of", "the", "technical", "report", "repairs", "include",
  "paint", "windshield", "and", "front", "bumper", "any", "additional", "expenses", "are", "excluded", "unless", "written", "authorization",
];

export type TruthLine = { text: string; size: number; top: number; left: number; width: number; role: "title" | "body" | "header" | "date" | "label" | "value" };

export type PageRender = {
  canvas: Canvas;
  lines: TruthLine[];
  title: string | null;
  /** Fecha ISO escrita en el documento, si la hay. */
  date: string | null;
  /** Hoja sin contenido (o solo un sello pequeno / un numero de pagina). */
  blank: boolean;
  /** Recuadro de la tinta en coordenadas de pagina (px), o `null` si no hay. */
  inkBox: { x: number; y: number; w: number; h: number } | null;
};

function newPaper(width: number, height: number, rng: Rng, tint = PAPER): { canvas: Canvas; ctx: SKRSContext2D } {
  ensureFonts();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, width, height);
  // Grano del papel: puntos muy tenues que no son tinta.
  for (let index = 0; index < width * height * 0.01; index += 1) {
    const value = 235 + rng.int(0, 14);
    ctx.fillStyle = `rgb(${value},${value - 1},${value - 6})`;
    ctx.fillRect(rng.int(0, width - 1), rng.int(0, height - 1), 1, 1);
  }
  ctx.textBaseline = "alphabetic";
  return { canvas, ctx };
}

function sentence(rng: Rng, words: readonly string[], count: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) out.push(rng.pick(words));
  return out;
}

/** Parrafos justificados a la izquierda (borde derecho irregular, como un texto real). */
function paragraphs(
  ctx: SKRSContext2D,
  rng: Rng,
  words: readonly string[],
  opts: { x: number; y: number; width: number; size: number; lead: number; maxY: number; lines: TruthLine[] },
): number {
  ctx.font = `${opts.size}px ScanSans`;
  ctx.fillStyle = "rgb(24,24,28)";
  let y = opts.y;
  while (y < opts.maxY) {
    const paragraphLines = rng.int(3, 6);
    for (let line = 0; line < paragraphLines && y < opts.maxY; line += 1) {
      const tokens: string[] = [];
      let text = "";
      while (true) {
        const word = rng.pick(words);
        const candidate = tokens.length === 0 ? word : `${text} ${word}`;
        if (ctx.measureText(candidate).width > opts.width * rng.range(0.82, 1)) break;
        tokens.push(word);
        text = candidate;
        if (tokens.length > 22) break;
      }
      if (line === 0 && tokens.length > 0) text = text[0].toUpperCase() + text.slice(1);
      if (line === paragraphLines - 1) text += ".";
      ctx.fillText(text, opts.x, y);
      opts.lines.push({ text, size: opts.size, top: y - opts.size, left: opts.x, width: ctx.measureText(text).width, role: "body" });
      y += opts.lead;
    }
    y += opts.lead * 0.7;
  }
  return y;
}

export type TextPageOptions = { seed: number; title: string; english?: boolean; letterhead?: boolean; date?: string; lines?: number };

/** Documento de texto: membrete opcional, titulo grande, fecha y parrafos. */
export function renderTextPage(options: TextPageOptions): PageRender {
  const rng = makeRng(options.seed);
  const { canvas, ctx } = newPaper(PAGE_W, PAGE_H, rng);
  const lines: TruthLine[] = [];
  const words = options.english ? WORDS_EN : WORDS_ES;
  let y = 70;
  if (options.letterhead) {
    ctx.font = "22px ScanSansBold";
    ctx.fillStyle = "rgb(40,60,110)";
    const header = options.english ? "NORTHWIND ADJUSTERS LLC" : "AJUSTADORES DEL NORTE S.A.";
    ctx.fillText(header, 60, y);
    lines.push({ text: header, size: 22, top: y - 22, left: 60, width: ctx.measureText(header).width, role: "header" });
    y += 70;
  } else {
    y += 20;
  }
  ctx.font = "44px ScanSansBold";
  ctx.fillStyle = "rgb(16,16,20)";
  const titleWidth = ctx.measureText(options.title).width;
  const titleX = rng.chance(0.5) ? 60 : Math.max(40, (PAGE_W - titleWidth) / 2);
  ctx.fillText(options.title, titleX, y);
  lines.push({ text: options.title, size: 44, top: y - 44, left: titleX, width: titleWidth, role: "title" });
  y += 58;
  let date: string | null = null;
  if (options.date) {
    date = options.date;
    const [yy, mm, dd] = options.date.split("-").map(Number);
    const month = (options.english ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] : ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"])[mm - 1];
    const label = options.english ? `Date: ${month} ${dd}, ${yy}` : `Fecha: ${dd} de ${month} de ${yy}`;
    ctx.font = "21px ScanSans";
    ctx.fillStyle = "rgb(24,24,28)";
    ctx.fillText(label, 60, y);
    lines.push({ text: label, size: 21, top: y - 21, left: 60, width: ctx.measureText(label).width, role: "date" });
    y += 50;
  } else {
    y += 12;
  }
  const maxY = options.lines ? y + options.lines * 34 : PAGE_H - 70;
  paragraphs(ctx, rng, words, { x: 60, y, width: PAGE_W - 120, size: 21, lead: 33, maxY, lines });
  return {
    canvas,
    lines,
    title: options.title,
    date,
    blank: false,
    inkBox: { x: 60, y: 40, w: PAGE_W - 120, h: Math.min(PAGE_H - 80, maxY - 30) },
  };
}

const NAMES = ["María González", "Carlos Pérez", "Ana Martínez", "Luis Hernández", "Elena Torres", "Jorge Ramírez", "Lucía Fernández", "Pedro Sánchez"];
const PLATES = ["ABC-1234", "XYZ-9087", "KLM-5521", "QRS-7710", "TUV-3302"];

export type FormPageOptions = { family: number; fill: number; title?: string };

/** Formulario: la MISMA plantilla impresa (`family`) con datos distintos (`fill`): paginas casi identicas pero distintas. */
export function renderFormPage(options: FormPageOptions): PageRender {
  const layoutRng = makeRng(1000 + options.family);
  const fillRng = makeRng(5000 + options.fill);
  const { canvas, ctx } = newPaper(PAGE_W, PAGE_H, makeRng(77 + options.fill));
  const lines: TruthLine[] = [];
  const title = options.title ?? TITLES[options.family % TITLES.length];
  ctx.font = "40px ScanSansBold";
  ctx.fillStyle = "rgb(16,16,20)";
  ctx.fillText(title, 50, 90);
  lines.push({ text: title, size: 40, top: 50, left: 50, width: ctx.measureText(title).width, role: "title" });
  const labels = ["Nombre del asegurado", "Número de póliza", "Placa del vehículo", "Fecha del siniestro", "Lugar de los hechos", "Monto estimado", "Teléfono de contacto", "Observaciones"];
  ctx.strokeStyle = "rgb(60,60,70)";
  ctx.lineWidth = 2;
  const top = 130;
  const rowH = 82;
  for (let index = 0; index < labels.length; index += 1) {
    const y = top + index * rowH;
    ctx.strokeRect(50, y, PAGE_W - 100, rowH - 10);
    ctx.font = "16px ScanSansBold";
    ctx.fillStyle = "rgb(60,60,70)";
    ctx.fillText(labels[index], 62, y + 24);
    lines.push({ text: labels[index], size: 16, top: y + 8, left: 62, width: ctx.measureText(labels[index]).width, role: "label" });
    // Dato escrito a mano (distinto en cada relleno); el formato de la plantilla es el mismo.
    ctx.font = "26px ScanSansItalic";
    ctx.fillStyle = "rgb(20,40,120)";
    let value: string;
    switch (index) {
      case 0:
        value = fillRng.pick(NAMES);
        break;
      case 1:
        value = `POL-${fillRng.int(100000, 999999)}`;
        break;
      case 2:
        value = fillRng.pick(PLATES);
        break;
      case 3:
        value = `${fillRng.int(1, 28)}/${fillRng.int(1, 12)}/2026`;
        break;
      case 4:
        value = `Av. ${fillRng.pick(["Bolívar", "Libertador", "Sucre", "Miranda"])} con calle ${fillRng.int(1, 40)}`;
        break;
      case 5:
        value = `$ ${fillRng.int(120, 9800)},${fillRng.int(10, 99)}`;
        break;
      case 6:
        value = `0${fillRng.int(412, 426)}-${fillRng.int(1000000, 9999999)}`;
        break;
      default:
        value = fillRng.pick(["Daños en la defensa y el faro derecho", "Sin lesionados; se levantó el acta", "Vidrio trasero roto por granizo", "Choque leve en estacionamiento"]);
    }
    ctx.fillText(value, 70, y + 58);
    lines.push({ text: value, size: 26, top: y + 34, left: 70, width: ctx.measureText(value).width, role: "value" });
  }
  void layoutRng;
  return { canvas, lines, title, date: null, blank: false, inkBox: { x: 50, y: 50, w: PAGE_W - 100, h: top + labels.length * rowH - 50 } };
}

export type BlankPageOptions = { seed: number; stamp?: boolean; pageNumber?: boolean; shortNote?: boolean };

/** Hoja en blanco (con el grano del papel); opcionalmente un sello pequeno, un numero de pagina o una nota corta (que NO la hace "en blanco"). */
export function renderBlankPage(options: BlankPageOptions): PageRender {
  const rng = makeRng(options.seed);
  const { canvas, ctx } = newPaper(PAGE_W, PAGE_H, rng);
  let inkBox: PageRender["inkBox"] = null;
  let blank = true;
  const lines: TruthLine[] = [];
  if (options.stamp) {
    const cx = rng.int(140, PAGE_W - 140);
    const cy = rng.int(160, PAGE_H - 160);
    ctx.strokeStyle = "rgb(160,30,40)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, 52, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "16px ScanSansBold";
    ctx.fillStyle = "rgb(160,30,40)";
    ctx.textAlign = "center";
    ctx.fillText("RECIBIDO", cx, cy + 5);
    ctx.textAlign = "left";
    inkBox = { x: cx - 52, y: cy - 52, w: 104, h: 104 };
  }
  if (options.pageNumber) {
    ctx.font = "18px ScanSans";
    ctx.fillStyle = "rgb(60,60,60)";
    ctx.textAlign = "center";
    ctx.fillText(String(rng.int(2, 40)), PAGE_W / 2, PAGE_H - 36);
    ctx.textAlign = "left";
    inkBox = { x: PAGE_W / 2 - 14, y: PAGE_H - 56, w: 28, h: 26 };
  }
  if (options.shortNote) {
    // Un parrafo corto de verdad: NO es una hoja en blanco aunque tenga poca tinta.
    ctx.font = "21px ScanSans";
    ctx.fillStyle = "rgb(24,24,28)";
    for (let line = 0; line < 4; line += 1) {
      const text = sentence(rng, WORDS_ES, rng.int(7, 9)).join(" ");
      ctx.fillText(text, 60, 120 + line * 34);
      lines.push({ text, size: 21, top: 100 + line * 34, left: 60, width: ctx.measureText(text).width, role: "body" });
    }
    blank = false;
    inkBox = { x: 60, y: 100, w: PAGE_W - 120, h: 150 };
  }
  return { canvas, lines, title: null, date: null, blank, inkBox };
}

/** Recibo largo y estrecho (tipo ticket). */
export function renderReceipt(seed: number): PageRender & { width: number; height: number } {
  const rng = makeRng(seed);
  const width = 300;
  const height = 1000;
  const { canvas, ctx } = newPaper(width, height, rng, "rgb(252,251,247)");
  const lines: TruthLine[] = [];
  const store = rng.pick(["TALLER EL ENGRANAJE", "AUTOPARTES LA ROCA", "FERRETERÍA CENTRAL", "CLÍNICA SANTA ANA"]);
  ctx.font = "26px ScanMonoBold";
  ctx.fillStyle = "rgb(20,20,20)";
  ctx.textAlign = "center";
  ctx.fillText(store, width / 2, 60);
  lines.push({ text: store, size: 26, top: 36, left: 10, width: ctx.measureText(store).width, role: "title" });
  ctx.textAlign = "left";
  ctx.font = "16px ScanMono";
  let y = 110;
  const items = rng.int(10, 16);
  let total = 0;
  for (let index = 0; index < items; index += 1) {
    const price = rng.int(5, 480);
    total += price;
    const name = rng.pick(["Filtro de aceite", "Pastillas freno", "Mano de obra", "Bujía", "Correa", "Lámpara", "Aceite 5W30", "Batería"]);
    ctx.fillText(name, 14, y);
    ctx.textAlign = "right";
    ctx.fillText(`${price}.00`, width - 14, y);
    ctx.textAlign = "left";
    y += 30;
  }
  ctx.font = "22px ScanMonoBold";
  ctx.fillText("TOTAL", 14, y + 30);
  ctx.textAlign = "right";
  ctx.fillText(`${total}.00`, width - 14, y + 30);
  ctx.textAlign = "left";
  return { canvas, lines, title: store, date: null, blank: false, inkBox: { x: 10, y: 30, w: width - 20, h: y }, width, height };
}

/** Tarjeta de identificacion (anverso) con proporcion 1,586. */
export function renderIdCard(seed: number): PageRender & { width: number; height: number } {
  const rng = makeRng(seed);
  const width = 640;
  const height = 404;
  ensureFonts();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(226,236,246)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgb(30,70,150)";
  ctx.fillRect(0, 0, width, 70);
  ctx.fillStyle = "white";
  ctx.font = "28px ScanSansBold";
  ctx.fillText("DOCUMENTO DE IDENTIDAD", 24, 46);
  ctx.fillStyle = "rgb(170,180,196)";
  ctx.fillRect(24, 100, 150, 190);
  ctx.fillStyle = "rgb(20,20,30)";
  ctx.font = "22px ScanSansBold";
  const lines: TruthLine[] = [];
  const fields = [`APELLIDOS: ${rng.pick(NAMES).split(" ")[1].toUpperCase()}`, `NOMBRES: ${rng.pick(NAMES).split(" ")[0].toUpperCase()}`, `NÚMERO: ${rng.int(10000000, 29999999)}`, `NACIDO: ${rng.int(1, 28)}/${rng.int(1, 12)}/${rng.int(1960, 2000)}`];
  fields.forEach((text, index) => {
    ctx.fillText(text, 200, 120 + index * 44);
    lines.push({ text, size: 22, top: 100 + index * 44, left: 200, width: ctx.measureText(text).width, role: "label" });
  });
  return { canvas, lines, title: null, date: null, blank: false, inkBox: { x: 0, y: 0, w: width, h: height }, width, height };
}

/** Libro abierto: dos paginas de texto con la sombra del lomo en el centro. */
export function renderBookSpread(seed: number): PageRender & { width: number; height: number } {
  const rng = makeRng(seed);
  const half = 560;
  const height = 780;
  const width = half * 2;
  ensureFonts();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(247,243,232)";
  ctx.fillRect(0, 0, width, height);
  const lines: TruthLine[] = [];
  for (let side = 0; side < 2; side += 1) {
    const x = side === 0 ? 50 : half + 70;
    paragraphs(ctx, rng, WORDS_ES, { x, y: 90, width: half - 120, size: 20, lead: 31, maxY: height - 70, lines });
  }
  // Lomo: oscurece hacia el centro (curvatura de las hojas) con una raya mas oscura justo en la costura.
  const gradient = ctx.createLinearGradient(half - 90, 0, half + 90, 0);
  gradient.addColorStop(0, "rgba(40,30,20,0)");
  gradient.addColorStop(0.45, "rgba(40,30,20,0.45)");
  gradient.addColorStop(0.5, "rgba(20,14,8,0.85)");
  gradient.addColorStop(0.55, "rgba(40,30,20,0.45)");
  gradient.addColorStop(1, "rgba(40,30,20,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(half - 90, 0, 180, height);
  return { canvas, lines, title: null, date: null, blank: false, inkBox: { x: 50, y: 70, w: width - 100, h: height - 120 }, width, height };
}

/** Pizarra: fondo gris claro, marco y trazos de rotulador de colores. */
export function renderWhiteboard(seed: number): PageRender & { width: number; height: number } {
  const rng = makeRng(seed);
  const width = 900;
  const height = 600;
  ensureFonts();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(226,230,232)";
  ctx.fillRect(0, 0, width, height);
  const lines: TruthLine[] = [];
  ctx.lineCap = "round";
  const colors = ["rgb(30,60,160)", "rgb(190,40,40)", "rgb(30,30,36)", "rgb(30,130,60)"];
  ctx.font = "54px ScanSansBold";
  const title = rng.pick(["PLAN DE TRABAJO", "ETAPAS DE LA OBRA", "REVISIÓN SEMANAL"]);
  ctx.fillStyle = colors[0];
  ctx.fillText(title, 60, 100);
  lines.push({ text: title, size: 54, top: 50, left: 60, width: ctx.measureText(title).width, role: "title" });
  for (let row = 0; row < 6; row += 1) {
    ctx.strokeStyle = colors[rng.int(0, 3)];
    ctx.lineWidth = 5;
    ctx.beginPath();
    const y = 180 + row * 62;
    ctx.moveTo(70, y);
    for (let step = 1; step <= 14; step += 1) ctx.lineTo(70 + step * rng.range(38, 56), y + Math.sin(step * 1.7 + row) * 13);
    ctx.stroke();
  }
  return { canvas, lines, title, date: null, blank: false, inkBox: { x: 50, y: 40, w: width - 100, h: height - 80 }, width, height };
}

/** Foto de un dano (sin documento): bloques de color con textura. */
export function renderDamagePhoto(seed: number): PageRender & { width: number; height: number } {
  const rng = makeRng(seed);
  const width = 800;
  const height = 600;
  ensureFonts();
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "rgb(120,160,210)");
  sky.addColorStop(0.55, "rgb(190,205,220)");
  sky.addColorStop(0.56, "rgb(90,84,76)");
  sky.addColorStop(1, "rgb(60,56,52)");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  for (let index = 0; index < 60; index += 1) {
    ctx.fillStyle = `rgba(${rng.int(40, 220)},${rng.int(40, 200)},${rng.int(40, 200)},${rng.range(0.3, 0.9)})`;
    ctx.fillRect(rng.int(0, width - 40), rng.int(0, height - 40), rng.int(20, 160), rng.int(12, 90));
  }
  return { canvas, lines: [], title: null, date: null, blank: false, inkBox: null, width, height };
}

export function canvasToRgba(canvas: Canvas): Rgba {
  const ctx = canvas.getContext("2d");
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: new Uint8ClampedArray(image.data), width: canvas.width, height: canvas.height };
}
