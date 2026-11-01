/**
 * Reglas de extraccion: de las paginas de texto (con lineas y celdas) a CANDIDATOS de valor. Dos familias:
 *   - con ETIQUETA («Insured: …», «Policy No. …»): el valor esta en la misma celda, en la celda de la derecha o en la linea de
 *     debajo (tablas con la etiqueta encima del valor, o fila de titulos + fila de datos);
 *   - LIBRES, validadas por formato: correo, telefono, fecha narrada («…ocurrio el 20 de febrero de 2026»), bloque de
 *     destinatario de una carta (nombre + calle + ciudad/estado/CP) y membrete de una aseguradora.
 * Precision primero: cada regla descarta lo que no cumple al pie de la letra y deja una BANDERA cuando algo obliga a revisar.
 * Esto NO decide el nivel (`high`/`review`) ni resuelve conflictos: lo hace `resolve.ts`.
 */

import { isContiguous, overlapFraction, type TextLine, type TextOrigin, type TextPage } from "@/lib/autofill/layout";
import { scanLabels, sliceLine, type LabelHit } from "@/lib/autofill/labels";
import { cleanValue, collapseSpaces, fold, hasFiller, isBlank, stripFiller } from "@/lib/autofill/text";
import { findCsz, looksLikeCszLine, looksLikeStreet, looksLikeUnitLine, parseAddress } from "@/lib/autofill/valueAddress";
import { findDates, formatDateForLocale, parseLeadingDate } from "@/lib/autofill/valueDate";
import { findInsurerName, parseClaimType, parseIdValue, parseInsurer } from "@/lib/autofill/valueOther";
import { looksLikePersonName, parseNames } from "@/lib/autofill/valueName";
import { findEmails, findPhones } from "@/lib/autofill/valuePhone";

export type Flag =
  | "ambiguous-date"
  | "shared-surname"
  | "single-word"
  | "lowercase"
  | "margin"
  | "ocr-low"
  | "generic-mailbox"
  | "multi-name"
  | "unlabeled";

export type Layout = "inline" | "right" | "below" | "free";

export type Candidate = {
  key: string;
  value: string;
  sourceIndex: number;
  pageIndex: number;
  lineIndex: number;
  origin: TextOrigin;
  /** Vino de una etiqueta (si no, de un patron libre). */
  labeled: boolean;
  labelText?: string;
  /** Peso de la etiqueta (0..1); para las libres, el de la regla. */
  labelWeight: number;
  /** Solidez del formato del valor (0..1). */
  valueStrength: number;
  layout: Layout;
  /** Como se llamo la regla libre (para la razon). */
  freeKind?: "email" | "phone" | "date" | "block" | "letterhead" | "id-card";
  flags: Flag[];
  /** Texto leido que contiene el dato (sin recortar). */
  snippet: string;
  /** Orden de lectura dentro de la fuente (pagina, linea). */
  order: number;
};

export type RuleContext = {
  sourceIndex: number;
  locale: "es" | "en";
  /** Lineas (por pagina) que se repiten como membrete o pie: no se leen. */
  boilerplate: ReadonlySet<string>;
};

/** Margen superior/inferior de la hoja (fraccion del alto): membretes, pies y numeros de pagina. */
const MARGIN_TOP = 0.12;
const MARGIN_BOTTOM = 0.9;
/** Zona alta donde un correo o telefono suelto (sin etiqueta) es casi siempre del membrete. */
const LETTERHEAD_ZONE = 0.16;
/** Lineas que dura el contexto «esto es de otra parte» tras una etiqueta de ajustador, contratista… (y se corta en un hueco de parrafo). */
const PARTY_REACH = 5;
const PARTY_GAP_EM = 2.2;

type Party = "insured" | "other";

export function lineKey(line: TextLine): string {
  return fold(line.text).replace(/\s+/g, " ").replace(/\d+/g, "#").trim();
}

export function isMarginLine(line: TextLine, page: TextPage): boolean {
  // Solo una pagina de PDF con capa de texto tiene margenes con significado (membrete y pie); una foto o un texto pegado, no.
  if (page.origin !== "text-layer" || page.height <= 0) return false;
  return line.y1 < page.height * MARGIN_TOP || line.y0 > page.height * MARGIN_BOTTOM;
}

