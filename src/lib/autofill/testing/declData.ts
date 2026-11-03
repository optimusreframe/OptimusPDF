/**
 * BANCO DE «DECLARATION PAGES» de seguros de hogar (datos): personas, direcciones, aseguradoras FICTICIAS, hipotecarios, agentes
 * y la VERDAD de cada documento. Todo inventado (telefonos 555-01xx, correos @example.com, aseguradoras que no existen) y
 * reproducible: el mismo `makeDeclData(seed, …)` da siempre el mismo caso.
 *
 * Aqui NO se dibuja nada (eso es `declLayouts.ts`): solo se decide QUE hay en el documento y, segun lo que el diseno muestre, QUE
 * debe leer el motor (`buildTruth`). Un diseno que no imprime el telefono del asegurado dice `phone: false` y entonces cualquier
 * telefono que salga (el de reclamos, el del agente…) es un error (`absent`).
 */

import type { Rng } from "@/lib/scan/__fixtures__/rng";
import type { Truth } from "@/lib/autofill/testing/corpus";

export type DeclLang = "en" | "es";

export type Addr = { street: string; unit?: string; city: string; state: string; zip: string };

export type DeclPerson = { first: string; middle?: string; last: string; suffix?: string };

export type Ymd = { y: number; m: number; d: number };

export type Carrier = { name: string; short: string; domain: string; lang: DeclLang; hasSuffix: boolean };

export type DeclData = {
  lang: DeclLang;
  carrier: Carrier;
  people: DeclPerson[];
  mailing: Addr;
  premises: Addr;
  samePlace: boolean;
  /** Telefono del asegurado: 10 cifras. */
  phoneDigits: string;
  email: string;
  policyNo: string;
  priorPolicyNo: string;
  start: Ymd;
  end: Ymd;
  issued: Ymd;
  mortgagee?: { name: string; addr: Addr; loan: string };
  agent: { person: string; agency: string; phoneDigits: string; email: string };
  claimsDigits: string;
  tollFreeDigits: string;
  cov: Record<"A" | "B" | "C" | "D" | "E" | "F", number>;
  aop: number;
  wind: { pct?: number; amt?: number };
  forms: string[];
  premium: number;
  loan: string;
};

/* ------------------------------------------------------------------ *
 * Reservas de datos inventados
 * ------------------------------------------------------------------ */

export const CARRIERS: Carrier[] = [
  { name: "Marlowe Peak Insurance Company", short: "Marlowe Peak", domain: "marlowepeak-example.com", lang: "en", hasSuffix: true },
  { name: "Tidewater Hollow Mutual", short: "Tidewater Hollow", domain: "tidewaterhollow-example.com", lang: "en", hasSuffix: true },
  { name: "Quillon Ridge Casualty Company", short: "Quillon Ridge", domain: "quillonridge-example.com", lang: "en", hasSuffix: true },
  { name: "Verdant Oak Insurance Co.", short: "Verdant Oak", domain: "verdantoak-example.com", lang: "en", hasSuffix: true },
  { name: "Saltmarsh Indemnity Company", short: "Saltmarsh", domain: "saltmarsh-example.com", lang: "en", hasSuffix: true },
  { name: "Ferrowick Home Insurance", short: "Ferrowick", domain: "ferrowick-example.com", lang: "en", hasSuffix: true },
  { name: "Linden Crescent Property & Casualty Insurance Company", short: "Linden Crescent", domain: "lindencrescent-example.com", lang: "en", hasSuffix: true },
  { name: "Auroral Shield Assurance", short: "Auroral Shield", domain: "auroralshield-example.com", lang: "en", hasSuffix: true },
  { name: "Brackenridge Mutual Insurance Company", short: "Brackenridge", domain: "brackenridge-example.com", lang: "en", hasSuffix: true },
  { name: "Copperleaf Home Group", short: "Copperleaf", domain: "copperleaf-example.com", lang: "en", hasSuffix: false },
  { name: "Northwind Hearth", short: "Northwind", domain: "northwindhearth-example.com", lang: "en", hasSuffix: false },
  { name: "Aseguradora Costa Serena", short: "Costa Serena", domain: "costaserena-example.com", lang: "es", hasSuffix: true },
  { name: "Seguros Caribe Norte", short: "Caribe Norte", domain: "caribenorte-example.com", lang: "es", hasSuffix: true },
  { name: "Compañía de Seguros Altamira", short: "Altamira", domain: "altamira-example.com", lang: "es", hasSuffix: true },
];

