import "fake-indexeddb/auto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/crypto/sha256";
import { getDocument, getDocumentBytes, listDocuments } from "@/lib/docLibrary/store";
import { listTemplates, statusOfTemplate } from "@/lib/docLibrary/templatesStore";
import { readPackage } from "@/lib/backup/package";
import { applyLibraryImport, defaultLibraryDecisions, loadLibraryExisting, planLibraryImport } from "@/lib/backup/modules/library";
import { freshLibrary } from "@/lib/backup/__fixtures__/libraryKit";

/**
 * Paquetes «dorados» del módulo «library» (plantillas + documentos): archivos generados con la versión PUBLICADA del formato
 * (esquema 1) y guardados en `__fixtures__/packages/`. Prueba de no regresión (§9.3): todo dorado tiene que seguir
 * importándose. NO se regeneran; cuando haya un esquema 2 se AÑADE `library-v2…zip` junto al v1.
 * Llevan contratos sintéticos REALES (PDF de pdf-lib con su huella de pdf.js), así que también se importan en la interfaz.
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");
const PASSWORD = "dorada-2026";
const goldens = readdirSync(DIR).filter((f) => f.startsWith("library-") && f.endsWith(".optimuspdf.zip")).sort();

beforeEach(() => {
  freshLibrary();
});

function open(name: string): Blob {
  return new Blob([new Uint8Array(readFileSync(path.join(DIR, name)))]);
}

describe("paquetes dorados del módulo library", () => {
  it("existe el dorado v1 (en claro y cifrado)", () => {
    expect(goldens).toEqual(["library-v1-encrypted.optimuspdf.zip", "library-v1.optimuspdf.zip"]);
  });

  for (const name of goldens) {
    it(`${name}: se lee, se planifica y se importa con los datos exactos`, async () => {
      const encrypted = name.includes("-encrypted");
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      expect(read).toMatchObject({ formatVersion: 1, encrypted, app: { version: "0.1.0", build: "golden" } });
      expect(read.createdAt).toBe("2026-10-15T12:00:00.000Z");
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status, m.meta])).toEqual([["library", 1, "ok", { documents: 3, templates: 2 }]]);
      expect(read.warnings).toEqual([]);

      const plan = await planLibraryImport(read, await loadLibraryExisting());
      expect(plan.state).toBe("ok");
      expect(plan.items.map((i) => [i.key, i.status, i.name, i.pageCount, i.templates.map((t) => t.id)])).toEqual([
        ["golden-doc-a", "new", "Contrato dorado A", 3, ["golden-tpl-a"]],
        ["golden-doc-b", "new", "Contrato dorado B", 2, ["golden-tpl-b"]],
        ["golden-doc-c", "new", "Contrato dorado C", 2, []],
      ]);
      expect(await applyLibraryImport(plan, defaultLibraryDecisions(plan))).toMatchObject({ ok: true, documents: 3, templates: 2, reassigned: 0 });

      const docs = (await listDocuments()).documents;
      expect(docs.map((d) => d.id)).toEqual(["golden-doc-c", "golden-doc-b", "golden-doc-a"]);
      const a = (await getDocument("golden-doc-a"))!;
      expect(a.createdAt).toBe("2026-10-01T10:00:00.000Z");
      expect(a.updatedAt).toBe("2026-10-01T10:00:00.000Z");
      expect(a.templateIds).toEqual(["golden-tpl-a"]);
      expect(a.fingerprint.exact).toBe(await sha256Hex((await getDocumentBytes("golden-doc-a"))!));
      expect(a.fingerprint.pages).toHaveLength(3);
      const templates = (await listTemplates()).templates;
      expect(templates.map((t) => [t.id, t.documentId, t.name, t.createdAt, statusOfTemplate(t).state])).toEqual([
        ["golden-tpl-b", "golden-doc-b", "Plantilla dorada B", "2026-10-05T10:00:00.000Z", "single"],
        ["golden-tpl-a", "golden-doc-a", "Plantilla dorada A", "2026-10-04T10:00:00.000Z", "ready"],
      ]);

      // Y volver a importarlo es «Ya lo tienes» en los tres.
      const again = await planLibraryImport(await readPackage(open(name), encrypted ? PASSWORD : undefined), await loadLibraryExisting());
      expect(again.counts).toEqual({ new: 0, identical: 3, different: 0, invalid: 0 });
    });
  }

  it("el dorado cifrado no se abre sin contraseña ni con una mala", async () => {
    await expect(readPackage(open("library-v1-encrypted.optimuspdf.zip"))).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(open("library-v1-encrypted.optimuspdf.zip"), "nope")).rejects.toMatchObject({ code: "wrongPassword" });
  });
});