/** Lineas de margen que se repiten en 2 o mas paginas (membrete/pie): clave normalizada (los numeros no cuentan). */
export function findBoilerplate(pages: readonly TextPage[]): Set<string> {
  const seen = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      if (!isMarginLine(line, page)) continue;
      const key = lineKey(line);
      if (key.length < 4) continue;
      let set = seen.get(key);
      if (!set) seen.set(key, (set = new Set()));
      set.add(page.index);
    }
  }
  const out = new Set<string>();
  for (const [key, set] of seen) if (set.size >= 2) out.add(key);
  return out;
}

/* ------------------------------------------------------------------ *
 * Localizar el valor de una etiqueta
 * ------------------------------------------------------------------ */

type Located = {
  text: string;
  layout: Exclude<Layout, "free">;
  /** Linea y celda donde empieza el valor (para continuar la direccion en las lineas de debajo). */
  line: TextLine;
  x0: number;
  confidence?: number;
};

/** Posicion horizontal aproximada de un tramo de una celda (interpola por caracteres). */
function xAt(line: TextLine, cell: number, index: number): number {
  const c = line.cells[cell];
  const length = Math.max(1, c.text.length);
  const offset = Math.min(length, Math.max(0, index - line.starts[cell]));
  return c.x0 + ((c.x1 - c.x0) * offset) / length;
}

function firstHitStartInCell(hits: readonly LabelHit[], cell: number): number | undefined {
  const hit = hits.find((h) => h.cell === cell);
  return hit ? (hit.qualStart ?? hit.start) : undefined;
}

/** Cuantos tramos de texto separados por rellenos hay («____ A ____ B» = 2). Un valor puesto sobre la raya es un solo tramo. */
function textSegments(raw: string): number {
  return stripFiller(raw, "\u0000").split("\u0000").filter((piece) => piece.replace(/[\s:;,.\-–—]/g, "") !== "").length;
}

/**
 * Valor de una etiqueta: 1) lo que sigue en su celda; 2) la celda de la derecha; 3) la celda alineada de la linea de debajo.
 * Devuelve `null` si el campo esta en blanco (relleno «____» o nada) o si el valor candidato es otra etiqueta.
 */
function locate(page: TextPage, hitsByLine: readonly LabelHit[][], lineIndex: number, hit: LabelHit): Located | null {
  const line = page.lines[lineIndex];
  const hits = hitsByLine[lineIndex];

  // 1) En la misma celda.
  const inlineRaw = sliceLine(line, hit.valueStart, hit.valueEnd);
  const inline = cleanValue(inlineRaw);
  if (inline !== "" && !isBlank(inlineRaw)) {
    // «____ Emergency ____ Non-Emergency ____»: una lista de casillas, no un valor.
    if (hit.kind !== "address" && textSegments(inlineRaw) >= 2) return null;
    return { text: inline, layout: "inline", line, x0: xAt(line, hit.cell, hit.valueStart), confidence: line.cells[hit.cell].confidence };
  }
  // El campo se dejo en blanco con su raya: el valor NO esta mas abajo.
  if (hasFiller(inlineRaw)) return null;

  // 2) Celda de la derecha (columna siguiente de una tabla o valor puesto con hueco).
  const nextCell = hit.cell + 1;
  if (nextCell < line.cells.length) {
    const nextStart = line.starts[nextCell];
    const firstHit = hits.find((h) => h.cell === nextCell);
    if (!(firstHit && firstHit.start === nextStart)) {
      const end = firstHitStartInCell(hits, nextCell) ?? nextStart + line.cells[nextCell].text.length;
      const raw = sliceLine(line, nextStart, end);
      if (hasFiller(raw) && isBlank(raw)) return null;
      const text = cleanValue(raw);
      if (text !== "" && !isBlank(raw)) return { text, layout: "right", line, x0: line.cells[nextCell].x0, confidence: line.cells[nextCell].confidence };
    }
  }

  // 3) Linea de debajo (etiqueta encima del valor, o fila de titulos + fila de datos).
  const below = page.lines[lineIndex + 1];
  if (!isContiguous(line, below)) return null;
  const belowHits = hitsByLine[lineIndex + 1];
  const labelX0 = xAt(line, hit.cell, hit.start);
  const labelX1 = xAt(line, hit.cell, hit.end);
  let best: { cell: number; distance: number } | null = null;
  for (let c = 0; c < below.cells.length; c += 1) {
    const cell = below.cells[c];
    const distance = Math.abs(cell.x0 - labelX0);
    const aligned = distance <= 3 * line.size || overlapFraction(cell, { x0: labelX0, x1: Math.max(labelX1, labelX0 + 1) }) >= 0.3;
    if (!aligned) continue;
    if (best === null || distance < best.distance) best = { cell: c, distance };
  }
  if (best === null) return null;
  const startsWithLabel = belowHits.find((h) => h.cell === best.cell && h.start === below.starts[best.cell]);
  if (startsWithLabel) return null;
  const end = firstHitStartInCell(belowHits, best.cell) ?? below.starts[best.cell] + below.cells[best.cell].text.length;
  const raw = sliceLine(below, below.starts[best.cell], end);
  if (hasFiller(raw) && isBlank(raw)) return null;
  const text = cleanValue(raw);
  if (text === "" || isBlank(raw)) return null;
  return { text, layout: "below", line: below, x0: below.cells[best.cell].x0, confidence: below.cells[best.cell].confidence };
}

