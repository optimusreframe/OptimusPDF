import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { AutoField, AutoMapResult } from "../pdf/autoMapTypes";
import { autoMapBytes } from "../pdf/testing/autoMapHarness";
import { SCALE_VARIANTS, renderSynthetic, syntheticCorpus, type Item, type SyntheticDoc } from "../pdf/testing/autoMapSynthetic";
import { computeFingerprintWith } from "./fingerprintEngine";
import { __resetLibraryForTests, putDocument } from "./store";
import { applyTemplate } from "./templateApply";
import { templateFromAutoMap } from "./templateAuto";
import { cloneTemplateToDocument, createTemplate, findTemplateForFingerprint, getTemplate, statusOfTemplate } from "./templatesStore";
import { nodeEnv } from "./testing/nodeEnv";
import { resave } from "./testing/syntheticContracts";
import type { Fingerprint } from "./types";

/**
 * Integración con el corpus SINTÉTICO del automapeo (U2.8): automapear → plantilla → guardarla en la biblioteca →
 * cargar una REEXPORTACIÓN del mismo PDF (otros bytes) → reconocerla por huella → aplicar la plantilla con el mapeo de
 * páginas → los campos caen donde el automapeo los puso (y donde el automapeo de la reexportación los pondría).
 */

const TOLERANCE = 0.005;

beforeEach(() => {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});

const fingerprintOf = (bytes: Uint8Array) => computeFingerprintWith(bytes, nodeEnv());

async function storeDocument(id: string, bytes: Uint8Array, fingerprint: Fingerprint) {
  await putDocument({ id, name: id, docType: "contrato", fileName: `${id}.pdf`, pageCount: fingerprint.pageCount, pageSizes: fingerprint.pageSizes, fingerprint, templateIds: [] }, bytes);
}

const structural = (fields: AutoField[], signers: 1 | 2) =>
  fields.filter((field) => field.tier === "high" && (field.type === "signature" || field.type === "initials") && field.signerIndex !== undefined && field.signerIndex < signers);

function maxError(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
}

type Case = { name: string; doc: SyntheticDoc; options?: Parameters<typeof renderSynthetic>[1] };
const corpus = syntheticCorpus();
const variants = SCALE_VARIANTS.filter((variant) => ["a4", "rot90", "x0.7"].includes(variant.id));
const cases: Case[] = [
  ...corpus.map(({ doc }) => ({ name: doc.name, doc })),
  ...corpus.filter(({ doc }) => ["corner-repeat-2", "es-single"].includes(doc.name)).flatMap(({ doc }) => variants.map((variant) => ({ name: `${doc.name} @ ${variant.id}`, doc, options: variant.options }))),
];

async function pipeline(testCase: Case) {
  const rendered = await renderSynthetic(testCase.doc, testCase.options);
  const signers = testCase.doc.signers;
  const original = rendered.bytes;
  const auto = await autoMapBytes(original, { signers, locale: "es" });
  const fingerprint = await fingerprintOf(original);
  await storeDocument("doc-1", original, fingerprint);
  const { draft, stats } = templateFromAutoMap(auto, { documentId: "doc-1", signers });
  const template = await createTemplate(draft, { newId: () => "tpl-int" });
  return { signers, original, auto, fingerprint, template, stats };
}

