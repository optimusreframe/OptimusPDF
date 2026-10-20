import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetLibraryForTests, clearLibrary, getDocumentBytes } from "@/lib/docLibrary/store";
import { applyEverything, defaultEverythingDecisions, exportEverything, readAndPlanEverything } from "@/lib/backup/globalPackage";
import { seedDoc } from "@/lib/backup/__fixtures__/libraryKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";

/**
 * H1 por la ruta REAL (exportEverything → readAndPlanEverything → applyEverything) con los módulos de verdad: una biblioteca
 * de 130 MiB de PDF, cifrada o no, se exporta, se lee, se planifica y se vuelve a importar. Era el caso que daba `bomb`.
 */

const PASS = { validatePdf: async () => true, validateImage: async () => true } as const;

beforeEach(async () => {
  window.localStorage.clear();
  __resetLibraryForTests();
  await clearLibrary();
});

describe("H1 — la biblioteca de 130 MiB se puede reimportar (por la vía global)", () => {
  for (const password of [undefined, "clave-larga-123"]) {
    it(`${password ? "CIFRADA" : "sin cifrar"}: exporta, lee, planifica y aplica`, async () => {
      await seedDoc("big-a", 1, { size: 65 * 1024 * 1024 });
      await seedDoc("big-b", 2, { size: 65 * 1024 * 1024 });
      const exported = await exportEverything({ modules: { library: true }, password });
      if (!exported.ok) throw new Error(exported.reason);
      expect(exported.counts.documents).toBe(2);
      expect(exported.blob.size).toBeGreaterThan(125 * 1024 * 1024);
      const before = [await getDocumentBytes("big-a"), await getDocumentBytes("big-b")].map((bytes) => bytes?.length);
      await clearLibrary();
      const read = await readAndPlanEverything(asFile(exported.blob), password, PASS);
      if (!read.ok) throw new Error(`${read.reason}/${read.code}`);
      expect(read.modules).toMatchObject([{ module: "library", state: "ok", counts: { new: 2, invalid: 0 } }]);
      const applied = await applyEverything(read.plans, defaultEverythingDecisions(read.plans));
      expect(applied.failed).toEqual([]);
      expect([await getDocumentBytes("big-a"), await getDocumentBytes("big-b")].map((bytes) => bytes?.length)).toEqual(before);
    }, 300_000);
  }
});
