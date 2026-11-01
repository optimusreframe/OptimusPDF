import type { DetectedField } from "@/lib/pdf/detectFields";
import type { AutoField, AutoMapResult } from "@/lib/pdf/autoMapTypes";
import { signerColorAt, type SignatureField, type Signer } from "@/lib/pdf/sign";
import { applyTemplate, selectVariant, type ApplyWarning, type ReviewField } from "@/lib/docLibrary/templateApply";
import type { DocTemplate, Rect, TemplateRole } from "@/lib/docLibrary/templateTypes";
import type { MatchLevel, MatchResult } from "@/lib/docLibrary/types";
import { captureStamp, sameStamp } from "@/app/sign-pdf/captures";
import { ensureBlocks, docStateOf, liveFields, type DocId, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import type { SignSession } from "@/app/sign-pdf/signSession";

/*
 * Aplicar una plantilla (o lo que propone el automapeo) a UN documento de la sesion de Firmar (Fase 2 · U2.4). Todo PURO:
 * recibe la sesion y devuelve el parche que hay que escribir, el registro de lo aplicado (para «Deshacer» y para
 * re-aplicar al cambiar de 1 a 2 firmantes) y la lista de campos «a revisar» que NO se aplicaron solos.
 *
 * Reglas:
 *  - Un documento "limpio" (`isPristine`) es el unico al que se aplica algo solo: una sesion restaurada, un trabajo ya
 *    empezado o unos campos puestos a mano mandan siempre.
 *  - Los firmantes salen de los ROLES de la plantilla («Asegurado», «Co-asegurado»); si ya hay firmantes se usan los
 *    existentes, por orden. Solo se crean los que faltan.
 *  - Re-aplicar (otro nº de firmantes, otra plantilla) sustituye SOLO lo que se aplico antes (por id) y reutiliza el id
 *    de un campo que queda donde estaba: el trazo recogido para ese firmante sigue valiendo (su sello depende de los
 *    huecos del firmante).
 */

export type FieldKindType = "signature" | "initials" | "text" | "date" | "checkbox";

/** Un campo que NO se aplico solo: la persona lo acepta (o no) desde el panel «Sugerencias» / «Revisar». */
export type PendingField = {
  key: string;
  origin: "automap" | "template";
  kind: "sign" | "text";
  type: FieldKindType;
  /** Firmante (0 = el primero). Solo en campos de firma e iniciales; ausente = «sin firmante claro» (se ofrece para el 1, de una en una). */
  signerIndex?: 0 | 1;
  /** Pagina del DOCUMENTO (0-based); `null` = la plantilla no encontro esa pagina aqui (no se puede aceptar). */
  pageIndex: number | null;
  /** Pagina en la plantilla (solo `origin: "template"`). */
  templatePage?: number;
  rect: Rect;
  label?: string;
  /** Por que se propone o por que no se aplico solo (frase corta del automapeo, o la razon de la plantilla). */
  reason: string;
  dataKey?: string;
  rule?: "today";
  confidence?: number;
};

export type AppliedRecord = {
  source: "template" | "automap";
  template?: { id: string; name: string; version: number; documentId: string | null };
  /** Como se reconocio el documento (solo `source: "template"`). */
  level?: MatchLevel;
  percent?: number;
  count: 1 | 2;
  fieldIds: string[];
  textFieldIds: string[];
  /** Firmantes que creo la aplicacion (al deshacer o bajar el nº de firmantes se retiran, salvo que ya tengan trabajo). */
  createdSignerIds: string[];
  /** Nombre con que se creo cada uno de esos firmantes (el del rol): si ya no coincide, la persona escribio un nombre. */
  createdNames: Record<string, string>;
  /** Nombres de los firmantes que esta aplicacion habria retirado pero SE QUEDAN porque otro documento tiene campos suyos. */
  keptSigners?: string[];
  before: { mode: SignSession["mode"]; signers: Signer[]; activeSignerId: string | null };
  /** Paginas distintas con algun campo aplicado. */
  pages: number;
  /** Paginas (1-based en pantalla, 0-based aqui) que hay que revisar y no se aplicaron solas. */
  reviewPages: number[];
  skippedPages: number[];
  warnings: ApplyWarning[];
  /** `dataKey` / regla de cada campo de texto aplicado (por su id nuevo). */
  textMeta: Record<string, { dataKey?: string; rule?: "today"; required: boolean }>;
  /** Propuestas del automapeo con confianza alta que se colocaron. */
  placed?: number;
  /** Donde quedo cada campo aplicado (por id), para saber despues si la persona lo toco (`appliedFieldsUnchanged`). */
  spots: Record<string, string>;
};

const spotOf = (field: { pageIndex: number; rect: Rect; type?: string; signerId?: string }): string =>
  `${field.pageIndex}|${field.type ?? "text"}|${field.signerId ?? ""}|${field.rect.x.toFixed(6)}|${field.rect.y.toFixed(6)}|${field.rect.width.toFixed(6)}|${field.rect.height.toFixed(6)}`;

function spotsOf(fields: readonly SignatureField[], text: readonly DetectedField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) out[field.id] = spotOf(field);
  for (const field of text) out[field.id] = spotOf(field);
  return out;
}

