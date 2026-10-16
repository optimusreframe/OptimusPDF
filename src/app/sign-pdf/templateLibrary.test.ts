import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeFingerprintWith } from "@/lib/docLibrary/fingerprintEngine";
import { __resetLibraryForTests, deleteDocument, getDocument, getDocumentBytes, listDocuments, putDocument, replaceDocumentBytes } from "@/lib/docLibrary/store";
import { nodeEnv } from "@/lib/docLibrary/testing/nodeEnv";
import { resave } from "@/lib/docLibrary/testing/syntheticContracts";
import { findTemplateForFingerprint, getTemplate, getTemplateForDocument, getTemplateVersions, listTemplates } from "@/lib/docLibrary/templatesStore";
import { renderSynthetic } from "@/lib/pdf/testing/autoMapSynthetic";
import { markDecryptedCopy } from "@/lib/pdf/inputGuard";
import { DEFAULT_SESSION } from "@/app/sign-pdf/signSession";
import { EMPTY_DOC_STATE } from "@/app/sign-pdf/docSet";
import { contractSpec } from "../../../e2e/helpers/template-pdfs";
import { emptyContent, repeatInitialsIn, type EditorContent } from "@/app/sign-pdf/templateEditorModel";
import { openLibraryDocument, saveTemplateToLibrary, seedContentFromSession } from "@/app/sign-pdf/templateLibrary";
import { planTemplateApplication, type Mint } from "@/app/sign-pdf/templateSession";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";

vi.mock("@/lib/docLibrary/fingerprint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docLibrary/fingerprint")>()),
  computeFingerprint: async (source: Uint8Array | Blob) => computeFingerprintWith(source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer()), nodeEnv()),
}));

const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const LINE = R(0.74, 0.885, 0.13, 0.045);
let n = 0;
const mint: Mint = { signerId: () => `sg-${(n += 1)}`, fieldId: () => `fld-${(n += 1)}`, textFieldId: () => `txt-${(n += 1)}` };
const minter = { sign: mint.fieldId, text: mint.textFieldId };

beforeEach(() => {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});

async function contract(label: string, pages = 5): Promise<Uint8Array> {
  return (await renderSynthetic(contractSpec({ label, pages, signers: 2 }))).bytes;
}
const fileOf = (bytes: Uint8Array, name = "contrato.pdf") => new File([bytes as BlobPart], name, { type: "application/pdf" });

function configured(pages: number): EditorContent {
  const base = emptyContent("Mold Test", "es");
  const start: EditorContent = { ...base, variants: { ...base.variants, "2": { fields: [{ id: "base", roleIndex: 0, pageIndex: 0, type: "initials", rect: LINE, required: true, source: "manual" }, { id: "sig1", roleIndex: 0, pageIndex: pages - 1, type: "signature", rect: R(0.1, 0.5, 0.3, 0.05), required: true, source: "manual" }, { id: "sig2", roleIndex: 1, pageIndex: pages - 1, type: "signature", rect: R(0.55, 0.5, 0.3, 0.05), required: true, source: "manual" }], textFields: [] } } };
  const out = repeatInitialsIn(start, "2", { basePage: 0, pageCount: pages });
  if ("error" in out) throw new Error(out.error);
  return out.content;
}

