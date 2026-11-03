/**
 * BANCO DE «DECLARATION PAGES» (maquetacion): 28 plantillas de hoja de declaraciones de seguro de hogar con aseguradoras
 * FICTICIAS y disenos variados. Cada plantilla = un CONTENIDO (que datos hay, con que etiquetas y formatos) + un MOTOR de
 * dibujo (como se colocan):
 *
 *   - `kv`    : «Etiqueta: valor» en lineas, a una o dos columnas, con bloques de varias lineas (estilo carta / sistema de polizas);
 *   - `table` : filas con borde, etiqueta | valor (una o dos parejas por fila);
 *   - `above` : celdas con la etiqueta pequena ENCIMA del valor (3 columnas);
 *   - `mono`  : tipografia de ancho fijo con puntos guia («POLICY NUMBER.......: …»), todo en mayusculas.
 *
 * El motor dibuja operaciones (`DOp`) que `declRender.ts` convierte en PDF con capa de texto, hoja escaneada o foto. Los textos
 * que el diseno imprime deciden la verdad (`Shown` -> `buildTruth` en `declData.ts`). Nada aqui toca el motor de extraccion.
 */

import { PDFDocument, StandardFonts, type PDFFont } from "@cantoo/pdf-lib";
import type { Rng } from "@/lib/scan/__fixtures__/rng";
import {
  addrLines,
  money,
  moneyCents,
  phoneNorm,
  printDate,
  printName,
  printPhone,
  windText,
  type DateStyle,
  type DeclData,
  type DeclLang,
  type PhoneStyle,
  type Shown,
} from "@/lib/autofill/testing/declData";

export type Fam = "sans" | "serif" | "mono";

export type DOp =
  | { t: "text"; x: number; y: number; s: string; size: number; bold?: boolean; fam: Fam; gray?: number }
  | { t: "rule"; x0: number; x1: number; y: number; w?: number }
  | { t: "box"; x: number; y: number; w: number; h: number; w2?: number }
  | { t: "shade"; x: number; y: number; w: number; h: number; gray: number };

export type DPage = DOp[];

export const PAGE_W = 612;
export const PAGE_H = 792;

/* ------------------------------------------------------------------ *
 * Medidas de texto (fuentes estandar de PDF)
 * ------------------------------------------------------------------ */

let fonts: Record<string, PDFFont> | null = null;

export async function initMeasure(): Promise<void> {
  if (fonts) return;
  const doc = await PDFDocument.create();
  fonts = {
    "sans:0": await doc.embedFont(StandardFonts.Helvetica),
    "sans:1": await doc.embedFont(StandardFonts.HelveticaBold),
    "serif:0": await doc.embedFont(StandardFonts.TimesRoman),
    "serif:1": await doc.embedFont(StandardFonts.TimesRomanBold),
    "mono:0": await doc.embedFont(StandardFonts.Courier),
    "mono:1": await doc.embedFont(StandardFonts.CourierBold),
  };
}

export function textW(s: string, size: number, fam: Fam, bold = false): number {
  if (!fonts) throw new Error("initMeasure() primero");
  try {
    return fonts[`${fam}:${bold ? 1 : 0}`].widthOfTextAtSize(s, size);
  } catch {
    return s.length * size * 0.55;
  }
}

/* ------------------------------------------------------------------ *
 * Escritor de operaciones
 * ------------------------------------------------------------------ */

class Writer {
  readonly ops: DOp[] = [];
  constructor(private readonly chunk: boolean) {}

  text(x: number, y: number, s: string, size: number, fam: Fam, bold = false, gray?: number): void {
    if (s === "") return;
    if (!this.chunk || !s.includes(" ") || fam === "mono") {
      this.ops.push({ t: "text", x, y, s, size, bold, fam, gray });
      return;
    }
    // Una operacion por palabra (como emiten muchos PDF de sistemas de polizas): el lector debe unirlas por la distancia.
    let cursor = x;
    const space = textW(" ", size, fam, bold);
    for (const word of s.split(" ")) {
      if (word !== "") this.ops.push({ t: "text", x: cursor, y, s: word, size, bold, fam, gray });
      cursor += textW(word, size, fam, bold) + space;
    }
  }

  rule(x0: number, x1: number, y: number, w?: number): void {
    this.ops.push({ t: "rule", x0, x1, y, w });
  }

  box(x: number, y: number, w: number, h: number): void {
    this.ops.push({ t: "box", x, y, w, h });
  }

  shade(x: number, y: number, w: number, h: number, gray: number): void {
    this.ops.push({ t: "shade", x, y, w, h, gray });
  }
}

/* ------------------------------------------------------------------ *
 * Contenido
 * ------------------------------------------------------------------ */

export type Item = {
  id: string;
  label?: string;
  lines: string[];
  kind: "kv" | "block" | "note" | "table";
  rows?: Array<[string, string]>;
  col?: "L" | "R";
  span?: number;
};

export type ContentOpts = {
  caps: boolean;
  joiner: "amp" | "and" | "lines";
  /** «Named Insured and Mailing Address» en un solo bloque, o dos etiquetas separadas. */
  insured: "combined" | "separate";
  premises: "label" | "same" | "none";
  phone: boolean;
  email: boolean;
  mortgagee: boolean;
  period: "range" | "effexp" | "fromto" | "none";
  dateStyle: DateStyle;
  phoneStyle: PhoneStyle;
  insurer: "letterhead" | "label" | "both";
  aop: boolean;
  wind: boolean;
  agent: boolean;
  claims: boolean;
  coverages: boolean;
  forms: boolean;
  issued: boolean;
  prior: boolean;
  /** Variante de redaccion de las etiquetas. */
  v: number;
  /** El numero de poliza antes de los nombres (si no, despues). */
  policyFirst?: boolean;
};

const DEFAULT_CONTENT: ContentOpts = {
  caps: false,
  joiner: "amp",
  insured: "combined",
  premises: "label",
  phone: false,
  email: false,
  mortgagee: true,
  period: "range",
  dateStyle: "mdy",
  phoneStyle: "paren",
  insurer: "letterhead",
  aop: true,
  wind: true,
  agent: true,
  claims: true,
  coverages: true,
  forms: true,
  issued: true,
  prior: false,
  v: 0,
  policyFirst: true,
};

type Words = {
  policy: string[];
  period: string[];
  effective: string[];
  expiration: string[];
  insuredCombined: string[];
  insuredSep: string[];
  mailing: string[];
  premises: string[];
  mortgagee: string[];
  phone: string[];
  email: string[];
  insurer: string[];
  aop: string[];
  wind: string[];
  agent: string[];
  claims: (phone: string) => string;
  issued: string[];
  prior: string[];
  loan: string;
  from: string;
  to: string;
  same: string[];
  title: string[];
  coverages: Array<[string, string]>;
  forms: string;
  premium: string;
  tenAm: string;
};