/**
 * ¿El documento sigue teniendo EXACTAMENTE lo que se aplico (mismos campos, en los mismos sitios) y nada mas? Si es asi,
 * guardar la plantilla desde aqui no cambia nada y se parte de la plantilla guardada (no de los ids nuevos de la sesion).
 */
export function appliedFieldsUnchanged(doc: Pick<DocState, "fields" | "textFields">, record: Pick<AppliedRecord, "spots">): boolean {
  const own = (field: DetectedField) => field.source !== "heuristic-vector" && field.source !== "heuristic-raster";
  const current = spotsOf(doc.fields, doc.textFields.filter(own));
  const keys = Object.keys(record.spots);
  return keys.length === Object.keys(current).length && keys.every((key) => current[key] === record.spots[key]);
}

export type Mint = {
  signerId: () => string;
  fieldId: () => string;
  textFieldId: () => string;
};

/* ------------------------------------------------------------------ *
 * Trabajo que se perderia
 * ------------------------------------------------------------------ */

/** Un firmante que un cambio quitaria y que ya tiene trabajo de la persona (trazos recogidos o un nombre escrito). */
export type LostSigner = { id: string; name: string; strokes: boolean };

/** Lo que un cambio quitaria y NO es solo lo que la plantilla puso: se pide confirmacion antes de hacerlo. */
export type WorkLoss = { signers: LostSigner[]; values: number };

export const NO_LOSS: WorkLoss = { signers: [], values: 0 };

export function hasLoss(loss: WorkLoss): boolean {
  return loss.signers.length > 0 || loss.values > 0;
}

/**
 * ¿Este firmante tiene trabajo de la persona? `strokes`: firma o iniciales recogidas (en cualquier bloque). `typed`: un
 * nombre escrito, distinto del que le dio la plantilla (el del rol) al crearlo; sin ese dato (un firmante que no creo la
 * aplicacion) cualquier nombre cuenta.
 */
export function signerWork(session: Pick<SignSession, "blocks">, signer: Signer, record: Pick<AppliedRecord, "createdNames"> | undefined): { strokes: boolean; typed: boolean } {
  const strokes = session.blocks.some((block) => block.signerId === signer.id && (block.signature !== null || block.initials !== null));
  const name = signer.name.trim();
  const typed = name !== "" && name !== (record?.createdNames?.[signer.id] ?? "").trim();
  return { strokes, typed };
}

/** Valores escritos (no vacios) en campos de texto de `docId` que dejan de existir en `next`. */
function orphanedValues(before: DocState, next: Pick<DocState, "textFields">): number {
  const known = new Set(before.textFields.map((field) => field.id));
  const kept = new Set(next.textFields.map((field) => field.id));
  let count = 0;
  for (const [id, value] of Object.entries(before.textValues)) {
    if (known.has(id) && !kept.has(id) && value.trim() !== "") count += 1;
  }
  return count;
}

/** Lo que perderia la persona si la sesion `session` pasara a tener `nextSigners` y `nextDoc` en `docId`. */
export function lossOf(args: { session: Pick<SignSession, "signers" | "blocks" | "docs">; docId: DocId; nextSigners: readonly Signer[]; nextDoc: Pick<DocState, "textFields">; previous: AppliedRecord | undefined }): WorkLoss {
  const kept = new Set(args.nextSigners.map((signer) => signer.id));
  const signers: LostSigner[] = [];
  for (const signer of args.session.signers) {
    if (kept.has(signer.id)) continue;
    const work = signerWork(args.session, signer, args.previous);
    if (work.strokes || work.typed) signers.push({ id: signer.id, name: signer.name.trim(), strokes: work.strokes });
  }
  return { signers, values: orphanedValues(docStateOf(args.session.docs, args.docId), args.nextDoc) };
}

/* ------------------------------------------------------------------ *
 * Documento limpio
 * ------------------------------------------------------------------ */

/**
 * ¿Se le puede aplicar algo solo? No: ya hay huecos de firma, valores escritos, texto editado, campos de texto puestos a
 * mano (o de una plantilla), ni trazos recogidos para el. Los campos que SOLO detecto la deteccion automatica (AcroForm,
 * sugerencias) no son trabajo de la persona.
 */
