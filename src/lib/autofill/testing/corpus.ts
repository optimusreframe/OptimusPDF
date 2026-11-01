/**
 * CORPUS SINTETICO del autorrelleno (versionado, para CI): documentos generados con pdf-lib y texto pegado, con DATOS INVENTADOS
 * (nombres, calles, telefonos 555-01xx, correos @example.com, polizas y reclamos al azar) y su verdad de terreno. Ningun
 * documento real. Todo sale de una semilla: el mismo `buildCorpus()` da siempre los mismos documentos.
 *
 * Disposiciones (ES y EN): «etiqueta: valor» en una cadena, valor puesto en otra columna, valor escrito SOBRE la raya de la etiqueta,
 * etiqueta partida en dos tramos, fila de titulos + fila de datos, etiqueta encima del valor, dos pares por linea, todo en
 * mayusculas, carta de reclamo, hoja de poliza (con fechas senuelo), contrato con membrete/pie y bloque del ajustador (senuelos),
 * formulario en blanco, texto de clausulas (prosa con senuelos) y texto pegado.
 *
 * Cada documento declara: `high` (lo que DEBE salir con nivel alto), `review` (lo que como mucho llega a revision), `forbidden`
 * (valores de senuelo que no pueden salir en NINGUN nivel) y `noHigh` (claves que no pueden salir como `high`).
 */

import { PDFDocument, StandardFonts, degrees, type PDFFont, type PDFPage } from "@cantoo/pdf-lib";
import { makeRng, type Rng } from "@/lib/scan/__fixtures__/rng";
import type { AutofillSource } from "@/lib/autofill/types";

export type Lang = "es" | "en";

export type Truth = {
  high?: Partial<Record<string, string | string[]>>;
  review?: Partial<Record<string, string | string[]>>;
  forbidden?: string[];
  noHigh?: string[];
};

export type CorpusDoc = {
  id: string;
  /** Idioma de la interfaz con que se extrae (decide el formato de la fecha de perdida). */
  locale: Lang;
  /** Familia de la disposicion (para desglosar las metricas). */
  layout: string;
  source: () => Promise<AutofillSource>;
  truth: Truth;
};

/* ------------------------------------------------------------------ *
 * Datos inventados
 * ------------------------------------------------------------------ */