/** Lineas de debajo que continuan una direccion (ciudad/estado/CP o unidad), alineadas con el valor. */
function continuation(page: TextPage, hitsByLine: readonly LabelHit[][], located: Located, limit: number): TextLine[] {
  const out: TextLine[] = [];
  let previous = located.line;
  for (let n = 0; n < limit; n += 1) {
    const next = page.lines[previous.index + 1];
    if (!isContiguous(previous, next)) break;
    const first = next.cells[0];
    if (hitsByLine[next.index].some((h) => h.cell === 0 && h.start === 0)) break;
    if (Math.abs(first.x0 - located.x0) > 4 * previous.size && Math.abs(first.x0 - previous.x0) > 4 * previous.size) break;
    if (!(looksLikeCszLine(first.text) || looksLikeUnitLine(first.text))) break;
    out.push(next);
    previous = next;
  }
  return out;
}

function snippetOf(parts: string[]): string {
  return collapseSpaces(parts.join(" ").replace(/\t/g, " "));
}

/* ------------------------------------------------------------------ *
 * Reglas por clave (valor ya localizado)
 * ------------------------------------------------------------------ */

type Emission = Omit<Candidate, "sourceIndex" | "pageIndex" | "lineIndex" | "origin" | "order" | "snippet" | "labeled" | "labelText" | "labelWeight" | "layout" | "freeKind">;

function emitFromLabel(hit: LabelHit, located: Located, extra: readonly TextLine[], locale: "es" | "en"): Emission[] {
  const out: Emission[] = [];
  const text = located.text;
  switch (hit.kind) {
    case "insuredName1":
    case "insuredName2": {
      // «Debajo de» y las etiquetas debiles solo valen con un nombre completo (si no, cualquier titulo seria un nombre).
      const parsed = parseNames(text, hit.kind === "insuredName1");
      if (!parsed) return out;
      if (located.layout === "below" && (parsed.strength < 0.9 || parsed.lower)) return out;
      if (parsed.names.length === 2 && parsed.names.some((name) => name.split(" ").length === 1)) return out;
      const flags: Flag[] = [];
      if (parsed.shared) flags.push("shared-surname");
      if (parsed.lower) flags.push("lowercase");
      if (parsed.strength < 0.9) flags.push("single-word");
      parsed.names.forEach((name, index) => {
        const key = hit.kind === "insuredName2" ? "insuredName2" : index === 0 ? "insuredName1" : "insuredName2";
        out.push({ key, value: name, valueStrength: parsed.strength, flags });
      });
      return out;
    }
    case "phone": {
      const found = findPhones(text, true)[0];
      if (!found || found.index > 4) return out;
      out.push({ key: "phone", value: found.value, valueStrength: found.kind === "local" ? 0.6 : found.kind === "nanp" ? 1 : 0.95, flags: [] });
      return out;
    }
    case "email": {
      const found = findEmails(text)[0];
      if (!found || found.index > 4) return out;
      out.push({ key: "email", value: found.value, valueStrength: 1, flags: found.generic ? ["generic-mailbox"] : [] });
      return out;
    }
    case "address": {
      const lines = [text, ...extra.map((line) => cleanValue(line.cells[0].text))];
      const parsed = parseAddress(lines, true);
      if (!parsed) return out;
      out.push({ key: "address", value: parsed.value, valueStrength: parsed.hasCsz ? 1 : 0.92, flags: [] });
      return out;
    }
    case "csz": {
      const csz = findCsz(text);
      if (!csz) return out;
      out.push({ key: "address#csz", value: collapseSpaces(text), valueStrength: 1, flags: [] });
      return out;
    }
    case "insurer": {
      const parsed = parseInsurer(text, true);
      if (!parsed) return out;
      // Debajo de la etiqueta solo se acepta un nombre que se reconozca (un titulo de seccion no es una aseguradora).
      if (located.layout === "below" && parsed.strength < 0.9) return out;
      out.push({ key: "insurer", value: parsed.value, valueStrength: parsed.strength, flags: [] });
      return out;
    }
    case "policyNumber":
    case "claimNumber": {
      const parsed = parseIdValue(text);
      if (!parsed) return out;
      out.push({ key: hit.kind, value: parsed.value, valueStrength: parsed.strength, flags: [] });
      return out;
    }
    case "claimType": {
      const parsed = parseClaimType(text);
      if (!parsed) return out;
      if (located.layout === "below" && !parsed.perilFound) return out;
      out.push({ key: "claimType", value: parsed.value, valueStrength: parsed.strength, flags: [] });
      return out;
    }
    case "lossDate": {
      const date = parseLeadingDate(text);
      if (!date) return out;
      out.push({
        key: "lossDate",
        value: date.ambiguous ? collapseSpaces(date.source) : formatDateForLocale(date, locale),
        valueStrength: date.ambiguous ? 0.7 : 1,
        flags: date.ambiguous ? ["ambiguous-date"] : [],
      });
      return out;
    }
    default:
      return out;
  }
}