describe("guardar en la biblioteca", () => {
  it("crea el documento (PDF base + huella) y la plantilla, y pide el almacenamiento persistente", async () => {
    const bytes = await contract("Alpha");
    const result = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null });
    if (!result.ok) throw new Error(result.reason);
    expect(result.createdDocument).toBe(true);
    expect(result.pages).toBe(5);
    expect(result.persistence).toEqual({ granted: false, supported: false });
    expect(result.document.templateIds).toEqual([result.template.id]);
    expect(Array.from((await getDocumentBytes(result.document.id)) ?? [])).toEqual(Array.from(bytes));
    expect((await getDocument(result.document.id))?.fingerprint.exact).toBe(result.fingerprint.exact);
    const stored = await getTemplate(result.template.id);
    expect(stored?.variants["2"].fields).toHaveLength(12);
    expect(stored?.roles.map((r) => r.label)).toEqual(["Asegurado", "Co-asegurado"]);
  });

  it("guardar otra vez el MISMO PDF no duplica el documento: es una versión nueva de su plantilla", async () => {
    const bytes = await contract("Alpha");
    const first = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null });
    if (!first.ok) throw new Error(first.reason);
    const edited = configured(5);
    edited.variants["2"].fields = edited.variants["2"].fields.filter((f) => f.pageIndex !== 1);
    const second = await saveTemplateToLibrary({ file: fileOf(bytes), content: edited, documentId: null, template: null });
    if (!second.ok) throw new Error(second.reason);
    expect(second.createdDocument).toBe(false);
    expect(second.persistence).toBeNull();
    expect((await listDocuments()).documents).toHaveLength(1);
    expect((await listTemplates()).templates).toHaveLength(1);
    expect(second.template.id).toBe(first.template.id);
    expect(second.template.version).toBe(2);
    expect((await getTemplateVersions(first.template.id)).map((v) => v.version)).toEqual([2, 1]);
  });

  it("el PDF reexportado (otros bytes) se RECONOCE y la plantilla se aplica donde se configuró, en todas las páginas y con el firmante 1 a la izquierda", async () => {
    const bytes = await contract("Alpha", 6);
    const saved = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(6), documentId: null, template: null });
    if (!saved.ok) throw new Error(saved.reason);
    const again = await resave(bytes, { title: "otra vez", author: "otro exportador" });
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(false);
    const fingerprint = await computeFingerprintWith(again, nodeEnv());
    const found = await findTemplateForFingerprint(fingerprint);
    expect(found?.match.level).toBe("match");
    expect(found?.template.id).toBe(saved.template.id);
    const plan = planTemplateApplication({ template: found!.template, match: found!.match, count: 2, session: { ...DEFAULT_SESSION, docOrder: ["doc-1"] }, docId: "doc-1", pageCount: fingerprint.pageCount, mint });
    const fields = plan.patch.docs!["doc-1"].fields;
    expect(fields).toHaveLength(14);
    const [one, two] = plan.patch.signers!;
    for (let page = 0; page < 6; page += 1) {
      const left = fields.find((f) => f.type === "initials" && f.pageIndex === page && f.signerId === one.id)!;
      const right = fields.find((f) => f.type === "initials" && f.pageIndex === page && f.signerId === two.id)!;
      expect(left.rect.x).toBeLessThan(right.rect.x);
      expect(left.rect.y).toBeCloseTo(LINE.y, 5);
    }
  });

  it("un contrato distinto NO se reconoce con la plantilla de otro", async () => {
    const saved = await saveTemplateToLibrary({ file: fileOf(await contract("Alpha")), content: configured(5), documentId: null, template: null });
    if (!saved.ok) throw new Error(saved.reason);
    const other = await computeFingerprintWith(await contract("Zulu Totally Different Agreement", 5), nodeEnv());
    expect((await findTemplateForFingerprint(other))?.match.level ?? "none").not.toMatch(/^(exact|match)$/);
  });

  it("copia descifrada, sin almacén y PDF dañado: motivo claro y nada guardado", async () => {
    const bytes = await contract("Alpha");
    const decrypted = fileOf(bytes);
    markDecryptedCopy(decrypted);
    expect(await saveTemplateToLibrary({ file: decrypted, content: configured(5), documentId: null, template: null })).toEqual({ ok: false, reason: "encrypted" });
    expect(await saveTemplateToLibrary({ file: fileOf(new Uint8Array([1, 2, 3])), content: configured(5), documentId: null, template: null })).toEqual({ ok: false, reason: "corrupt" });
    expect(await saveTemplateToLibrary({ file: fileOf(new Uint8Array()), content: configured(5), documentId: null, template: null })).toEqual({ ok: false, reason: "empty" });
    // Contenido que no cumple el esquema (rect fuera de la pagina).
    const bad = configured(5);
    bad.variants["2"].fields[0].rect = R(0.9, 0.9, 0.5, 0.5);
    expect(await saveTemplateToLibrary({ file: fileOf(bytes), content: bad, documentId: null, template: null })).toEqual({ ok: false, reason: "invalid" });
    expect((await listDocuments()).documents).toHaveLength(0);
    __resetLibraryForTests();
    // @ts-expect-error simulamos un navegador sin IndexedDB
    globalThis.indexedDB = undefined;
    expect(await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("si la plantilla no se puede guardar, el PDF que esta llamada acababa de crear no se queda huérfano", async () => {
    const result = await saveTemplateToLibrary({ file: fileOf(await contract("Alpha")), content: configured(5), documentId: null, template: { id: "no-existe", rev: 1 } });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("editar con una plantilla vieja (rev distinta) da conflicto y no pisa nada", async () => {
    const bytes = await contract("Alpha");
    const first = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null });
    if (!first.ok) throw new Error(first.reason);
    const edited = { ...configured(5), name: "Otro nombre" };
    const ok = await saveTemplateToLibrary({ file: fileOf(bytes), content: edited, documentId: first.document.id, template: { id: first.template.id, rev: first.template.rev } });
    expect(ok.ok).toBe(true);
    const stale = await saveTemplateToLibrary({ file: fileOf(bytes), content: { ...edited, name: "Tercero" }, documentId: first.document.id, template: { id: first.template.id, rev: first.template.rev } });
    expect(stale).toEqual({ ok: false, reason: "conflict" });
    expect((await getTemplate(first.template.id))?.name).toBe("Otro nombre");
  });
});

describe("abrir un documento de la biblioteca", () => {
  it("devuelve el PDF base como File y su plantilla; un id que ya no existe, null", async () => {
    const bytes = await contract("Alpha");
    const saved = await saveTemplateToLibrary({ file: fileOf(bytes, "Mold Test.pdf"), content: configured(5), documentId: null, template: null });
    if (!saved.ok) throw new Error(saved.reason);
    const opened = await openLibraryDocument(saved.document.id);
    expect(opened?.file.name).toBe("Mold Test.pdf");
    expect(opened?.file.type).toBe("application/pdf");
    expect(opened?.file.size).toBe(bytes.length);
    expect(opened?.template?.id).toBe(saved.template.id);
    expect(await openLibraryDocument("no-existe")).toBeNull();
    // Un documento sin copia del PDF no se puede abrir.
    const fp = saved.fingerprint;
    await putDocument({ id: "sin-copia", name: "x", docType: "", fileName: "x.pdf", pageCount: fp.pageCount, pageSizes: fp.pageSizes, fingerprint: fp, templateIds: [] });
    expect(await openLibraryDocument("sin-copia")).toBeNull();
  });
});

describe("de lo hecho en Firmar a una plantilla", () => {
  const signers = [{ id: "sg-1", name: "Juan Pérez", color: "#0d4bff" }, { id: "sg-2", name: "Ana Gómez", color: "#0f9d68" }];
  const docs = {
    "doc-1": {
      ...EMPTY_DOC_STATE,
      fields: [
        { id: "f1", signerId: "sg-1", pageIndex: 0, type: "initials" as const, rect: R(0.74, 0.885, 0.065, 0.045) },
        { id: "f2", signerId: "sg-2", pageIndex: 0, type: "initials" as const, rect: R(0.81, 0.885, 0.065, 0.045) },
        { id: "f3", signerId: "sg-9", pageIndex: 0, type: "signature" as const, rect: R(0.1, 0.5, 0.3, 0.05) },
      ],
      textFields: [
        { id: "weird id", pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.03), label: "Phone:", source: "acroform" as const, confidence: "high" as const },
        { id: "sug", pageIndex: 0, rect: R(0.1, 0.3, 0.3, 0.03), source: "heuristic-vector" as const, confidence: "low" as const },
        { id: "d1", pageIndex: 1, rect: R(0.1, 0.4, 0.2, 0.03), type: "date" as const, source: "manual" as const, confidence: "high" as const },
      ],
    },
  };

  it("pasa posiciones, no nombres de personas, no sugerencias; los ids no válidos se renuevan y la fecha lleva «hoy»", () => {
    const content = seedContentFromSession({ session: { signers, docs }, docId: "doc-1", name: "Mi plantilla", language: "es", mint: minter });
    const v2 = content.variants["2"];
    expect(content.variants["1"].fields).toHaveLength(0);
    expect(v2.fields.map((f) => [f.roleIndex, f.type])).toEqual([[0, "initials"], [1, "initials"]]);
    expect(v2.textFields.map((f) => f.type)).toEqual(["text", "date"]);
    expect(v2.textFields[0].dataKey).toBe("phone");
    expect(v2.textFields[1]).toMatchObject({ dataKey: "today", rule: "today" });
    expect(new Set([...v2.fields, ...v2.textFields].map((f) => f.id)).size).toBe(4);
    expect(JSON.stringify(content)).not.toContain("Juan");
    expect(JSON.stringify(content)).not.toContain("Gómez");
    expect(content.roles.map((r) => r.label)).toEqual(["Asegurado", "Co-asegurado"]);
  });

  it("con un firmante rellena la variante de 1 y conserva la otra de la plantilla base", () => {
    const base = configured(5);
    const content = seedContentFromSession({ session: { signers: [signers[0]], docs }, docId: "doc-1", name: "x", language: "es", mint: minter, base });
    expect(content.variants["1"].fields).toHaveLength(1);
    expect(content.variants["2"].fields).toHaveLength(base.variants["2"].fields.length);
  });
});