const WORDS: Record<DeclLang, Words> = {
  en: {
    policy: ["Policy Number", "Policy No.", "Policy #", "POLICY NUMBER", "Policy ID", "Policy No"],
    period: ["Policy Period", "Policy Term", "Policy Period:", "Period of Insurance", "Term of Policy"],
    effective: ["Effective Date", "Policy Effective", "Effective", "Policy Inception Date", "Inception Date"],
    expiration: ["Expiration Date", "Policy Expires", "Expiration", "Expiry Date", "Policy Expiry"],
    insuredCombined: ["Named Insured and Mailing Address", "Named Insured & Mailing Address", "NAMED INSURED AND MAILING ADDRESS", "Insured and Mailing Address", "Insured Name and Mailing Address", "Policyholder and Mailing Address"],
    insuredSep: ["Named Insured", "Insured Name(s)", "Policyholder", "NAMED INSURED", "Insured", "Policy Holder"],
    mailing: ["Mailing Address", "Mailing Address", "MAILING ADDRESS"],
    premises: ["Residence Premises", "Insured Location", "Location of Insured Property", "Property Address", "Location of Residence Premises", "Insured Property", "Dwelling Address", "Property Insured"],
    mortgagee: ["Mortgagee", "First Mortgagee", "Mortgagee / Lienholder", "Mortgage Company", "Lienholder", "Mortgage Holder"],
    phone: ["Insured Phone", "Home Phone", "Phone", "Telephone"],
    email: ["Insured Email", "Email", "E-mail Address"],
    insurer: ["Insurance Company", "Issuing Company", "Carrier", "Insurer"],
    aop: ["All Other Perils Deductible", "AOP Deductible", "Deductible - All Other Perils", "Section I Deductible", "Standard Deductible", "Policy Deductible"],
    wind: ["Wind/Hail Deductible", "Hurricane Deductible", "Named Storm Deductible", "Windstorm or Hail Deductible", "Windstorm Deductible", "Hurricane Peril Deductible"],
    agent: ["Agent", "Producer", "Your Agent"],
    claims: (phone) => `To report a claim, call ${phone} (24 hours a day, 7 days a week).`,
    issued: ["Date Issued", "Issue Date", "Prepared"],
    prior: ["Renewal of Policy", "Replaces Policy No.", "Prior Policy Number"],
    loan: "Loan Number",
    from: "From",
    to: "To",
    same: ["Same as mailing address", "SAME AS MAILING ADDRESS", "Same as above"],
    title: ["HOMEOWNERS POLICY DECLARATIONS", "Homeowners 3 - Special Form Declarations", "Homeowner Policy - Declarations Page", "POLICY DECLARATIONS"],
    coverages: [
      ["A - Dwelling", "Coverage A - Dwelling"],
      ["B - Other Structures", "Coverage B - Other Structures"],
      ["C - Personal Property", "Coverage C - Personal Property"],
      ["D - Loss of Use", "Coverage D - Loss of Use"],
      ["E - Personal Liability", "Coverage E - Personal Liability"],
      ["F - Medical Payments to Others", "Coverage F - Medical Payments"],
    ],
    forms: "Forms and Endorsements",
    premium: "Total Annual Premium",
    tenAm: "12:01 AM standard time at the residence premises",
  },
  es: {
    policy: ["Número de Póliza", "Póliza No.", "No. de Póliza", "NÚMERO DE PÓLIZA", "Póliza Núm.", "Póliza"],
    period: ["Vigencia", "Período de la Póliza", "Vigencia de la Póliza", "Período de Seguro", "Vigencia del Seguro"],
    effective: ["Inicio de Vigencia", "Vigente desde", "Fecha de Efectividad", "Efectiva desde", "Fecha de Inicio"],
    expiration: ["Fin de Vigencia", "Vence", "Fecha de Vencimiento", "Vigente hasta", "Vencimiento"],
    insuredCombined: ["Asegurado Nombrado y Dirección Postal", "Asegurado y Dirección Postal", "ASEGURADO NOMBRADO Y DIRECCIÓN POSTAL", "Nombre del Asegurado y Dirección Postal"],
    insuredSep: ["Asegurado Nombrado", "Nombre del Asegurado", "Asegurado(s)", "ASEGURADO NOMBRADO"],
    mailing: ["Dirección Postal", "Dirección Postal", "DIRECCIÓN POSTAL"],
    premises: ["Ubicación del Riesgo", "Ubicación de la Propiedad Asegurada", "Residencia Asegurada", "Dirección de la Propiedad"],
    mortgagee: ["Acreedor Hipotecario", "Hipotecario", "Banco Hipotecario", "Primer Acreedor Hipotecario"],
    phone: ["Teléfono del Asegurado", "Teléfono", "Teléfono Residencial", "Celular"],
    email: ["Correo Electrónico", "Correo electrónico del asegurado", "Email"],
    insurer: ["Aseguradora", "Compañía Aseguradora", "Compañía de Seguros", "Aseguradora emisora"],
    aop: ["Deducible Todo Otro Riesgo", "Deducible General", "Deducible - Todos los Demás Riesgos", "Deducible Sección I"],
    wind: ["Deducible de Viento/Granizo", "Deducible de Huracán", "Deducible por Tormenta Nombrada", "Deducible de Vendaval"],
    agent: ["Agente", "Productor", "Su Agente"],
    claims: (phone) => `Para reportar un reclamo llame al ${phone} (las 24 horas, todos los días).`,
    issued: ["Fecha de Emisión", "Emitida el", "Preparada"],
    prior: ["Renovación de la Póliza", "Sustituye la Póliza No.", "Póliza Anterior"],
    loan: "Número de Préstamo",
    from: "Desde",
    to: "Hasta",
    same: ["Igual que la dirección postal", "IGUAL QUE LA DIRECCIÓN POSTAL", "Igual que arriba"],
    title: ["DECLARACIONES DE LA PÓLIZA DE HOGAR", "Declaraciones - Póliza de Propietario de Vivienda", "Hoja de Declaraciones", "DECLARACIONES DE LA PÓLIZA"],
    coverages: [
      ["A - Vivienda", "Cobertura A - Vivienda"],
      ["B - Otras Estructuras", "Cobertura B - Otras Estructuras"],
      ["C - Bienes Personales", "Cobertura C - Bienes Personales"],
      ["D - Pérdida de Uso", "Cobertura D - Pérdida de Uso"],
      ["E - Responsabilidad Personal", "Cobertura E - Responsabilidad Civil"],
      ["F - Pagos Médicos a Terceros", "Cobertura F - Gastos Médicos"],
    ],
    forms: "Formularios y Endosos",
    premium: "Prima Anual Total",
    tenAm: "a las 12:01 AM, hora estándar, en la residencia asegurada",
  },
};

const pick = <T>(list: readonly T[], v: number): T => list[v % list.length];