export function isPristine(session: Pick<SignSession, "docs" | "blocks" | "signers">, docId: DocId): boolean {
  const doc = docStateOf(session.docs, docId);
  if (liveFields(doc, session.signers).length > 0 || doc.fields.length > 0) return false;
  if (Object.keys(doc.textValues).length > 0) return false;
  if ((doc.textEdits?.length ?? 0) > 0) return false;
  if (doc.textFields.some((field) => field.source === "manual")) return false;
  if (session.blocks.some((block) => block.appliesTo.includes(docId) && (block.signature !== null || block.initials !== null))) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Firmantes
 * ------------------------------------------------------------------ */

export function clampCount(value: number): 1 | 2 {
  return value >= 2 ? 2 : 1;
}

function recolorSigners(signers: Signer[]): Signer[] {
  return signers.map((signer, index) => ({ ...signer, color: signerColorAt(index) }));
}

/**
 * Los firmantes que necesita aplicar `count` firmantes: los que ya hay (por orden) y, si faltan, nuevos con el nombre del
 * rol. `created` son los ids de los nuevos. Con mas firmantes que `count` se dejan todos (los sobrantes no reciben campos).
 */
export function ensureRoleSigners(existing: readonly Signer[], roles: readonly Pick<TemplateRole, "label">[], count: 1 | 2, mint: () => string): { signers: Signer[]; created: string[] } {
  const signers = [...existing];
  const created: string[] = [];
  while (signers.length < count) {
    const role = roles[signers.length];
    const id = mint();
    signers.push({ id, name: role?.label ?? "", color: signerColorAt(signers.length) });
    created.push(id);
  }
  return { signers: recolorSigners(signers), created };
}

/** ¿Los nombres de los firmantes siguen siendo los de los roles de la plantilla? (no hay nombres de personas: no se pregunta el prefijo del archivo) */
export function signerNamesAreRoleDefaults(signers: readonly Signer[], roles: readonly Pick<TemplateRole, "label">[]): boolean {
  return signers.length > 0 && signers.every((signer, index) => signer.name.trim() === (roles[index]?.label ?? "").trim());
}

/* ------------------------------------------------------------------ *
 * Reutilizar ids
 * ------------------------------------------------------------------ */

const EPS = 1e-6;

function sameSpot(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.width - b.width) < EPS && Math.abs(a.height - b.height) < EPS;
}

/** Un campo nuevo que queda donde estaba uno aplicado antes conserva SU id (el trazo del firmante sigue valiendo). */
export function reuseFieldIds(previous: readonly SignatureField[], next: readonly SignatureField[]): SignatureField[] {
  const pool = [...previous];
  return next.map((field) => {
    const index = pool.findIndex((old) => old.signerId === field.signerId && old.pageIndex === field.pageIndex && old.type === field.type && sameSpot(old.rect, field.rect));
    if (index < 0) return field;
    const [old] = pool.splice(index, 1);
    return { ...field, id: old.id };
  });
}

/**
 * Segunda pasada tras `reuseFieldIds`: el hueco nuevo que NO quedo donde estaba ninguno viejo conserva el id de uno viejo
 * del MISMO firmante, pagina y tipo (por orden) que aun no se haya reutilizado. Asi la identidad de un hueco es
 * «firmante + pagina + tipo»: cambiar de variante (o mover un hueco en el editor) cambia su tamano o su sitio, no quien
 * es. `next` es la salida de `reuseFieldIds`.
 */
export function reuseFieldIdsByRole(previous: readonly SignatureField[], next: readonly SignatureField[]): SignatureField[] {
  const claimed = new Set(next.map((field) => field.id));
  const pool = previous.filter((old) => !claimed.has(old.id));
  return next.map((field) => {
    if (previous.some((old) => old.id === field.id)) return field;
    const index = pool.findIndex((old) => old.signerId === field.signerId && old.pageIndex === field.pageIndex && old.type === field.type);
    if (index < 0) return field;
    const [old] = pool.splice(index, 1);
    return { ...field, id: old.id };
  });
}

/** Fraccion del rectangulo menor que cubre la interseccion (1 = uno dentro del otro). */
function overlapRatio(a: DetectedField["rect"], b: DetectedField["rect"]): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a.width * a.height, b.width * b.height);
}

export function reuseTextIds(previous: readonly DetectedField[], next: readonly DetectedField[], mapMeta?: (oldId: string, newId: string) => void): DetectedField[] {
  const pool = [...previous];
  return next.map((field) => {
    const index = pool.findIndex((old) => old.pageIndex === field.pageIndex && (old.type ?? "text") === (field.type ?? "text") && sameSpot(old.rect, field.rect));
    if (index < 0) return field;
    const [old] = pool.splice(index, 1);
    mapMeta?.(old.id, field.id);
    return { ...field, id: old.id };
  });
}

/* ------------------------------------------------------------------ *
 * Plan de aplicacion
 * ------------------------------------------------------------------ */

