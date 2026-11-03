/**
 * Reglas de extraccion: de las paginas de texto (con lineas y celdas) a CANDIDATOS de valor. Dos familias:
 *   - con ETIQUETA («Insured: …», «Policy No. …»): el valor esta en la misma celda, en la celda de la derecha o en la linea de
 *     debajo (tablas con la etiqueta encima del valor, o fila de titulos + fila de datos);
 *   - LIBRES, validadas por formato: correo, telefono, fecha narrada («…ocurrio el 20 de febrero de 2026»), bloque de
 *     destinatario de una carta (nombre + calle + ciudad/estado/CP) y membrete de una aseguradora.
 * Precision primero: cada regla descarta lo que no cumple al pie de la letra y deja una BANDERA cuando algo obliga a revisar.
 * Esto NO decide el nivel (`high`/`review`) ni resuelve conflictos: lo hace `resolve.ts`.
 */

import { isContiguous, overlapFraction, NEXT_LINE_GAP_EM, type TextLine, type TextOrigin, type TextPage } from "@/lib/autofill/layout";
import { scanLabels, sliceLine, type LabelHit } from "@/lib/autofill/labels";
import { cleanValue, collapseSpaces, fold, hasFiller, isBlank, stripFiller } from "@/lib/autofill/text";
import { findCsz, looksLikeCszLine, looksLikeStreet, looksLikeUnitLine, parseAddress } from "@/lib/autofill/valueAddress";
import { findDates, formatDateForLocale, inferDateOrder, parseLeadingDate, resolveWithOrder, type DateMatch, type DateOrder } from "@/lib/autofill/valueDate";
import { findInsurerName, parseClaimType, parseDeductible, parseIdValue, parseInsurer, parseMortgagee } from "@/lib/autofill/valueOther";
import { looksLikePersonName, parseNames, type NameParse } from "@/lib/autofill/valueName";
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
  | "unlabeled"
  /** Direccion de la propiedad deducida de la POSTAL (no hay otra): puede no ser la misma. */
  | "from-mailing"
  /** Telefono o correo de una hoja de declaraciones sin nada que diga que es del asegurado (puede ser del agente o de la aseguradora). */
  | "owner-unknown"
  /** Fecha numerica cuyo orden dia/mes se dedujo de una sola fecha clara del documento. */
  | "date-inferred"
  /** Vigencia rara (termina antes de empezar, o dura menos de un mes o mas de tres anos). */
  | "period-odd"
  /** La propiedad se declara «igual que la direccion postal» y su valor se tomo de esta (informativa: no impide `high`). */
  | "same-as-mailing";

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
  /** Zona de la pagina donde se leyo (fracciones 0..1, con la etiqueta); solo se usa con OCR. */
  box?: { x0: number; y0: number; x1: number; y1: number };
  /** Solo la zona del valor (sin la etiqueta). */
  valueBox?: { x0: number; y0: number; x1: number; y1: number };
  /** Menor confianza (0..100) de las palabras del dato leido con OCR. */
  ocrConfidence?: number;
};