/** Construye los elementos del documento y dice que se imprimio. */
export function buildItems(d: DeclData, rng: Rng, o: ContentOpts): { items: Item[]; shown: Shown; header: string[]; title: string; words: Words } {
  const W = WORDS[d.lang];
  const cap = (s: string): string => (o.caps ? s.toUpperCase() : s);
  const names = d.people.map((p) => printName(p, o.caps));
  let nameLines: string[];
  if (names.length === 1) nameLines = [names[0]];
  else if (o.joiner === "lines") nameLines = names;
  else if (o.joiner === "and") {
    const sameSurname = d.people[0].last === d.people[1].last && !o.caps && !d.people.some((p) => p.suffix || p.middle);
    const word = d.lang === "es" ? "y" : o.caps ? "AND" : "and";
    nameLines = [sameSurname ? `${d.people[0].first} ${word} ${d.people[1].first} ${d.people[0].last}` : `${names[0]} ${word} ${names[1]}`];
  } else nameLines = [`${names[0]} & ${names[1]}`];

  const items: Item[] = [];
  const policyLabel = cap(pick(W.policy, o.v));
  const policyItem: Item = { id: "policy", label: policyLabel, lines: [d.policyNo], kind: "kv", col: "R" };
  const dateOf = (date: typeof d.start): string => printDate(date, o.dateStyle, d.lang);

  const mailLines = addrLines(d.mailing, o.caps);
  if (o.policyFirst) items.push(policyItem);
  if (o.insured === "combined") {
    items.push({ id: "insured", label: cap(pick(W.insuredCombined, o.v)), lines: [...nameLines, ...mailLines], kind: "block", col: "L" });
  } else {
    items.push({ id: "insured", label: cap(pick(W.insuredSep, o.v)), lines: nameLines, kind: nameLines.length > 1 ? "block" : "kv", col: "L" });
    items.push({ id: "mailing", label: cap(pick(W.mailing, o.v)), lines: mailLines, kind: "block", col: "L" });
  }
  if (o.premises === "label") items.push({ id: "premises", label: cap(pick(W.premises, o.v + 1)), lines: addrLines(d.premises, o.caps), kind: "block", col: "R" });
  else if (o.premises === "same") items.push({ id: "premises", label: cap(pick(W.premises, o.v + 1)), lines: [cap(pick(W.same, o.v))], kind: "kv", col: "R" });
  if (!o.policyFirst) items.push(policyItem);

  let period = false;
  if (o.period === "range") {
    items.push({ id: "period", label: cap(pick(W.period, o.v)), lines: [`${dateOf(d.start)} ${d.lang === "es" ? "a" : "to"} ${dateOf(d.end)}`], kind: "kv", col: "R" });
    period = true;
  } else if (o.period === "fromto") {
    items.push({ id: "period", label: cap(pick(W.period, o.v)), lines: [`${W.from} ${dateOf(d.start)} ${W.to} ${dateOf(d.end)} ${W.tenAm}`], kind: "kv", col: "R" });
    period = true;
  } else if (o.period === "effexp") {
    items.push({ id: "effective", label: cap(pick(W.effective, o.v)), lines: [dateOf(d.start)], kind: "kv", col: "R" });
    items.push({ id: "expiration", label: cap(pick(W.expiration, o.v)), lines: [dateOf(d.end)], kind: "kv", col: "R" });
    period = true;
  }
  if (o.insurer !== "letterhead") items.push({ id: "insurer", label: cap(pick(W.insurer, o.v)), lines: [cap(d.carrier.name)], kind: "kv", col: "L" });
  if (o.phone) items.push({ id: "phone", label: cap(pick(W.phone, o.v)), lines: [printPhone(d.phoneDigits, o.phoneStyle)], kind: "kv", col: "L" });
  if (o.email) items.push({ id: "email", label: cap(pick(W.email, o.v)), lines: [d.email], kind: "kv", col: "L" });
  if (o.mortgagee && d.mortgagee) {
    const m = d.mortgagee;
    items.push({
      id: "mortgagee",
      label: cap(pick(W.mortgagee, o.v)),
      lines: [cap(`${m.name} ISAOA ATIMA`), ...addrLines(m.addr, o.caps), `${cap(W.loan)}: ${m.loan}`],
      kind: "block",
      col: "L",
    });
  } else if (o.mortgagee === false) items.push({ id: "mortgagee-none", label: cap(pick(W.mortgagee, o.v)), lines: [d.lang === "es" ? cap("Ninguno") : cap("None")], kind: "kv", col: "L" });
  if (o.coverages) items.push({ id: "coverages", kind: "table", lines: [], rows: W.coverages.map(([short, long], i) => [pick([short, long], o.v), money(Object.values(d.cov)[i])] as [string, string]), col: "L" });
  const ded: Array<[string, string]> = [];
  if (o.aop) ded.push([cap(pick(W.aop, o.v)), money(d.aop)]);
  if (o.wind && windText(d) !== "") ded.push([cap(pick(W.wind, o.v)), windText(d)]);
  if (ded.length > 0) items.push({ id: "deductibles", kind: "table", lines: [], rows: ded, col: "R" });
  if (o.agent) {
    items.push({
      id: "agent",
      label: cap(pick(W.agent, o.v)),
      lines: [cap(d.agent.agency), cap(d.agent.person), `${d.lang === "es" ? "Tel" : "Phone"}: ${printPhone(d.agent.phoneDigits, o.phoneStyle)}`],
      kind: "block",
      col: "R",
    });
  }
  if (o.claims) items.push({ id: "claims", lines: [W.claims(printPhone(d.claimsDigits, "one-dash"))], kind: "note", col: "L" });
  if (o.issued) items.push({ id: "issued", label: cap(pick(W.issued, o.v)), lines: [printDate(d.issued, o.dateStyle === "long" ? "long" : "mdy", d.lang)], kind: "kv", col: "R" });
  if (o.prior) items.push({ id: "prior", label: cap(pick(W.prior, o.v)), lines: [d.priorPolicyNo], kind: "kv", col: "R" });
  if (o.forms) items.push({ id: "forms", label: cap(W.forms), lines: [d.forms.slice(0, 2).join(", "), d.forms[2]], kind: "block", col: "L", span: 3 });
  items.push({ id: "premium", label: cap(W.premium), lines: [moneyCents(d.premium)], kind: "kv", col: "R" });
  void rng;

  const shown: Shown = {
    mailing: true,
    premises: o.premises,
    phone: o.phone,
    email: o.email,
    period,
    mortgagee: Boolean(o.mortgagee && d.mortgagee),
    aop: o.aop,
    wind: o.wind && windText(d) !== "",
    insurer: true,
    priorPolicy: o.prior,
  };
  return { items, shown, header: [], title: cap(pick(W.title, o.v)), words: W };
}

/* ------------------------------------------------------------------ *
 * Motores de dibujo
 * ------------------------------------------------------------------ */

const LM = 54;
const RM = 558;