const FIRSTS = ["John", "Mary", "Carlos", "Linda", "Robert", "Susan", "David", "Karen", "Michael", "Patricia", "Thomas", "Laura", "Daniel", "Emily", "Andrew", "Rachel", "Kevin", "Angela", "Marcus", "Diane", "Victor", "Helen", "Omar", "Janet"];
const FIRSTS_ES = ["María", "José", "Carmen", "Luis", "Ana", "Jorge", "Rosa", "Miguel", "Elena", "Pedro", "Lucía", "Andrés", "Sofía", "Rafael"];
const LASTS = ["Alderton", "Marquez", "Fontaine", "Brightwater", "Okonkwo", "Villanueva", "Pemberton", "Castellano", "Hargrove", "Lindqvist", "Abernathy", "Rosales", "Quintero", "Whitcombe", "Delgado", "Ferreira", "Montalvo", "O'Hara", "Muñoz", "McAllister", "Thornbury", "Salcedo", "Nakamura", "Kowalczyk", "Bellamy", "Ostrander"];
const MIDDLES = ["A", "B", "C", "D", "E", "J", "L", "M", "R", "T"];

const STREETS = ["Seaglass Ln", "NW 14th Ct", "SW 87th Ave", "Bayshore Dr", "Harbor View Blvd", "Palm Hollow Rd", "Sandpiper Way", "Orchid Grove Cir", "Magnolia Bend Ter", "Cypress Landing Pl", "Coral Reef St", "Heron Point Pkwy", "Lakeshore Dr", "Oak Meadow Ln", "Pelican Run"];
const CITIES: Array<[string, string, string]> = [
  ["Miami", "FL", "33166"],
  ["Orlando", "FL", "32839"],
  ["Tampa", "FL", "33602"],
  ["Houston", "TX", "77002"],
  ["Kissimmee", "FL", "34741"],
  ["San Juan", "PR", "00901"],
  ["Austin", "TX", "78701"],
  ["Cape Coral", "FL", "33904"],
  ["Pensacola", "FL", "32503"],
  ["Mobile", "AL", "36602"],
  ["Lake Charles", "LA", "70601"],
  ["New Port Richey", "FL", "34652"],
];
const LENDERS = ["First Coastal Bank", "Harborview Savings Bank", "Tidal Federal Credit Union", "Pinecrest Mortgage Servicing", "Granite Ridge Home Loans", "Sunbelt Community Bank"];
const AGENCIES = ["Sunrise Insurance Agency Inc.", "Keystone Family Insurance Group", "Bayside Insurance Services LLC", "Trusted Hands Insurance Agency", "Meridian Agency Insurance Group"];
const AGENT_PEOPLE = ["Patricia Lindgren", "Gordon Hale", "Yvonne Castellanos", "Raymond Ibarra", "Teresa Whitfield"];
const FORMS = ["HO 00 03 05 11", "HO 04 90 05 11", "HO 04 16 05 11", "HO 04 61 05 11", "IL 00 17 11 98", "HO 03 12 05 11", "FL HO 2301 04 22"];

const pad2 = (n: number): string => String(n).padStart(2, "0");
const digits = (rng: Rng, n: number): string => Array.from({ length: n }, () => rng.int(0, 9)).join("");

function person(rng: Rng, lang: DeclLang, surname?: string, withMiddle = false): DeclPerson {
  const first = rng.pick(lang === "es" ? FIRSTS_ES : FIRSTS);
  const last = surname ?? rng.pick(LASTS);
  return { first, last, ...(withMiddle ? { middle: rng.pick(MIDDLES) } : {}), ...(rng.chance(0.05) ? { suffix: "Jr." } : {}) };
}

function address(rng: Rng, kind: "street" | "unit" | "po" = "street"): Addr {
  const [city, state, zip] = rng.pick(CITIES);
  if (kind === "po") return { street: `P.O. Box ${rng.int(1000, 9999)}`, city, state, zip };
  const number = rng.int(100, 9899);
  const street = `${number} ${rng.pick(STREETS)}`;
  return kind === "unit" ? { street, unit: `${rng.pick(["Apt", "Unit"])} ${rng.int(1, 40)}${rng.pick(["A", "B", "C", ""])}`, city, state, zip } : { street, city, state, zip };
}

