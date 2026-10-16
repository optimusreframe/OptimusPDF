import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_TEMPLATES_STORAGE_KEY } from "@/app/sign-pdf/signTemplates";
import { LEGACY_TEMPLATES_STORAGE_KEY, markMigrated, migrateLocalTemplates } from "./templateLegacy";
import { __resetLibraryForTests, putDocument } from "./store";
import { attachTemplate, getTemplate, listTemplates, statusOfTemplate } from "./templatesStore";
import { R } from "./testing/templateSamples";
import { sampleBytes, sampleInput } from "./testing/sampleDocs";
import { applyTemplate } from "./templateApply";

beforeEach(() => {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  __resetLibraryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem = vi.fn((key: string) => this.map.get(key) ?? null);
  setItem = vi.fn((key: string, value: string) => void this.map.set(key, value));
  removeItem = vi.fn((key: string) => void this.map.delete(key));
}

type Legacy = Record<string, unknown>;
const legacy = (id: string, over: Legacy = {}): Legacy => ({
  id,
  name: `Plantilla ${id}`,
  savedAt: "2026-01-15T12:00:00.000Z",
  sourcePageCount: 4,
  signers: [{ name: "Ana" }, { name: "Luis" }],
  fields: [
    { signerIndex: 0, pageIndex: 3, type: "signature", rect: R(0.16, 0.5, 0.25, 0.05) },
    { signerIndex: 1, pageIndex: 3, type: "signature", rect: R(0.55, 0.5, 0.25, 0.05) },
    { signerIndex: 0, pageIndex: 0, type: "initials", rect: R(0.79, 0.84, 0.05, 0.03) },
  ],
  textFields: [{ pageIndex: 0, rect: R(0.1, 0.2, 0.3, 0.025), label: "Nombre" }],
  ...over,
});

function storageWith(templates: unknown[], version: unknown = 1): FakeStorage {
  const storage = new FakeStorage();
  storage.map.set(LEGACY_TEMPLATES_STORAGE_KEY, JSON.stringify({ version, templates }));
  return storage;
}

let n = 0;
const newId = () => `mig-${(n += 1)}`;

describe("la clave es la de signTemplates.ts", () => {
  it("LEGACY_TEMPLATES_STORAGE_KEY === SIGN_TEMPLATES_STORAGE_KEY", () => {
    expect(LEGACY_TEMPLATES_STORAGE_KEY).toBe(SIGN_TEMPLATES_STORAGE_KEY);
  });
});

describe("migrateLocalTemplates: sin datos o sin localStorage", () => {
  it("sin localStorage (Node, sin window) no rompe: unavailable", async () => {
    expect(await migrateLocalTemplates()).toEqual({ status: "unavailable" });
    expect(await markMigrated()).toEqual({ status: "unavailable", removed: 0, kept: 0 });
  });

  it("localStorage que LANZA al leer → unavailable", async () => {
    const storage = new FakeStorage();
    storage.getItem.mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError");
    });
    expect(await migrateLocalTemplates({ storage })).toEqual({ status: "unavailable" });
  });

  it("window.localStorage que lanza al ACCEDER → unavailable", async () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("bloqueado", "SecurityError");
      },
    });
    expect(await migrateLocalTemplates()).toEqual({ status: "unavailable" });
  });

  it("clave ausente o vacía → none", async () => {
    expect(await migrateLocalTemplates({ storage: new FakeStorage() })).toEqual({ status: "none" });
    const empty = new FakeStorage();
    empty.map.set(LEGACY_TEMPLATES_STORAGE_KEY, "");
    expect(await migrateLocalTemplates({ storage: empty })).toEqual({ status: "none" });
  });

  it("datos corruptos → corrupt, sin crear nada ni tocar el original", async () => {
    const bad: string[] = ["{no json", "null", "5", "[]", JSON.stringify({ version: 2, templates: [] }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, templates: "x" }), JSON.stringify({ version: 1, templates: Array.from({ length: 201 }, () => ({})) })];
    for (const text of bad) {
      const storage = new FakeStorage();
      storage.map.set(LEGACY_TEMPLATES_STORAGE_KEY, text);
      expect(await migrateLocalTemplates({ storage }), text.slice(0, 30)).toEqual({ status: "corrupt" });
      expect(storage.map.get(LEGACY_TEMPLATES_STORAGE_KEY)).toBe(text);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
    }
    expect((await listTemplates()).templates).toEqual([]);
  });

  it("sin IndexedDB → storeUnavailable (y no crea nada)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    __resetLibraryForTests();
    expect(await migrateLocalTemplates({ storage: storageWith([legacy("a")]) })).toEqual({ status: "storeUnavailable" });
    expect(await markMigrated({ storage: storageWith([legacy("a")]) })).toMatchObject({ status: "storeUnavailable", removed: 0 });
  });
});

