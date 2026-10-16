import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSignTemplatesCacheForTests, listTemplates as listLegacyTemplates, refreshSignTemplates, saveTemplate } from "@/app/sign-pdf/signTemplates";
import { applyTemplate } from "./templateApply";
import { markMigrated, migrateLocalTemplates } from "./templateLegacy";
import { __resetLibraryForTests } from "./store";
import { listTemplates } from "./templatesStore";

/**
 * `.test.tsx` a propósito (único entorno con `window.localStorage` real): las plantillas ANTIGUAS se crean con el código
 * REAL de `signTemplates.ts` (`saveTemplate`), se migran a la biblioteca con el `localStorage` de verdad, y se comprueba
 * que `markMigrated` + `refreshSignTemplates` dejan la interfaz antigua al día.
 */

beforeEach(() => {
  window.localStorage.clear();
  __resetSignTemplatesCacheForTests();
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});

const signers = [
  { id: "sg-1", name: "Ana", color: "#0d4bff" },
  { id: "sg-2", name: "Luis", color: "#ff0000" },
];

function saveReal(name: string) {
  const result = saveTemplate({
    name,
    pageCount: 4,
    signers,
    fields: [
      { id: "f1", signerId: "sg-1", pageIndex: 3, type: "signature", rect: { x: 0.16, y: 0.5, width: 0.25, height: 0.05 } },
      { id: "f2", signerId: "sg-2", pageIndex: 3, type: "signature", rect: { x: 0.55, y: 0.5, width: 0.25, height: 0.05 } },
      { id: "f3", signerId: "sg-1", pageIndex: 0, type: "initials", rect: { x: 0.79, y: 0.84, width: 0.05, height: 0.03 } },
    ],
    textFields: [{ id: "t1", pageIndex: 0, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.025 }, label: "Nombre", source: "manual", confidence: "high" }],
  });
  expect(result).toBe("ok");
}

describe("migración de plantillas REALES de localStorage", () => {
  it("las plantillas guardadas por saveTemplate se migran, se aplican y markMigrated limpia la interfaz antigua", async () => {
    saveReal("Contrato A");
    saveReal("Contrato B");
    expect(listLegacyTemplates()).toHaveLength(2);

    const migrated = await migrateLocalTemplates();
    expect(migrated.status).toBe("ok");
    if (migrated.status !== "ok") return;
    expect(migrated.created.map((template) => template.name).sort()).toEqual(["Contrato A", "Contrato B"]);
    expect(migrated.skipped).toBe(0);
    // Las originales siguen ahí hasta confirmar.
    expect(listLegacyTemplates()).toHaveLength(2);
    expect(await migrateLocalTemplates()).toMatchObject({ status: "ok", created: [], alreadyMigrated: expect.any(Array) });

    const applied = applyTemplate(migrated.created[0], { signers: 2 });
    expect(applied.fields).toHaveLength(3);
    expect(applied.textFields[0]).toMatchObject({ label: "Nombre", pageIndex: 0 });

    // El usuario confirma: se borran de localStorage y la lista reactiva antigua se refresca.
    expect(await markMigrated()).toEqual({ status: "ok", removed: 2, kept: 0 });
    expect(window.localStorage.getItem("optimuspdf.signTemplates")).toBeNull();
    expect(listLegacyTemplates()).toHaveLength(2); // la caché antigua aún no lo sabe…
    refreshSignTemplates();
    expect(listLegacyTemplates()).toHaveLength(0); // …hasta que se refresca
    expect((await listTemplates()).templates).toHaveLength(2);
  });
});