function policyNumber(rng: Rng, style: number): string {
  switch (style % 9) {
    case 0:
      return `HO3-${digits(rng, 7)}-${pad2(rng.int(1, 9))}`;
    case 1:
      return `FL-HO-${digits(rng, 7)}`;
    case 2:
      return `${rng.int(10, 99)}-${rng.pick(["AB", "XK", "QR", "HP"])}-${rng.int(1000, 9999)}-${rng.int(1, 9)}`;
    case 3:
      return digits(rng, 10);
    case 4:
      return `H3${digits(rng, 8)}`;
    case 5:
      return `HOP ${digits(rng, 7)} ${pad2(rng.int(0, 9))}`;
    case 6:
      return `HO ${digits(rng, 4)} ${digits(rng, 4)}`;
    case 7:
      return `PH-${rng.pick(["A", "B", "C"])}${digits(rng, 6)}`;
    default:
      return `${rng.pick(["HO", "DP", "HW"])}${digits(rng, 9)}`;
  }
}

function dateIn(rng: Rng, maxDay: number, minDay = 13): Ymd {
  return { y: rng.int(2025, 2026), m: rng.int(1, 12), d: rng.int(minDay, maxDay) };
}

export type DeclOptions = {
  lang?: DeclLang;
  /** Cuantos asegurados (1 o 2). */
  people?: 1 | 2;
  /** Mismo apellido en los dos (matrimonio). */
  sharedSurname?: boolean;
  middle?: boolean;
  /** Direccion postal: calle, con unidad, o apartado postal. */
  mailingKind?: "street" | "unit" | "po";
  /** La propiedad es la misma que la direccion postal. */
  samePlace?: boolean;
  mortgagee?: boolean;
  policyStyle?: number;
  /** Dia > 12 (sin ambiguedad) o libre (puede ser ≤ 12). */
  dayMode?: "clear" | "free";
  windStyle?: "pct" | "amt" | "both" | "none";
  carrierIndex?: number;
};

export function makeDeclData(rng: Rng, options: DeclOptions = {}): DeclData {
  const carrier = CARRIERS[options.carrierIndex ?? 0];
  const lang = options.lang ?? carrier.lang;
  const people: DeclPerson[] = [person(rng, lang, undefined, options.middle)];
  if (options.people === 2) {
    let second = person(rng, lang, options.sharedSurname === false ? undefined : people[0].last, options.middle);
    while (second.first === people[0].first) second = person(rng, lang, options.sharedSurname === false ? undefined : people[0].last, options.middle);
    people.push(second);
  }
  const mailing = address(rng, options.mailingKind ?? "street");
  const samePlace = options.samePlace ?? false;
  const premises = samePlace ? mailing : address(rng, "street");
  const start = dateIn(rng, 28, options.dayMode === "free" ? 1 : 13);
  const end = { y: start.y + 1, m: start.m, d: start.d };
  const issued = dateIn(rng, 28, 13);
  const coverageA = rng.int(18, 90) * 5000;
  const windStyle = options.windStyle ?? rng.pick(["pct", "amt", "both", "none"] as const);
  const windPct = rng.pick([1, 2, 2, 5]);
  const wind = windStyle === "none" ? {} : windStyle === "pct" ? { pct: windPct } : windStyle === "amt" ? { amt: rng.pick([2500, 5000, 7500, 10000]) } : { pct: windPct, amt: Math.round((coverageA * windPct) / 100) };
  const lender = rng.pick(LENDERS);
  const agentPhone = `${rng.pick(["305", "407", "813", "850"])}55501${pad2(rng.int(0, 99))}`;
  return {
    lang,
    carrier,
    people,
    mailing,
    premises,
    samePlace,
    phoneDigits: `${rng.pick(["305", "407", "786", "713", "787", "512"])}55501${pad2(rng.int(0, 99))}`,
    email: `${people[0].first}.${people[0].last}${rng.int(1, 99)}@example.com`.toLowerCase().normalize("NFD").replace(/[^a-z0-9.@]/g, ""),
    policyNo: policyNumber(rng, options.policyStyle ?? rng.int(0, 8)),
    priorPolicyNo: policyNumber(rng, rng.int(0, 4)),
    start,
    end,
    issued,
    mortgagee: options.mortgagee ? { name: lender, addr: address(rng, "po"), loan: digits(rng, 10) } : undefined,
    agent: { person: rng.pick(AGENT_PEOPLE), agency: rng.pick(AGENCIES), phoneDigits: agentPhone, email: `service@${carrier.domain.replace("-example.com", "agency-example.com")}` },
    claimsDigits: `80055501${pad2(rng.int(0, 99))}`,
    tollFreeDigits: `88855501${pad2(rng.int(0, 99))}`,
    cov: { A: coverageA, B: Math.round(coverageA * 0.1), C: Math.round(coverageA * 0.5), D: Math.round(coverageA * 0.2), E: rng.pick([100000, 300000, 500000]), F: rng.pick([1000, 2000, 5000]) },
    aop: rng.pick([500, 1000, 1000, 2500, 2500, 5000]),
    wind,
    forms: [rng.pick(FORMS), rng.pick(FORMS), rng.pick(FORMS)],
    premium: rng.int(1200, 6900) + 0.35,
    loan: digits(rng, 10),
  };
}