export type Plan = {
  patch: Partial<SignSession>;
  record: AppliedRecord;
  pending: PendingField[];
  /** Trabajo de la persona que este cambio quitaria (vacio = se puede hacer sin preguntar). */
  loss: WorkLoss;
};

const REVIEW_REASON: Record<ReviewField["reason"], string> = {
  needsReview: "needsReview",
  pageReview: "pageReview",
  noPageMatch: "noPageMatch",
  outOfRange: "outOfRange",
};

function pendingFromReview(review: ReviewField, count: 1 | 2, index: number): PendingField | null {
  if (review.kind === "signature") {
    const role = review.roleIndex ?? 0;
    if (role >= count) return null;
    return {
      key: `tpl-${index}`,
      origin: "template",
      kind: "sign",
      type: review.type as FieldKindType,
      signerIndex: role === 1 ? 1 : 0,
      pageIndex: review.documentPage,
      templatePage: review.templatePage,
      rect: { ...review.rect },
      reason: REVIEW_REASON[review.reason],
    };
  }
  return {
    key: `tpl-${index}`,
    origin: "template",
    kind: "text",
    type: review.type as FieldKindType,
    pageIndex: review.documentPage,
    templatePage: review.templatePage,
    rect: { ...review.rect },
    ...(review.label ? { label: review.label } : {}),
    reason: REVIEW_REASON[review.reason],
  };
}

function distinctPages(fields: readonly SignatureField[], text: readonly DetectedField[]): number {
  return new Set([...fields.map((f) => f.pageIndex), ...text.map((f) => f.pageIndex)]).size;
}

/**
 * Quita de un documento lo que se aplico antes (por id) y las sugerencias heuristicas que la plantilla sustituye.
 * `replace`: ademas se tratan como «de la plantilla» (se reemplazan, reutilizando su id si no cambian) TODOS los huecos de
 * los firmantes de rol y los campos de texto puestos a mano del documento: es lo que pasa al guardar y aplicar desde el
 * editor, que se abrio con esos mismos campos. Los de otros firmantes y los de la deteccion automatica (AcroForm) no se tocan.
 */
function withoutApplied(doc: DocState, previous: AppliedRecord | undefined, replace?: { signerIds: ReadonlySet<string> }): { fields: SignatureField[]; textFields: DetectedField[]; previousFields: SignatureField[]; previousText: DetectedField[] } {
  const fieldIds = new Set(previous?.fieldIds ?? []);
  const textIds = new Set(previous?.textFieldIds ?? []);
  if (replace) {
    for (const field of doc.fields) if (replace.signerIds.has(field.signerId)) fieldIds.add(field.id);
    for (const field of doc.textFields) if (field.source === "manual") textIds.add(field.id);
  }
  return {
    fields: doc.fields.filter((field) => !fieldIds.has(field.id)),
    textFields: doc.textFields.filter((field) => !textIds.has(field.id)),
    previousFields: doc.fields.filter((field) => fieldIds.has(field.id)),
    previousText: doc.textFields.filter((field) => textIds.has(field.id)),
  };
}

/** Otro documento de la sesion tiene campos de este firmante: no se puede retirar. */
function signerUsedElsewhere(session: Pick<SignSession, "docs">, docId: DocId, signerId: string): boolean {
  return Object.entries(session.docs).some(([id, state]) => id !== docId && state.fields.some((field) => field.signerId === signerId));
}

/**
 * Los firmantes que quedan tras aplicar para `count`: bajar el nº de firmantes retira los que creo la aplicacion anterior
 * (los que puso la persona se quedan), SALVO los que otro documento usa (campos suyos): esos se quedan y se anuncian.
 */
function retainSigners(session: Pick<SignSession, "docs">, docId: DocId, signers: readonly Signer[], count: 1 | 2, previous: AppliedRecord | undefined): { signers: Signer[]; kept: string[] } {
  const kept: string[] = [];
  const out = signers.filter((signer, index) => {
    if (index < count || !previous?.createdSignerIds.includes(signer.id)) return true;
    if (!signerUsedElsewhere(session, docId, signer.id)) return false;
    kept.push(signer.name.trim());
    return true;
  });
  return { signers: out, kept };
}

/**
 * Las firmas ya recogidas del firmante que SE QUEDA siguen valiendo cuando cambian sus huecos (otra variante, otro nº de
 * firmantes). Desde que el sello (`captureStamp`) lleva solo la huella del documento, cambiar los huecos ya no lo invalida;
 * esta funcion queda para normalizar los sellos antiguos (`huella~hueco~hueco…`, de borradores previos) a la forma nueva, SOLO
 * en los bloques cuyo sello de `docId` valia ANTES del cambio (con la huella con que se hizo): una firma que ya habia caducado
 * (otro archivo, texto editado) no se revalida, y los sellos de los demas documentos del bloque no se tocan.
 */