export type RuleContext = {
  /** Origen del texto de la pagina que se esta leyendo (el OCR confunde letras: una calle sin sufijo conocido no se da por buena). */
  origin?: TextOrigin;
  sourceIndex: number;
  locale: "es" | "en";
  /** Orden dia/mes de las fechas numericas del documento (de las no ambiguas), si se sabe. */
  dateOrder?: { order: DateOrder; votes: number } | null;
  /** Alguna pagina de la fuente es una hoja de declaraciones: el membrete de la aseguradora es de fiar. */
  declarations?: boolean;
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
  /** Borde izquierdo de la celda de la ETIQUETA (las lineas de debajo pueden alinearse con ella). */
  labelX0: number;
  /** Celda de `line` donde esta el valor. */
  cell: number;
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
function locate(page: TextPage, hitsByLine: readonly LabelHit[][], lineIndex: number, hit: LabelHit, startAt: "inline" | "below" = "inline"): Located | null {
  const line = page.lines[lineIndex];
  const hits = hitsByLine[lineIndex];
  const belowOnly = startAt === "below";

  // 1) En la misma celda.
  const inlineRaw = sliceLine(line, hit.valueStart, hit.valueEnd);
  const inline = cleanValue(inlineRaw);
  if (!belowOnly && inline !== "" && !isBlank(inlineRaw)) {
    // «____ Emergency ____ Non-Emergency ____»: una lista de casillas, no un valor.
    if (hit.kind !== "address" && textSegments(inlineRaw) >= 2) return null;
    return { text: inline, layout: "inline", line, x0: xAt(line, hit.cell, hit.valueStart), labelX0: line.cells[hit.cell].x0, cell: hit.cell, confidence: line.cells[hit.cell].confidence };
  }
  // El campo se dejo en blanco con su raya: el valor NO esta mas abajo.
  if (hasFiller(inlineRaw) && !belowOnly) return null;

  // 2) Celda de la derecha (columna siguiente de una tabla o valor puesto con hueco).
  const nextCell = hit.cell + 1;
  if (!belowOnly && nextCell < line.cells.length) {
    const nextStart = line.starts[nextCell];
    const firstHit = hits.find((h) => h.cell === nextCell);
    if (!(firstHit && firstHit.start === nextStart)) {
      const end = firstHitStartInCell(hits, nextCell) ?? nextStart + line.cells[nextCell].text.length;
      const raw = sliceLine(line, nextStart, end);
      if (hasFiller(raw) && isBlank(raw)) return null;
      const text = cleanValue(raw);
      if (text !== "" && !isBlank(raw)) return { text, layout: "right", line, x0: line.cells[nextCell].x0, labelX0: line.cells[hit.cell].x0, cell: nextCell, confidence: line.cells[nextCell].confidence };
    }
  }

  // 3) Linea de debajo (etiqueta encima del valor, o fila de titulos + fila de datos). En una hoja a dos columnas la linea siguiente
  // puede ser solo de la otra columna: se saltan (hasta 2) las lineas cuyas celdas quedan enteras a un lado de la etiqueta.
  const labelX0 = xAt(line, hit.cell, hit.start);
  const labelX1 = xAt(line, hit.cell, hit.end);
  for (let skip = 0; skip <= 2; skip += 1) {
    const below = page.lines[lineIndex + 1 + skip];
    if (!below || below.y0 < line.y0) return null;
    if (below.y0 - line.y1 > NEXT_LINE_GAP_EM * Math.max(line.size, below.size) * (skip + 1)) return null;
    const belowHits = hitsByLine[lineIndex + 1 + skip];
    let best: { cell: number; distance: number } | null = null;
    for (let c = 0; c < below.cells.length; c += 1) {
      const cell = below.cells[c];
      const distance = Math.abs(cell.x0 - labelX0);
      const aligned = distance <= 3 * line.size || overlapFraction(cell, { x0: labelX0, x1: Math.max(labelX1, labelX0 + 1) }) >= 0.3;
      if (!aligned) continue;
      if (best === null || distance < best.distance) best = { cell: c, distance };
    }
    if (best === null) {
      // Solo se salta una linea que es de OTRA columna (todas sus celdas a un lado de la etiqueta), no una linea cualquiera.
      const otherColumn = below.cells.every((cell) => cell.x0 > labelX1 + 3 * line.size || cell.x1 < labelX0 - 3 * line.size);
      if (!otherColumn) return null;
      continue;
    }
    const chosen = best.cell;
    if (belowHits.find((h) => h.cell === chosen && h.start === below.starts[chosen])) return null;
    const end = firstHitStartInCell(belowHits, chosen) ?? below.starts[chosen] + below.cells[chosen].text.length;
    const raw = sliceLine(below, below.starts[chosen], end);
    if (hasFiller(raw) && isBlank(raw)) return null;
    const text = cleanValue(raw);
    if (text === "" || isBlank(raw)) return null;
    return { text, layout: "below", line: below, x0: below.cells[chosen].x0, labelX0: line.cells[hit.cell].x0, cell: chosen, confidence: below.cells[chosen].confidence };
  }
  return null;
}

/**
 * La siguiente linea que tiene una celda ALINEADA con alguno de los bordes `targets` (el del valor o el de la etiqueta). Una hoja a dos
 * columnas intercala las lineas de las dos: se saltan (hasta 2) las que no tienen celda en esta columna, siempre que el hueco vertical
 * siga siendo el de un bloque (no un parrafo nuevo). Devuelve `null` si la columna termina o la siguiente celda empieza otra etiqueta.
 */
function nextAligned(page: TextPage, hitsByLine: readonly LabelHit[][], previous: TextLine, targets: readonly number[]): { line: TextLine; cell: number } | null {
  for (let skip = 0; skip <= 2; skip += 1) {
    const next = page.lines[previous.index + 1 + skip];
    if (!next || next.y0 < previous.y0) return null;
    if (next.y0 - previous.y1 > NEXT_LINE_GAP_EM * Math.max(previous.size, next.size) * (skip + 1)) return null;
    const tolerance = 4 * previous.size;
    let best = -1;
    let bestDistance = Infinity;
    next.cells.forEach((cell, c) => {
      for (const target of targets) {
        const distance = Math.abs(cell.x0 - target);
        if (distance <= tolerance && distance < bestDistance) {
          best = c;
          bestDistance = distance;
        }
      }
    });
    if (best < 0) continue;
    // La celda empieza otra etiqueta: ahi acaba el bloque.
    if (hitsByLine[next.index].some((h) => h.cell === best && h.start === next.starts[best])) return null;
    return { line: next, cell: best };
  }
  return null;
}

/** Lineas de debajo que continuan una direccion (ciudad/estado/CP o unidad), alineadas con el valor. */
function continuation(page: TextPage, hitsByLine: readonly LabelHit[][], located: Located, limit: number): TextLine[] {
  const out: TextLine[] = [];
  let previous = located.line;
  for (let n = 0; n < limit; n += 1) {
    const found = nextAligned(page, hitsByLine, previous, [located.x0, located.labelX0]);
    if (!found) break;
    const text = found.line.cells[found.cell].text;
    if (!(looksLikeCszLine(text) || looksLikeUnitLine(text))) break;
    out.push(found.line);
    previous = found.line;
    cells.set(found.line, found.cell);
  }
  return out;
}

/** Celda de cada linea de continuacion (para leer su texto sin mirar la otra columna). */
const cells = new WeakMap<TextLine, number>();

type Rect = { x0: number; y0: number; x1: number; y1: number };

const cellRect = (line: TextLine, cell: number): Rect => ({ x0: line.cells[cell].x0, x1: line.cells[cell].x1, y0: line.y0, y1: line.y1 });

/** Zona (fracciones 0..1 de la pagina, con un margen) que cubre varias zonas; `undefined` si la pagina no tiene tamano. */
function pageBox(page: TextPage, rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0 || !(page.width > 0) || !(page.height > 0)) return undefined;
  const pad = 0.006;
  const x0 = Math.min(...rects.map((r) => r.x0)) / page.width - pad;
  const x1 = Math.max(...rects.map((r) => r.x1)) / page.width + pad;
  const y0 = Math.min(...rects.map((r) => r.y0)) / page.height - pad;
  const y1 = Math.max(...rects.map((r) => r.y1)) / page.height + pad;
  const clamp = (v: number): number => Math.max(0, Math.min(1, Math.round(v * 10_000) / 10_000));
  return { x0: clamp(x0), y0: clamp(y0), x1: clamp(x1), y1: clamp(y1) };
}