/* ------------------------------------------------------------------ *
 * Formatos con que se IMPRIME
 * ------------------------------------------------------------------ */

const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export type DateStyle = "mdy" | "mdy-dash" | "long" | "dmy-mon" | "mdy-short" | "dmy" | "iso";

export function printDate(date: Ymd, style: DateStyle, lang: DeclLang = "en"): string {
  const { y, m, d } = date;
  switch (style) {
    case "mdy":
      return `${pad2(m)}/${pad2(d)}/${y}`;
    case "mdy-dash":
      return `${pad2(m)}-${pad2(d)}-${y}`;
    case "mdy-short":
      return `${pad2(m)}/${pad2(d)}/${String(y).slice(2)}`;
    case "dmy":
      return `${pad2(d)}/${pad2(m)}/${y}`;
    case "iso":
      return `${y}-${pad2(m)}-${pad2(d)}`;
    case "dmy-mon":
      return `${pad2(d)} ${MONTHS_EN[m - 1].slice(0, 3).toUpperCase()} ${y}`;
    default:
      return lang === "es" ? `${d} de ${MONTHS_ES[m - 1]} de ${y}` : `${MONTHS_EN[m - 1]} ${d}, ${y}`;
  }
}

/** Lo que el motor debe devolver para una fecha de vigencia segun el idioma con que se lee. */
export function expectedDate(date: Ymd, locale: DeclLang): string {
  return locale === "es" ? `${pad2(date.d)}/${pad2(date.m)}/${date.y}` : `${pad2(date.m)}/${pad2(date.d)}/${date.y}`;
}

export const money = (value: number): string => `$${value.toLocaleString("en-US")}`;

export const moneyCents = (value: number): string => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type PhoneStyle = "paren" | "dash" | "dot" | "one-dash" | "plus";

export function printPhone(raw: string, style: PhoneStyle): string {
  const [a, b, c] = [raw.slice(0, 3), raw.slice(3, 6), raw.slice(6)];
  switch (style) {
    case "dash":
      return `${a}-${b}-${c}`;
    case "dot":
      return `${a}.${b}.${c}`;
    case "one-dash":
      return `1-${a}-${b}-${c}`;
    case "plus":
      return `+1 ${a} ${b} ${c}`;
    default:
      return `(${a}) ${b}-${c}`;
  }
}

export const phoneNorm = (raw: string): string => `(${raw.slice(0, 3)}) ${raw.slice(3, 6)}-${raw.slice(6)}`;

/** Nombre tal como lo normaliza el motor («John A. Smith Jr.»). */
export function nameNorm(p: DeclPerson): string {
  return [p.first, p.middle ? `${p.middle}.` : "", p.last, p.suffix ?? ""].filter(Boolean).join(" ");
}

/** Nombre tal como se IMPRIME: en mayusculas (sin punto en la inicial, como los sistemas de poliza) o normal. */
export function printName(p: DeclPerson, caps: boolean): string {
  const text = caps ? [p.first, p.middle ?? "", p.last, p.suffix ? p.suffix.replace(".", "") : ""].filter(Boolean).join(" ").toUpperCase() : nameNorm(p);
  return text;
}

export function addrLines(a: Addr, caps: boolean): string[] {
  const street = a.unit ? `${a.street} ${a.unit}` : a.street;
  const lines = [street, `${a.city}, ${a.state} ${a.zip}`];
  return caps ? lines.map((line) => line.toUpperCase().replace(/,/g, "")) : lines;
}

