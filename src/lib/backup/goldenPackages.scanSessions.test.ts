import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/crypto/sha256";
import { readPackage } from "@/lib/backup/package";
import { applyScanSessionsImport, defaultScanSessionDecisions, planScanSessionsImport } from "@/lib/backup/modules/scanSessions";
import { GOLDEN_SCAN_IDS, GOLDEN_SCAN_NOW } from "@/lib/backup/__fixtures__/goldenScan";
import { bytesOf, resetScanStore } from "@/lib/backup/__fixtures__/scanKit";
import { listScanSessionSummaries, scanSessionStore } from "@/lib/scan/sessionStore";

/**
 * Dorados de «Escaneos en curso» (`__fixtures__/packages/scan-sessions-v1*.zip`), generados con el codigo de
 * `__fixtures__/goldenScan.ts` y NUNCA regenerados: si una prueba de aqui falla, se rompio la compatibilidad de un formato
 * publicado (cuando exista el esquema 2 se AÑADE su dorado junto al v1). Contrasena de los cifrados: `dorada-2026`. Que se
 * abren sin avisos lo cubre `goldenPackages.test.ts`, que itera TODOS los dorados.
 *
 * Los SHA-256 de las fotos de aqui abajo son los de los archivos publicados (no se recalculan con codigo actual).
 */

const DIR = path.resolve(__dirname, "__fixtures__/packages");
const PASSWORD = "dorada-2026";
const open = (name: string) => new Blob([new Uint8Array(readFileSync(path.join(DIR, name)))]);

const PHOTO_SHA256: Record<string, string> = {
  "scan-sessions/s1-p1.jpg": "d4aff1ec3e5764a207f66f89e76b1364227466ec7078f8f961e751ca731eedf2",
  "scan-sessions/s1-p2.png": "a87647ff678e1e389466fc0cbe382946a548cb7e81a257d067024eef384f80e3",
  "scan-sessions/s1-p3.jpg": "41725746519223f1fc6c0c9aba3cf6c675b7863078b8ab37cfc8106d53fbf7b8",
  "scan-sessions/s2-p1.jpg": "0e413c0183bd83043287c88f5d517af229c240fb8340b075a6ca253c90652719",
};

beforeEach(async () => {
  await resetScanStore();
});