/* ------------------------------------------------------------------ *
 * F2-fix: m2 (la otra variante se conserva), m5 («Guardar como documento nuevo») y MAYOR 3 (reconfigurar limpia el aviso)
 * ------------------------------------------------------------------ */

describe("guardar la variante de un nº de firmantes no borra la otra (m2)", () => {
  /** Lo que sale de Firmar con UN firmante: la variante de 1 con campos, la de 2 vacia (no «borrada»). */
  function fromSession(name = "contrato"): EditorContent {
    const base = emptyContent(name, "es");
    return { ...base, variants: { ...base.variants, "1": { fields: [{ id: "u1", roleIndex: 0, pageIndex: 0, type: "signature", rect: R(0.1, 0.4, 0.3, 0.05), required: true, source: "manual" }], textFields: [] } } };
  }

  it("con keepOtherVariant, guardar la de 1 firmante conserva la de 2 (campos, nombre y roles) de la plantilla ya guardada", async () => {
    const bytes = await contract("Alpha");
    const first = await saveTemplateToLibrary({ file: fileOf(bytes), content: { ...configured(5), name: "Mold Test", roles: [{ key: "a", label: "Titular" }, { key: "b", label: "Cónyuge" }] }, documentId: null, template: null });
    if (!first.ok) throw new Error(first.reason);
    const twoBefore = (await getTemplate(first.template.id))!.variants["2"];
    expect(twoBefore.fields.length).toBeGreaterThan(0);
    const second = await saveTemplateToLibrary({ file: fileOf(bytes), content: fromSession(), documentId: null, template: null, keepOtherVariant: true });
    if (!second.ok) throw new Error(second.reason);
    expect(second.template.id).toBe(first.template.id);
    expect(second.template.version).toBe(2);
    const stored = (await getTemplate(first.template.id))!;
    expect(stored.variants["1"].fields).toHaveLength(1);
    expect(stored.variants["2"]).toEqual(twoBefore);
    expect(stored.name).toBe("Mold Test");
    expect(stored.roles.map((r) => r.label)).toEqual(["Titular", "Cónyuge"]);
  });

  it("y al reves: guardar la de 2 firmantes conserva la de 1", async () => {
    const bytes = await contract("Alpha");
    const first = await saveTemplateToLibrary({ file: fileOf(bytes), content: fromSession("Solo uno"), documentId: null, template: null });
    if (!first.ok) throw new Error(first.reason);
    const oneBefore = (await getTemplate(first.template.id))!.variants["1"];
    const second = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null, keepOtherVariant: true });
    if (!second.ok) throw new Error(second.reason);
    const stored = (await getTemplate(first.template.id))!;
    expect(stored.variants["1"]).toEqual(oneBefore);
    expect(stored.variants["2"].fields.length).toBeGreaterThan(0);
  });

  it("sin keepOtherVariant (el editor) lo vacio SI es vacio: quitar todos los campos de una variante es una decision de la persona", async () => {
    const bytes = await contract("Alpha");
    const first = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null });
    if (!first.ok) throw new Error(first.reason);
    const emptied = await saveTemplateToLibrary({ file: fileOf(bytes), content: fromSession(), documentId: null, template: null });
    if (!emptied.ok) throw new Error(emptied.reason);
    expect((await getTemplate(first.template.id))!.variants["2"].fields).toHaveLength(0);
  });

  it("si la plantilla esta desactualizada la otra variante describe el PDF de antes: NO se conserva", async () => {
    const bytes = await contract("Alpha");
    const first = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null });
    if (!first.ok) throw new Error(first.reason);
    const replacement = await contract("Zulu Totally Different Agreement", 5);
    await replaceDocumentBytes(first.document.id, replacement, { fingerprinter: async () => sampleFingerprint(5, 77) });
    expect((await getDocument(first.document.id))?.templateStale).toBeDefined();
    const saved = await saveTemplateToLibrary({ file: fileOf(replacement), content: fromSession(), documentId: first.document.id, template: null, keepOtherVariant: true });
    if (!saved.ok) throw new Error(saved.reason);
    expect((await getTemplate(first.template.id))!.variants["2"].fields).toHaveLength(0);
    // Y reconfigurar la deja al dia.
    expect((await getDocument(first.document.id))?.templateStale).toBeUndefined();
  });

  it("sin plantilla previa no hay nada que conservar", async () => {
    const saved = await saveTemplateToLibrary({ file: fileOf(await contract("Alpha")), content: fromSession(), documentId: null, template: null, keepOtherVariant: true });
    if (!saved.ok) throw new Error(saved.reason);
    expect((await getTemplate(saved.template.id))!.variants["2"].fields).toHaveLength(0);
  });
});