export function restampKeptSigners(args: { before: Pick<SignSession, "signers" | "docs">; docId: DocId; nextSigners: readonly Signer[]; nextDoc: Pick<DocState, "fields">; blocks: readonly SignerBlock[] }): SignerBlock[] {
  const { before, docId, nextSigners, nextDoc } = args;
  const kept = new Set(nextSigners.map((signer) => signer.id));
  const oldFields = liveFields(docStateOf(before.docs, docId), before.signers);
  const newFields = liveFields(nextDoc, nextSigners);
  return args.blocks.map((block) => {
    const stored = block.stamps[docId];
    if (!kept.has(block.signerId) || !stored || (!block.signature && !block.initials) || !block.appliesTo.includes(docId)) return block;
    const key = stored.split("~")[0];
    if (!sameStamp(stored, captureStamp(key, oldFields, block.signerId))) return block;
    const renewed = captureStamp(key, newFields, block.signerId);
    return renewed === stored ? block : { ...block, stamps: { ...block.stamps, [docId]: renewed } };
  });
}

function isHeuristic(field: DetectedField): boolean {
  return field.source === "heuristic-vector" || field.source === "heuristic-raster";
}

/** Los firmantes que creo la aplicacion (y siguen en la lista) con el nombre con que nacieron. */
function createdBook(previous: AppliedRecord | undefined, signers: readonly Signer[], created: readonly string[]): Pick<AppliedRecord, "createdSignerIds" | "createdNames"> {
  const createdSignerIds = [...new Set([...(previous?.createdSignerIds ?? []).filter((id) => signers.some((s) => s.id === id)), ...created])];
  const createdNames: Record<string, string> = {};
  for (const id of createdSignerIds) {
    const fresh = created.includes(id) ? signers.find((signer) => signer.id === id)?.name : undefined;
    createdNames[id] = fresh ?? previous?.createdNames?.[id] ?? "";
  }
  return { createdSignerIds, createdNames };
}

export type TemplatePlanInput = {
  template: DocTemplate;
  /** `null` = mismo documento (mismos bytes): mapa identidad. */
  match: Pick<MatchResult, "mappedPages" | "reviewPages" | "level" | "percent"> | null;
  count: 1 | 2;
  session: SignSession;
  docId: DocId;
  pageCount: number;
  mint: Mint;
  /** Lo aplicado antes a este documento (re-aplicar lo sustituye). */
  previous?: AppliedRecord;
  documentId?: string | null;
  /**
   * La plantilla sale de este mismo documento (el editor se abrio con sus campos): todos sus huecos y campos de texto a
   * mano se reconocen como «de la plantilla» y se reemplazan (mismo id si no cambian) en vez de duplicarse. Sin esto, un
   * documento sin registro del aviso (p. ej. un borrador restaurado) recibiria los campos otra vez.
   */
  replaceDocument?: boolean;
};