/** Direccion en una sola cadena, como la devuelve el motor (comparada sin comas ni mayusculas). */
export function addrNorm(a: Addr): string {
  const street = a.unit ? `${a.street} ${a.unit}` : a.street;
  return `${street}, ${a.city}, ${a.state} ${a.zip}`;
}

/* ------------------------------------------------------------------ *
 * Verdad
 * ------------------------------------------------------------------ */

/** Lo que el diseno IMPRIMIO (decide la verdad). */
export type Shown = {
  /** Direccion postal impresa (propia o dentro del bloque del asegurado). */
  mailing: boolean;
  /** Direccion de la propiedad: con su etiqueta, «igual que la postal», o no impresa. */
  premises: "label" | "same" | "none";
  phone: boolean;
  email: boolean;
  period: boolean;
  mortgagee: boolean;
  aop: boolean;
  wind: boolean;
  /** Aseguradora legible en el documento (membrete o etiqueta). */
  insurer: boolean;
  /** Fecha/s de vigencia con dia ≤ 12 y formato numerico: ambiguas si nada mas las aclara. */
  priorPolicy: boolean;
};

export type DeclTruth = Truth & {
  /** Claves que no deben salir en NINGUN nivel (la hoja no tiene ese dato). */
  absent: string[];
  /** Nombre del documento (para informes). */
  note?: string;
};

export function buildTruth(d: DeclData, shown: Shown, locale: DeclLang): DeclTruth {
  const high: Record<string, string | string[]> = {};
  const review: Record<string, string | string[]> = {};
  const noHigh: string[] = [];
  const absent: string[] = ["claimNumber", "claimType", "lossDate"];
  const forbidden: string[] = [phoneNorm(d.claimsDigits), phoneNorm(d.agent.phoneDigits), phoneNorm(d.tollFreeDigits), d.agent.person, d.agent.agency, d.agent.email, d.policyNo === d.priorPolicyNo ? "~" : d.priorPolicyNo, d.loan];
  high.insuredName1 = nameNorm(d.people[0]);
  if (d.people[1]) high.insuredName2 = nameNorm(d.people[1]);
  if (shown.mailing) high.mailingAddress = addrNorm(d.mailing);
  else absent.push("mailingAddress");
  if (shown.premises === "label") high.address = addrNorm(d.premises);
  else if (shown.premises === "same") high.address = addrNorm(d.mailing);
  else if (shown.mailing) {
    // Solo hay direccion postal: puede ser la propiedad, pero no se da por hecho (precision primero).
    review.address = addrNorm(d.mailing);
    noHigh.push("address");
  } else absent.push("address");
  if (shown.insurer) high.insurer = d.carrier.name;
  else absent.push("insurer");
  high.policyNumber = d.policyNo;
  if (shown.period) {
    high.policyStart = expectedDate(d.start, locale);
    high.policyEnd = expectedDate(d.end, locale);
  } else absent.push("policyStart", "policyEnd");
  if (shown.phone) high.phone = phoneNorm(d.phoneDigits);
  else absent.push("phone");
  if (shown.email) high.email = d.email;
  else absent.push("email");
  if (shown.mortgagee && d.mortgagee) high.mortgagee = d.mortgagee.name;
  else absent.push("mortgagee");
  if (shown.aop) high.deductible = money(d.aop);
  else absent.push("deductible");
  // «2% ($7,000)» y «2%» son el mismo dato (el OCR suele perder el parentesis): las dos formas valen.
  if (shown.wind) high.windDeductible = d.wind.pct !== undefined && d.wind.amt !== undefined ? [windText(d), `${d.wind.pct}%`] : windText(d);
  else absent.push("windDeductible");
  forbidden.push(...d.forms, d.premium.toFixed(2));
  return { high, review, forbidden: forbidden.filter((value) => value !== "~"), noHigh, absent };
}

/** Deducible de viento tal como lo devuelve el motor: «2%», «$5,000» o «2% ($7,000)». */
export function windText(d: DeclData): string {
  const { pct, amt } = d.wind;
  if (pct !== undefined && amt !== undefined) return `${pct}% (${money(amt)})`;
  if (pct !== undefined) return `${pct}%`;
  return amt !== undefined ? money(amt) : "";
}