describe("editor abierto desde «Mis documentos» cuyo documento se borró en otra pestaña (m5)", () => {
  it("guardar en el documento original da conflicto; «como documento nuevo» guarda las ediciones en uno nuevo con su plantilla, sin tocar nada mas", async () => {
    const bytes = await contract("Alpha");
    const first = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null });
    if (!first.ok) throw new Error(first.reason);
    const open = { documentId: first.document.id, template: { id: first.template.id, rev: first.template.rev } };
    // Otra pestaña borra el documento: su plantilla queda «sin documento» (y con otra rev).
    await deleteDocument(first.document.id);
    const edited = { ...configured(5), name: "Editada tras borrar" };
    const lost = await saveTemplateToLibrary({ file: fileOf(bytes), content: edited, documentId: open.documentId, template: open.template });
    expect(lost).toEqual({ ok: false, reason: "conflict" });
    expect((await listDocuments()).documents).toHaveLength(0);
    const saved = await saveTemplateToLibrary({ file: fileOf(bytes), content: edited, documentId: null, template: null, asNewDocument: true });
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.createdDocument).toBe(true);
    expect(saved.document.id).not.toBe(first.document.id);
    expect(saved.template.id).not.toBe(first.template.id);
    expect(saved.template.documentId).toBe(saved.document.id);
    expect(saved.document.templateIds).toEqual([saved.template.id]);
    expect((await getTemplateForDocument(saved.document.id))?.name).toBe("Editada tras borrar");
    expect(Array.from((await getDocumentBytes(saved.document.id)) ?? [])).toEqual(Array.from(bytes));
    // La plantilla huérfana del documento borrado no se toca.
    expect((await getTemplate(first.template.id))?.documentId).toBeNull();
  });

  it("«documento nuevo» no reutiliza el documento existente con los mismos bytes ni pisa su plantilla", async () => {
    const bytes = await contract("Alpha");
    const first = await saveTemplateToLibrary({ file: fileOf(bytes), content: configured(5), documentId: null, template: null });
    if (!first.ok) throw new Error(first.reason);
    // Aunque se indique el documento de antes (que sigue existiendo), «documento nuevo» crea uno nuevo.
    const copy = await saveTemplateToLibrary({ file: fileOf(bytes), content: { ...configured(5), name: "Copia" }, documentId: first.document.id, template: { id: first.template.id, rev: first.template.rev }, asNewDocument: true });
    if (!copy.ok) throw new Error(copy.reason);
    expect((await listDocuments()).documents).toHaveLength(2);
    expect((await listTemplates()).templates).toHaveLength(2);
    expect((await getTemplate(first.template.id))?.name).toBe("Mold Test");
    expect(copy.document.id).not.toBe(first.document.id);
  });
});