export function planTemplateApplication(input: TemplatePlanInput): Plan {
  const { template, count, session, docId, mint } = input;
  const doc = docStateOf(session.docs, docId);
  const grown = ensureRoleSigners(session.signers, template.roles, count, mint.signerId);
  // Bajar el nº de firmantes retira los que creo la aplicacion anterior (los que puso la persona se quedan, y los que usa otro documento tambien).
  const { signers, kept } = retainSigners(session, docId, grown.signers, count, input.previous);
  const created = grown.created;
  const roleSigners = signers.slice(0, count);

  const result = applyTemplate(template, {
    signers: count,
    ...(input.match ? { pageMapping: input.match.mappedPages, reviewPages: input.match.reviewPages } : {}),
    pageCount: input.pageCount,
    roles: roleSigners.map((signer) => ({ signerId: signer.id })),
    mintFieldId: mint.fieldId,
    mintTextFieldId: mint.textFieldId,
  });

  const rest = withoutApplied(doc, input.previous, input.replaceDocument ? { signerIds: new Set(roleSigners.map((signer) => signer.id)) } : undefined);
  const fields = reuseFieldIdsByRole(rest.previousFields, reuseFieldIds(rest.previousFields, result.fields));
  const textMeta: AppliedRecord["textMeta"] = {};
  const reusedAs = new Map<string, string>();
  // Un campo de la plantilla que cae sobre un AcroForm del propio PDF no se anade otra vez: el AcroForm adopta su dato.
  const adopted = new Map<string, string>();
  const placeable = result.textFields.filter((field) => {
    const acro = rest.textFields.find((existing) => existing.source === "acroform" && existing.pageIndex === field.pageIndex && (existing.type ?? "text") === (field.type ?? "text") && overlapRatio(existing.rect, field.rect) > 0.5);
    if (!acro) return true;
    adopted.set(field.id, acro.id);
    return false;
  });
  const textFields = reuseTextIds(rest.previousText, placeable, (oldId, newId) => reusedAs.set(newId, oldId));
  for (const original of result.textFields) {
    const fresh = result.textMeta[original.id];
    if (!fresh) continue;
    textMeta[adopted.get(original.id) ?? reusedAs.get(original.id) ?? original.id] = { required: fresh.required, ...(fresh.dataKey ? { dataKey: fresh.dataKey } : {}), ...(fresh.rule ? { rule: fresh.rule } : {}) };
  }
  // Una plantilla con campos de texto sustituye las sugerencias heuristicas (iguales a los campos de la plantilla, que ya estan puestos).
  const keptText = textFields.length > 0 ? rest.textFields.filter((field) => !isHeuristic(field)) : rest.textFields;
  const nextDoc: DocState = {
    ...doc,
    fields: [...rest.fields, ...fields],
    textFields: [...keptText, ...textFields],
  };
  const docs = { ...session.docs, [docId]: nextDoc };
  const docOrder = session.docOrder.length > 0 ? session.docOrder : [docId];
  const pending = result.reviewFields.map((review, index) => pendingFromReview(review, count, index)).filter((item): item is PendingField => item !== null);

  const record: AppliedRecord = {
    source: "template",
    template: { id: template.id, name: template.name, version: template.version, documentId: input.documentId ?? template.documentId },
    ...(input.match ? { level: input.match.level, percent: input.match.percent } : { level: "exact" as const, percent: 100 }),
    count,
    fieldIds: fields.map((field) => field.id),
    textFieldIds: textFields.map((field) => field.id),
    ...createdBook(input.previous, signers, created),
    ...(kept.length > 0 ? { keptSigners: kept } : {}),
    before: input.previous?.before ?? { mode: session.mode, signers: session.signers, activeSignerId: session.activeSignerId },
    pages: distinctPages(fields, textFields),
    reviewPages: result.reviewPages,
    skippedPages: result.skippedPages,
    warnings: result.warnings,
    textMeta,
    spots: spotsOf(fields, textFields),
  };

  return {
    patch: {
      mode: "multi",
      signers,
      docs,
      activeSignerId: session.activeSignerId && signers.some((s) => s.id === session.activeSignerId) ? session.activeSignerId : (signers[0]?.id ?? null),
      blocks: restampKeptSigners({ before: session, docId, nextSigners: signers, nextDoc, blocks: ensureBlocks(signers, docOrder, session.signMode, session.blocks) }),
    },
    record,
    pending,
    loss: lossOf({ session, docId, nextSigners: signers, nextDoc, previous: input.previous }),
  };
}

/* ------------------------------------------------------------------ *
 * Automapeo
 * ------------------------------------------------------------------ */

function textTypeOf(field: AutoField): "text" | "date" {
  return field.type === "date" ? "date" : "text";
}

export type AutoPlanInput = {
  result: AutoMapResult;
  count: 1 | 2;
  session: SignSession;
  docId: DocId;
  roles: readonly Pick<TemplateRole, "label">[];
  mint: Mint;
  previous?: AppliedRecord;
};