export type StyleOpts = {
  fam: Fam;
  /** Alto de letra del cuerpo. */
  size?: number;
  chunk?: boolean;
  /** Posicion del membrete: nombre de la aseguradora. */
  letterhead?: "left" | "center" | "box" | "right";
  /** Telefono de reclamos y agente en una banda superior (cerca del membrete). */
  topBand?: boolean;
  columns?: 1 | 2;
  /** `inline` = «Etiqueta: valor»; `column` = valor en una columna alineada. */
  align?: "inline" | "column";
  /** Puntos guia (solo mono). */
  leader?: boolean;
  /** Parejas por fila en la tabla (2 o 4 columnas). */
  tableCols?: 2 | 4;
  /** Solo el membrete corto («Marlowe Peak»), el nombre completo va en una etiqueta. */
  shortHeader?: boolean;
  page?: string;
};

function headerOps(w: Writer, d: DeclData, o: ContentOpts, st: StyleOpts, title: string, shown: Shown, words: Words): number {
  const fam = st.fam;
  const head = st.shortHeader && o.insurer !== "letterhead" ? d.carrier.short.toUpperCase() : d.carrier.name;
  const size = 15;
  const headText = o.caps || fam === "mono" ? head.toUpperCase() : head;
  const wText = textW(headText, size, fam, true);
  if (st.letterhead === "center") w.text((PAGE_W - wText) / 2, 58, headText, size, fam, true);
  else if (st.letterhead === "right") w.text(RM - wText, 58, headText, size, fam, true);
  else if (st.letterhead === "box") {
    w.shade(LM, 36, RM - LM, 34, 0.9);
    w.text(LM + 10, 58, headText, size, fam, true);
  } else w.text(LM, 58, headText, size, fam, true);
  void shown;
  w.text(LM, 84, title, 12, fam, true);
  let y = 100;
  if (st.topBand) {
    // Telefonos de la aseguradora y del agente junto al encabezado: senuelos que no son del asegurado.
    w.text(LM, 98, words.claims(printPhone(d.claimsDigits, "paren")), 8.5, fam);
    w.text(LM, 110, `${d.agent.agency}   ${printPhone(d.agent.phoneDigits, "dash")}`, 8.5, fam);
    y = 124;
  }
  w.rule(LM, RM, y + 2);
  return y + 22;
}

/** Motor «kv»: etiqueta: valor, bloques con la etiqueta en negrita y las lineas debajo. */
function kvEngine(d: DeclData, o: ContentOpts, st: StyleOpts, items: Item[], title: string, shown: Shown, words: Words): DPage {
  const w = new Writer(Boolean(st.chunk));
  const fam = st.fam;
  const size = st.size ?? 10;
  const lh = size + 4;
  const y0 = headerOps(w, d, o, st, title, shown, words);
  const two = (st.columns ?? 2) === 2;
  const xs = { L: LM, R: two ? 330 : LM };
  const cursor = { L: y0, R: two ? y0 : -1 };
  const valueGap = st.align === "column" ? 150 : 0;
  const colWidth = two ? 240 : RM - LM;
  void colWidth;
  for (const item of items) {
    const col = two ? (item.col ?? "L") : "L";
    let y = two ? cursor[col] : cursor.L;
    const x = xs[col];
    if (item.kind === "kv" && item.label) {
      const label = item.label;
      if (st.leader) {
        const text = `${label}${".".repeat(Math.max(2, 26 - label.length))}: ${item.lines[0]}`;
        w.text(x, y, text, size, fam, false);
      } else if (valueGap > 0 && !two) {
        w.text(x, y, `${label}:`, size, fam, true);
        w.text(x + valueGap, y, item.lines[0], size, fam, false);
      } else {
        w.text(x, y, `${label}: ${item.lines[0]}`, size, fam, false);
      }
      y += lh + 3;
    } else if (item.kind === "block" && item.label) {
      if (valueGap > 0 && !two) {
        w.text(x, y, `${item.label}:`, size, fam, true);
        item.lines.forEach((line, i) => w.text(x + valueGap, y + i * lh, line, size, fam));
        y += item.lines.length * lh + 4;
      } else {
        w.text(x, y, st.leader ? `${item.label}:` : item.label, size, fam, true);
        y += lh;
        for (const line of item.lines) {
          w.text(x + (st.leader ? 0 : 8), y, line, size, fam);
          y += lh;
        }
        y += 4;
      }
    } else if (item.kind === "note") {
      for (const line of item.lines) {
        w.text(x, y, line, size - 1, fam);
        y += lh;
      }
      y += 4;
    } else if (item.kind === "table" && item.rows) {
      for (const [a, b] of item.rows) {
        w.text(x, y, a, size - 1, fam);
        const bw = textW(b, size - 1, fam);
        w.text(Math.min(x + (two ? 230 : 330), RM) - bw, y, b, size - 1, fam);
        y += lh - 1;
      }
      y += 6;
    }
    if (two) cursor[col] = y;
    else cursor.L = y;
  }
  return w.ops;
}

/** Motor «table»: filas con borde (una pareja etiqueta | valor por fila, o dos en cuatro columnas). */
function tableEngine(d: DeclData, o: ContentOpts, st: StyleOpts, items: Item[], title: string, shown: Shown, words: Words): DPage {
  const w = new Writer(Boolean(st.chunk));
  const fam = st.fam;
  const size = st.size ?? 10;
  const lh = size + 3;
  let y = headerOps(w, d, o, st, title, shown, words) - 8;
  const four = st.tableCols === 4;
  const simple = items.filter((item) => item.kind === "kv" || item.kind === "block");
  const rest = items.filter((item) => item.kind === "note" || item.kind === "table");
  const rowH = (lines: number): number => Math.max(1, lines) * lh + 8;
  const draw = (x: number, width: number, label: string, lines: string[], top: number, h: number, labelW: number): void => {
    w.box(x, top, width, h);
    w.shade(x, top, labelW, h, 0.93);
    w.box(x, top, labelW, h);
    w.text(x + 5, top + lh, label, size - 2, fam, true);
    lines.forEach((line, i) => w.text(x + labelW + 6, top + lh + i * lh, line, size, fam));
  };
  if (!four) {
    for (const item of simple) {
      const h = rowH(item.lines.length);
      draw(LM, RM - LM, item.label ?? "", item.lines, y, h, 190);
      y += h;
    }
  } else {
    // Parejas de elementos de una linea lado a lado; los bloques ocupan la fila entera.
    let pending: Item | null = null;
    const flush = (a: Item, b: Item | null): void => {
      const h = rowH(Math.max(a.lines.length, b?.lines.length ?? 1));
      draw(LM, b ? 252 : RM - LM, a.label ?? "", a.lines, y, h, b ? 112 : 190);
      if (b) draw(LM + 252, 252, b.label ?? "", b.lines, y, h, 112);
      y += h;
    };
    for (const item of simple) {
      if (item.kind === "block") {
        if (pending) {
          flush(pending, null);
          pending = null;
        }
        flush(item, null);
      } else if (pending) {
        flush(pending, item);
        pending = null;
      } else pending = item;
    }
    if (pending) flush(pending, null);
  }
  y += 14;
  for (const item of rest) {
    if (item.kind === "note") {
      for (const line of item.lines) {
        w.text(LM, y, line, size - 1, fam);
        y += lh;
      }
      y += 6;
    } else if (item.rows) {
      for (const [a, b] of item.rows) {
        w.box(LM, y - lh + 2, RM - LM, lh + 3);
        w.text(LM + 6, y, a, size - 1, fam);
        w.text(RM - 8 - textW(b, size - 1, fam), y, b, size - 1, fam);
        y += lh + 3;
      }
      y += 10;
    }
  }
  return w.ops;
}