describe("migrateLocalTemplates: conversión", () => {
  it("2 firmantes → plantilla «sin documento» con la variante «2», roles con los nombres y origen local", async () => {
    const storage = storageWith([legacy("tpl-17-4")]);
    const out = await migrateLocalTemplates({ storage, newId });
    expect(out).toMatchObject({ status: "ok", alreadyMigrated: [], skipped: 0, droppedFields: 0, failed: 0 });
    if (out.status !== "ok") return;
    expect(out.created).toHaveLength(1);
    const t = out.created[0];
    expect(t).toMatchObject({ documentId: null, name: "Plantilla tpl-17-4", version: 1, origin: { kind: "local", legacyId: "tpl-17-4", savedAt: "2026-01-15T12:00:00.000Z" } });
    expect(t.roles).toEqual([
      { key: "signer1", label: "Ana" },
      { key: "signer2", label: "Luis" },
    ]);
    expect(t.variants["1"]).toEqual({ fields: [], textFields: [] });
    expect(t.variants["2"].fields.map((field) => [field.roleIndex, field.type, field.pageIndex, field.required, field.source])).toEqual([
      [0, "signature", 3, true, "manual"],
      [1, "signature", 3, true, "manual"],
      [0, "initials", 0, true, "manual"],
    ]);
    expect(t.variants["2"].textFields[0]).toMatchObject({ type: "text", label: "Nombre", required: false, source: "manual" });
    expect(await getTemplate(t.id)).toEqual(t);
  });

  it("con las plantillas migradas Firmar sigue funcionando: 'ready' (el firmante 1 sirve para 1) y se aplican igual", async () => {
    const out = await migrateLocalTemplates({ storage: storageWith([legacy("a")]), newId });
    if (out.status !== "ok") throw new Error("debía migrar");
    const t = out.created[0];
    expect(statusOfTemplate(t)).toMatchObject({ state: "ready", usesFallbackForOne: true });
    const two = applyTemplate(t, { signers: 2 });
    expect(two.fields).toHaveLength(3);
    const one = applyTemplate(t, { signers: 1 });
    expect(one.fields).toHaveLength(2);
    expect(one.warnings).toEqual([{ code: "fallbackFromTwoSigners", droppedFields: 1 }]);
  });

  it("1 firmante → variante «1» y un solo rol", async () => {
    const out = await migrateLocalTemplates({ storage: storageWith([legacy("one", { signers: [{ name: "" }], fields: [{ signerIndex: 0, pageIndex: 1, type: "signature", rect: R(0.2, 0.5, 0.25, 0.05) }] })]), newId });
    if (out.status !== "ok") throw new Error("debía migrar");
    const t = out.created[0];
    expect(t.roles).toEqual([{ key: "signer1", label: "Asegurado" }]);
    expect(t.variants["1"].fields).toHaveLength(1);
    expect(t.variants["2"].fields).toHaveLength(0);
    expect(statusOfTemplate(t).state).toBe("single");
  });

  it("sin firmantes pero con campos: usa el nº de firmante más alto; más de 2 → se descartan los demás y se cuentan", async () => {
    const out = await migrateLocalTemplates({
      storage: storageWith([
        legacy("zero", { signers: [], fields: [{ signerIndex: 1, pageIndex: 0, type: "signature", rect: R(0.2, 0.5, 0.25, 0.05) }] }),
        legacy("three", { signers: [{ name: "A" }, { name: "B" }, { name: "C" }], fields: [{ signerIndex: 2, pageIndex: 0, type: "signature", rect: R(0.2, 0.5, 0.25, 0.05) }, { signerIndex: 0, pageIndex: 0, type: "signature", rect: R(0.2, 0.6, 0.25, 0.05) }] }),
      ]),
      newId,
    });
    if (out.status !== "ok") throw new Error("debía migrar");
    expect(out.created[0].roles).toHaveLength(2);
    expect(out.created[0].variants["2"].fields[0].roleIndex).toBe(1);
    expect(out.created[1].roles.map((role) => role.label)).toEqual(["A", "B"]);
    expect(out.created[1].variants["2"].fields).toHaveLength(1);
    expect(out.droppedFields).toBe(1);
  });

  it("rects ligeramente fuera de 0..1 se recortan; sin tamaño se descartan y se cuentan", async () => {
    const out = await migrateLocalTemplates({
      storage: storageWith([
        legacy("edge", {
          fields: [
            { signerIndex: 0, pageIndex: 0, type: "signature", rect: { x: 0.9, y: 0.95, width: 0.115, height: 0.06 } },
            { signerIndex: 0, pageIndex: 1, type: "signature", rect: { x: 1.005, y: 0.1, width: 0.1, height: 0.1 } },
            { signerIndex: 0, pageIndex: 2, type: "signature", rect: { x: -0.005, y: 0.1, width: 0.1, height: 0.1 } },
          ],
          textFields: [],
        }),
      ]),
      newId,
    });
    if (out.status !== "ok") throw new Error("debía migrar");
    const fields = out.created[0].variants["2"].fields;
    expect(fields).toHaveLength(2);
    expect(fields[0].rect.x + fields[0].rect.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(fields[0].rect.y + fields[0].rect.height).toBeLessThanOrEqual(1 + 1e-9);
    expect(fields[1].rect.x).toBe(0);
    expect(out.droppedFields).toBe(1);
  });

  it("tipos de campo de texto y etiquetas (limpias, recortadas)", async () => {
    const out = await migrateLocalTemplates({
      storage: storageWith([
        legacy("txt", {
          textFields: [
            { pageIndex: 0, rect: R(0.1, 0.1, 0.2, 0.02), type: "date", label: "Fecha" },
            { pageIndex: 0, rect: R(0.1, 0.2, 0.2, 0.02), type: "checkbox" },
            { pageIndex: 0, rect: R(0.1, 0.3, 0.2, 0.02), label: `a‮b\n${"x".repeat(400)}` },
          ],
        }),
      ]),
      newId,
    });
    if (out.status !== "ok") throw new Error("debía migrar");
    const texts = out.created[0].variants["2"].textFields;
    expect(texts.map((field) => field.type)).toEqual(["date", "checkbox", "text"]);
    expect(texts[1].label).toBe("");
    expect(texts[2].label.length).toBeLessThanOrEqual(120);
    expect(texts[2].label).not.toMatch(/[‮\n]/);
  });

  it("entradas dañadas se saltan (y se cuentan) sin impedir las demás; JSON hostil no contamina", async () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"id":"h","name":"Hostil","savedAt":"2026-01-15T12:00:00.000Z","signers":[{"name":"A"}],"fields":[],"textFields":[],"constructor":{"x":1}}') as Legacy;
    const storage = storageWith([
      legacy("ok-1"),
      null,
      5,
      "x",
      legacy("bad-name", { name: "" }),
      legacy("bad-date", { savedAt: "ayer" }),
      legacy("bad-fields", { fields: "x" }),
      legacy("bad-field", { fields: [{ signerIndex: 0, pageIndex: -1, type: "signature", rect: R(0.1, 0.1, 0.1, 0.1) }] }),
      legacy("bad-type", { fields: [{ signerIndex: 0, pageIndex: 0, type: "stamp", rect: R(0.1, 0.1, 0.1, 0.1) }] }),
      legacy("bad-text", { textFields: [{ pageIndex: 0, rect: R(0.1, 0.1, 0.1, 0.1), type: "number" }] }),
      legacy("", {}),
      hostile,
      legacy("ok-2"),
    ]);
    const out = await migrateLocalTemplates({ storage, newId });
    if (out.status !== "ok") throw new Error("debía migrar");
    expect(out.created.map((template) => template.origin && "legacyId" in template.origin && template.origin.legacyId)).toEqual(["ok-1", "h", "ok-2"]);
    expect(out.skipped).toBe(10);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("migrateLocalTemplates: idempotencia y reasignación", () => {
  it("llamarla otra vez no repite nada y NO borra los originales", async () => {
    const storage = storageWith([legacy("a"), legacy("b")]);
    const before = storage.map.get(LEGACY_TEMPLATES_STORAGE_KEY);
    const first = await migrateLocalTemplates({ storage, newId });
    const second = await migrateLocalTemplates({ storage, newId });
    expect(first.status === "ok" && first.created).toHaveLength(2);
    expect(second).toMatchObject({ status: "ok", created: [], alreadyMigrated: ["a", "b"], failed: 0 });
    expect((await listTemplates()).templates).toHaveLength(2);
    expect(storage.map.get(LEGACY_TEMPLATES_STORAGE_KEY)).toBe(before);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("si se añade otra plantilla antigua después, solo migra la nueva", async () => {
    const storage = storageWith([legacy("a")]);
    await migrateLocalTemplates({ storage, newId });
    storage.map.set(LEGACY_TEMPLATES_STORAGE_KEY, JSON.stringify({ version: 1, templates: [legacy("a"), legacy("b")] }));
    const out = await migrateLocalTemplates({ storage, newId });
    expect(out).toMatchObject({ status: "ok", alreadyMigrated: ["a"] });
    expect(out.status === "ok" && out.created).toHaveLength(1);
  });

  it("dos entradas con el mismo id antiguo se migran una sola vez", async () => {
    const out = await migrateLocalTemplates({ storage: storageWith([legacy("dup"), legacy("dup", { name: "Otra" })]), newId });
    expect(out).toMatchObject({ status: "ok", alreadyMigrated: ["dup"] });
    expect(out.status === "ok" && out.created).toHaveLength(1);
  });

  it("una plantilla migrada se puede reasignar a un documento", async () => {
    await putDocument(sampleInput("d1"), sampleBytes(16));
    const out = await migrateLocalTemplates({ storage: storageWith([legacy("a")]), newId });
    if (out.status !== "ok") throw new Error("debía migrar");
    const moved = await attachTemplate(out.created[0].id, "d1");
    expect(moved.documentId).toBe("d1");
    // Seguir siendo «ya migrada» después de reasignarla.
    expect(await migrateLocalTemplates({ storage: storageWith([legacy("a")]), newId })).toMatchObject({ alreadyMigrated: ["a"] });
  });

  it("biblioteca llena: lo que no cabe cuenta como `failed` y se reintenta en la siguiente llamada", async () => {
    const storage = storageWith([legacy("a"), legacy("b")]);
    let calls = 0;
    const flaky = () => {
      calls += 1;
      return `mig-flaky-${calls}`;
    };
    const original = IDBObjectStore.prototype.put;
    let fail = true;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (fail && this.name === "templates") throw new DOMException("sin espacio", "QuotaExceededError");
      return original.apply(this, args);
    });
    const first = await migrateLocalTemplates({ storage, newId: flaky });
    expect(first).toMatchObject({ status: "ok", failed: 2, created: [] });
    fail = false;
    const second = await migrateLocalTemplates({ storage, newId: flaky });
    expect(second.status === "ok" && second.created).toHaveLength(2);
  });
});

describe("markMigrated (solo cuando la persona lo confirma)", () => {
  it("borra de localStorage SOLO las ya migradas y deja las que no se pudieron migrar", async () => {
    const broken = legacy("broken", { name: "" });
    const storage = storageWith([legacy("a"), broken, legacy("b")]);
    await migrateLocalTemplates({ storage, newId });
    const out = await markMigrated({ storage });
    expect(out).toEqual({ status: "ok", removed: 2, kept: 1 });
    expect(JSON.parse(storage.map.get(LEGACY_TEMPLATES_STORAGE_KEY)!)).toEqual({ version: 1, templates: [broken] });
    // Lo migrado sigue en la biblioteca.
    expect((await listTemplates()).templates).toHaveLength(2);
    // Una segunda confirmación no borra nada más.
    expect(await markMigrated({ storage })).toEqual({ status: "ok", removed: 0, kept: 1 });
  });

  it("si todo estaba migrado, elimina la clave entera", async () => {
    const storage = storageWith([legacy("a")]);
    await migrateLocalTemplates({ storage, newId });
    expect(await markMigrated({ storage })).toEqual({ status: "ok", removed: 1, kept: 0 });
    expect(storage.map.has(LEGACY_TEMPLATES_STORAGE_KEY)).toBe(false);
    expect(await markMigrated({ storage })).toEqual({ status: "none", removed: 0, kept: 0 });
  });

  it("sin haber migrado antes no borra nada", async () => {
    const storage = storageWith([legacy("a"), legacy("b")]);
    const before = storage.map.get(LEGACY_TEMPLATES_STORAGE_KEY);
    expect(await markMigrated({ storage })).toEqual({ status: "ok", removed: 0, kept: 2 });
    expect(storage.map.get(LEGACY_TEMPLATES_STORAGE_KEY)).toBe(before);
  });

  it("datos corruptos: no toca nada", async () => {
    const storage = new FakeStorage();
    storage.map.set(LEGACY_TEMPLATES_STORAGE_KEY, "{roto");
    expect(await markMigrated({ storage })).toEqual({ status: "corrupt", removed: 0, kept: 0 });
    expect(storage.map.get(LEGACY_TEMPLATES_STORAGE_KEY)).toBe("{roto");
  });

  it("si localStorage falla al escribir, no promete haber borrado", async () => {
    const storage = storageWith([legacy("a")]);
    await migrateLocalTemplates({ storage, newId });
    storage.removeItem.mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError");
    });
    expect(await markMigrated({ storage })).toEqual({ status: "unavailable", removed: 0, kept: 1 });
    expect(storage.map.has(LEGACY_TEMPLATES_STORAGE_KEY)).toBe(true);
  });
});