export function planAutoMapApplication(input: AutoPlanInput): Plan {
  const { result, count, session, docId, mint } = input;
  const doc = docStateOf(session.docs, docId);
  const grown = ensureRoleSigners(session.signers, input.roles, count, mint.signerId);
  const { signers, kept } = retainSigners(session, docId, grown.signers, count, input.previous);
  const created = grown.created;
  const roleSigners = signers.slice(0, count);

  const fields: SignatureField[] = [];
  const textFields: DetectedField[] = [];
  const textMeta: AppliedRecord["textMeta"] = {};
  const pending: PendingField[] = [];

  for (const field of result.fields) {
    if (field.tier === "ignore") continue;
    const isSign = field.type === "signature" || field.type === "initials";
    if (isSign) {
      // Una firma sin firmante claro (o la de la otra parte) nunca se coloca sola: se ofrece, de una en una, para el firmante 1.
      if (field.signerIndex === undefined) {
        if (field.tier === "review") {
          pending.push({ key: field.id, origin: "automap", kind: "sign", type: field.type, pageIndex: field.pageIndex, rect: { ...field.rect }, ...(field.label ? { label: field.label } : {}), reason: field.reason, confidence: field.confidence });
        }
        continue;
      }
      if (field.signerIndex >= count) continue;
      if (field.tier === "high") {
        fields.push({ id: mint.fieldId(), signerId: roleSigners[field.signerIndex].id, pageIndex: field.pageIndex, type: field.type as "signature" | "initials", rect: { ...field.rect } });
      } else {
        pending.push({ key: field.id, origin: "automap", kind: "sign", type: field.type, signerIndex: field.signerIndex, pageIndex: field.pageIndex, rect: { ...field.rect }, ...(field.label ? { label: field.label } : {}), reason: field.reason, confidence: field.confidence });
      }
      continue;
    }
    if (field.signerIndex !== undefined && field.signerIndex >= count) continue;
    if (field.tier === "high") {
      const id = mint.textFieldId();
      const detected: DetectedField = { id, pageIndex: field.pageIndex, rect: { ...field.rect }, source: "manual", confidence: "high" };
      if (field.label) detected.label = field.label;
      if (textTypeOf(field) !== "text") detected.type = textTypeOf(field);
      textFields.push(detected);
      if (field.type === "date") textMeta[id] = { required: false, dataKey: "today", rule: "today" };
    } else {
      pending.push({ key: field.id, origin: "automap", kind: "text", type: textTypeOf(field), pageIndex: field.pageIndex, rect: { ...field.rect }, ...(field.label ? { label: field.label } : {}), reason: field.reason, confidence: field.confidence });
    }
  }

  const rest = withoutApplied(doc, input.previous);
  const reusedFields = reuseFieldIdsByRole(rest.previousFields, reuseFieldIds(rest.previousFields, fields));
  const reusedAs = new Map<string, string>();
  const reusedText = reuseTextIds(rest.previousText, textFields, (oldId, newId) => reusedAs.set(newId, oldId));
  const finalMeta: AppliedRecord["textMeta"] = {};
  for (const [id, meta] of Object.entries(textMeta)) finalMeta[reusedAs.get(id) ?? id] = meta;
  const keptText = reusedText.length > 0 ? rest.textFields.filter((field) => !isHeuristic(field)) : rest.textFields;
  const nextDoc: DocState = { ...doc, fields: [...rest.fields, ...reusedFields], textFields: [...keptText, ...reusedText] };
  const docs = { ...session.docs, [docId]: nextDoc };
  const docOrder = session.docOrder.length > 0 ? session.docOrder : [docId];

  const record: AppliedRecord = {
    source: "automap",
    count,
    fieldIds: reusedFields.map((field) => field.id),
    textFieldIds: reusedText.map((field) => field.id),
    ...createdBook(input.previous, signers, created),
    ...(kept.length > 0 ? { keptSigners: kept } : {}),
    before: input.previous?.before ?? { mode: session.mode, signers: session.signers, activeSignerId: session.activeSignerId },
    pages: distinctPages(reusedFields, reusedText),
    reviewPages: [],
    skippedPages: [],
    warnings: [],
    textMeta: finalMeta,
    placed: reusedFields.length + reusedText.length,
    spots: spotsOf(reusedFields, reusedText),
  };

  return {
    patch: {
      mode: "multi",
      signers,
      docs,
      activeSignerId: session.activeSignerId && signers.some((s) => s.id === session.activeSignerId) ? session.activeSignerId : (signers[0]?.id ?? null),
      blocks: restampKeptSigners({ before: session, docId, nextSigners: signers, nextDoc, blocks: ensureBlocks(signers, docOrder, session.signMode, session.blocks) }),
    },
    record,
    pending,
    loss: lossOf({ session, docId, nextSigners: signers, nextDoc, previous: input.previous }),
  };
}

/** ¿El automapeo vio un segundo firmante? (decide cuantos firmantes crear cuando aun no hay ninguno) */
export function autoMapSignerCount(result: AutoMapResult): 1 | 2 {
  return result.fields.some((field) => field.tier === "high" && field.signerIndex === 1 && (field.type === "signature" || field.type === "initials")) ? 2 : 1;
}

/* ------------------------------------------------------------------ *
 * Deshacer y aceptar
 * ------------------------------------------------------------------ */

/** Otro documento de la sesion tiene campos de la plantilla o a mano: los firmantes no se pueden retirar. */
function otherDocsTouched(session: Pick<SignSession, "docs">, docId: DocId): boolean {
  return Object.entries(session.docs).some(([id, state]) => id !== docId && (state.fields.length > 0 || state.textFields.some((field) => field.source === "manual")));
}

/**
 * Trabajo de la persona que «Deshacer» pondria en riesgo: firmantes que creo la aplicacion y que ya tienen trazos o un
 * nombre escrito, y valores escritos en campos de texto de la plantilla. Si hay algo, el aviso NO ofrece «Deshacer»
 * (se queda informativo): deshacer revierte lo que la plantilla puso, nunca lo que la persona aporto.
 */
export function undoWork(session: Pick<SignSession, "signers" | "blocks" | "docs">, docId: DocId, record: AppliedRecord): WorkLoss {
  const doc = docStateOf(session.docs, docId);
  const textIds = new Set(record.textFieldIds);
  let values = 0;
  for (const [id, value] of Object.entries(doc.textValues)) if (textIds.has(id) && value.trim() !== "") values += 1;
  if (otherDocsTouched(session, docId)) return { signers: [], values };
  const signers: LostSigner[] = [];
  for (const signer of session.signers) {
    if (!record.createdSignerIds.includes(signer.id)) continue;
    const work = signerWork(session, signer, record);
    if (work.strokes || work.typed) signers.push({ id: signer.id, name: signer.name.trim(), strokes: work.strokes });
  }
  return { signers, values };
}