describe("automapear → plantilla → reexportación → los campos caen en el mismo sitio", () => {
  for (const testCase of cases) {
    it(`${testCase.name}`, async () => {
      const { signers, original, auto, stats } = await pipeline(testCase);
      const reexported = await resave(original, { useObjectStreams: true, title: "Reexportado", author: "Otro programa" });
      expect(Buffer.compare(Buffer.from(original), Buffer.from(reexported))).not.toBe(0);
      const reexportFingerprint = await fingerprintOf(reexported);

      // 1. Se reconoce por huella (otros bytes, misma estructura).
      const lookup = await findTemplateForFingerprint(reexportFingerprint);
      expect(lookup, "no se reconoció el documento").not.toBeNull();
      expect(lookup!.template.id).toBe("tpl-int");
      // Una página SIN texto se compara por imagen y (decisión de U2.1) impide «Coincide»: el documento sale «Parece» y la
      // interfaz pregunta; con texto en todas las páginas, «Coincide». En ambos casos las páginas quedan emparejadas.
      const textless = reexportFingerprint.pages.some((page) => page.textHash === "");
      if (textless) expect(lookup!.match.level).toBe("similar");
      else expect(["exact", "match"]).toContain(lookup!.match.level);
      expect(lookup!.match.reviewPages).toEqual([]);
      expect(lookup!.match.mappedPages).toEqual(Array.from({ length: reexportFingerprint.pageCount }, (_, index) => index));

      // 2. Se aplica con el mapeo de páginas.
      const applied = applyTemplate(lookup!.template, { signers, match: lookup!.match, roles: [{ signerId: "S1" }, { signerId: "S2" }] });
      expect(applied.skippedPages).toEqual([]);
      expect(applied.reviewPages).toEqual([]);
      expect(applied.warnings).toEqual(stats.signFields === 0 ? [{ code: "noSignFields" }] : []);

      // 3. Las firmas/iniciales aplicadas son exactamente las `high` del automapeo del original.
      const expected = structural(auto.fields, signers);
      expect(applied.fields).toHaveLength(expected.length);
      const used = new Set<number>();
      for (const field of applied.fields) {
        const index = expected.findIndex((candidate, position) => !used.has(position) && candidate.pageIndex === field.pageIndex && candidate.type === field.type && `S${(candidate.signerIndex ?? 0) + 1}` === field.signerId && maxError(candidate.rect, field.rect) < 1e-9);
        expect(index, `campo sin pareja en p${field.pageIndex} ${field.type} ${field.signerId}`).toBeGreaterThanOrEqual(0);
        used.add(index);
      }

      // 4. Y caen donde el automapeo de la REEXPORTACIÓN los pone (error < 0,005).
      const again: AutoMapResult = await autoMapBytes(reexported, { signers, locale: "es" });
      const reference = structural(again.fields, signers);
      for (const field of applied.fields) {
        const near = reference.filter((candidate) => candidate.pageIndex === field.pageIndex && candidate.type === field.type && `S${(candidate.signerIndex ?? 0) + 1}` === field.signerId);
        expect(near.length, `el automapeo de la reexportación no tiene ${field.type} en p${field.pageIndex}`).toBeGreaterThan(0);
        expect(Math.min(...near.map((candidate) => maxError(candidate.rect, field.rect)))).toBeLessThan(TOLERANCE);
      }

      // 5. Los campos de revisión del automapeo NO se aplican solos y quedan disponibles para «Revisar».
      expect(applied.reviewFields.filter((field) => field.reason === "needsReview")).toHaveLength(stats.needsReview);

      // 6. Texto y fecha: los `high` sin firmante o del firmante pedido.
      const expectedText = auto.fields.filter((field) => field.tier === "high" && (field.type === "date" || field.type === "text") && (field.signerIndex === undefined || field.signerIndex < signers));
      expect(applied.textFields).toHaveLength(expectedText.length);
      for (const field of applied.textFields) {
        const rects = expectedText.filter((candidate) => candidate.pageIndex === field.pageIndex).map((candidate) => maxError(candidate.rect, field.rect));
        expect(Math.min(...rects)).toBeLessThan(1e-9);
      }
    });
  }
});