function snippetOf(parts: string[]): string {
  return collapseSpaces(parts.join(" ").replace(/\t/g, " "));
}

/* ------------------------------------------------------------------ *
 * Reglas por clave (valor ya localizado)
 * ------------------------------------------------------------------ */

type Emission = Omit<Candidate, "sourceIndex" | "pageIndex" | "lineIndex" | "origin" | "order" | "snippet" | "labeled" | "labelText" | "labelWeight" | "layout" | "freeKind">;

const continuationText = (line: TextLine): string => cleanValue(line.cells[cells.get(line) ?? 0].text);

/** «Same as mailing address», «Igual que la dirección postal»: la propiedad es la misma que la direccion postal. */
const SAME_AS = /^(?:same(?:\s+as\s+(?:the\s+)?(?:mailing|above|insured|named\s+insured|policy|home|billing)(?:\s+address)?)?|igual(?:\s+que)?(?:\s+la)?(?:\s+direccion)?(?:\s+postal|\s+de\s+arriba|\s+anterior|\s+del\s+asegurado)?|mismo|misma|idem)\b/;

/** Una fecha de la poliza: ya resuelta con el orden del documento si era ambigua; la que sigue ambigua conserva el texto. */
function dateEmission(date: DateMatch, key: string, ctx: Pick<RuleContext, "locale" | "dateOrder">): Emission {
  const resolved = resolveWithOrder(date, ctx.dateOrder?.order);
  const flags: Flag[] = [];
  if (resolved.ambiguous) flags.push("ambiguous-date");
  else if (date.ambiguous && (ctx.dateOrder?.votes ?? 0) < 2) flags.push("date-inferred");
  return { key, value: resolved.ambiguous ? collapseSpaces(resolved.source) : formatDateForLocale(resolved, ctx.locale), valueStrength: resolved.ambiguous ? 0.7 : 1, flags };
}

const dayNumber = (date: Pick<DateMatch, "year" | "month" | "day">): number => Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;