/**
 * Deshacer una aplicacion: se retiran los campos aplicados (por id; lo que la persona puso a mano se queda) y, si la
 * aplicacion creo los firmantes o cambio el modo, vuelven a como estaban. NUNCA se toca el trabajo de la persona: un
 * firmante creado por la aplicacion que ya tiene trazos o un nombre escrito se queda (con su modo), y los valores
 * escritos en los campos que se retiran se conservan.
 */
export function planUndo(session: SignSession, docId: DocId, record: AppliedRecord): Partial<SignSession> {
  const doc = docStateOf(session.docs, docId);
  const fieldIds = new Set(record.fieldIds);
  const textIds = new Set(record.textFieldIds);
  // Solo se borran los valores vacios: lo escrito por la persona no se toca.
  const textValues = { ...doc.textValues };
  for (const id of textIds) if ((textValues[id] ?? "").trim() === "") delete textValues[id];
  const nextDoc: DocState = {
    ...doc,
    fields: doc.fields.filter((field) => !fieldIds.has(field.id)),
    textFields: doc.textFields.filter((field) => !textIds.has(field.id)),
    textValues,
  };
  const docs = { ...session.docs, [docId]: nextDoc };
  const touchedOtherDocs = otherDocsTouched({ docs }, docId);
  // Los firmantes que creo la aplicacion se van con ella, salvo que otro documento los use o que ya tengan trabajo.
  const keepSigners = touchedOtherDocs
    ? session.signers
    : session.signers.filter((signer) => {
        if (!record.createdSignerIds.includes(signer.id)) return true;
        const work = signerWork(session, signer, record);
        return work.strokes || work.typed;
      });
  const signersChanged = keepSigners.length !== session.signers.length;
  const restoreMode = !touchedOtherDocs && signersChanged && keepSigners.length === 0 ? record.before.mode : session.mode;
  const docOrder = session.docOrder.length > 0 ? session.docOrder : [docId];
  return {
    docs,
    signers: keepSigners,
    mode: restoreMode,
    activeSignerId: session.activeSignerId && keepSigners.some((signer) => signer.id === session.activeSignerId) ? session.activeSignerId : (keepSigners[0]?.id ?? null),
    blocks: ensureBlocks(keepSigners, docOrder, session.signMode, session.blocks),
  };
}

/** Acepta una sugerencia: el campo pasa al documento. `null` si no se puede (sin pagina, o sin firmante para ella). */
export function planAccept(session: SignSession, docId: DocId, item: PendingField, mint: Mint): { patch: Partial<SignSession>; fieldId: string } | null {
  if (item.pageIndex === null) return null;
  const doc = docStateOf(session.docs, docId);
  if (item.kind === "sign") {
    const signer = session.signers[item.signerIndex ?? 0];
    if (!signer) return null;
    const id = mint.fieldId();
    const field: SignatureField = { id, signerId: signer.id, pageIndex: item.pageIndex, type: item.type === "initials" ? "initials" : "signature", rect: { ...item.rect } };
    return { fieldId: id, patch: { docs: { ...session.docs, [docId]: { ...doc, fields: [...doc.fields, field] } } } };
  }
  const id = mint.textFieldId();
  const detected: DetectedField = { id, pageIndex: item.pageIndex, rect: { ...item.rect }, source: "manual", confidence: "high" };
  if (item.label) detected.label = item.label;
  if (item.type === "date" || item.type === "checkbox") detected.type = item.type;
  return { fieldId: id, patch: { docs: { ...session.docs, [docId]: { ...doc, textFields: [...doc.textFields, detected] } } } };
}

/** Variantes disponibles de una plantilla (para decidir cuantos firmantes ofrecer). */
export function variantSupport(template: Pick<DocTemplate, "variants">): { one: boolean; two: boolean } {
  return {
    one: selectVariant(template, 1).variant.fields.length > 0,
    two: template.variants["2"].fields.length > 0,
  };
}

/** Cuantos firmantes aplicar: los que ya hay (1 o 2), si no los recordados, si no 2 cuando la plantilla lo permite. */
export function chooseCount(options: { signers: number; remembered: 1 | 2 | null; support: { one: boolean; two: boolean } }): 1 | 2 {
  const want: 1 | 2 = options.signers >= 1 ? clampCount(options.signers) : (options.remembered ?? (options.support.two ? 2 : 1));
  if (want === 2 && !options.support.two) return 1;
  return want;
}