/** Motor «above»: celdas con la etiqueta pequena encima del valor. */
function aboveEngine(d: DeclData, o: ContentOpts, st: StyleOpts, items: Item[], title: string, shown: Shown, words: Words): DPage {
  const w = new Writer(Boolean(st.chunk));
  const fam = st.fam;
  const size = st.size ?? 10.5;
  const lh = size + 3;
  let y = headerOps(w, d, o, st, title, shown, words) - 6;
  const colW = (RM - LM) / 3;
  let col = 0;
  let rowTop = y;
  let rowMax = 0;
  const newRow = (): void => {
    y = rowTop + rowMax;
    rowTop = y;
    rowMax = 0;
    col = 0;
  };
  const place = (span: number, label: string, lines: string[]): void => {
    if (col + span > 3) newRow();
    const x = LM + col * colW;
    const width = span * colW;
    w.box(x, rowTop, width, 16 + lines.length * lh + 6);
    w.text(x + 5, rowTop + 10, label, 7, fam, false, 0.35);
    lines.forEach((line, i) => w.text(x + 5, rowTop + 10 + lh + i * lh, line, size, fam));
    rowMax = Math.max(rowMax, 16 + lines.length * lh + 6);
    col += span;
    if (col >= 3) newRow();
  };
  // Una celda ocupa las columnas que necesita su linea mas larga (un nombre doble no debe invadir la celda vecina).
  const spanFor = (item: Item, wanted: number): number => {
    const widest = Math.max(textW(item.label ?? "", 7, fam), ...item.lines.map((line) => textW(line, size, fam)));
    return Math.min(3, Math.max(wanted, Math.ceil((widest + 14 + 2.5 * size) / colW)));
  };
  for (const item of items) {
    if (item.kind === "kv") place(spanFor(item, item.span ?? 1), item.label ?? "", item.lines);
    else if (item.kind === "block") place(spanFor(item, item.span ?? (item.lines.length > 2 ? 2 : 1)), item.label ?? "", item.lines);
  }
  if (col > 0) newRow();
  y += 14;
  for (const item of items) {
    if (item.kind === "note") {
      item.lines.forEach((line) => {
        w.text(LM, y, line, size - 1.5, fam);
        y += lh;
      });
      y += 6;
    } else if (item.kind === "table" && item.rows) {
      for (const [a, b] of item.rows) {
        w.text(LM + 4, y, a, size - 1.5, fam);
        w.text(LM + 330 - textW(b, size - 1.5, fam), y, b, size - 1.5, fam);
        y += lh;
      }
      y += 8;
    }
  }
  return w.ops;
}

/* ------------------------------------------------------------------ *
 * Paginas de relleno (portada, jacket, continuacion)
 * ------------------------------------------------------------------ */

const JACKET_EN = [
  "SECTION I - PROPERTY COVERAGES. We cover the dwelling on the residence premises shown in the Declarations, including structures attached to the dwelling.",
  "Throughout this policy, you and your refer to the named insured shown in the Declarations and the spouse if a resident of the same household. We, us and our refer to the company providing this insurance.",
  "Coverage A - Dwelling. We cover the dwelling on the residence premises shown in the Declarations, including structures attached to the dwelling, and materials and supplies located on or next to the residence premises used to construct, alter or repair the dwelling.",
  "Coverage C - Personal Property. We cover personal property owned or used by an insured while it is anywhere in the world. At your request we cover personal property owned by others while the property is on the part of the residence premises occupied by an insured.",
  "Perils insured against. We insure against direct physical loss to property described in Coverages A and B, except for losses excluded in Section I - Exclusions. Windstorm or hail is covered subject to the deductible shown in the Declarations.",
  "Duties after loss. In case of a loss to covered property, we have no duty to provide coverage under this policy if the failure to comply with the following duties is prejudicial to us. These duties must be performed either by you, an insured seeking coverage, or a representative of either: give prompt notice to us or our agent; notify the police in case of loss by theft; protect the property from further damage.",
  "Mortgage clause. The word mortgagee includes trustee. If a mortgagee is named in this policy, any loss payable under Coverage A or B will be paid to the mortgagee and you, as interests appear. If more than one mortgagee is named, the order of payment will be the same as the order of precedence of the mortgages.",
  "Concealment or fraud. We provide coverage to no insureds under this policy if, whether before or after a loss, an insured has intentionally concealed or misrepresented any material fact or circumstance. Policy periods run from 12:01 AM standard time on the effective date through 12:01 AM on the expiration date.",
];
const JACKET_ES = [
  "SECCIÓN I - COBERTURAS DE LA PROPIEDAD. Cubrimos la vivienda en la residencia asegurada que aparece en las Declaraciones, incluidas las estructuras adjuntas a la vivienda.",
  "En esta póliza, usted y su se refieren al asegurado nombrado en las Declaraciones y al cónyuge si reside en el mismo hogar. Nosotros y nuestro se refieren a la compañía que provee este seguro.",
  "Cobertura A - Vivienda. Cubrimos la vivienda en la residencia asegurada que aparece en las Declaraciones, incluidas las estructuras adjuntas, y los materiales usados para construir, alterar o reparar la vivienda.",
  "Cobertura C - Bienes personales. Cubrimos los bienes personales de un asegurado en cualquier lugar del mundo. A su solicitud cubrimos bienes de terceros mientras estén en la parte de la residencia ocupada por un asegurado.",
  "Riesgos cubiertos. Aseguramos contra pérdida física directa a los bienes descritos en las Coberturas A y B, salvo las pérdidas excluidas. El viento o el granizo se cubre sujeto al deducible indicado en las Declaraciones.",
  "Obligaciones después de una pérdida. En caso de pérdida a bienes cubiertos, debe dar aviso inmediato a nosotros o a nuestro agente, notificar a la policía en caso de robo y proteger los bienes de daños adicionales.",
  "Cláusula hipotecaria. Si en esta póliza se nombra un acreedor hipotecario, toda pérdida pagadera bajo las Coberturas A o B se pagará al acreedor y a usted, según sus intereses.",
];