function emitFromLabel(hit: LabelHit, located: Located, extra: readonly TextLine[], locale: "es" | "en", ctx: Pick<RuleContext, "locale" | "dateOrder" | "origin"> = { locale }): Emission[] {
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
      // «Residence premises: same as mailing address»: se resuelve despues con la direccion postal del mismo documento.
      if (SAME_AS.test(fold(text))) {
        out.push({ key: "address#same", value: "", valueStrength: 1, flags: [] });
        return out;
      }
      const lines = [text, ...extra.map(continuationText)];
      const parsed = parseAddress(lines, true);
      if (!parsed) return out;
      out.push({ key: "address", value: parsed.value, valueStrength: parsed.hasCsz ? 1 : ctx.origin === "ocr" ? 0.8 : 0.92, flags: parsed.looseStreet && ctx.origin === "ocr" ? ["ocr-low"] : [] });
      return out;
    }
    case "mailingAddress": {
      const lines = [text, ...extra.map(continuationText)];
      const parsed = parseAddress(lines, true);
      if (!parsed) return out;
      out.push({ key: "mailingAddress", value: parsed.value, valueStrength: parsed.hasCsz ? 1 : ctx.origin === "ocr" ? 0.8 : 0.92, flags: parsed.looseStreet && ctx.origin === "ocr" ? ["ocr-low"] : [] });
      return out;
    }
    case "policyPeriod": {
      const dates = findDates(text);
      if (dates.length < 2) return out;
      const [first, second] = dates;
      const lead = text.slice(0, first.index).replace(/[\s:;,.\-–—()[\]]/g, "").toLowerCase();
      if (lead !== "" && !/^(?:from|desde|del|de|effective|efectiva|inicio|vigentedesde)$/.test(lead)) return out;
      const start = dateEmission(first, "policyStart", ctx);
      const end = dateEmission(second, "policyEnd", ctx);
      const a = resolveWithOrder(first, ctx.dateOrder?.order);
      const b = resolveWithOrder(second, ctx.dateOrder?.order);
      if (!a.ambiguous && !b.ambiguous) {
        const days = dayNumber(b) - dayNumber(a);
        if (days < 28 || days > 1100) {
          start.flags.push("period-odd");
          end.flags.push("period-odd");
        }
      }
      out.push(start, end);
      return out;
    }
    case "policyStart":
    case "policyEnd": {
      const date = parseLeadingDate(text);
      if (!date) return out;
      out.push(dateEmission(date, hit.kind, ctx));
      return out;
    }
    case "mortgagee": {
      const parsed = parseMortgagee(text);
      if (!parsed) return out;
      out.push({ key: "mortgagee", value: parsed.value, valueStrength: parsed.strength, flags: [] });
      return out;
    }
    case "deductible":
    case "windDeductible": {
      const parsed = parseDeductible(text, hit.kind === "windDeductible");
      if (!parsed) return out;
      out.push({ key: hit.kind, value: parsed.value, valueStrength: parsed.strength, flags: [] });
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
      // Un numero en grupos separados por espacio leido por OCR puede ser un numero partido o con un grupo perdido: se revisa.
      out.push({ key: hit.kind, value: parsed.value, valueStrength: ctx.origin === "ocr" && parsed.value.includes(" ") ? Math.min(parsed.strength, 0.8) : parsed.strength, flags: [] });
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
      out.push(dateEmission(date, "lossDate", ctx));
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
const NOT_INSURER_LINE = /\b(?:adjust|public|claims?|consult|restor|construct|roof|plumb|law|legal|attorney|abogad|ajust|contractor|contratista|mitigation|services?|agency|agent|agente|agencia|producer|productor|broker|corredor|mortgage|lender|bank|hipotec\w*)\b/i;

/** Claves que aparecen en membretes y pies (telefono, correo, direccion de la empresa): el margen las rebaja. */
const LETTERHEAD_KEYS = new Set(["phone", "email", "address", "mailingAddress"]);

/**
 * Una pagina leida por OCR con una confianza media por debajo de esto es una lectura pobre (mala luz, desenfoque, ruido): ninguno de sus valores
 * llega a `high`. Medido: una pagina limpia da 93 o mas; con 90 las fotos en malas condiciones pasan de 93,5 % a 98,8 % de precision en `high` y las
 * normales pierden 1,5 puntos de recall.
 */
export const PAGE_LOW_CONFIDENCE = 90;

function flagsFor(line: TextLine, page: TextPage, origin: TextOrigin, confidence: number | undefined, base: Flag[], key?: string): Flag[] {
  const flags = [...base];
  if (origin === "ocr" && page.ocrMean !== undefined && page.ocrMean < PAGE_LOW_CONFIDENCE && !flags.includes("ocr-low")) flags.push("ocr-low");
  if (isMarginLine(line, page) && !flags.includes("margin") && (key === undefined || LETTERHEAD_KEYS.has(key))) flags.push("margin");
  if (origin === "ocr" && confidence !== undefined && confidence < 75 && !flags.includes("ocr-low")) flags.push("ocr-low");
  return flags;
}

/** Marcas de una hoja de declaraciones de una poliza de hogar (con tres o mas, la hoja lo es). */
const DECLARATION_MARKERS: readonly RegExp[] = [
  /\b(?:declarations?|declaraciones)\b/,
  /\b(?:policy\s+(?:period|term)|term\s+of\s+(?:the\s+)?policy|period\s+of\s+insurance|coverage\s+period|vigencia|periodo\s+de\s+(?:la\s+poliza|seguro))\b/,
  /\b(?:effective|expiration|expiry|expires|inception|vence|vencimiento)\b/,
  /\b(?:mortgagee|mortgage\s+(?:company|holder)|lienholder|loss\s+payee|hipotecari[oa])\b/,
  /\b(?:residence\s+premises|insured\s+(?:location|property)|location\s+of\s+(?:residence|insured)|ubicacion\s+del\s+riesgo|residencia\s+asegurada)\b/,
  /\b(?:coverage|cobertura)\s+[a-f]\b|\b(?:dwelling|other\s+structures|personal\s+property|loss\s+of\s+use|personal\s+liability|medical\s+payments|vivienda|bienes\s+personales|responsabilidad\s+(?:personal|civil))\b/,
  /\b(?:deductible|deducible)\b/,
  /\b(?:named\s+insured|asegurado\s+nombrado)\b/,
  /\b(?:total\s+annual\s+premium|annual\s+premium|prima\s+anual)\b/,
  /\b(?:forms?\s+and\s+endorsements|formularios\s+y\s+endosos)\b/,
];

export function isDeclarationPage(page: TextPage): boolean {
  // Un clausulado (prosa en lineas largas) nombra las coberturas y el deducible sin ser la hoja de declaraciones: esa es de lineas cortas.
  if (page.lines.length >= 8 && page.lines.filter((line) => line.text.length > 70).length / page.lines.length > 0.3) return false;
  const text = fold(page.lines.map((line) => line.text.replace(/\t/g, " ")).join(" \n "));
  // El OCR pierde alguna palabra: en una pagina leida por OCR bastan dos marcas.
  return DECLARATION_MARKERS.filter((marker) => marker.test(text)).length >= (page.origin === "ocr" ? 2 : 3);
}

/** Claves cuya etiqueta nombra datos del asegurado (si cuelgan de otra parte, no son suyos). */
const SENSITIVE_KINDS: ReadonlySet<string> = new Set(["insuredName1", "insuredName2", "insuredBlock", "phone", "email", "address", "mailingAddress"]);

type BlockLine = { line: TextLine; text: string };

/** ¿Es una linea de direccion (calle, apartado postal, unidad o ciudad-estado-CP)? */
function isAddressLine(text: string): boolean {
  return looksLikeStreet(text) !== null || looksLikeCszLine(text) || looksLikeUnitLine(text);
}

/**
 * Lineas contiguas del bloque de un asegurado: la del valor y las de debajo, alineadas con ella (o con la etiqueta), hasta una linea
 * que empiece otra etiqueta o que no sea ni nombre ni direccion.
 */
function readBlock(page: TextPage, hitsByLine: readonly LabelHit[][], located: Located, limit: number): BlockLine[] {
  const out: BlockLine[] = [{ line: located.line, text: located.text }];
  let previous = located.line;
  for (let n = 0; n < limit; n += 1) {
    const found = nextAligned(page, hitsByLine, previous, [located.x0, located.labelX0]);
    if (!found) break;
    const text = cleanValue(found.line.cells[found.cell].text);
    if (text === "") break;
    out.push({ line: found.line, text });
    cells.set(found.line, found.cell);
    previous = found.line;
  }
  return out;
}

type InsuredBlock = { names: Array<{ parsed: NameParse; text: string; line: TextLine }>; address: { value: string; strength: number; lines: BlockLine[]; loose: boolean } | null };

/** Nombres (1 o 2) seguidos de la direccion postal (calle, unidad, ciudad-estado-CP). `null` si la primera linea no es un nombre. */
function parseInsuredBlock(lines: readonly BlockLine[], ocr = false): InsuredBlock | null {
  const names: InsuredBlock["names"] = [];
  let index = 0;
  for (; index < lines.length && names.length < 3; index += 1) {
    const raw = lines[index].text.replace(/^(?:and|&|y)\s+/i, "");
    if (isAddressLine(raw)) break;
    const parsed = parseNames(raw, true);
    if (!parsed) break;
    names.push({ parsed, text: raw, line: lines[index].line });
  }
  if (names.length === 0) return null;
  const rest: BlockLine[] = [];
  for (; index < lines.length && rest.length < 3; index += 1) {
    if (!isAddressLine(lines[index].text)) break;
    rest.push(lines[index]);
  }
  const address = rest.length > 0 ? parseAddress(
    rest.map((entry) => entry.text),
    true,
  ) : null;
  return { names, address: address ? { value: address.value, strength: address.hasCsz ? 1 : ocr ? 0.8 : 0.92, lines: rest, loose: address.looseStreet } : null };
}

/** Candidatos de UNA pagina. */
export function collectPage(page: TextPage, ctx: RuleContext): Candidate[] {
  const out: Candidate[] = [];
  const hitsByLine = page.lines.map((line) => (line.text.length > 600 ? [] : scanLabels(line)));
  const orderBase = page.index * 100_000;
  const push = (candidate: Omit<Candidate, "sourceIndex" | "pageIndex" | "origin" | "order">, line: TextLine): void => {
    const box = page.origin === "ocr" && candidate.box === undefined ? pageBox(page, [{ x0: line.x0, x1: line.x1, y0: line.y0, y1: line.y1 }]) : candidate.box;
    out.push({ ...candidate, sourceIndex: ctx.sourceIndex, pageIndex: page.index, origin: page.origin, order: orderBase + line.index, ...(box ? { box, valueBox: candidate.valueBox ?? box } : {}) });
  };

  /** Rangos de valor ya atendidos por una etiqueta (los patrones libres no los repiten). */
  const claimed: Array<Array<[number, number]>> = page.lines.map(() => []);

  const decPage = isDeclarationPage(page);

  /**
   * Contexto de «de quien son los datos»: `heading` (membrete/encabezado) se corta en un hueco de parrafo; `label` («Adjuster:», «Authorized
   * Party») no. Cada contexto recuerda la columna (`x`) de su etiqueta: en una hoja a dos columnas, el bloque del agente de la columna
   * derecha no se pisa con la etiqueta del asegurado de la izquierda que cae entre medias.
   */
  type PartyState = { who: Party; line: number; via: "heading" | "label"; x?: number };
  const current: { party: PartyState | null } = { party: null };
  const recent: PartyState[] = [];
  const setParty = (next: PartyState | null): void => {
    current.party = next;
    if (next) recent.push(next);
  };
  const partyAt = (lineIndex: number, x?: number): Party | undefined => {
    if (x !== undefined) {
      for (let k = recent.length - 1; k >= 0; k -= 1) {
        const entry = recent[k];
        if (lineIndex - entry.line > PARTY_REACH) break;
        if (entry.x !== undefined && Math.abs(entry.x - x) <= 40) return entry.who;
      }
    }
    return current.party && lineIndex - current.party.line <= PARTY_REACH ? current.party.who : undefined;
  };

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
    if (current.party?.via === "heading" && i > 0 && line.y0 - page.lines[i - 1].y1 > PARTY_GAP_EM * line.size) setParty(null);
    if (isOrgHeading(line, hits)) setParty({ who: "other", line: i, via: "heading" });
    for (const hit of hits) {
      claimed[i].push([hit.start, hit.valueEnd]);
      const labelX = line.cells[hit.cell].x0;
      if (hit.kind === "party") {
        setParty({ who: "other", line: i, via: "label", x: labelX });
        continue;
      }
      if (hit.kind === "stop") continue;
      // El acreedor hipotecario da un valor Y todo lo que cuelga de el (direccion, telefono) es suyo, no del asegurado.
      if (hit.kind === "mortgagee") setParty({ who: "other", line: i, via: "label", x: labelX });
      if (repeated && LETTERHEAD_KEYS.has(hit.kind)) continue;
      const sensitive = SENSITIVE_KINDS.has(hit.kind);
      // La etiqueta lo dice («Adjuster Phone:») o cuelga de un encabezado/etiqueta de otra parte (ajustador, abogado, contratista): no es del asegurado.
      if (sensitive && (hit.party === "other" || (hit.party === undefined && partyAt(i, labelX) === "other"))) continue;
      if (hit.party === "insured") setParty({ who: "insured", line: i, via: "label", x: labelX });

      /** Lee el valor de la etiqueta tal como `located` lo coloca; `true` si leyo algo (o la etiqueta no vale en este sitio). */
      const readAt = (located: Located): boolean => {
        // Telefono, correo o direccion en el membrete o el pie de un PDF son de la empresa, no del asegurado.
        if (page.origin === "text-layer" && LETTERHEAD_KEYS.has(hit.kind) && isMarginLine(located.line, page)) return true;
        // Etiquetas debiles («Name:») no leen debajo: cualquier titulo seria un nombre.
        if (hit.weight < 0.8 && located.layout === "below") return true;

        // En una hoja de declaraciones los telefonos y correos son casi siempre de la aseguradora, del agente o del hipotecario: sin nada que diga que
        // son del asegurado (su etiqueta, o su bloque), NO se proponen (precision primero).
        const foreignContact = (decPage || ctx.declarations === true) && (hit.kind === "phone" || hit.kind === "email") && hit.party !== "insured" && partyAt(i, labelX) !== "insured";
        if (foreignContact) return true;
        const make = (emission: Emission, snippet: string, at: TextLine, layout: Layout, rects?: Rect[], valueRects?: Rect[]): Candidate => {
          const flags = flagsFor(at, page, page.origin, located.confidence, emission.flags, emission.key);
          const box = page.origin === "ocr" ? pageBox(page, rects ?? [cellRect(line, hit.cell), cellRect(located.line, located.cell)]) : undefined;
          const valueBox = page.origin === "ocr" ? pageBox(page, valueRects ?? [cellRect(located.line, located.cell)]) : undefined;
          return {
            ...emission,
            sourceIndex: ctx.sourceIndex,
            pageIndex: page.index,
            lineIndex: i,
            origin: page.origin,
            labeled: true,
            labelText: hit.labelText,
            labelWeight: hit.weight,
            layout,
            flags,
            snippet,
            order: orderBase + i,
            ...(box ? { box } : {}),
            ...(valueBox ? { valueBox } : {}),
            ...(page.origin === "ocr" && located.confidence !== undefined ? { ocrConfidence: Math.round(located.confidence) } : {}),
          };
        };

        // Bloque «Named Insured and Mailing Address»: el nombre (o dos) y la direccion postal debajo. En una hoja de declaraciones, tambien
        // bajo un «Named Insured» a secas.
        if (hit.kind === "insuredBlock" || (hit.kind === "insuredName1" && decPage && hit.weight >= 0.9 && hit.party === "insured")) {
          const block = parseInsuredBlock(readBlock(page, hitsByLine, located, 6), page.origin === "ocr");
          if (block && (hit.kind === "insuredBlock" || block.names.length > 1 || block.address)) {
            const labelLine = line.text.slice(hit.qualStart ?? hit.start);
            const snippet = snippetOf([labelLine, ...block.names.map((n) => n.text), ...(block.address?.lines.map((l) => l.text) ?? [])]);
            let slot = 0;
            for (const entry of block.names) {
              const flags: Flag[] = [];
              if (entry.parsed.shared) flags.push("shared-surname");
              if (entry.parsed.lower) flags.push("lowercase");
              if (entry.parsed.strength < 0.9) flags.push("single-word");
              for (const name of entry.parsed.names) {
                slot += 1;
                if (slot > 2) break;
                out.push(make({ key: slot === 1 ? "insuredName1" : "insuredName2", value: name, valueStrength: entry.parsed.strength, flags: [...flags, ...(block.names.length > 2 ? (["multi-name"] as Flag[]) : [])] }, snippet, entry.line, located.layout, [cellRect(line, hit.cell), cellRect(entry.line, cells.get(entry.line) ?? located.cell)], [cellRect(entry.line, cells.get(entry.line) ?? located.cell)]));
              }
            }
            if (block.address) {
              const candidate = make({ key: "mailingAddress", value: block.address.value, valueStrength: block.address.strength, flags: block.address.loose && page.origin === "ocr" ? ["ocr-low"] : [] }, snippet, block.address.lines[0].line, located.layout, [cellRect(line, hit.cell), ...block.address.lines.map((entry) => cellRect(entry.line, cells.get(entry.line) ?? located.cell))], block.address.lines.map((entry) => cellRect(entry.line, cells.get(entry.line) ?? located.cell)));
              out.push(candidate);
              addressCandidates.push({ candidate, line });
            }
            for (const entry of block.names) claimed[entry.line.index].push([0, entry.line.text.length]);
            for (const entry of block.address?.lines ?? []) claimed[entry.line.index].push([0, entry.line.text.length]);
            return true;
          }
        }

        const extra = hit.kind === "address" || hit.kind === "mailingAddress" ? continuation(page, hitsByLine, located, 2) : [];
        const emissions = emitFromLabel(hit, located, extra, ctx.locale, { ...ctx, origin: page.origin });
        for (const emission of emissions) {
          const labelLineText = line.text.slice(hit.qualStart ?? hit.start, hit.valueEnd);
          const snippet = located.layout === "inline" ? snippetOf([labelLineText]) : snippetOf([line.text.slice(hit.qualStart ?? hit.start), located.line.text, ...extra.map((l) => l.text)]);
          const candidate = make(emission, snippet, located.line, located.layout, [cellRect(line, hit.cell), cellRect(located.line, located.cell), ...extra.map((l) => cellRect(l, cells.get(l) ?? 0))], [cellRect(located.line, located.cell), ...extra.map((l) => cellRect(l, cells.get(l) ?? 0))]);
          if (candidate.key === "address#csz") cszParts.push({ value: candidate.value, line });
          else {
            out.push(candidate);
            if (candidate.key === "address" || candidate.key === "mailingAddress") addressCandidates.push({ candidate, line });
          }
          if (located.layout !== "inline") claimed[located.line.index].push([0, located.line.text.length]);
        }
        return emissions.length > 0;
      };
      // Si la celda de la derecha no era un valor de esta etiqueta (p. ej. otra etiqueta mal leida por el OCR), se prueba con la linea de debajo.
      const first = locate(page, hitsByLine, i, hit);
      if (!first) continue;
      if (!readAt(first) && first.layout === "right") {
        const below = locate(page, hitsByLine, i, hit, "below");
        if (below) readAt(below);
      }
    }
    partyAfter[i] = partyAt(i);
  }

  // La misma etiqueta de nombre en filas contiguas con nombres distintos («Policyholder:» dos veces): la segunda fila es el segundo asegurado.
  const names = out.filter((candidate) => candidate.key === "insuredName1" && candidate.labeled).sort((a, b) => a.lineIndex - b.lineIndex);
  for (let n = 1; n < names.length; n += 1) {
    const previous = names[n - 1];
    const current = names[n];
    const full = (candidate: Candidate): boolean => !candidate.flags.includes("single-word") && candidate.value.includes(" ");
    if (current.lineIndex - previous.lineIndex <= 3 && previous.key === "insuredName1" && full(previous) && full(current) && fold(current.labelText ?? "") === fold(previous.labelText ?? "") && fold(current.value) !== fold(previous.value)) current.key = "insuredName2";
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
  collectFree(page, ctx, hitsByLine, claimed, push, partyAfter, idPage, decPage || ctx.declarations === true);
  collectIdCard(page, push, idPage);
  return out;
}

/**
 * Candidatos de TODAS las paginas de una fuente: membrete y pie repetidos, orden dia/mes de las fechas numericas (de las no ambiguas del
 * documento) y las referencias «igual que la direccion postal» de la propiedad.
 */
export function collectSource(pages: readonly TextPage[], ctx: Omit<RuleContext, "boilerplate" | "dateOrder" | "declarations">): Candidate[] {
  const boilerplate = findBoilerplate(pages);
  const dateOrder = inferDateOrder(pages.flatMap((page) => page.lines.map((line) => line.text.replace(/\t/g, " "))));
  const all: Candidate[] = [];
  const declarations = pages.some(isDeclarationPage);
  for (const page of pages) all.push(...collectPage(page, { ...ctx, boilerplate, dateOrder, declarations }));
  const mailing = all.filter((candidate) => candidate.key === "mailingAddress" && candidate.labeled).sort((a, b) => a.order - b.order);
  const out: Candidate[] = [];
  for (const candidate of all) {
    if (candidate.key !== "address#same") {
      out.push(candidate);
      continue;
    }
    const source = mailing.find((entry) => entry.pageIndex === candidate.pageIndex) ?? mailing[0];
    if (!source) continue;
    const box = candidate.box && source.box ? { x0: Math.min(candidate.box.x0, source.box.x0), y0: Math.min(candidate.box.y0, source.box.y0), x1: Math.max(candidate.box.x1, source.box.x1), y1: Math.max(candidate.box.y1, source.box.y1) } : candidate.box;
    out.push({
      ...candidate,
      key: "address",
      value: source.value,
      valueStrength: Math.min(candidate.valueStrength, source.valueStrength),
      flags: [...candidate.flags.filter((flag) => flag !== "unlabeled"), "same-as-mailing"],
      ...(box ? { box } : {}),
      ...(source.valueBox ? { valueBox: source.valueBox } : {}),
      ...(source.ocrConfidence !== undefined ? { ocrConfidence: Math.min(candidate.ocrConfidence ?? 100, source.ocrConfidence) } : {}),
    });
  }
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
  declarations: boolean,
): void {
  const sizes = page.lines.map((line) => line.size).sort((a, b) => a - b);
  const medianSize = sizes.length > 0 ? sizes[sizes.length >> 1] : 0;
  for (let i = 0; i < page.lines.length; i += 1) {
    const line = page.lines[i];
    if (line.text.length > 600) continue;
    // El membrete repetido es de la empresa (su telefono, correo y direccion no se leen); su NOMBRE si puede ser la aseguradora.
    const repeatedLine = ctx.boilerplate.has(lineKey(line));
    const margin = isMarginLine(line, page);
    const baseFlags: Flag[] = ["unlabeled", ...(margin ? (["margin"] as Flag[]) : [])];
    const confidence = Math.min(...line.cells.map((cell) => cell.confidence ?? 100));
    const lineFlags = (extra: Flag[] = []): Flag[] => flagsFor(line, page, page.origin, Number.isFinite(confidence) ? confidence : undefined, [...baseFlags, ...extra]);
    const other = partyAfter[i] === "other" || hitsByLine[i].some((hit) => hit.kind === "party" || hit.party === "other" || hit.kind === "stop");

    // Correo y telefono sueltos (con formato valido); no en el membrete/pie de un PDF ni junto a una etiqueta de otra parte.
    const letterhead = page.origin === "text-layer" && (line.y1 < page.height * LETTERHEAD_ZONE || line.y0 > page.height * MARGIN_BOTTOM);
    // En un PDF, un correo o telefono sin etiqueta casi siempre es de una empresa: solo se propone junto al nombre de una persona.
    const contactOk = page.origin !== "text-layer" || personNearby(page, i);
    if (!repeatedLine && !margin && !other && !letterhead && contactOk) {
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
    if (!repeatedLine && !margin) {
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
        // En una hoja de declaraciones el nombre grande de arriba ES la aseguradora: se trata como un dato con etiqueta (puede ser `high`).
        const trusted = declarations && insurer.strength >= 1 && (i === 0 || line.size >= 1.2 * medianSize);
        push(
          trusted
            ? { key: "insurer", value: insurer.value, lineIndex: i, labeled: true, labelText: "", labelWeight: 0.95, valueStrength: insurer.strength, layout: "free", freeKind: "letterhead", flags: flagsFor(line, page, page.origin, Number.isFinite(confidence) ? confidence : undefined, [], "insurer"), snippet: snippetOf([line.text]) }
            : { key: "insurer", value: insurer.value, lineIndex: i, labeled: false, labelWeight: 0.68, valueStrength: insurer.strength, layout: "free", freeKind: "letterhead", flags: lineFlags(), snippet: snippetOf([line.text]) },
          line,
        );
      }
    }

    // Bloque de destinatario o de documento de identidad: nombre + calle + ciudad/estado/CP en lineas contiguas.
    if (!repeatedLine && ((!margin && !other) || idPage)) {
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
