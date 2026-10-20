import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearLibrary, getDocumentBytes, listDocuments } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import { readPackage } from "@/lib/backup/package";
import { applyLibraryImport, defaultLibraryDecisions, loadLibraryExisting, planLibraryImport } from "@/lib/backup/modules/library";
import { exportBlob, fakePdf, freshLibrary, planOf, seedDoc, seedTemplate, snapshotLibrary } from "@/lib/backup/__fixtures__/libraryKit";

/**
 * El mismo recorrido que `library.test.ts` pero en jsdom (proyecto "components"): ahí `TextEncoder`/`Uint8Array`/`Blob`
 * son de dominios distintos y JSZip/WebCrypto/IndexedDB se comportan distinto. Las hojas de «Mis documentos» corren aquí.
 */

beforeEach(() => {
  freshLibrary();
});

describe("módulo library en jsdom", () => {
  for (const password of [undefined, "contraseña de prueba"]) {
    it(`ida y vuelta ${password ? "cifrada" : "en claro"}: exportar → vaciar → importar → idéntico`, async () => {
      await seedDoc("a", 1, { pages: 4 });
      await seedDoc("b", 2);
      await seedTemplate("a", {}, "tpl-a");
      const before = await snapshotLibrary();
      const blob = await exportBlob(password);
      await clearLibrary();
      const plan = await planOf(blob, {}, password);
      expect(plan.counts).toEqual({ new: 2, identical: 0, different: 0, invalid: 0 });
      expect(await applyLibraryImport(plan, defaultLibraryDecisions(plan))).toMatchObject({ ok: true, documents: 2, templates: 1 });
      const after = await snapshotLibrary();
      expect(after.documents.map((d) => ({ ...d, rev: undefined }))).toEqual(before.documents.map((d) => ({ ...d, rev: undefined })));
      expect((await listTemplates()).templates.map((t) => t.id)).toEqual(["tpl-a"]);
      expect(Array.from((await getDocumentBytes("a")) ?? [])).toEqual(Array.from(fakePdf(1)));
      // Y otra vez: todo «Ya lo tienes».
      const again = await planOf(blob, {}, password);
      expect(again.counts).toMatchObject({ identical: 2, new: 0 });
    });
  }

  it("los dorados se leen y se importan también en jsdom", async () => {
    const dir = path.resolve(__dirname, "../__fixtures__/packages");
    const blob = new Blob([new Uint8Array(readFileSync(path.join(dir, "library-v1.optimuspdf.zip")))]);
    const plan = await planLibraryImport(await readPackage(blob), await loadLibraryExisting());
    expect(await applyLibraryImport(plan, defaultLibraryDecisions(plan))).toMatchObject({ ok: true, documents: 3, templates: 2 });
    expect((await listDocuments()).documents).toHaveLength(3);
  });
});