function jacketPage(d: DeclData, n: number, total: number, fam: Fam): DPage {
  const w = new Writer(false);
  const lines = d.lang === "es" ? JACKET_ES : JACKET_EN;
  w.text(LM, 52, `${d.carrier.name} - ${d.lang === "es" ? "Condiciones Generales" : "Policy Jacket"}`, 9, fam, true);
  let y = 84;
  // Texto corrido en lineas de ~92 caracteres: densidad de un clausulado real.
  for (let block = 0; block < 5; block += 1) {
    const paragraph = lines[(n * 3 + block) % lines.length];
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      if (textW(`${line} ${word}`, 8.5, fam) > RM - LM) {
        w.text(LM, y, line, 8.5, fam);
        y += 11.5;
        line = word;
      } else line = line === "" ? word : `${line} ${word}`;
    }
    if (line) {
      w.text(LM, y, line, 8.5, fam);
      y += 11.5;
    }
    y += 8;
  }
  while (y < 700) {
    const paragraph = lines[(n + Math.floor(y)) % lines.length];
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (textW(`${line} ${word}`, 8.5, fam) > RM - LM) {
        w.text(LM, y, line, 8.5, fam);
        y += 11.5;
        line = word;
        if (y >= 700) break;
      } else line = line === "" ? word : `${line} ${word}`;
    }
    y += 8;
  }
  w.text(LM, 760, `${d.lang === "es" ? "Página" : "Page"} ${n} ${d.lang === "es" ? "de" : "of"} ${total}   HO 00 03 05 11`, 8, fam);
  return w.ops;
}

function coverLetter(d: DeclData, o: ContentOpts, fam: Fam): DPage {
  const w = new Writer(false);
  const es = d.lang === "es";
  w.text(LM, 60, d.carrier.name, 15, fam, true);
  w.text(LM, 76, `P.O. Box 90${d.policyNo.replace(/\D/g, "").slice(0, 3)}, ${es ? "Servicio al cliente" : "Customer Service"}`, 9, fam);
  w.text(LM, 120, printDate(d.issued, "long", d.lang), 10, fam);
  const names = d.people.map((p) => printName(p, false)).join(es ? " y " : " and ");
  w.text(LM, 170, names, 10, fam);
  addrLines(d.mailing, false).forEach((line, i) => w.text(LM, 184 + i * 13, line, 10, fam));
  w.text(LM, 230, `${es ? "Asunto" : "Re"}: ${es ? "Renovación de su póliza de hogar" : "Your homeowners policy renewal"}`, 10, fam, true);
  w.text(LM, 244, `${es ? "Póliza No." : "Policy No."} ${d.policyNo}`, 10, fam, true);
  const text = es
    ? ["Estimado asegurado:", "Adjuntamos las Declaraciones de su póliza y el clausulado. Revise la información con cuidado.", `Si desea reportar un reclamo, llame al ${printPhone(d.claimsDigits, "one-dash")} o escriba a claims@${d.carrier.domain}.`, "Atentamente,", "Servicio al cliente"]
    : ["Dear policyholder:", "Enclosed are your policy Declarations and policy jacket. Please review the information carefully.", `To report a claim, call ${printPhone(d.claimsDigits, "one-dash")} or write to claims@${d.carrier.domain}.`, "Sincerely,", "Customer Service"];
  text.forEach((line, i) => w.text(LM, 290 + i * 18, line, 10, fam));
  void o;
  return w.ops;
}

/** Hoja de continuacion: coberturas, deducibles, hipotecario y formularios (la segunda hoja de unas declaraciones largas). */
function continuation(d: DeclData, o: ContentOpts, st: StyleOpts, items: Item[], words: Words): DPage {
  const w = new Writer(Boolean(st.chunk));
  const fam = st.fam;
  w.text(LM, 58, d.carrier.name, 13, fam, true);
  w.text(LM, 78, `${d.lang === "es" ? "Declaraciones (continuación)" : "Declarations (continued)"}  -  ${words.policy[0]}: ${d.policyNo}`, 10, fam, true);
  w.rule(LM, RM, 86);
  let y = 110;
  for (const item of items) {
    if (item.kind === "table" && item.rows) {
      for (const [a, b] of item.rows) {
        w.text(LM, y, a, 10, fam);
        w.text(RM - 100 - textW(b, 10, fam), y, b, 10, fam);
        y += 15;
      }
      y += 12;
    } else if (item.kind === "block" && item.label) {
      w.text(LM, y, `${item.label}:`, 10, fam, true);
      y += 14;
      for (const line of item.lines) {
        w.text(LM + 10, y, line, 10, fam);
        y += 13;
      }
      y += 10;
    } else if (item.kind === "kv" && item.label) {
      w.text(LM, y, `${item.label}: ${item.lines[0]}`, 10, fam);
      y += 18;
    }
  }
  void o;
  return w.ops;
}

/* ------------------------------------------------------------------ *
 * Plantillas
 * ------------------------------------------------------------------ */

export type Engine = "kv" | "table" | "above";

export type Template = {
  id: string;
  family: string;
  engine: Engine;
  style: StyleOpts;
  content: Partial<ContentOpts>;
  /** Opciones de datos (cuantos asegurados, etc.). */
  data: { people?: 1 | 2; lang?: DeclLang; mailingKind?: "street" | "unit" | "po"; samePlace?: boolean; mortgagee?: boolean; middle?: boolean; sharedSurname?: boolean; dayMode?: "clear" | "free"; policyStyle?: number; windStyle?: "pct" | "amt" | "both" | "none"; carrierIndex?: number };
  /** Paginas extra: el documento largo. */
  multi?: "cover+dec+jacket" | "dec+continued+jacket" | "dec-late";
  /** Cada hoja se fotografia por separado (varias fotos). */
  splitPhotos?: boolean;
};