const FIRST_EN = ["Maria", "John", "Jane", "Carlos", "Linda", "Robert", "Susan", "David", "Karen", "Michael", "Patricia", "Thomas", "Laura", "Daniel", "Emily", "Andrew", "Rachel", "Kevin"];
const FIRST_ES = ["María", "José", "Carmen", "Luis", "Ana", "Jorge", "Rosa", "Miguel", "Elena", "Pedro", "Lucía", "Andrés", "Sofía", "Rafael", "Marta", "Diego"];
const LAST = ["Testwell", "Alderton", "Marquez", "Fontaine", "Brightwater", "Okonkwo", "Villanueva", "Pemberton", "Castellano", "Hargrove", "Lindqvist", "Abernathy", "Rosales", "Quintero", "Whitcombe", "Delgado", "Ferreira", "Montalvo", "O'Hara", "Muñoz"];
const STREETS = ["Maple Ridge Dr", "Coral Bay Ave", "Sunset Palm Blvd", "Harbor View Ln", "Olive Grove Ct", "Magnolia St", "Heron Cove Way", "Pine Hollow Rd", "Cypress Point Cir", "Lakeshore Ter"];
const CITIES: Array<[string, string, string]> = [["Miami", "FL", "33166"], ["Orlando", "FL", "32839"], ["Tampa", "FL", "33602"], ["Houston", "TX", "77002"], ["Kissimmee", "FL", "34741"], ["San Juan", "PR", "00901"], ["Austin", "TX", "78701"]];
const INSURERS_EN = ["State Farm", "Allstate", "Citizens Property Insurance Corporation", "Universal Property & Casualty Insurance Company", "Palmetto Mutual Insurance Company", "Liberty Mutual", "Heritage Property & Casualty", "Gulfshore Indemnity Company"];
const INSURERS_ES = ["Seguros Atlas del Caribe", "Aseguradora Sol Naciente", "Mapfre", "Seguros Monterrey", "Compañía de Seguros Horizonte"];
const CLAIM_TYPES_EN = ["Wind", "Hail", "Water Damage", "Fire", "Mold", "Hurricane", "Roof Leak", "Pipe Burst"];
const CLAIM_TYPES_ES = ["Viento", "Granizo", "Daño por agua", "Incendio", "Moho", "Huracán", "Filtración en el techo"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export type Person = { first: string; last: string; full: string };

export type Case = {
  lang: Lang;
  p1: Person;
  p2?: Person;
  phoneDigits: string;
  phoneNorm: string;
  email: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  addressNorm: string;
  insurer: string;
  policy: string;
  claim: string;
  claimType?: string;
  y: number;
  m: number;
  d: number;
};

const pad2 = (value: number): string => String(value).padStart(2, "0");
const upperId = (rng: Rng, prefix: string, digits: number): string => `${prefix}${Array.from({ length: digits }, () => rng.int(0, 9)).join("")}`;

export function makeCase(rng: Rng, lang: Lang, options: { second?: boolean; claimType?: boolean } = {}): Case {
  const firsts = lang === "es" ? FIRST_ES : FIRST_EN;
  const person = (surname?: string): Person => {
    const first = rng.pick(firsts);
    const last = surname ?? rng.pick(LAST);
    return { first, last, full: `${first} ${last}` };
  };
  const p1 = person();
  let p2 = options.second ? person(p1.last) : undefined;
  // Dos personas distintas: el mismo nombre dos veces no es un segundo asegurado.
  while (p2 && p2.first === p1.first) p2 = person(p1.last);
  const area = rng.pick(["305", "407", "813", "713", "787", "512"]);
  const line = String(rng.int(0, 99)).padStart(2, "0");
  const phoneDigits = `${area}55501${line}`;
  const [city, state, zip] = rng.pick(CITIES);
  const street = `${rng.int(100, 9899)} ${rng.pick(STREETS)}`;
  const slug = `${p1.first}.${p1.last}`.toLowerCase().normalize("NFD").replace(/[^a-z.]/g, "");
  const claimType = options.claimType ? rng.pick(lang === "es" ? CLAIM_TYPES_ES : CLAIM_TYPES_EN) : undefined;
  return {
    lang,
    p1,
    p2,
    phoneDigits,
    phoneNorm: `(${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`,
    email: `${slug}${rng.int(1, 99)}@example.com`,
    street,
    city,
    state,
    zip,
    addressNorm: `${street}, ${city}, ${state} ${zip}`,
    insurer: rng.pick(lang === "es" ? INSURERS_ES : INSURERS_EN),
    policy: rng.pick([`${rng.int(10, 99)}-${rng.pick(["AB", "XK", "QR", "HP"])}-${rng.int(1000, 9999)}`, upperId(rng, "HO3-", 7), upperId(rng, "FL-HO-2026-", 6), String(rng.int(1_000_000_000, 9_999_999_999))]),
    claim: rng.pick([upperId(rng, "CLM-2026-", 6), `${rng.int(10, 99)}-${rng.int(100, 999)}-${rng.int(100, 999)}`, upperId(rng, "FL26-", 5), String(rng.int(10_000_000, 99_999_999))]),
    claimType,
    y: rng.int(2023, 2026),
    m: rng.int(1, 12),
    // Dia > 12 para que los formatos numericos no sean ambiguos (los ambiguos tienen su propia prueba).
    d: rng.int(13, 28),
  };
}

/** Fecha tal como se TECLEA en el documento (varios formatos). */
export function typedDate(c: Case, style: number): string {
  const { y, m, d, lang } = c;
  const mm = pad2(m);
  const dd = pad2(d);
  if (lang === "en") {
    return [`${MONTHS_EN[m - 1]} ${d}, ${y}`, `${mm}/${dd}/${y}`, `${y}-${mm}-${dd}`, `${d}-${MONTHS_EN[m - 1].slice(0, 3)}-${y}`, `${MONTHS_EN[m - 1].slice(0, 3)}. ${d}, ${y}`][style % 5];
  }
  return [`${d} de ${MONTHS_ES[m - 1]} de ${y}`, `${dd}/${mm}/${y}`, `${y}-${mm}-${dd}`, `${d}-${MONTHS_ES[m - 1].slice(0, 3)}-${y}`, `${MONTHS_ES[m - 1]} ${d}, ${y}`][style % 5];
}

/** Fecha esperada en el formato del idioma de la interfaz. */
export function expectedDate(c: Case, locale: Lang): string {
  return locale === "es" ? `${pad2(c.d)}/${pad2(c.m)}/${c.y}` : `${pad2(c.m)}/${pad2(c.d)}/${c.y}`;
}

export function typedPhone(c: Case, style: number): string {
  const [a, b, d] = [c.phoneDigits.slice(0, 3), c.phoneDigits.slice(3, 6), c.phoneDigits.slice(6)];
  return [`${a}-${b}-${d}`, `(${a}) ${b}-${d}`, `${a}.${b}.${d}`, `+1 ${a} ${b} ${d}`, `1-${a}-${b}-${d}`][style % 5];
}

export const LABELS: Record<Lang, Record<string, string[]>> = {
  en: {
    name: ["Insured", "Insured Name", "Named Insured", "Policyholder", "Client", "Insured(s)", "Client/Insured"],
    phone: ["Phone", "Telephone", "Cell Phone", "Phone Number", "Phone#", "Tel."],
    email: ["Email", "E-mail", "Email Address"],
    address: ["Loss Address", "Property Address", "Address", "Address of Loss"],
    insurer: ["Insurance Company", "Insurer", "Carrier"],
    policy: ["Policy No.", "Policy Number", "Policy #", "Policy#"],
    claim: ["Claim No.", "Claim Number", "Claim #", "Claim#"],
    claimType: ["Type of Loss", "Cause of Loss", "Claim Type", "Damage caused by"],
    lossDate: ["Date of Loss", "Loss Date", "DOL"],
  },
  es: {
    name: ["Asegurado", "Nombre del asegurado", "Cliente", "Titular de la póliza", "Nombre del cliente"],
    phone: ["Teléfono", "Celular", "Tel.", "Número de teléfono"],
    email: ["Correo electrónico", "Correo", "Email"],
    address: ["Dirección de la pérdida", "Dirección de la propiedad", "Dirección", "Domicilio"],
    insurer: ["Aseguradora", "Compañía de seguros", "Compañía aseguradora"],
    policy: ["Póliza", "Póliza No.", "Número de póliza", "N.º de póliza"],
    claim: ["Reclamo No.", "Número de reclamo", "N.º de siniestro", "Número de siniestro", "Reclamo #"],
    claimType: ["Tipo de pérdida", "Causa de la pérdida", "Tipo de reclamo", "Daño causado por"],
    lossDate: ["Fecha de pérdida", "Fecha del siniestro", "Fecha de la pérdida"],
  },
};

/* ------------------------------------------------------------------ *
 * Dibujo
 * ------------------------------------------------------------------ */

export type Op =
  | { t: "text"; x: number; y: number; s: string; size?: number; bold?: boolean }
  | { t: "rule"; x0: number; x1: number; y: number }
  | { t: "box"; x: number; y: number; w: number; h: number };

export type PageSpec = { ops: Op[]; rotate?: 0 | 90 | 180 | 270 };

export const PAGE_W = 612;
export const PAGE_H = 792;

/** Genera un PDF Letter: `y` se mide desde ARRIBA. */
export async function buildPdf(pages: readonly PageSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const spec of pages) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    for (const op of spec.ops) draw(page, op, regular, bold);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
  }
  return doc.save();
}

