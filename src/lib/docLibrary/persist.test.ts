import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LIBRARY_EXPORT_SCHEMA,
  MAX_LIBRARY_JSON_BYTES,
  deserializeLibrary,
  serializeLibrary,
  serializeLibraryJson,
  toDocumentInput,
} from "./persist";
import { __resetLibraryForTests, getDocument, getDocumentBytes, putDocument } from "./store";
import { sampleBytes, sampleFingerprint, sampleInput } from "./testing/sampleDocs";
import { FINGERPRINT_VERSION, LIBRARY_LIMITS, type DocumentEntry } from "./types";

beforeEach(() => {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});

function entry(id: string, overrides: Partial<DocumentEntry> = {}): DocumentEntry {
  const input = sampleInput(id);
  return {
    ...input,
    fingerprint: input.fingerprint,
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-02-03T04:05:06.000Z",
    byteLength: 1234,
    rev: 7,
    ...overrides,
  } as DocumentEntry;
}

describe("serializeLibrary", () => {
  it("no exporta `rev`, lleva el esquema y el MinHash en base64 compacto", () => {
    const out = serializeLibrary([entry("a")]);
    expect(out.schemaVersion).toBe(LIBRARY_EXPORT_SCHEMA);
    expect("rev" in out.documents[0]).toBe(false);
    const page = out.documents[0].fingerprint.pages[0];
    expect(typeof page.minhash).toBe("string");
    expect(page.minhash.length).toBeLessThan(700);
    expect(JSON.stringify(out)).not.toContain('"rev"');
  });

  it("es JSON-seguro y conserva el orden", () => {
    const text = serializeLibraryJson([entry("b"), entry("a")]);
    expect((JSON.parse(text) as { documents: Array<{ id: string }> }).documents.map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("no modifica las entradas de entrada", () => {
    const original = entry("keep");
    const snapshot = structuredClone(original);
    serializeLibrary([original]);
    expect(original).toEqual(snapshot);
  });
});

describe("deserializeLibrary", () => {
  it("ida y vuelta exacta (la rev vuelve a 1: es de cada navegador)", () => {
    const originals = [entry("a"), entry("b", { templateIds: ["t-1", "t-2"], name: "Otro" })];
    const back = deserializeLibrary(serializeLibraryJson(originals));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.warnings).toEqual([]);
    expect(back.documents).toEqual(originals.map((original) => ({ ...original, rev: 1 })));
  });

  it("acepta el objeto ya parseado", () => {
    const back = deserializeLibrary(serializeLibrary([entry("a")]));
    expect(back.ok && back.documents).toHaveLength(1);
  });

  it("conserva huellas parciales y páginas escaneadas (dHash, sin MinHash)", () => {
    const partial = entry("big", {
      pageCount: 300,
      pageSizes: [],
      fingerprint: { version: FINGERPRINT_VERSION, exact: "ab".repeat(32), pageCount: 300, pageSizes: [], pages: [], partial: "tooManyPages" },
    });
    const scan = entry("scan", {
      pageCount: 1,
      pageSizes: [{ width: 612, height: 792 }],
      fingerprint: { version: FINGERPRINT_VERSION, exact: "cd".repeat(32), pageCount: 1, pageSizes: [{ width: 612, height: 792 }], pages: [{ textHash: "", minhash: [], dhash: "0123456789abcdef" }] },
    });
    const back = deserializeLibrary(serializeLibraryJson([partial, scan]));
    expect(back.ok && back.documents).toEqual([partial, scan].map((original) => ({ ...original, rev: 1 })));
  });

  it("un documento inválido se omite con aviso y el resto sigue; duplicados también", () => {
    const data = serializeLibrary([entry("ok-1"), entry("ok-2"), entry("ok-1")]);
    const broken = { ...data, documents: [data.documents[0], { ...data.documents[1], name: 5 }, data.documents[2], data.documents[1]] };
    const back = deserializeLibrary(broken);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.documents.map((document) => document.id)).toEqual(["ok-1", "ok-2"]);
    expect(back.warnings).toEqual([
      { code: "invalidDocument", index: 1 },
      { code: "duplicateId", index: 2 },
    ]);
  });

  it("ignora campos desconocidos (no pasan a la entrada)", () => {
    const data = serializeLibrary([entry("a")]);
    const dirty = { ...data, documents: [{ ...data.documents[0], extra: "<script>", __proto__: { polluted: true } }] };
    const back = deserializeLibrary(dirty);
    expect(back.ok && "extra" in back.documents[0]).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("MinHash en base64 manipulado → ese documento se omite", () => {
    for (const minhash of ["", "AAAA", "!!!!", "A".repeat(2000), btoa("x".repeat(511)), btoa("x".repeat(513))]) {
      const data = serializeLibrary([entry("a")]);
      data.documents[0].fingerprint.pages[0].minhash = minhash;
      const back = deserializeLibrary(data);
      expect(back.ok && back.documents.length, `minhash ${minhash.slice(0, 8)}`).toBe(0);
    }
  });

  it("más de 50 documentos: se quedan los 50 primeros y se avisa", () => {
    const many = Array.from({ length: LIBRARY_LIMITS.maxDocuments + 5 }, (_, index) => entry(`doc-${index}`));
    const back = deserializeLibrary(serializeLibraryJson(many));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.documents).toHaveLength(50);
    expect(back.warnings).toContainEqual({ code: "tooManyDocuments", kept: 50 });
  });

  it("texto demasiado grande, JSON roto, formato raro y esquema más nuevo", () => {
    expect(deserializeLibrary("x".repeat(MAX_LIBRARY_JSON_BYTES + 1))).toEqual({ ok: false, reason: "tooLarge" });
    expect(deserializeLibrary("{no es json")).toEqual({ ok: false, reason: "invalidJson" });
    for (const raw of [null, 5, "[]", [], { documents: [] }, { schemaVersion: 0, documents: [] }, { schemaVersion: 1.5, documents: [] }, { schemaVersion: "1", documents: [] }, { schemaVersion: 1, documents: "x" }]) {
      expect(deserializeLibrary(raw)).toEqual({ ok: false, reason: "invalidFormat" });
    }
    expect(deserializeLibrary({ schemaVersion: LIBRARY_EXPORT_SCHEMA + 1, documents: [] })).toEqual({ ok: false, reason: "newerVersion" });
  });

  it("nunca lanza, con cualquier basura", () => {
    const junk: unknown[] = [undefined, NaN, () => 1, Symbol.iterator.toString(), { schemaVersion: 1, documents: [null, 1, "x", [], {}, { fingerprint: 5 }, { fingerprint: { pages: [null] } }, { fingerprint: { pages: [{ minhash: 7 }] } }] }];
    for (const value of junk) expect(() => deserializeLibrary(value)).not.toThrow();
    const back = deserializeLibrary(junk[junk.length - 1]);
    expect(back.ok && back.documents).toEqual([]);
    expect(back.ok && back.warnings).toHaveLength(8);
  });

  it("mide el peor caso: 50 documentos × 200 páginas caben en el tope de texto", () => {
    const fingerprint = sampleFingerprint(200, 3);
    const big = Array.from({ length: 50 }, (_, index) => entry(`doc-${index}`, { pageCount: 200, pageSizes: fingerprint.pageSizes, fingerprint }));
    const text = serializeLibraryJson(big);
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_LIBRARY_JSON_BYTES);
    const back = deserializeLibrary(text);
    expect(back.ok && back.documents).toHaveLength(50);
  });
});

describe("restaurar en el almacén", () => {
  it("toDocumentInput + putDocument conserva createdAt y updatedAt de la copia", async () => {
    const original = entry("rest-1");
    const back = deserializeLibrary(serializeLibraryJson([original]));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    const imported = back.documents[0];
    const stored = await putDocument(toDocumentInput(imported), sampleBytes(20), { updatedAt: imported.updatedAt });
    expect(stored).toMatchObject({ id: "rest-1", createdAt: original.createdAt, updatedAt: original.updatedAt, rev: 1, byteLength: 20 });
    expect(await getDocument("rest-1")).toEqual(stored);
    expect(await getDocumentBytes("rest-1")).toEqual(sampleBytes(20));
    expect(stored.fingerprint).toEqual(original.fingerprint);
  });
});