export const TEMPLATES: Template[] = [
  /* ---- clasica (kv) ---- */
  { id: "classic-amp-premises", family: "classic", engine: "kv", style: { fam: "serif", letterhead: "center", columns: 2 }, content: { joiner: "amp", premises: "label", v: 0 }, data: { people: 2, sharedSurname: true, middle: true, carrierIndex: 0 } },
  { id: "classic-and-same", family: "classic", engine: "kv", style: { fam: "serif", letterhead: "left", columns: 2 }, content: { joiner: "and", premises: "same", v: 1, dateStyle: "long" }, data: { people: 2, sharedSurname: true, samePlace: true, carrierIndex: 1 } },
  { id: "classic-unit-po", family: "classic", engine: "kv", style: { fam: "sans", letterhead: "box", columns: 2 }, content: { joiner: "lines", premises: "label", v: 2, mortgagee: true }, data: { people: 2, sharedSurname: false, mailingKind: "po", carrierIndex: 2 } },
  { id: "classic-single-nomort", family: "classic", engine: "kv", style: { fam: "serif", letterhead: "right", columns: 2 }, content: { joiner: "amp", premises: "none", mortgagee: false, v: 3 }, data: { people: 1, mortgagee: false, mailingKind: "unit", carrierIndex: 3 } },
  { id: "classic-phone-email", family: "classic", engine: "kv", style: { fam: "sans", letterhead: "left", columns: 2, chunk: true }, content: { joiner: "amp", premises: "label", phone: true, email: true, insured: "separate", v: 0 }, data: { people: 2, middle: true, carrierIndex: 4 } },
  /* ---- tabla ---- */
  { id: "table-basic", family: "table", engine: "table", style: { fam: "sans", letterhead: "left", tableCols: 2 }, content: { insured: "separate", premises: "label", period: "range", v: 0 }, data: { people: 1, carrierIndex: 5 } },
  { id: "table-caps-two", family: "table", engine: "table", style: { fam: "sans", letterhead: "center", tableCols: 4 }, content: { caps: true, insured: "combined", premises: "label", joiner: "amp", period: "effexp", dateStyle: "mdy", v: 1 }, data: { people: 2, carrierIndex: 6 } },
  { id: "table-unit-effexp", family: "table", engine: "table", style: { fam: "serif", letterhead: "box", tableCols: 2 }, content: { insured: "separate", premises: "same", period: "effexp", dateStyle: "mdy-dash", v: 2, joiner: "lines", phone: true }, data: { people: 2, sharedSurname: false, mailingKind: "unit", samePlace: true, carrierIndex: 7 } },
  { id: "table-agent-top", family: "table", engine: "table", style: { fam: "sans", letterhead: "left", tableCols: 2, topBand: true, chunk: true }, content: { insured: "combined", premises: "label", period: "fromto", v: 3, joiner: "and" }, data: { people: 2, sharedSurname: true, carrierIndex: 8 } },
  /* ---- etiqueta encima ---- */
  { id: "above-3col", family: "above", engine: "above", style: { fam: "sans", letterhead: "left" }, content: { insured: "separate", premises: "label", period: "effexp", v: 0 }, data: { people: 1, carrierIndex: 0 } },
  { id: "above-caps-blocks", family: "above", engine: "above", style: { fam: "sans", letterhead: "box" }, content: { caps: true, insured: "combined", premises: "label", period: "effexp", dateStyle: "mdy-dash", v: 1, joiner: "lines" }, data: { people: 2, sharedSurname: false, middle: true, carrierIndex: 1 } },
  { id: "above-phone-email", family: "above", engine: "above", style: { fam: "serif", letterhead: "center" }, content: { insured: "separate", premises: "same", period: "range", phone: true, email: true, v: 2, dateStyle: "long" }, data: { people: 1, samePlace: true, carrierIndex: 2 } },
  { id: "above-mortgagee", family: "above", engine: "above", style: { fam: "sans", letterhead: "right", chunk: true }, content: { insured: "separate", premises: "label", period: "range", mortgagee: true, v: 3, aop: true, wind: true }, data: { people: 2, sharedSurname: true, mailingKind: "unit", mortgagee: true, carrierIndex: 3 } },
  /* ---- ancho fijo (mono) ---- */
  { id: "mono-colons", family: "mono", engine: "kv", style: { fam: "mono", letterhead: "left", columns: 1, size: 9 }, content: { caps: true, insured: "combined", premises: "label", joiner: "amp", dateStyle: "mdy", v: 0, period: "effexp" }, data: { people: 2, carrierIndex: 4 } },
  { id: "mono-dots", family: "mono", engine: "kv", style: { fam: "mono", letterhead: "left", columns: 1, size: 9, leader: true }, content: { caps: true, insured: "separate", premises: "label", joiner: "lines", dateStyle: "dmy-mon", v: 1, period: "effexp" }, data: { people: 2, sharedSurname: false, carrierIndex: 5, middle: true } },
  { id: "mono-twocol", family: "mono", engine: "kv", style: { fam: "mono", letterhead: "center", columns: 2, size: 8.5 }, content: { caps: true, insured: "combined", premises: "same", joiner: "amp", v: 2, dateStyle: "mdy-short", period: "range" }, data: { people: 1, samePlace: true, carrierIndex: 6 } },
  /* ---- columnas con barra lateral ---- */
  { id: "side-agent-claims", family: "side", engine: "kv", style: { fam: "sans", letterhead: "left", columns: 2, topBand: true }, content: { insured: "combined", premises: "label", joiner: "amp", period: "range", v: 0, issued: true, prior: true }, data: { people: 2, sharedSurname: true, carrierIndex: 7 } },
  { id: "side-spaced-policy", family: "side", engine: "kv", style: { fam: "serif", letterhead: "center", columns: 2, align: "inline" }, content: { insured: "separate", premises: "label", joiner: "and", period: "effexp", v: 1 }, data: { people: 2, sharedSurname: true, policyStyle: 5, carrierIndex: 8 } },
  { id: "side-hurricane-pct", family: "side", engine: "kv", style: { fam: "sans", letterhead: "box", columns: 1, align: "column" }, content: { insured: "combined", premises: "label", joiner: "amp", period: "range", v: 3, dateStyle: "long" }, data: { people: 2, sharedSurname: false, windStyle: "both", carrierIndex: 9 } },
  { id: "side-nocarrier-label", family: "side", engine: "kv", style: { fam: "sans", letterhead: "center", columns: 1, align: "column", shortHeader: true }, content: { insured: "separate", premises: "label", joiner: "lines", period: "range", insurer: "label", v: 0 }, data: { people: 2, sharedSurname: false, carrierIndex: 10, middle: true } },
  /* ---- espanol ---- */
  { id: "es-classic", family: "es", engine: "kv", style: { fam: "serif", letterhead: "center", columns: 2 }, content: { insured: "combined", premises: "label", joiner: "amp", period: "range", dateStyle: "dmy", v: 0, phoneStyle: "dash" }, data: { lang: "es", people: 2, sharedSurname: true, carrierIndex: 11 } },
  { id: "es-table", family: "es", engine: "table", style: { fam: "sans", letterhead: "left", tableCols: 2 }, content: { insured: "separate", premises: "label", joiner: "and", period: "effexp", dateStyle: "dmy", v: 1, phone: true }, data: { lang: "es", people: 2, sharedSurname: true, carrierIndex: 12 } },
  { id: "es-caps-mono", family: "es", engine: "kv", style: { fam: "mono", letterhead: "left", columns: 1, size: 9, leader: true }, content: { caps: true, insured: "separate", premises: "same", joiner: "lines", period: "effexp", dateStyle: "dmy", v: 2 }, data: { lang: "es", people: 2, sharedSurname: false, samePlace: true, carrierIndex: 13 } },
  { id: "es-above", family: "es", engine: "above", style: { fam: "sans", letterhead: "right" }, content: { insured: "combined", premises: "label", joiner: "lines", period: "range", dateStyle: "dmy", v: 3 }, data: { lang: "es", people: 2, sharedSurname: false, mailingKind: "unit", mortgagee: true, carrierIndex: 11 } },
  /* ---- documentos largos ---- */
  { id: "long-cover-dec-jacket", family: "long", engine: "kv", style: { fam: "serif", letterhead: "center", columns: 2 }, content: { insured: "combined", premises: "label", joiner: "amp", period: "range", v: 0 }, data: { people: 2, sharedSurname: true, carrierIndex: 1 }, multi: "cover+dec+jacket" },
  { id: "long-dec-continued", family: "long", engine: "above", style: { fam: "sans", letterhead: "left" }, content: { insured: "combined", premises: "label", period: "effexp", mortgagee: true, aop: true, wind: true, coverages: true, v: 1, joiner: "lines" }, data: { people: 2, sharedSurname: false, mortgagee: true, carrierIndex: 2 }, multi: "dec+continued+jacket", splitPhotos: true },
  { id: "long-dec-late", family: "long", engine: "table", style: { fam: "sans", letterhead: "box", tableCols: 2 }, content: { insured: "separate", premises: "same", period: "range", v: 2, joiner: "amp" }, data: { people: 1, samePlace: true, carrierIndex: 3 }, multi: "dec-late" },
  { id: "long-es-cover", family: "long", engine: "kv", style: { fam: "serif", letterhead: "center", columns: 2 }, content: { insured: "combined", premises: "label", joiner: "amp", period: "range", dateStyle: "dmy", v: 2 }, data: { lang: "es", people: 2, sharedSurname: true, carrierIndex: 12 }, multi: "cover+dec+jacket" },
];