/* ------------------------------------------------------------------ *
 * Pagina completa
 * ------------------------------------------------------------------ */

/** Lineas de un documento de identidad: dos o mas marcas tipicas. */
const ID_MARKERS =
  /\b(?:driver'?s?\s+licen[sc]e|licencia\s+de\s+conducir|identification\s+card|id\s+card|identificacion|dob|date\s+of\s+birth|fecha\s+de\s+nacimiento|hgt|height|eyes|donor|restrictions|endorsements|real\s+id|class|sex|iss|exp|dl)\b/g;

function isIdPage(page: TextPage): boolean {
  const text = fold(page.lines.map((line) => line.text).join(" \n "));
  const found = new Set<string>();
  ID_MARKERS.lastIndex = 0;
  for (let m = ID_MARKERS.exec(text); m !== null; m = ID_MARKERS.exec(text)) found.add(m[0].replace(/\s+/g, " "));
  return found.size >= 3;
}

const NOT_RECIPIENT =
  /\b(?:adjusters?|ajustador(?:a|es|as)?|agent|manager|director|claims?|department|inc|llc|corp|company|insurance|attorneys?|esq|p\.\s?a|pllc|law|legal|group|services?|solutions|ajustador|gerente|departamento|empresa|seguros|abogados?)\b\.?/i;

/** Encabezado de una organizacion (membrete, bufete, contratista): lo que vaya debajo es suyo, no del asegurado. */
const ORG_HEADING =
  /\b(?:adjusters?|llc|inc\.?|corp\.?|corporation|p\.\s?a\.?|pllc|esq\.?|law\s+(?:office|firm|group)|attorneys?|group|solutions|services|restoration|construction|roofing|consulting|associates|ajustador(?:a|es|as)?|abogados?|bufete|constructora|servicios|grupo|s\.\s?a\.?)\b/i;

function isOrgHeading(line: TextLine, hits: readonly LabelHit[]): boolean {
  if (hits.length > 0 || line.text.length > 80 || line.cells.length > 2) return false;
  const digits = line.text.replace(/\D/g, "").length;
  return digits <= 4 && line.text.split(/\s+/).length <= 9 && ORG_HEADING.test(line.text);
}
const NOT_INSURER_LINE = /\b(?:adjust|public|claims?|consult|restor|construct|roof|plumb|law|legal|attorney|abogad|ajust|contractor|contratista|mitigation|services?)\b/i;

/** Claves que aparecen en membretes y pies (telefono, correo, direccion de la empresa): el margen las rebaja. */
const LETTERHEAD_KEYS = new Set(["phone", "email", "address"]);

function flagsFor(line: TextLine, page: TextPage, origin: TextOrigin, confidence: number | undefined, base: Flag[], key?: string): Flag[] {
  const flags = [...base];
  if (isMarginLine(line, page) && !flags.includes("margin") && (key === undefined || LETTERHEAD_KEYS.has(key))) flags.push("margin");
  if (origin === "ocr" && confidence !== undefined && confidence < 75 && !flags.includes("ocr-low")) flags.push("ocr-low");
  return flags;
}

/** Candidatos de UNA pagina. */
export function collectPage(page: TextPage, ctx: RuleContext): Candidate[] {
  const out: Candidate[] = [];
  const hitsByLine = page.lines.map((line) => (line.text.length > 600 ? [] : scanLabels(line)));
  const orderBase = page.index * 100_000;
  const push = (candidate: Omit<Candidate, "sourceIndex" | "pageIndex" | "origin" | "order">, line: TextLine): void => {
    out.push({ ...candidate, sourceIndex: ctx.sourceIndex, pageIndex: page.index, origin: page.origin, order: orderBase + line.index });
  };

  /** Rangos de valor ya atendidos por una etiqueta (los patrones libres no los repiten). */
  const claimed: Array<Array<[number, number]>> = page.lines.map(() => []);

  /** Contexto de «de quien son los datos»: `heading` (membrete/encabezado) se corta en un hueco de parrafo; `label` («Adjuster:», «Authorized Party») no. */
  let party: { who: Party; line: number; via: "heading" | "label" } | null = null;
  const partyAt = (lineIndex: number): Party | undefined => (party && lineIndex - party.line <= PARTY_REACH ? party.who : undefined);

  /** De quien son los datos de cada linea al terminar de leerla (para los patrones libres, que corren despues). */
  const partyAfter: Array<Party | undefined> = [];

  const addressCandidates: Array<{ candidate: Candidate; line: TextLine }> = [];
  const cszParts: Array<{ value: string; line: TextLine }> = [];

  for (let i = 0; i < page.lines.length; i += 1) {
    const line = page.lines[i];
    // Membrete o pie repetido en varias paginas: su telefono, correo y direccion son de la empresa. Un numero de poliza o de reclamo
    // impreso en la cabecera de cada pagina SI es un dato.
    const repeated = ctx.boilerplate.has(lineKey(line));
    const hits = hitsByLine[i];
    if (party?.via === "heading" && i > 0 && line.y0 - page.lines[i - 1].y1 > PARTY_GAP_EM * line.size) party = null;
    if (isOrgHeading(line, hits)) party = { who: "other", line: i, via: "heading" };
    for (const hit of hits) {
      claimed[i].push([hit.start, hit.valueEnd]);
      if (hit.kind === "party") {
        party = { who: "other", line: i, via: "label" };
        continue;
      }
      if (hit.kind === "stop") continue;
      if (repeated && LETTERHEAD_KEYS.has(hit.kind)) continue;
      const sensitive = hit.kind === "insuredName1" || hit.kind === "insuredName2" || hit.kind === "phone" || hit.kind === "email" || hit.kind === "address";
      // La etiqueta lo dice («Adjuster Phone:») o cuelga de un encabezado/etiqueta de otra parte (ajustador, abogado, contratista): no es del asegurado.
      if (sensitive && (hit.party === "other" || (hit.party === undefined && partyAt(i) === "other"))) continue;
      if (hit.party === "insured") party = { who: "insured", line: i, via: "label" };

      const located = locate(page, hitsByLine, i, hit);
      if (!located) continue;
      // Telefono, correo o direccion en el membrete o el pie de un PDF son de la empresa, no del asegurado.
      if (page.origin === "text-layer" && LETTERHEAD_KEYS.has(hit.kind) && isMarginLine(located.line, page)) continue;
      // Etiquetas debiles («Name:») no leen debajo: cualquier titulo seria un nombre.
      if (hit.weight < 0.8 && located.layout === "below") continue;
      const extra = hit.kind === "address" ? continuation(page, hitsByLine, located, 2) : [];
      const emissions = emitFromLabel(hit, located, extra, ctx.locale);
      for (const emission of emissions) {
        const labelLineText = line.text.slice(hit.qualStart ?? hit.start, hit.valueEnd);
        const snippet = located.layout === "inline" ? snippetOf([labelLineText]) : snippetOf([line.text.slice(hit.qualStart ?? hit.start), located.line.text, ...extra.map((l) => l.text)]);
        const candidate: Candidate = {
          ...emission,
          sourceIndex: ctx.sourceIndex,
          pageIndex: page.index,
          lineIndex: i,
          origin: page.origin,
          labeled: true,
          labelText: hit.labelText,
          labelWeight: hit.weight,
          layout: located.layout,
          flags: flagsFor(located.line, page, page.origin, located.confidence, emission.flags, emission.key),
          snippet,
          order: orderBase + i,
        };
        if (candidate.key === "address#csz") cszParts.push({ value: candidate.value, line });
        else {
          out.push(candidate);
          if (candidate.key === "address") addressCandidates.push({ candidate, line });
        }
        if (located.layout !== "inline") claimed[located.line.index].push([0, located.line.text.length]);
      }
    }
    partyAfter[i] = partyAt(i);
  }

  // La misma etiqueta de nombre en filas contiguas con nombres distintos («Policyholder:» dos veces): la segunda fila es el segundo asegurado.
  const names = out.filter((candidate) => candidate.key === "insuredName1" && candidate.labeled).sort((a, b) => a.lineIndex - b.lineIndex);
  for (let n = 1; n < names.length; n += 1) {
    const previous = names[n - 1];
    const current = names[n];
    if (current.lineIndex - previous.lineIndex <= 3 && previous.key === "insuredName1" && fold(current.labelText ?? "") === fold(previous.labelText ?? "") && fold(current.value) !== fold(previous.value)) current.key = "insuredName2";
  }

  // «City, State, Zip» como etiqueta aparte: se une a la direccion de la misma linea o de la anterior que no tenga ciudad.
  for (const part of cszParts) {
    const target = addressCandidates
      .filter(({ candidate, line }) => line.index <= part.line.index && part.line.index - line.index <= 2 && !findCsz(candidate.value))
      .sort((a, b) => b.line.index - a.line.index)[0];
    if (!target) continue;
    const merged = parseAddress([target.candidate.value, part.value], true);
    if (merged) {
      target.candidate.value = merged.value;
      target.candidate.valueStrength = Math.max(target.candidate.valueStrength, merged.hasCsz ? 1 : 0.92);
      target.candidate.snippet = snippetOf([target.candidate.snippet, part.line.text]);
    }
  }

  const idPage = isIdPage(page);
  collectFree(page, ctx, hitsByLine, claimed, push, partyAfter, idPage);
  collectIdCard(page, push, idPage);
  return out;
}

function inClaimed(ranges: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return ranges.some(([from, to]) => start < to && end > from);
}

type Push = (candidate: Omit<Candidate, "sourceIndex" | "pageIndex" | "origin" | "order">, line: TextLine) => void;

/** Palabras de la linea que no son el propio valor: una linea con mucha prosa no es un dato suelto. */
function proseWords(text: string, start: number, end: number): number {
  return `${text.slice(0, start)} ${text.slice(end)}`.split(/\s+/).filter((word) => /\p{L}{2,}/u.test(word)).length;
}

/** El valor va tras una palabra con dos puntos que NO es una etiqueta conocida («Para consultas: …», «Fax: …»): es de esa etiqueta. */
function afterUnknownLabel(text: string, start: number): boolean {
  return /[\p{L}][\p{L}\s.#]{0,28}:\s*$/u.test(text.slice(Math.max(0, start - 36), start));
}

/** ¿Hay el nombre de una persona en esta linea (fuera del propio dato) o en la linea contigua de arriba? */
function personNearby(page: TextPage, index: number): boolean {
  const line = page.lines[index];
  const without = line.cells.map((cell) => cell.text.replace(/\S*@\S*/g, " ").replace(/[\d()+.\-/]{6,}/g, " ")).join(" ");
  if (looksLikePersonName(collapseSpaces(without).replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""))) return true;
  const above = page.lines[index - 1];
  return Boolean(above && isContiguous(above, line) && above.cells.length === 1 && looksLikePersonName(above.cells[0].text));
}

/** Patrones libres: correo, telefono, fecha narrada, bloque de destinatario y membrete. */
function collectFree(
  page: TextPage,
  ctx: RuleContext,
  hitsByLine: readonly LabelHit[][],
  claimed: ReadonlyArray<ReadonlyArray<[number, number]>>,
  push: Push,
  partyAfter: ReadonlyArray<Party | undefined>,
  idPage: boolean,
): void {
  for (let i = 0; i < page.lines.length; i += 1) {
    const line = page.lines[i];
    if (ctx.boilerplate.has(lineKey(line)) || line.text.length > 600) continue;
    const margin = isMarginLine(line, page);
    const baseFlags: Flag[] = ["unlabeled", ...(margin ? (["margin"] as Flag[]) : [])];
    const confidence = Math.min(...line.cells.map((cell) => cell.confidence ?? 100));
    const lineFlags = (extra: Flag[] = []): Flag[] => flagsFor(line, page, page.origin, Number.isFinite(confidence) ? confidence : undefined, [...baseFlags, ...extra]);
    const other = partyAfter[i] === "other" || hitsByLine[i].some((hit) => hit.kind === "party" || hit.party === "other" || hit.kind === "stop");

    // Correo y telefono sueltos (con formato valido); no en el membrete/pie de un PDF ni junto a una etiqueta de otra parte.
    const letterhead = page.origin === "text-layer" && (line.y1 < page.height * LETTERHEAD_ZONE || line.y0 > page.height * MARGIN_BOTTOM);
    // En un PDF, un correo o telefono sin etiqueta casi siempre es de una empresa: solo se propone junto al nombre de una persona.
    const contactOk = page.origin !== "text-layer" || personNearby(page, i);
    if (!margin && !other && !letterhead && contactOk) {
      for (const email of findEmails(line.text)) {
        if (inClaimed(claimed[i], email.index, email.end) || afterUnknownLabel(line.text, email.index) || proseWords(line.text, email.index, email.end) > 3) continue;
        push(
          { key: "email", value: email.value, lineIndex: i, labeled: false, labelWeight: 0.72, valueStrength: 1, layout: "free", freeKind: "email", flags: lineFlags(email.generic ? ["generic-mailbox"] : []), snippet: snippetOf([line.text]) },
          line,
        );
      }
      for (const phone of findPhones(line.text, false)) {
        if (phone.kind === "local" || inClaimed(claimed[i], phone.index, phone.end) || afterUnknownLabel(line.text, phone.index) || proseWords(line.text, phone.index, phone.end) > 3) continue;
        push(
          { key: "phone", value: phone.value, lineIndex: i, labeled: false, labelWeight: 0.72, valueStrength: phone.kind === "nanp" ? 1 : 0.9, layout: "free", freeKind: "phone", flags: lineFlags(), snippet: snippetOf([line.text]) },
          line,
        );
      }
    }

    // Fecha narrada: «…ocurrio el 20 de febrero de 2026», «Date of loss on…». Mira esta linea y la siguiente.
    if (!margin) {
      const next = page.lines[i + 1];
      const text = collapseSpaces(line.text.replace(/\t/g, " ") + (isContiguous(line, next) ? ` ${next.text.replace(/\t/g, " ")}` : ""));
      for (const date of findDates(text)) {
        if (date.index > line.text.replace(/\t/g, " ").length) continue;
        const before = fold(text.slice(Math.max(0, date.index - 90), date.index));
        const after = fold(text.slice(date.end, date.end + 70));
        const cueBefore = /(?:occurred|happened|took place|sustained|date of loss|loss date|ocurrio|sucedio|ocurrido|fecha de (?:la )?(?:perdida|siniestro))\b[^.;]{0,50}(?:\bon|\bel|\ben|\bdate|:)?\s*$/.test(before);
        const cueAfter = /^[^.;]{0,50}\b(?:storm|hurricane|loss|fire|leak|flood|water damage|damage occurred|tormenta|huracan|perdida|incendio|inundacion|siniestro)\b/.test(after) && /(?:\bon|\bel|\bsince|\bdesde)\s*$/.test(before);
        if (!cueBefore && !cueAfter) continue;
        push(
          {
            key: "lossDate",
            value: date.ambiguous ? collapseSpaces(date.source) : formatDateForLocale(date, ctx.locale),
            lineIndex: i,
            labeled: false,
            labelWeight: 0.7,
            valueStrength: date.ambiguous ? 0.7 : 1,
            layout: "free",
            freeKind: "date",
            flags: lineFlags(date.ambiguous ? ["ambiguous-date"] : []),
            snippet: snippetOf([text]),
          },
          line,
        );
      }
    }

    // Membrete de una aseguradora en el primer cuarto de la primera pagina: un nombre conocido o con sufijo de aseguradora.
    if (page.index === 0 && line.y1 < page.height * 0.25 && line.cells.length === 1 && !NOT_INSURER_LINE.test(line.text)) {
      const insurer = findInsurerName(line.cells[0].text);
      if (insurer) {
        push(
          { key: "insurer", value: insurer.value, lineIndex: i, labeled: false, labelWeight: 0.68, valueStrength: insurer.strength, layout: "free", freeKind: "letterhead", flags: lineFlags(), snippet: snippetOf([line.text]) },
          line,
        );
      }
    }

    // Bloque de destinatario o de documento de identidad: nombre + calle + ciudad/estado/CP en lineas contiguas.
    if (!margin || idPage) {
      const first = line.cells[0].text;
      const second = page.lines[i + 1];
      const street = looksLikeStreet(first);
      if (street && street !== "po" && isContiguous(line, second) && looksLikeCszLine(second.cells[0].text) && !hitsByLine[i].some((h) => h.cell === 0 && h.start === 0)) {
        const parsed = parseAddress([first, second.cells[0].text], false);
        const above = page.lines[i - 1];
        const nameLine = above && isContiguous(above, line) ? above.cells[0].text : "";
        const recipient = nameLine !== "" && looksLikePersonName(nameLine) && !NOT_RECIPIENT.test(nameLine) && !NOT_RECIPIENT.test(first);
        if (parsed && (recipient || idPage) && !NOT_RECIPIENT.test(first)) {
          push(
            { key: "address", value: parsed.value, lineIndex: i, labeled: false, labelWeight: 0.74, valueStrength: parsed.strength, layout: "free", freeKind: idPage ? "id-card" : "block", flags: lineFlags(), snippet: snippetOf([nameLine, first, second.text]) },
            line,
          );
          if (recipient && !idPage) {
            const names = parseNames(nameLine, false);
            if (names && names.names.length === 1) {
              push(
                { key: "insuredName1", value: names.names[0], lineIndex: above.index, labeled: false, labelWeight: 0.7, valueStrength: names.strength, layout: "free", freeKind: "block", flags: flagsFor(above, page, page.origin, undefined, ["unlabeled", ...names.shared ? (["shared-surname"] as Flag[]) : []]), snippet: snippetOf([nameLine, first, second.text]) },
                above,
              );
            }
          }
        }
      }
    }
  }
}

/** Documento de identidad (licencia, ID): «LN/Last name» + «FN/First name» y el bloque de domicilio. */
function collectIdCard(page: TextPage, push: Push, idPage: boolean): void {
  if (!idPage) return;
  let last: { text: string; line: TextLine } | null = null;
  let first: { text: string; line: TextLine } | null = null;
  const cellValue = (text: string, labels: RegExp): string | null => {
    const m = labels.exec(collapseSpaces(text));
    return m ? cleanValue(m[1]) : null;
  };
  for (const line of page.lines) {
    for (const cell of line.cells) {
      const lastName = cellValue(cell.text, /^(?:ln|last\s+name|surname|apellidos?|1)\b[\s:.]*([A-Za-zÀ-ÿ' -]{2,40})$/i);
      const firstName = cellValue(cell.text, /^(?:fn|first\s+name|given\s+names?|nombres?|2)\b[\s:.]*([A-Za-zÀ-ÿ' -]{2,40})$/i);
      if (lastName && !last) last = { text: lastName, line };
      if (firstName && !first) first = { text: firstName, line };
    }
  }
  if (last && first) {
    const parsed = parseNames(`${first.text} ${last.text}`, false);
    if (parsed && parsed.names.length === 1) {
      const line = first.line;
      push(
        { key: "insuredName1", value: parsed.names[0], lineIndex: line.index, labeled: true, labelText: "LN/FN", labelWeight: 0.75, valueStrength: parsed.strength, layout: "inline", freeKind: "id-card", flags: flagsFor(line, page, page.origin, undefined, []), snippet: snippetOf([`${first.line.text} ${last.line.text}`]) },
        line,
      );
    }
  }
}