describe("dorados de escaneos en curso", () => {
  for (const name of ["scan-sessions-v1.optimuspdf.zip", "scan-sessions-v1-encrypted.optimuspdf.zip"]) {
    const encrypted = name.includes("encrypted");

    it(`${name}: el modulo scan-sessions con esquema 1, sus fotos intactas y sin avisos`, async () => {
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      expect(read).toMatchObject({ formatVersion: 1, encrypted, app: { version: "0.1.0", build: "golden" }, createdAt: "2026-10-15T12:00:00.000Z" });
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status])).toEqual([["scan-sessions", 1, "ok"]]);
      expect(read.modules[0].meta).toEqual({ sessions: 2, pages: 4 });
      expect(read.warnings).toEqual([]);
      for (const [file, sha] of Object.entries(PHOTO_SHA256)) {
        const entry = read.modules[0].files.get(file);
        expect(entry?.status, file).toBe("ok");
        expect(await sha256Hex(entry!.bytes!), file).toBe(sha);
      }
    });

    it(`${name}: se planifica (dos sesiones nuevas), se importa y queda cada sesion con sus parametros y fotos exactos`, async () => {
      const read = await readPackage(open(name), encrypted ? PASSWORD : undefined);
      const plan = await planScanSessionsImport(read, { now: GOLDEN_SCAN_NOW });
      expect(plan.state).toBe("ok");
      expect(plan.counts).toEqual({ new: 2, identical: 0, different: 0, invalid: 0 });
      expect(plan.items.map((i) => [i.id, i.status, i.name, i.pageCount, i.discardedPages])).toEqual([
        [GOLDEN_SCAN_IDS.contract, "new", "Contrato de servicio (dorado)", 3, 0],
        [GOLDEN_SCAN_IDS.receipt, "new", "Recibo (dorado)", 1, 0],
      ]);
      const result = await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan), { now: GOLDEN_SCAN_NOW });
      expect(result).toMatchObject({ ok: true, written: 2, failed: 0, changed: 0 });

      const contract = await scanSessionStore.load(GOLDEN_SCAN_IDS.contract);
      if (!contract) throw new Error("falta el contrato");
      expect(contract).toMatchObject({
        name: "Contrato de servicio (dorado)",
        createdAt: "2026-10-14T09:00:00.000Z",
        updatedAt: "2026-10-14T09:05:00.000Z",
        settings: { mode: "id-card", autoCapture: false, batch: false, defaultFilter: "grayscale", searchable: true },
        nameSuggested: { title: "Contrato de servicio", date: "2026-10-14", source: "ocr", name: "Contrato de servicio · 2026-10-14" },
      });
      expect(contract.lostPages).toBeUndefined();
      expect(contract.pages.map((p) => p.id)).toEqual(["pg-golden-1", "pg-golden-2", "pg-golden-3"]);
      const [first, second, third] = contract.pages;
      expect(first).toMatchObject({
        source: "camera",
        originalWidth: 64,
        originalHeight: 80,
        rotation: 90,
        filter: "bw",
        adjust: { brightness: 0.25, contrast: -0.5 },
        flags: { blurry: true },
        ocrText: "Texto reconocido de la primera pagina\nsegunda linea",
        mode: "document",
        resolvedFilter: "bw",
        jpegSample: { side: 256, bytesPerPixel: 0.4, qualityRatio: { "0.8": 0.7 } },
      });
      expect(first.corners).toEqual({ topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.12 }, bottomRight: { x: 0.88, y: 0.9 }, bottomLeft: { x: 0.12, y: 0.88 } });
      expect(second).toMatchObject({ source: "library", corners: null, mode: "id-card", originalWidth: 24, originalHeight: 30 });
      expect(third.flags).toEqual({ noDocument: true });
      expect(first.original.type).toBe("image/jpeg");
      expect(second.original.type).toBe("image/png");
      for (const [index, file] of ["scan-sessions/s1-p1.jpg", "scan-sessions/s1-p2.png", "scan-sessions/s1-p3.jpg"].entries()) {
        expect(await sha256Hex(await bytesOf(contract.pages[index].original)), file).toBe(PHOTO_SHA256[file]);
      }
      const receipt = await scanSessionStore.load(GOLDEN_SCAN_IDS.receipt);
      expect(await sha256Hex(await bytesOf(receipt!.pages[0].original))).toBe(PHOTO_SHA256["scan-sessions/s2-p1.jpg"]);

      // Y volver a importarlo es «Ya lo tienes»: no escribe nada.
      const before = (await listScanSessionSummaries()).map((s) => [s.id, s.savedAt]);
      const again = await planScanSessionsImport(read, { now: GOLDEN_SCAN_NOW });
      expect(again.counts).toEqual({ new: 0, identical: 2, different: 0, invalid: 0 });
      expect(await applyScanSessionsImport(again, defaultScanSessionDecisions(again), { now: GOLDEN_SCAN_NOW })).toMatchObject({ ok: true, written: 0 });
      expect((await listScanSessionSummaries()).map((s) => [s.id, s.savedAt])).toEqual(before);
    });
  }

  it("los dorados caducan a los 14 dias como cualquier escaneo: con el reloj de hoy se rechazan («caducado»), no se importan", async () => {
    const read = await readPackage(open("scan-sessions-v1.optimuspdf.zip"));
    const plan = await planScanSessionsImport(read, { now: GOLDEN_SCAN_NOW + 15 * 24 * 60 * 60 * 1000 });
    expect(plan.items.map((i) => [i.status, i.reason])).toEqual([["invalid", "expired"], ["invalid", "expired"]]);
  });

  it("el dorado cifrado no se abre sin contraseña ni con una mala", async () => {
    await expect(readPackage(open("scan-sessions-v1-encrypted.optimuspdf.zip"))).rejects.toMatchObject({ code: "needsPassword" });
    await expect(readPackage(open("scan-sessions-v1-encrypted.optimuspdf.zip"), "nope")).rejects.toMatchObject({ code: "wrongPassword" });
  });
});