/**
 * PLANTILLAS «DE RESERVA» (held-out): redaccion de etiquetas y formatos de fecha que NO se usaron al afinar las reglas (`v >= 4` elige las
 * variantes anadidas al final de cada lista de `WORDS`: «Lienholder», «Policy ID», «Inception Date», «Standard Deductible», fechas con ano de
 * dos cifras…). Miden cuanto generalizan las reglas fuera de las 28 plantillas con las que se desarrollaron. Se piden con `held: true`.
 */
export const HELDOUT_TEMPLATES: Template[] = [
  { id: "held-classic", family: "held", engine: "kv", style: { fam: "serif", letterhead: "center", columns: 2 }, content: { insured: "combined", joiner: "amp", premises: "label", period: "effexp", dateStyle: "mdy-short", v: 4 }, data: { people: 2, sharedSurname: true, middle: true, carrierIndex: 2 } },
  { id: "held-table", family: "held", engine: "table", style: { fam: "sans", letterhead: "left", tableCols: 2 }, content: { insured: "separate", joiner: "and", premises: "label", period: "range", dateStyle: "mdy-dash", v: 4 }, data: { people: 2, sharedSurname: true, carrierIndex: 4 } },
  { id: "held-above", family: "held", engine: "above", style: { fam: "sans", letterhead: "right" }, content: { insured: "combined", joiner: "lines", premises: "label", period: "effexp", dateStyle: "long", v: 4 }, data: { people: 2, sharedSurname: false, mortgagee: true, carrierIndex: 6 } },
  { id: "held-mono", family: "held", engine: "kv", style: { fam: "mono", letterhead: "left", columns: 1, size: 9, leader: true }, content: { caps: true, insured: "separate", joiner: "lines", premises: "label", period: "effexp", dateStyle: "dmy-mon", v: 5 }, data: { people: 2, sharedSurname: false, carrierIndex: 8 } },
  { id: "held-side", family: "held", engine: "kv", style: { fam: "sans", letterhead: "box", columns: 1, align: "column" }, content: { insured: "combined", joiner: "amp", premises: "label", period: "fromto", dateStyle: "mdy", v: 5 }, data: { people: 2, sharedSurname: true, carrierIndex: 1 } },
  { id: "held-es", family: "held", engine: "kv", style: { fam: "serif", letterhead: "center", columns: 2 }, content: { insured: "combined", joiner: "amp", premises: "label", period: "effexp", dateStyle: "dmy", v: 4 }, data: { lang: "es", people: 2, sharedSurname: true, carrierIndex: 11 } },
  { id: "held-es-table", family: "held", engine: "table", style: { fam: "sans", letterhead: "left", tableCols: 2 }, content: { insured: "separate", joiner: "and", premises: "label", period: "effexp", dateStyle: "dmy", v: 5 }, data: { lang: "es", people: 2, sharedSurname: true, carrierIndex: 12 } },
  { id: "held-long", family: "held", engine: "kv", style: { fam: "serif", letterhead: "left", columns: 2 }, content: { insured: "combined", joiner: "amp", premises: "same", period: "range", dateStyle: "mdy", v: 4 }, data: { people: 2, sharedSurname: true, samePlace: true, carrierIndex: 3 }, multi: "cover+dec+jacket" },
];

export type BuiltDoc = {
  pages: DPage[];
  shown: Shown;
  /** Indice (0-based) de las hojas de declaraciones (las demas son portada o clausulado). */
  decPages: number[];
};

/** Datos de apoyo para dibujar (lo decide `declBank.ts` con la semilla). */
export function layoutTemplate(template: Template, d: DeclData, rng: Rng): BuiltDoc {
  const content: ContentOpts = { ...DEFAULT_CONTENT, ...template.content };
  const { items, shown, title, words } = buildItems(d, rng, content);
  const st = template.style;
  // Documento corto: todo en una hoja. En `dec+continued` lo de cobertura/hipotecario va en la hoja 2.
  const splitIds = new Set(["coverages", "deductibles", "mortgagee", "mortgagee-none", "forms", "premium", "issued", "prior"]);
  const onFirst = template.multi === "dec+continued+jacket" ? items.filter((item) => !splitIds.has(item.id)) : items;
  const onSecond = template.multi === "dec+continued+jacket" ? items.filter((item) => splitIds.has(item.id) && item.id !== "issued" && item.id !== "prior") : [];
  const draw = (list: Item[]): DPage => (template.engine === "kv" ? kvEngine(d, content, st, list, title, shown, words) : template.engine === "table" ? tableEngine(d, content, st, list, title, shown, words) : aboveEngine(d, content, st, list, title, shown, words));
  const dec = draw(onFirst);
  const pages: DPage[] = [];
  const decPages: number[] = [];
  const fam = st.fam;
  if (template.multi === "cover+dec+jacket") {
    pages.push(coverLetter(d, content, fam));
    decPages.push(1);
    pages.push(dec);
    const total = 9;
    for (let n = 3; n <= total; n += 1) pages.push(jacketPage(d, n, total, fam));
  } else if (template.multi === "dec+continued+jacket") {
    decPages.push(0, 1);
    pages.push(dec, continuation(d, content, st, onSecond, words));
    for (let n = 3; n <= 8; n += 1) pages.push(jacketPage(d, n, 8, fam));
  } else if (template.multi === "dec-late") {
    pages.push(coverLetter(d, content, fam), jacketPage(d, 2, 11, fam), jacketPage(d, 3, 11, fam));
    decPages.push(3);
    pages.push(dec);
    for (let n = 5; n <= 11; n += 1) pages.push(jacketPage(d, n, 11, fam));
  } else {
    decPages.push(0);
    pages.push(dec);
  }
  return { pages, shown: template.multi === "dec+continued+jacket" ? { ...shown, priorPolicy: false } : shown, decPages };
}

/** Telefono de reclamos normalizado (para la lista de valores que no deben salir). */
export const claimsPhoneNorm = (d: DeclData): string => phoneNorm(d.claimsDigits);