function draw(page: PDFPage, op: Op, regular: PDFFont, bold: PDFFont): void {
  if (op.t === "text") page.drawText(op.s, { x: op.x, y: PAGE_H - op.y, size: op.size ?? 11, font: op.bold ? bold : regular });
  else if (op.t === "rule") page.drawLine({ start: { x: op.x0, y: PAGE_H - op.y }, end: { x: op.x1, y: PAGE_H - op.y }, thickness: 0.7 });
  else page.drawRectangle({ x: op.x, y: PAGE_H - op.y - op.h, width: op.w, height: op.h, borderWidth: 0.7 });
}

/** Ancho de un texto en Helvetica 11 (para colocar un valor justo detras de su etiqueta). */
let measureFont: PDFFont | null = null;
export async function textWidth(text: string, size = 11): Promise<number> {
  if (!measureFont) {
    const doc = await PDFDocument.create();
    measureFont = await doc.embedFont(StandardFonts.Helvetica);
  }
  return measureFont.widthOfTextAtSize(text, size);
}

export async function pdfSource(pages: readonly PageSpec[], name = "doc.pdf"): Promise<AutofillSource> {
  const bytes = await buildPdf(pages);
  return { kind: "pdf", file: new File([bytes as BlobPart], name, { type: "application/pdf" }), origin: "file" };
}

export function textSource(text: string): AutofillSource {
  return { kind: "text", text, origin: "paste" };
}

/* ------------------------------------------------------------------ *
 * Pares etiqueta/valor
 * ------------------------------------------------------------------ */

export type Pair = { key: string; label: string; value: string; expected: string };