describe("la plantilla se guarda y se reconoce de verdad (IndexedDB)", () => {
  it("2 firmantes: queda «lista» (1 y 2 firmantes con respaldo) y sobrevive a recargar la biblioteca", async () => {
    const testCase = cases.find((entry) => entry.name === "corner-repeat-2")!;
    const { template } = await pipeline(testCase);
    expect(template.variants["2"].fields.length).toBeGreaterThan(10);
    expect(template.variants["1"].fields).toEqual([]);
    expect(statusOfTemplate(template)).toMatchObject({ state: "ready", usesFallbackForOne: true });
    __resetLibraryForTests();
    const back = (await getTemplate("tpl-int"))!;
    expect(back).toEqual(template);
    expect(back.variants["2"].fields.every((field) => field.source === "auto")).toBe(true);
  });

  it("con 1 firmante en el documento de 2: se usa el firmante 1 con aviso, en las mismas posiciones", async () => {
    const testCase = cases.find((entry) => entry.name === "corner-repeat-2")!;
    const { template, auto } = await pipeline(testCase);
    const applied = applyTemplate(template, { signers: 1, roles: [{ signerId: "S1" }] });
    expect(applied.warnings).toEqual([{ code: "fallbackFromTwoSigners", droppedFields: expect.any(Number) }]);
    expect(applied.fields.every((field) => field.signerId === "S1")).toBe(true);
    const signerOne = structural(auto.fields, 2).filter((field) => field.signerIndex === 0);
    expect(applied.fields).toHaveLength(signerOne.length);
  });
});

describe("una página distinta en la reexportación: «Revisar», nunca aplicar solo", () => {
  /** Sustituye el texto del cuerpo de una página por palabras inventadas distintas (mismo diseño de iniciales). */
  function rewritePage(doc: SyntheticDoc, pageIndex: number): SyntheticDoc {
    const pages = doc.pages.map((page, index) => {
      if (index !== pageIndex) return page;
      const items: Item[] = page.items.map((item, line) => (item.t === "text" && item.y >= 0.11 && item.y < 0.8 ? { ...item, text: Array.from({ length: 12 }, (_, word) => `zq${pageIndex}x${line}w${word}`).join(" ") } : item));
      return { ...page, items };
    });
    return { ...doc, pages };
  }

  it("la página cambiada se marca para revisar; las demás se aplican", async () => {
    const base = corpus.find(({ doc }) => doc.name === "labelled-initials-2")!.doc;
    const { auto } = await pipeline({ name: base.name, doc: base });
    const changed = rewritePage(base, 1);
    const changedBytes = (await renderSynthetic(changed)).bytes;
    const fingerprint = await fingerprintOf(changedBytes);
    const lookup = await findTemplateForFingerprint(fingerprint);
    expect(lookup).not.toBeNull();
    expect(lookup!.match.level).toBe("similar");
    expect(lookup!.match.reviewPages).toContain(1);
    const applied = applyTemplate(lookup!.template, { signers: 2, match: lookup!.match });
    const onPage1 = structural(auto.fields, 2).filter((field) => field.pageIndex === 1).length;
    expect(onPage1).toBeGreaterThan(0);
    expect(applied.fields.some((field) => field.pageIndex === 1)).toBe(false);
    expect(applied.fields).toHaveLength(structural(auto.fields, 2).length - onPage1);
    expect(applied.reviewFields.filter((field) => field.templatePage === 1)).toHaveLength(onPage1);
    expect([...applied.skippedPages, ...applied.reviewPages]).toEqual([1]);
  });

  it("«Usar esta plantilla en otro documento» desde el documento reexportado con una página distinta", async () => {
    const base = corpus.find(({ doc }) => doc.name === "labelled-initials-2")!.doc;
    await pipeline({ name: base.name, doc: base });
    const changedBytes = (await renderSynthetic(rewritePage(base, 1))).bytes;
    await storeDocument("doc-2", changedBytes, await fingerprintOf(changedBytes));
    const out = await cloneTemplateToDocument("tpl-int", "doc-2", { newId: () => "tpl-clone" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.dropped).toBeGreaterThan(0);
    expect(out.droppedPages).toEqual([1]);
    expect(out.template.documentId).toBe("doc-2");
    expect(out.template.variants["2"].fields.some((field) => field.pageIndex === 1)).toBe(false);
  });
});