export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(" ")
    .map((word, index) => (index > 0 && ["de", "del", "la", "las", "los", "el", "en", "por", "con", "para", "y", "and", "of"].includes(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ")
    .replace(/\bMc([a-z])/g, (_, c: string) => `Mc${c.toUpperCase()}`)
    .replace(/O'([a-z])/g, (_, c: string) => `O'${c.toUpperCase()}`);
}

/** Pares de un caso: lo que se escribe en el documento y lo que se espera que el motor devuelva. */
export function pairsOf(c: Case, rng: Rng, locale: Lang, options: { caps?: boolean; claimType?: boolean } = {}): Pair[] {
  const L = LABELS[c.lang];
  const caps = options.caps ?? false;
  const shape = (text: string): string => (caps ? text.toUpperCase() : text);
  const style = rng.int(0, 4);
  const fullNames = c.p2 ? `${c.p1.full} ${c.lang === "es" ? "y" : "and"} ${c.p2.full}` : c.p1.full;
  const pairs: Pair[] = [
    { key: "insuredName1", label: rng.pick(L.name), value: shape(fullNames), expected: caps ? titleCase(c.p1.full) : c.p1.full },
    { key: "address", label: rng.pick(L.address), value: shape(`${c.street}, ${c.city}, ${c.state} ${c.zip}`), expected: caps ? titleAddress(c.addressNorm) : c.addressNorm },
    { key: "phone", label: rng.pick(L.phone), value: typedPhone(c, style), expected: c.phoneNorm },
    { key: "email", label: rng.pick(L.email), value: shape(c.email), expected: c.email },
    { key: "insurer", label: rng.pick(L.insurer), value: shape(c.insurer), expected: caps ? titleCase(c.insurer).replace(/\bAnd\b/g, "and") : c.insurer },
    { key: "policyNumber", label: rng.pick(L.policy), value: c.policy, expected: c.policy },
    { key: "claimNumber", label: rng.pick(L.claim), value: c.claim, expected: c.claim },
    { key: "lossDate", label: rng.pick(L.lossDate), value: shape(typedDate(c, style)), expected: expectedDate(c, locale) },
  ];
  if (c.claimType && options.claimType !== false) pairs.push({ key: "claimType", label: rng.pick(L.claimType), value: shape(c.claimType), expected: caps ? titleCase(c.claimType) : c.claimType });
  return pairs;
}

function titleAddress(text: string): string {
  return text
    .split(" ")
    .map((token) => (/^[A-Z]{2}$/.test(token) || /\d/.test(token.replace(/[,.]/g, "")) ? token : token.charAt(0) + token.slice(1).toLowerCase()))
    .join(" ");
}

function truthOf(c: Case, pairs: readonly Pair[], caps = false): Truth {
  const high: Record<string, string | string[]> = {};
  for (const pair of pairs) high[pair.key] = pair.expected;
  if (c.p2) high.insuredName2 = caps ? titleCase(c.p2.full) : c.p2.full;
  return { high };
}

/* ------------------------------------------------------------------ *
 * Disposiciones
 * ------------------------------------------------------------------ */

type Layout = (pairs: readonly Pair[], c: Case, rng: Rng) => Promise<PageSpec[]>;

const LEFT = 60;
const TOP = 150;
const STEP = 26;

function title(c: Case): Op[] {
  return [{ t: "text", x: LEFT, y: 80, s: c.lang === "es" ? "FORMULARIO DE RECLAMO" : "CLAIM INTAKE FORM", size: 15, bold: true }];
}

const inline: Layout = async (pairs, c) => [
  { ops: [...title(c), ...pairs.flatMap((p, i): Op[] => [{ t: "text", x: LEFT, y: TOP + i * STEP, s: `${p.label}: ${p.value}` }, { t: "rule", x0: LEFT, x1: 540, y: TOP + i * STEP + 5 }])] },
];

const cols: Layout = async (pairs, c) => [
  {
    ops: [
      ...title(c),
      ...pairs.flatMap((p, i): Op[] => [
        { t: "text", x: LEFT, y: TOP + i * STEP, s: `${p.label}:` },
        { t: "text", x: 250, y: TOP + i * STEP, s: p.value },
        { t: "box", x: LEFT - 6, y: TOP + i * STEP - 14, w: 490, h: 22 },
      ]),
    ],
  },
];

const overlay: Layout = async (pairs, c) => {
  const ops: Op[] = [...title(c)];
  for (const [i, p] of pairs.entries()) {
    const y = TOP + i * STEP;
    const labelWidth = await textWidth(`${p.label}:`);
    ops.push({ t: "text", x: LEFT, y, s: `${p.label}:` }, { t: "text", x: LEFT + labelWidth + 6, y, s: "_".repeat(52) }, { t: "text", x: LEFT + labelWidth + 12, y: y - 2, s: p.value });
  }
  return [{ ops }];
};

const split: Layout = async (pairs, c) => {
  const ops: Op[] = [...title(c)];
  for (const [i, p] of pairs.entries()) {
    const y = TOP + i * STEP;
    const labelWidth = await textWidth(`${p.label}:`);
    ops.push({ t: "text", x: LEFT, y, s: `${p.label}:` }, { t: "text", x: LEFT + labelWidth + 4, y, s: p.value });
  }
  return [{ ops }];
};

const stacked: Layout = async (pairs, c) => [
  { ops: [...title(c), ...pairs.flatMap((p, i): Op[] => [{ t: "text", x: LEFT, y: TOP + i * 40, s: `${p.label}:`, size: 9 }, { t: "text", x: LEFT, y: TOP + i * 40 + 14, s: p.value }])] },
];

/** Filas de titulos (sin dos puntos) y, debajo, la fila de datos: las claves cortas van de 3 en 3; las largas, solas. */
const headerRow: Layout = async (pairs, c) => {
  const ops: Op[] = [...title(c)];
  const columns = [LEFT, 240, 420];
  const byKey = new Map(pairs.map((p) => [p.key, p]));
  const groups = [["insuredName1", "phone", "email"], ["address"], ["insurer"], ["policyNumber", "claimNumber", "lossDate"], ["claimType"]].map((keys) => keys.map((key) => byKey.get(key)).filter((p): p is Pair => Boolean(p)));
  groups.filter((group) => group.length > 0).forEach((group, row) => {
    const y = TOP + row * 62;
    group.forEach((p, i) => {
      ops.push({ t: "text", x: columns[i], y, s: p.label.replace(/[:#]$/, ""), size: 9, bold: true }, { t: "text", x: columns[i], y: y + 18, s: p.value, size: 10 });
    });
    ops.push({ t: "rule", x0: LEFT, x1: 540, y: y + 24 });
  });
  return [{ ops }];
};

/** Dos pares en una misma cadena: «Insured: X     Phone: Y». */
const dense: Layout = async (pairs, c) => {
  const ops: Op[] = [...title(c)];
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i];
    const b = pairs[i + 1];
    ops.push({ t: "text", x: LEFT, y: TOP + (i / 2) * STEP * 1.4, s: b ? `${a.label}: ${a.value}     ${b.label}: ${b.value}` : `${a.label}: ${a.value}`, size: 10 });
  }
  return [{ ops }];
};

export const LAYOUTS: Record<string, Layout> = { inline, cols, overlay, split, stacked, headerRow, dense };

/* ------------------------------------------------------------------ *
 * Documentos con significado propio
 * ------------------------------------------------------------------ */

const FOOTER_EN = { company: "Responsive Claims Group, LLC", phone: "Office: (305) 555-0188", fax: "Fax: (305) 555-0189", email: "E-mail: info@responsive-example.com", address: "Address: 8561 NW Palm Grove Drive, Medley FL 33166" };
const FOOTER_ES = { company: "Grupo de Reclamos Responsivo, S.A.", phone: "Oficina: (305) 555-0188", fax: "Fax: (305) 555-0189", email: "Correo: info@responsive-example.com", address: "Dirección: 8561 NW Palm Grove Drive, Medley FL 33166" };

function footerOps(lang: Lang): Op[] {
  const f = lang === "es" ? FOOTER_ES : FOOTER_EN;
  return [
    { t: "rule", x0: 40, x1: 572, y: 740 },
    { t: "text", x: 40, y: 752, s: `${f.address}   ${f.phone}   ${f.fax}`, size: 8 },
    { t: "text", x: 40, y: 763, s: `${f.email}`, size: 8 },
  ];
}

/** Contrato de 2 paginas: membrete + pie repetidos (senuelos), campos puestos sobre la raya y bloque del ajustador (senuelo). */
async function contract(c: Case, rng: Rng, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const L = LABELS[c.lang];
  const pairs = pairsOf(c, rng, locale, { claimType: true });
  const f = c.lang === "es" ? FOOTER_ES : FOOTER_EN;
  const head: Op[] = [{ t: "text", x: 380, y: 40, s: f.company, size: 12, bold: true }, { t: "text", x: 380, y: 54, s: f.phone, size: 9 }];
  const ops: Op[] = [...head, { t: "text", x: LEFT, y: 120, s: c.lang === "es" ? "CONTRATO DE SERVICIOS" : "SERVICE AGREEMENT", size: 15, bold: true }];
  for (const [i, p] of pairs.entries()) {
    const y = 170 + i * STEP;
    const labelWidth = await textWidth(`${p.label}:`);
    ops.push({ t: "text", x: LEFT, y, s: `${p.label}:` }, { t: "text", x: LEFT + labelWidth + 6, y, s: "_".repeat(48) }, { t: "text", x: LEFT + labelWidth + 12, y: y - 2, s: p.value });
  }
  const prose = c.lang === "es"
    ? ["El asegurado autoriza a la compañía a comunicarse con la aseguradora. El pago se hará dentro de 30 días.", "Para dudas llame al (305) 555-0190 en horario de oficina."]
    : ["The insured authorizes the company to communicate with the carrier. Payment is due within 30 days.", "For questions please call (305) 555-0190 during office hours."];
  prose.forEach((line, i) => ops.push({ t: "text", x: LEFT, y: 470 + i * 16, s: line, size: 10 }));
  const page2: Op[] = [
    ...head,
    { t: "text", x: LEFT, y: 120, s: c.lang === "es" ? "Bloque del ajustador" : "Adjuster block", size: 12, bold: true },
    { t: "text", x: LEFT, y: 150, s: `${c.lang === "es" ? "Ajustador público" : "Public Adjuster"}: Dana Whitfield` },
    { t: "text", x: LEFT, y: 172, s: `${L.phone[0]}: (689) 555-0111` },
    { t: "text", x: LEFT, y: 194, s: `${L.email[0]}: dana.whitfield@responsive-example.com` },
    { t: "text", x: LEFT, y: 216, s: `${L.address[2] ?? L.address[0]}: 4700 Orchard Blvd, Orlando, FL 32839` },
  ];
  const truth = truthOf(c, pairs);
  truth.forbidden = ["(305) 555-0188", "(305) 555-0189", "info@responsive-example.com", "(689) 555-0111", "dana.whitfield@responsive-example.com", "4700 Orchard Blvd, Orlando, FL 32839", "(305) 555-0190", "8561 NW Palm Grove Drive, Medley, FL 33166", "Dana Whitfield"];
  return { pages: [{ ops: [...ops, ...footerOps(c.lang)] }, { ops: [...page2, ...footerOps(c.lang)] }], truth };
}

/** Carta de reclamo de la aseguradora (membrete, fecha, destinatario, referencia, prosa y firma del ajustador). */
async function letter(c: Case, rng: Rng, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const es = c.lang === "es";
  const L = LABELS[c.lang];
  const ops: Op[] = [
    { t: "text", x: LEFT, y: 70, s: c.insurer, size: 14, bold: true },
    { t: "text", x: LEFT, y: 86, s: "P.O. Box 4410, Tampa, FL 33601", size: 10 },
    { t: "text", x: LEFT, y: 126, s: es ? `${d2(c.d)} de ${MONTHS_ES[(c.m % 12)]} de ${c.y + 0}` : `${MONTHS_EN[(c.m % 12)]} ${c.d}, ${c.y}`, size: 11 },
    { t: "text", x: LEFT, y: 170, s: c.p1.full },
    { t: "text", x: LEFT, y: 184, s: c.street },
    { t: "text", x: LEFT, y: 198, s: `${c.city}, ${c.state} ${c.zip}` },
    { t: "text", x: LEFT, y: 240, s: `RE:  ${L.name[0]}: ${c.p1.full}`, bold: true },
    { t: "text", x: LEFT + 28, y: 256, s: `${L.claim[0]} ${c.claim}`, bold: true },
    { t: "text", x: LEFT + 28, y: 272, s: `${L.policy[0]} ${c.policy}`, bold: true },
    { t: "text", x: LEFT + 28, y: 288, s: `${L.lossDate[0]}: ${typedDate(c, 0)}`, bold: true },
    { t: "text", x: LEFT, y: 330, s: es ? `Estimado(a) ${c.p1.full}:` : `Dear ${c.p1.full}:` },
    { t: "text", x: LEFT, y: 358, s: es ? "Hemos recibido su reclamo y asignamos a la ajustadora Dana Whitfield, quien le llamará pronto." : "We have received your claim and assigned adjuster Dana Whitfield, who will call you soon.", size: 10 },
    { t: "text", x: LEFT, y: 374, s: es ? "Puede escribirle a dana.whitfield@insurer-example.com o llamar al (800) 555-0100." : "You may write to dana.whitfield@insurer-example.com or call (800) 555-0100.", size: 10 },
    { t: "text", x: LEFT, y: 430, s: es ? "Atentamente," : "Sincerely," },
    { t: "text", x: LEFT, y: 470, s: es ? "Dana Whitfield, Ajustadora de reclamos" : "Dana Whitfield, Claims Adjuster" },
    { t: "text", x: LEFT, y: 486, s: `${L.phone[0]}: (800) 555-0100` },
    { t: "text", x: LEFT, y: 502, s: `${L.email[0]}: dana.whitfield@insurer-example.com` },
  ];
  const truth: Truth = {
    high: { insuredName1: c.p1.full, claimNumber: c.claim, policyNumber: c.policy, lossDate: expectedDate({ ...c }, locale) },
    review: { address: c.addressNorm, insurer: c.insurer },
    forbidden: ["(800) 555-0100", "dana.whitfield@insurer-example.com", "Dana Whitfield", "P.O. Box 4410, Tampa, FL 33601"],
  };
  void rng;
  return { pages: [{ ops }], truth };
}

const d2 = (value: number): string => String(value);

/** Hoja de declaraciones de una poliza: nombres, direccion postal, numero y fechas SENUELO (vigencia). */
async function declarations(c: Case, rng: Rng, locale: Lang): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const es = c.lang === "es";
  const name = c.p2 ? `${c.p1.full} ${es ? "y" : "and"} ${c.p2.full}` : c.p1.full;
  const ops: Op[] = [
    { t: "text", x: LEFT, y: 70, s: es ? "DECLARACIONES DE LA PÓLIZA" : "POLICY DECLARATIONS", size: 15, bold: true },
    { t: "text", x: LEFT, y: 120, s: `${es ? "Asegurado" : "Named Insured"}: ${name}` },
    { t: "text", x: LEFT, y: 142, s: `${es ? "Dirección postal" : "Mailing Address"}: ${c.street}, ${c.city}, ${c.state} ${c.zip}` },
    { t: "text", x: LEFT, y: 164, s: `${es ? "Número de póliza" : "Policy Number"}: ${c.policy}` },
    { t: "text", x: LEFT, y: 186, s: `${es ? "Aseguradora" : "Insurance Company"}: ${c.insurer}` },
    { t: "text", x: LEFT, y: 208, s: `${es ? "Vigencia" : "Policy Period"}: 01/01/${c.y} ${es ? "a" : "to"} 01/01/${c.y + 1}` },
    { t: "text", x: LEFT, y: 230, s: `${es ? "Prima anual" : "Annual Premium"}: $${rng.int(900, 4900)}.00` },
    { t: "text", x: LEFT, y: 252, s: `${es ? "Deducible" : "Deductible"}: $2,500   ${es ? "Cobertura A" : "Coverage A"}: $${rng.int(150, 450)},000` },
    { t: "text", x: LEFT, y: 274, s: `${es ? "Agente" : "Agent"}: Pat Lindgren   ${es ? "Teléfono del agente" : "Agent Phone"}: (407) 555-0166` },
  ];
  const truth: Truth = {
    high: { insuredName1: c.p1.full, address: c.addressNorm, policyNumber: c.policy, insurer: c.insurer },
    noHigh: ["lossDate", "phone", "claimNumber"],
    forbidden: ["(407) 555-0166"],
  };
  if (c.p2) truth.high!.insuredName2 = c.p2.full;
  void locale;
  return { pages: [{ ops }], truth };
}

/** Formulario en blanco: etiquetas con rayas o con cajas, sin ningun dato. */
async function blank(c: Case, mode: "underscore" | "boxes"): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const L = LABELS[c.lang];
  const labels = [L.name[0], L.phone[0], L.email[0], L.address[0], L.insurer[0], L.policy[0], L.claim[0], L.lossDate[0], L.claimType[0]];
  const ops: Op[] = [...title(c)];
  for (const [i, label] of labels.entries()) {
    const y = TOP + i * STEP;
    if (mode === "underscore") ops.push({ t: "text", x: LEFT, y, s: `${label}: ${"_".repeat(50)}` });
    else ops.push({ t: "text", x: LEFT, y, s: `${label}:` }, { t: "rule", x0: 220, x1: 540, y: y + 3 });
  }
  return { pages: [{ ops }], truth: { noHigh: ["insuredName1", "insuredName2", "address", "phone", "email", "insurer", "policyNumber", "claimNumber", "claimType", "lossDate"], forbidden: [] } };
}

/** Clausulas: prosa con las palabras «insured», fechas, numeros y un telefono, sin ningun campo. */
async function clauses(c: Case): Promise<{ pages: PageSpec[]; truth: Truth }> {
  const es = c.lang === "es";
  const lines = es
    ? [
        "1. El Asegurado reconoce que la póliza vigente desde el 15 de enero de 2024 cubre los daños descritos.",
        "2. El pago de 1,500 dólares vence a los 30 días de la firma. Para consultas: (305) 555-0123.",
        "3. Cliente: acepta que el contrato terminará el 31/12/2026 sin penalidad.",
        "4. Reclamo: cualquier reclamo deberá presentarse por escrito dentro de 60 días.",
        "5. Nombre: se refiere al nombre completo de cada parte según aparece más arriba.",
      ]
    : [
        "1. The Insured acknowledges that the policy in force since January 15, 2024 covers the damages described.",
        "2. Payment of $1,500 is due within 30 days of signing. For questions call (305) 555-0123.",
        "3. Client: agrees that this contract will end on 12/31/2026 without penalty.",
        "4. Claim: any claim must be submitted in writing within 60 days.",
        "5. Name: refers to the full name of each party as shown above.",
      ];
  const ops: Op[] = [{ t: "text", x: LEFT, y: 80, s: es ? "TÉRMINOS Y CONDICIONES" : "TERMS AND CONDITIONS", size: 14, bold: true }];
  lines.forEach((line, i) => ops.push({ t: "text", x: LEFT, y: 120 + i * 22, s: line, size: 10 }));
  void c;
  return { pages: [{ ops }], truth: { noHigh: ["insuredName1", "insuredName2", "address", "phone", "email", "insurer", "policyNumber", "claimNumber", "claimType", "lossDate"], forbidden: ["(305) 555-0123"] } };
}

/** Texto pegado: pares «etiqueta: valor» (como un correo o una nota) y un bloque libre. */
function pasted(c: Case, rng: Rng, locale: Lang, style: "lines" | "email" | "table"): { text: string; truth: Truth } {
  const pairs = pairsOf(c, rng, locale, { claimType: true });
  let text: string;
  if (style === "lines") text = pairs.map((p) => `${p.label}: ${p.value}`).join("\n");
  else if (style === "table") text = pairs.map((p) => `${p.label.padEnd(26)}   ${p.value}`).join("\n");
  else {
    const L = LABELS[c.lang];
    text = [
      c.lang === "es" ? "Hola, te paso los datos del cliente para el contrato." : "Hi, here is the customer information for the contract.",
      "",
      ...pairs.filter((p) => ["insuredName1", "phone", "email"].includes(p.key)).map((p) => `${p.label}: ${p.value}`),
      "",
      `${L.address[0]}:`,
      `${c.street}`,
      `${c.city}, ${c.state} ${c.zip}`,
      "",
      ...pairs.filter((p) => ["insurer", "policyNumber", "claimNumber", "lossDate", "claimType"].includes(p.key)).map((p) => `${p.label}: ${p.value}`),
    ].join("\n");
  }
  return { text, truth: truthOf(c, pairs) };
}

/* ------------------------------------------------------------------ *
 * Corpus completo
 * ------------------------------------------------------------------ */

export function buildCorpus(): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  const langs: Lang[] = ["en", "es"];
  let seed = 1000;
  const next = (): Rng => makeRng((seed += 7));

  for (const lang of langs) {
    for (const [layoutName, layout] of Object.entries(LAYOUTS)) {
      for (let variant = 0; variant < 4; variant += 1) {
        const rng = next();
        const c = makeCase(rng, lang, { second: variant === 1, claimType: variant !== 2 });
        const caps = variant === 3;
        const pairs = pairsOf(c, rng, lang, { caps });
        // En disposiciones de dos columnas la fila del segundo asegurado va junto al primero: se espera ademas el nombre 2.
        docs.push({
          id: `${layoutName}-${lang}-${variant}${caps ? "-caps" : ""}`,
          locale: lang,
          layout: layoutName + (caps ? "+caps" : ""),
          source: async () => pdfSource(await layout(pairs, c, rng)),
          truth: truthOf(c, pairs, caps),
        });
      }
    }

    for (let variant = 0; variant < 3; variant += 1) {
      const rng = next();
      const c = makeCase(rng, lang, { second: variant === 1, claimType: true });
      docs.push({ id: `contract-${lang}-${variant}`, locale: lang, layout: "contract", source: async () => pdfSource((await contract(c, makeRng(1), lang)).pages), truth: { ...truthSync(c, lang, makeRng(1)) } });
    }
    for (let variant = 0; variant < 3; variant += 1) {
      const rng = next();
      const c = makeCase(rng, lang, { second: false });
      docs.push({ id: `letter-${lang}-${variant}`, locale: lang, layout: "letter", source: async () => pdfSource((await letter(c, rng, lang)).pages), truth: lettersTruth(c, lang) });
    }
    for (let variant = 0; variant < 3; variant += 1) {
      const rng = next();
      const c = makeCase(rng, lang, { second: variant === 0 });
      docs.push({ id: `declarations-${lang}-${variant}`, locale: lang, layout: "declarations", source: async () => pdfSource((await declarations(c, makeRng(5), lang)).pages), truth: declarationsTruth(c) });
    }
    for (const mode of ["underscore", "boxes"] as const) {
      const c = makeCase(next(), lang);
      docs.push({ id: `blank-${mode}-${lang}`, locale: lang, layout: "blank", source: async () => pdfSource((await blank(c, mode)).pages), truth: { noHigh: ALL_KEYS, forbidden: [] } });
    }
    {
      const c = makeCase(next(), lang);
      docs.push({ id: `clauses-${lang}`, locale: lang, layout: "clauses", source: async () => pdfSource((await clauses(c)).pages), truth: { noHigh: ALL_KEYS, forbidden: ["(305) 555-0123"] } });
    }
    for (const style of ["lines", "email", "table"] as const) {
      for (let variant = 0; variant < 2; variant += 1) {
        const rng = next();
        const c = makeCase(rng, lang, { second: variant === 1, claimType: true });
        const made = pasted(c, rng, lang, style);
        docs.push({ id: `pasted-${style}-${lang}-${variant}`, locale: lang, layout: `pasted-${style}`, source: async () => textSource(made.text), truth: made.truth });
      }
    }
  }
  return docs;
}

const ALL_KEYS = ["insuredName1", "insuredName2", "address", "phone", "email", "insurer", "policyNumber", "claimNumber", "claimType", "lossDate"];

function truthSync(c: Case, lang: Lang, rng: Rng): Truth {
  const pairs = pairsOf(c, rng, lang, { claimType: true });
  const truth = truthOf(c, pairs);
  truth.forbidden = ["(305) 555-0188", "(305) 555-0189", "info@responsive-example.com", "(689) 555-0111", "dana.whitfield@responsive-example.com", "4700 Orchard Blvd, Orlando, FL 32839", "(305) 555-0190", "Dana Whitfield"];
  return truth;
}

function lettersTruth(c: Case, lang: Lang): Truth {
  return {
    high: { insuredName1: c.p1.full, claimNumber: c.claim, policyNumber: c.policy, lossDate: expectedDate(c, lang) },
    review: { address: c.addressNorm, insurer: c.insurer },
    forbidden: ["(800) 555-0100", "dana.whitfield@insurer-example.com", "Dana Whitfield"],
  };
}

function declarationsTruth(c: Case): Truth {
  const truth: Truth = {
    high: { insuredName1: c.p1.full, address: c.addressNorm, policyNumber: c.policy, insurer: c.insurer },
    noHigh: ["lossDate", "phone", "claimNumber"],
    forbidden: ["(407) 555-0166"],
  };
  if (c.p2) truth.high!.insuredName2 = c.p2.full;
  return truth;
}
