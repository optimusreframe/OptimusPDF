import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/crypto/sha256";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  LARGE_SCAN_BYTES,
  __setScanSessionBytesCapForTests,
  __setScanSessionsPackageBudgetForTests,
  applyScanSessionsImport,
  checkScanSessionsLimits,
  defaultScanSessionDecisions,
  exportScanSessions,
  exportScanSessionsDetailed,
  planScanSessionsImport,
  scanSelectionFits,
  summarizeScanSessions,
  type ScanSessionsImportPlan,
} from "@/lib/backup/modules/scanSessions";
import { bytesBlob, bytesOf, resetScanStore, scanPage, scanSession, seedScanSession, seedSimpleSession } from "@/lib/backup/__fixtures__/scanKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";
import { SCAN_SESSION_TTL_MS, __resetScanStoreMemoryForTests, __setScanStoreLimitsForTests, __setScanTabIdForTests, isValidScanSessionId, listScanSessionSummaries, scanSessionStore } from "@/lib/scan/sessionStore";
import { isSessionId } from "@/lib/backup/modules/scanSessionsSchema";

/**
 * Modulo «Escaneos en curso» sobre IndexedDB falso y el almacen REAL del Escaner: resumen previo, exportar (formato, topes,
 * sesion a sesion), ida y vuelta (con y sin contrasena), fusion (nueva / identica / distinta / conservar ambas), caducidad,
 * limites y cambios concurrentes. Las fotos son JPEG reales y sinteticos.
 */

const PASSWORD = "clave de prueba 1";
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetScanStore();
  __setScanSessionsPackageBudgetForTests(undefined);
  __setScanSessionBytesCapForTests(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __setScanSessionsPackageBudgetForTests(undefined);
  __setScanSessionBytesCapForTests(undefined);
  __setScanStoreLimitsForTests();
});

async function roundTrip(password?: string, ids?: string[]) {
  const { module, report } = await exportScanSessionsDetailed({ ids });
  const blob = await buildPackage({ modules: [module], password });
  const read = await readPackage(asFile(blob), password);
  return { module, report, read, blob };
}

/** Lo que hay guardado, con el SHA-256 de cada original (para comparar sin fiarse del id). */
async function snapshotOf(id: string) {
  const loaded = await scanSessionStore.load(id);
  if (!loaded) return null;
  const hashes: string[] = [];
  for (const page of loaded.pages) hashes.push(await sha256Hex(await bytesOf(page.original)));
  return { loaded, hashes };
}

describe("el nombre del modulo y los ids", () => {
  it("el nombre del paquete cumple la regla del contenedor (minusculas y guiones) aunque la interfaz lo llame scanSessions", async () => {
    await seedSimpleSession("Uno", 1);
    const { module } = await exportScanSessionsDetailed();
    expect(module.name).toBe("scan-sessions");
    expect(module.name).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
  });

  it("isSessionId (esquema) acepta y rechaza exactamente lo mismo que isValidScanSessionId (almacen)", () => {
    const samples = [
      "sc-abc12345", "sc-mgx3k2q1-1a7f3k", "abcdefgh", "ABCDEFGH", "sc-", "sc-abc", "x".repeat(64), "x".repeat(65), "-abcdefgh",
      "sc-abc/../x", "sc-abc 123", "sc-abc\n123", "", "__proto__", "constructor", "sc-ábc12345", "0".repeat(8), "a-b-c-d-e-f-g-h",
    ];
    for (const sample of samples) expect(isSessionId(sample), sample).toBe(isValidScanSessionId(sample));
    for (const sample of [undefined, null, 5, {}, []]) expect(isSessionId(sample)).toBe(false);
  });
});

describe("resumen previo (summarizeScanSessions)", () => {
  it("sin sesiones: todo a cero y nada que cifrar", async () => {
    const summary = await summarizeScanSessions();
    expect(summary).toMatchObject({ ok: true, sessions: [], total: { count: 0, pages: 0, bytes: 0 }, containsClientData: false, encryptionRecommended: false, fitsInPackage: true });
  });

  it("cuenta sesiones, paginas y los bytes de las fotos originales, de la mas reciente a la mas antigua, y recomienda cifrar", async () => {
    const a = await seedSimpleSession("Contrato A", 3, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await seedSimpleSession("Contrato B", 2, 10);
    const summary = await summarizeScanSessions();
    if (!summary.ok) throw new Error("esperaba ok");
    expect(summary.sessions.map((s) => [s.id, s.name, s.pageCount])).toEqual([
      [b.id, "Contrato B", 2],
      [a.id, "Contrato A", 3],
    ]);
    const expected = async (session: { pages: { original: Blob }[] }) => session.pages.reduce((sum, page) => sum + page.original.size, 0);
    expect(summary.sessions[0].bytes).toBe(await expected(b.session));
    expect(summary.sessions[1].bytes).toBe(await expected(a.session));
    expect(summary.total).toEqual({ count: 2, pages: 5, bytes: summary.sessions[0].bytes + summary.sessions[1].bytes });
    expect(summary.containsClientData).toBe(true);
    expect(summary.encryptionRecommended).toBe(true);
    expect(summary.fitsInPackage).toBe(true);
  });

  it("no lee ninguna foto (solo mide los Blob) y recuerda el tamano: pedirlo otra vez no vuelve a cargar la sesion", async () => {
    await seedSimpleSession("Contrato A", 2);
    const read = vi.spyOn(Blob.prototype, "arrayBuffer");
    const load = vi.spyOn(scanSessionStore, "load");
    await summarizeScanSessions();
    expect(read).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    await summarizeScanSessions();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("no ofrece las sesiones caducadas", async () => {
    await seedSimpleSession("Vieja", 1);
    const future = Date.now() + SCAN_SESSION_TTL_MS + DAY;
    const summary = await summarizeScanSessions({ now: future });
    expect(summary).toMatchObject({ ok: true, total: { count: 0 } });
  });

  it("avisa de lo que no cabe en un solo paquete (y de lo grande)", async () => {
    await seedSimpleSession("Contrato A", 3);
    __setScanSessionsPackageBudgetForTests(10);
    const summary = await summarizeScanSessions();
    if (!summary.ok) throw new Error("esperaba ok");
    expect(summary.fitsInPackage).toBe(false);
    expect(scanSelectionFits(summary.sessions)).toBe(false);
    expect(scanSelectionFits([])).toBe(true);
    expect(LARGE_SCAN_BYTES).toBe(100 * 1024 * 1024);
  });

  it("sin IndexedDB: unavailable (no lanza)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    try {
      expect(await summarizeScanSessions()).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("exportar", () => {
  it("escribe el indice y UNA foto por pagina con la ruta derivada de las referencias; sin miniaturas, sin rev/writerId/bytes/expiresAt", async () => {
    const { id, session } = await seedSimpleSession("Contrato A", 2, 1, { nameSuggested: { title: "Contrato", date: "2026-10-26", source: "ocr" } });
    const { module, report } = await exportScanSessionsDetailed();
    expect(report).toEqual({ sessions: 1, pages: 2, bytes: expect.any(Number), skippedSessions: 0, skippedPages: 0 });
    expect(module.meta).toEqual({ sessions: 1, pages: 2 });
    expect(module.files.map((file) => file.path)).toEqual(["scan-sessions/index.json", "scan-sessions/s1-p1.jpg", "scan-sessions/s1-p2.jpg"]);
    expect(module.files.slice(1).every((file) => file.type === "image/jpeg")).toBe(true);
    const index = JSON.parse(new TextDecoder().decode(module.files[0].data));
    expect(Object.keys(index)).toEqual(["sessions"]);
    const entry = index.sessions[0];
    expect(entry).toMatchObject({ ref: "s1", id, name: "Contrato A", settings: { mode: "document" }, nameSuggested: { title: "Contrato", date: "2026-10-26", source: "ocr" } });
    expect(Object.keys(entry).sort()).toEqual(["createdAt", "id", "name", "nameSuggested", "pages", "ref", "savedAt", "settings", "updatedAt"]);
    const page = entry.pages[0];
    expect(Object.keys(page).sort()).toEqual(["adjust", "corners", "createdAt", "file", "filter", "flags", "id", "mode", "originalHeight", "originalWidth", "ref", "rotation", "source"]);
    expect(page).toMatchObject({ ref: "p1", id: session.pages[0].id, file: "scan-sessions/s1-p1.jpg", rotation: 0, filter: "auto", mode: "document" });
    // Los bytes de la foto son EXACTAMENTE los del original (no se recodifica).
    expect(new Uint8Array(module.files[1].data)).toEqual(await bytesOf(session.pages[0].original));
    expect(new Uint8Array(module.files[2].data)).toEqual(await bytesOf(session.pages[1].original));
  });

  it("solo las sesiones pedidas con `ids`; sin sesiones el modulo sale vacio pero valido", async () => {
    const a = await seedSimpleSession("A", 1, 1);
    const b = await seedSimpleSession("B", 1, 5);
    const only = await exportScanSessionsDetailed({ ids: [b.id] });
    expect(only.report.sessions).toBe(1);
    expect(JSON.parse(new TextDecoder().decode(only.module.files[0].data)).sessions.map((s: { id: string }) => s.id)).toEqual([b.id]);
    const none = await exportScanSessionsDetailed({ ids: ["no-existe-0000"] });
    expect(none.report).toMatchObject({ sessions: 0, pages: 0 });
    expect((await exportScanSessions()).files.filter((file) => file.path !== "scan-sessions/index.json")).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
  });

  it("mas de 50 sesiones no caben en un paquete (tooLarge); elegir 50 si", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 51; index += 1) ids.push((await seedSimpleSession(`Sesion ${index}`, 1, index + 1)).id);
    await expect(exportScanSessionsDetailed()).rejects.toMatchObject({ code: "tooLarge" });
    const fifty = await exportScanSessionsDetailed({ ids: ids.slice(0, 50) });
    expect(fifty.report.sessions).toBe(50);
    const summary = await summarizeScanSessions();
    if (!summary.ok) throw new Error("esperaba ok");
    expect(summary.fitsInPackage).toBe(false);
  });

  it("NO exporta una sesion caducada", async () => {
    await seedSimpleSession("Vieja", 1);
    const { report } = await exportScanSessionsDetailed({ now: Date.now() + SCAN_SESSION_TTL_MS + DAY });
    expect(report.sessions).toBe(0);
  });

  it("procesa SESION A SESION: carga una, lee sus fotos y pasa a la siguiente (nunca todas a la vez)", async () => {
    await seedSimpleSession("A", 2, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedSimpleSession("B", 2, 10);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedSimpleSession("C", 2, 20);
    const events: string[] = [];
    const load = scanSessionStore.load;
    vi.spyOn(scanSessionStore, "load").mockImplementation(async (id) => {
      events.push("load");
      return load(id);
    });
    const arrayBuffer = Blob.prototype.arrayBuffer;
    vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
      events.push("read");
      return arrayBuffer.call(this);
    });
    await exportScanSessionsDetailed();
    expect(events).toEqual(["load", "read", "read", "load", "read", "read", "load", "read", "read"]);
  });

  it("si lo elegido no cabe en un paquete lanza tooLarge ANTES de leer ninguna foto", async () => {
    await seedSimpleSession("A", 3);
    __setScanSessionsPackageBudgetForTests(100);
    const read = vi.spyOn(Blob.prototype, "arrayBuffer");
    await expect(exportScanSessionsDetailed()).rejects.toMatchObject({ code: "tooLarge" });
    expect(read).not.toHaveBeenCalled();
  });

  it("lanza tooLarge si lo elegido pasa del numero de paginas de un paquete, y elegir menos sesiones lo arregla", async () => {
    const small = await seedSimpleSession("Pequena", 1);
    await seedSimpleSession("Grande", 3);
    __setScanSessionsPackageBudgetForTests(1500);
    const sizes = await summarizeScanSessions();
    if (!sizes.ok) throw new Error("esperaba ok");
    const smallBytes = sizes.sessions.find((s) => s.id === small.id)?.bytes ?? 0;
    __setScanSessionsPackageBudgetForTests(smallBytes + 10);
    await expect(exportScanSessionsDetailed()).rejects.toMatchObject({ code: "tooLarge" });
    await expect(exportScanSessionsDetailed({ ids: [small.id] })).resolves.toMatchObject({ report: { sessions: 1, pages: 1 } });
  });

  it("una pagina con la foto danada, de otro formato o vacia se queda fuera y se cuenta; la sesion viaja con las demas", async () => {
    const broken = scanPage(3, { original: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: "image/jpeg" }) });
    const text = scanPage(4, { original: new Blob(["no soy una foto"], { type: "image/jpeg" }) });
    const empty = scanPage(5, { original: new Blob([], { type: "image/jpeg" }) });
    const id = await seedScanSession(scanSession([scanPage(1), broken, text, empty, scanPage(2)], { name: "Mixta" }));
    const { report, module } = await exportScanSessionsDetailed();
    expect(report).toMatchObject({ sessions: 1, pages: 2, skippedPages: 3, skippedSessions: 0 });
    expect(module.files.map((file) => file.path)).toEqual(["scan-sessions/index.json", "scan-sessions/s1-p1.jpg", "scan-sessions/s1-p2.jpg"]);
    expect(id).toBeTruthy();
  });

  it("una pagina con un parametro que el lector rechazaria (ajuste fuera de rango) no se escribe: el modulo nunca exporta lo que no importaria", async () => {
    await seedScanSession(scanSession([scanPage(1), scanPage(2, { adjust: { brightness: 5, contrast: 0 } })], { name: "Ajuste raro" }));
    const { report, module } = await exportScanSessionsDetailed();
    expect(report).toMatchObject({ sessions: 1, pages: 1, skippedPages: 1 });
    expect(module.files.map((file) => file.path)).toEqual(["scan-sessions/index.json", "scan-sessions/s1-p1.jpg"]);
  });

  it("una sesion cuyas fotos son TODAS invalidas se queda fuera y se cuenta", async () => {
    await seedScanSession(scanSession([scanPage(1, { original: new Blob(["x".repeat(50)], { type: "image/jpeg" }) })], { name: "Rota" }));
    await seedSimpleSession("Buena", 1, 7);
    const { report } = await exportScanSessionsDetailed();
    expect(report).toMatchObject({ sessions: 1, pages: 1, skippedSessions: 1, skippedPages: 1 });
  });

  it("el formato de la foto sale de sus BYTES (un PNG con tipo image/jpeg va como .png)", async () => {
    const png = await import("@/lib/backup/__fixtures__/pngFactory").then((m) => m.makeRealPng({ width: 20, height: 30, seed: 3 }));
    await seedScanSession(scanSession([scanPage(1, { original: new Blob([png as unknown as BlobPart], { type: "image/jpeg" }), originalWidth: 20, originalHeight: 30 })]));
    const { module } = await exportScanSessionsDetailed();
    expect(module.files.map((file) => [file.path, file.type])).toEqual([
      ["scan-sessions/index.json", "application/json"],
      ["scan-sessions/s1-p1.png", "image/png"],
    ]);
  });

  it("no se escribe un texto reconocido que no cabe (se vuelve a reconocer al guardar el PDF) ni banderas en false", async () => {
    await seedScanSession(scanSession([scanPage(1, { ocrText: "x".repeat(20_000), flags: { blank: false, blurry: true } }), scanPage(2, { ocrText: "Hola\nmundo" })]));
    const { module } = await exportScanSessionsDetailed();
    const index = JSON.parse(new TextDecoder().decode(module.files[0].data));
    const [first, second] = index.sessions[0].pages;
    expect(first.ocrText).toBeUndefined();
    expect(first.flags).toEqual({ blurry: true });
    expect(second.ocrText).toBe("Hola\nmundo");
  });
});

describe("ida y vuelta: exportar -> borrar -> importar -> abrir", () => {
  async function seedTwo() {
    const a = await seedScanSession(
      scanSession([scanPage(1, { filter: "bw", rotation: 90, adjust: { brightness: 0.25, contrast: -0.5 }, flags: { blurry: true }, ocrText: "Texto uno", resolvedFilter: "bw", jpegSample: { side: 256, bytesPerPixel: 0.4, qualityRatio: { "0.8": 0.7 } } }), scanPage(2, { corners: null, mode: "id-card", source: "library" })], {
        name: "Contrato de servicio",
        nameSuggested: { title: "Contrato de servicio", date: "2026-10-26", source: "ocr", name: "Contrato de servicio · 2026-10-26" },
        settings: { mode: "id-card", autoCapture: false, batch: false, defaultFilter: "grayscale", searchable: true },
      }),
    );
    const b = await seedScanSession(scanSession([scanPage(9)], { name: "Recibo" }));
    return { a, b };
  }

  for (const password of [undefined, PASSWORD]) {
    it(`restaura las sesiones con sus originales BYTE A BYTE y todos sus parametros (${password ? "cifrado" : "sin cifrar"})`, async () => {
      const { a, b } = await seedTwo();
      const before = { a: await snapshotOf(a), b: await snapshotOf(b) };
      const trip = await roundTrip(password);
      expect(trip.read.encrypted).toBe(password !== undefined);
      await resetScanStore();
      expect(await listScanSessionSummaries()).toEqual([]);

      const plan = await planScanSessionsImport(trip.read);
      expect(plan.state).toBe("ok");
      expect(plan.counts).toEqual({ new: 2, identical: 0, different: 0, invalid: 0 });
      const decisions = defaultScanSessionDecisions(plan);
      expect(Object.values(decisions)).toEqual(["import", "import"]);
      const result = await applyScanSessionsImport(plan, decisions);
      expect(result).toMatchObject({ ok: true, written: 2, replaced: 0, keptBoth: 0, skipped: 0, changed: 0, failed: 0 });

      for (const [id, expected] of [[a, before.a], [b, before.b]] as const) {
        const after = await snapshotOf(id);
        if (!after || !expected) throw new Error("falta la sesion");
        expect(after.hashes).toEqual(expected.hashes);
        expect(after.loaded.lostPages).toBeUndefined();
        expect(after.loaded.name).toBe(expected.loaded.name);
        expect(after.loaded.createdAt).toBe(expected.loaded.createdAt);
        expect(after.loaded.updatedAt).toBe(expected.loaded.updatedAt);
        expect(after.loaded.settings).toEqual(expected.loaded.settings);
        expect(after.loaded.nameSuggested).toEqual(expected.loaded.nameSuggested);
        expect(after.loaded.pages.map((page) => page.id)).toEqual(expected.loaded.pages.map((page) => page.id));
        for (const [index, page] of after.loaded.pages.entries()) {
          const original = expected.loaded.pages[index];
          expect({ ...page, original: null, thumb: null, processed: null }).toEqual({ ...original, original: null, thumb: null, processed: null });
          expect(page.original.type).toBe("image/jpeg");
          // Lo que no viaja se vuelve a calcular al abrir la sesion.
          expect(page.processed).toBeNull();
          expect(page.thumb).toBeNull();
        }
      }
      const listing = await listScanSessionSummaries();
      expect(listing.map((s) => s.name).sort()).toEqual(["Contrato de servicio", "Recibo"]);
      // Se guardaron como cualquier sesion: con vida de 14 dias desde ahora.
      for (const summary of listing) expect(Date.parse(summary.savedAt)).toBeGreaterThan(Date.now() - 60_000);
    });
  }

  it("exportar otra vez lo importado da el MISMO indice (menos la fecha de guardado) y las mismas fotos", async () => {
    await seedTwo();
    const first = await roundTrip();
    await resetScanStore();
    const plan = await planScanSessionsImport(first.read);
    await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
    const second = await exportScanSessionsDetailed();
    const strip = (data: Uint8Array) => {
      const index = JSON.parse(new TextDecoder().decode(data)) as { sessions: Array<Record<string, unknown>> };
      return index.sessions.map(({ savedAt: _savedAt, ...rest }) => (void _savedAt, rest)).sort((x, y) => String(x.id).localeCompare(String(y.id)));
    };
    expect(strip(second.module.files[0].data)).toEqual(strip(first.module.files[0].data));
    const hashes = async (files: { path: string; data: Uint8Array }[]) => (await Promise.all(files.filter((f) => f.path.endsWith(".jpg")).map((f) => sha256Hex(f.data)))).sort();
    expect(await hashes(second.module.files)).toEqual(await hashes(first.module.files));
  });

  it("la sesion importada se puede volver a guardar (el almacen la ve como una sesion normal: abrir, cambiar un parametro, guardar)", async () => {
    const { a } = await seedTwo();
    const trip = await roundTrip();
    await resetScanStore();
    const plan = await planScanSessionsImport(trip.read);
    await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
    const loaded = await scanSessionStore.load(a);
    if (!loaded) throw new Error("falta");
    const saved = await scanSessionStore.save({ ...loaded, pages: loaded.pages.map((page) => ({ ...page, rotation: 180 as const })) });
    expect(saved).toMatchObject({ ok: true });
    expect((await scanSessionStore.load(a))?.pages.map((page) => page.rotation)).toEqual([180, 180]);
  });

  it("un paquete con cinco formatos de foto distintos vuelve con los mismos bytes y tipos", async () => {
    const { makeRealPng } = await import("@/lib/backup/__fixtures__/pngFactory");
    const png = makeRealPng({ width: 24, height: 30, seed: 4 });
    const id = await seedScanSession(scanSession([scanPage(1), scanPage(2, { original: new Blob([png as unknown as BlobPart], { type: "image/png" }), originalWidth: 24, originalHeight: 30 })], { name: "Mixta" }));
    const before = await snapshotOf(id);
    const trip = await roundTrip();
    await resetScanStore();
    const plan = await planScanSessionsImport(trip.read);
    await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
    const after = await snapshotOf(id);
    expect(after?.hashes).toEqual(before?.hashes);
    expect(after?.loaded.pages.map((page) => page.original.type)).toEqual(["image/jpeg", "image/png"]);
  });
});

describe("fusion sin duplicados", () => {
  async function exportedPackage() {
    const a = await seedSimpleSession("Contrato A", 2, 1);
    const b = await seedSimpleSession("Contrato B", 1, 30);
    return { a, b, trip: await roundTrip() };
  }

  it("reimportar lo que ya tienes: todo «ya lo tienes» y no escribe nada", async () => {
    await exportedPackage();
    const trip = await roundTrip();
    const plan = await planScanSessionsImport(trip.read);
    expect(plan.counts).toEqual({ new: 0, identical: 2, different: 0, invalid: 0 });
    const decisions = defaultScanSessionDecisions(plan);
    expect(Object.values(decisions)).toEqual(["omit", "omit"]);
    const before = (await listScanSessionSummaries()).map((s) => [s.id, s.savedAt]);
    const result = await applyScanSessionsImport(plan, decisions);
    expect(result).toMatchObject({ ok: true, written: 0, skipped: 2 });
    expect((await listScanSessionSummaries()).map((s) => [s.id, s.savedAt])).toEqual(before);
    // Aunque alguien marque «Importar» sobre una identica, no se escribe (la decision solo vale para lo nuevo).
    const forced = Object.fromEntries(plan.items.map((item) => [item.key, "import" as const]));
    expect(await applyScanSessionsImport(plan, forced)).toMatchObject({ ok: true, written: 0, changed: 0, failed: 0 });
    expect(await listScanSessionSummaries()).toHaveLength(2);
  });

  it("el mismo contenido bajo OTRO id (un «conservar ambas» anterior) tambien es «ya lo tienes»", async () => {
    const { a } = await exportedPackage();
    // Una copia con otro id y el mismo contenido.
    const loaded = await scanSessionStore.load(a.id);
    if (!loaded) throw new Error("falta");
    const trip = await roundTrip();
    await scanSessionStore.remove(a.id);
    await seedScanSession({ ...loaded, id: "sc-copia-0001-xx" });
    const plan = await planScanSessionsImport(trip.read);
    const item = plan.items.find((candidate) => candidate.id === a.id);
    expect(item).toMatchObject({ status: "identical", conflictWith: { id: "sc-copia-0001-xx" } });
    expect(plan.items.find((candidate) => candidate.id !== a.id)?.status).toBe("identical");
  });

  it("para buscar «el mismo contenido bajo otro id» solo se cargan las sesiones locales parecidas (mismo nombre y paginas), no todas", async () => {
    const { a, b } = await exportedPackage();
    const other = await seedSimpleSession("Otra cosa", 1, 50);
    const more = await seedSimpleSession("Otra mas", 4, 60);
    const trip = await roundTrip();
    await scanSessionStore.remove(a.id);
    const load = vi.spyOn(scanSessionStore, "load");
    await planScanSessionsImport(trip.read);
    // Solo se cargan las que coinciden por id (para compararlas). Contrato A ya no esta: se busca entre las de 2 paginas y ese
    // nombre -> ninguna, asi que no se carga ninguna sesion mas.
    expect(load.mock.calls.map(([id]) => id).sort()).toEqual([b.id, other.id, more.id].sort());
  });

  it("mezcla: lo que falta se importa, lo igual se omite, y no duplica nada", async () => {
    const { a, b, trip } = await exportedPackage();
    await scanSessionStore.remove(b.id);
    const plan = await planScanSessionsImport(trip.read);
    expect(plan.counts).toEqual({ new: 1, identical: 1, different: 0, invalid: 0 });
    const result = await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
    expect(result).toMatchObject({ ok: true, written: 1, skipped: 1 });
    expect((await listScanSessionSummaries()).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(result.ok && result.saved).toEqual([{ id: b.id }]);
  });

  it("«distinta» (mismo id, otro contenido): si la del paquete es mas nueva, se sugiere reemplazar; si la local es igual de nueva o mas, conservar ambas", async () => {
    const { a, trip } = await exportedPackage();
    // Local mas ANTIGUA que el paquete: se sugiere reemplazar.
    const loaded = await scanSessionStore.load(a.id);
    if (!loaded) throw new Error("falta");
    await scanSessionStore.save({ ...loaded, updatedAt: "2026-10-01T10:00:00.000Z", name: "Contrato A (viejo)" });
    let plan = await planScanSessionsImport(trip.read);
    let item = plan.items.find((candidate) => candidate.id === a.id);
    expect(item).toMatchObject({ status: "different", conflictWith: { id: a.id, newer: false } });
    expect(defaultScanSessionDecisions(plan)[item!.key]).toBe("replace");
    // Local mas NUEVA: se sugiere conservar ambas (nunca pisar).
    const again = await scanSessionStore.load(a.id);
    await scanSessionStore.save({ ...again!, updatedAt: "2026-12-01T10:00:00.000Z", name: "Contrato A (nuevo)" });
    plan = await planScanSessionsImport(trip.read);
    item = plan.items.find((candidate) => candidate.id === a.id);
    expect(item).toMatchObject({ status: "different", conflictWith: { newer: true } });
    expect(defaultScanSessionDecisions(plan)[item!.key]).toBe("keepBoth");
  });

  it("con la MISMA fecha de modificacion y otro contenido la local cuenta como «igual de nueva»: se sugiere conservar ambas (un empate nunca pisa)", async () => {
    const { a, trip } = await exportedPackage();
    const exported = JSON.parse(new TextDecoder().decode((await exportScanSessionsDetailed()).module.files[0].data)).sessions.find((s: { id: string }) => s.id === a.id);
    const loaded = await scanSessionStore.load(a.id);
    await scanSessionStore.save({ ...loaded!, updatedAt: exported.updatedAt, name: "Mismo instante, otro nombre" });
    const plan = await planScanSessionsImport(trip.read);
    const item = plan.items.find((candidate) => candidate.id === a.id)!;
    expect(item).toMatchObject({ status: "different", conflictWith: { newer: true } });
    expect(defaultScanSessionDecisions(plan)[item.key]).toBe("keepBoth");
  });

  it("la misma sesion con la MISMA foto de igual tamano pero otros bytes es «distinta» (se compara el contenido, no solo el tamano)", async () => {
    const { a, trip } = await exportedPackage();
    const loaded = await scanSessionStore.load(a.id);
    const first = await bytesOf(loaded!.pages[0].original);
    const changed = first.slice();
    changed[changed.length - 5] ^= 0xff; // mismo largo, otro contenido
    await scanSessionStore.save({ ...loaded!, pages: [{ ...loaded!.pages[0], original: bytesBlob(changed) }, loaded!.pages[1]] });
    const plan = await planScanSessionsImport(trip.read);
    expect(plan.items.find((candidate) => candidate.id === a.id)?.status).toBe("different");
  });

  it("reemplazar sustituye la sesion local SIN bifurcarla (mismo id, otro contenido) aunque la hubiera guardado otra pestana", async () => {
    const { a } = await exportedPackage();
    const trip = await roundTrip();
    // «Otra pestana» cambia la sesion (otro writerId); esta pestana no conoce su revision.
    __setScanTabIdForTests("t-otra");
    const loaded = await scanSessionStore.load(a.id);
    await scanSessionStore.save({ ...loaded!, updatedAt: "2026-10-01T10:00:00.000Z", name: "Cambiada en otra pestana", pages: loaded!.pages.slice(0, 1) });
    __setScanTabIdForTests("t-main");
    __resetScanStoreMemoryForTests();
    const plan = await planScanSessionsImport(trip.read);
    const item = plan.items.find((candidate) => candidate.id === a.id)!;
    expect(item.status).toBe("different");
    const result = await applyScanSessionsImport(plan, { ...defaultScanSessionDecisions(plan), [item.key]: "replace" });
    expect(result).toMatchObject({ ok: true, written: 1, replaced: 1, saved: [{ id: a.id }] });
    const after = await scanSessionStore.load(a.id);
    expect(after?.name).toBe("Contrato A");
    expect(after?.pages).toHaveLength(2);
    expect(await listScanSessionSummaries()).toHaveLength(2);
  });

  it("conservar ambas crea una copia con id nuevo y el nombre marcado; la local queda intacta", async () => {
    const { a } = await exportedPackage();
    const trip = await roundTrip();
    const loaded = await scanSessionStore.load(a.id);
    await scanSessionStore.save({ ...loaded!, updatedAt: "2026-12-01T10:00:00.000Z", name: "Contrato A (nuevo)" });
    const plan = await planScanSessionsImport(trip.read);
    const item = plan.items.find((candidate) => candidate.id === a.id)!;
    const result = await applyScanSessionsImport(plan, { ...defaultScanSessionDecisions(plan), [item.key]: "keepBoth" }, { copySuffix: "(importado)" });
    if (!result.ok) throw new Error("esperaba ok");
    expect(result).toMatchObject({ written: 1, keptBoth: 1, replaced: 0 });
    const copyId = result.saved[0].id;
    expect(copyId).not.toBe(a.id);
    expect(isValidScanSessionId(copyId)).toBe(true);
    expect((await scanSessionStore.load(copyId))?.name).toBe("Contrato A (importado)");
    expect((await scanSessionStore.load(a.id))?.name).toBe("Contrato A (nuevo)");
    // Y a la siguiente, la copia es «ya la tienes»: no se duplica otra vez.
    const next = await planScanSessionsImport(trip.read);
    expect(next.items.find((candidate) => candidate.id === a.id)?.status).toBe("different");
  });

  it("omitir no escribe; una decision que falta tampoco; solo lo aprobado explicitamente se escribe", async () => {
    const { trip } = await exportedPackage();
    await resetScanStore();
    const plan = await planScanSessionsImport(trip.read);
    expect(await applyScanSessionsImport(plan, {})).toMatchObject({ ok: true, written: 0, skipped: 2 });
    expect(await applyScanSessionsImport(plan, Object.fromEntries(plan.items.map((item) => [item.key, "omit" as const])))).toMatchObject({ written: 0 });
    // «Reemplazar» o «conservar ambas» sobre algo NUEVO no vale (no hay nada que reemplazar).
    expect(await applyScanSessionsImport(plan, Object.fromEntries(plan.items.map((item) => [item.key, "replace" as const])))).toMatchObject({ written: 0 });
    expect(await applyScanSessionsImport(plan, Object.fromEntries(plan.items.map((item) => [item.key, "keepBoth" as const])))).toMatchObject({ written: 0 });
    expect(await listScanSessionSummaries()).toEqual([]);
    const one = plan.items[0];
    expect(await applyScanSessionsImport(plan, { [one.key]: "import" })).toMatchObject({ written: 1, skipped: 1 });
    expect(await listScanSessionSummaries()).toHaveLength(1);
  });
});

describe("caducidad (14 dias)", () => {
  async function packageWith(mutate: (index: { sessions: Array<Record<string, unknown>> }) => void) {
    await seedSimpleSession("Contrato A", 1);
    const { module } = await exportScanSessionsDetailed();
    const index = JSON.parse(new TextDecoder().decode(module.files[0].data));
    mutate(index);
    module.files[0] = { ...module.files[0], data: new TextEncoder().encode(JSON.stringify(index)) };
    const blob = await buildPackage({ modules: [module] });
    await resetScanStore();
    return readPackage(asFile(blob));
  }

  it("una sesion que ya estaba caducada en el paquete (guardada hace mas de 14 dias) se rechaza", async () => {
    const read = await packageWith((index) => {
      index.sessions[0].savedAt = new Date(Date.now() - SCAN_SESSION_TTL_MS - 60_000).toISOString();
    });
    const plan = await planScanSessionsImport(read);
    expect(plan.items[0]).toMatchObject({ status: "invalid", reason: "expired" });
    expect(plan.counts.invalid).toBe(1);
    expect(await applyScanSessionsImport(plan, { [plan.items[0].key]: "import" })).toMatchObject({ ok: true, written: 0 });
    expect(await listScanSessionSummaries()).toEqual([]);
  });

  it("una guardada hace 13 dias entra, y vive 14 dias DESDE LA IMPORTACION (limite documentado: el almacen fija el vencimiento al guardar)", async () => {
    const read = await packageWith((index) => {
      index.sessions[0].savedAt = new Date(Date.now() - 13 * DAY).toISOString();
    });
    const plan = await planScanSessionsImport(read);
    expect(plan.items[0].status).toBe("new");
    await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
    const [summary] = await listScanSessionSummaries();
    expect(Date.parse(summary.savedAt)).toBeGreaterThan(Date.now() - 60_000);
    // A los 14 dias de la importacion (no del paquete) caduca como cualquier sesion.
    expect(await listScanSessionSummaries(Date.now() + SCAN_SESSION_TTL_MS + DAY)).toEqual([]);
  });

  it("la caducidad se juzga con la hora de la vista previa: lo caducado a esa hora no se escribe", async () => {
    const read = await packageWith(() => undefined);
    const plan = await planScanSessionsImport(read, { now: Date.now() + SCAN_SESSION_TTL_MS + DAY });
    expect(plan.items[0]).toMatchObject({ status: "invalid", reason: "expired" });
  });

  it("una fecha de guardado en el futuro se recorta a ahora (no da vida eterna)", async () => {
    const read = await packageWith((index) => {
      index.sessions[0].savedAt = "2999-01-01T00:00:00.000Z";
      index.sessions[0].updatedAt = "2999-01-01T00:00:00.000Z";
      index.sessions[0].createdAt = "2999-01-01T00:00:00.000Z";
    });
    const plan = await planScanSessionsImport(read);
    expect(plan.items[0].status).toBe("new");
    expect(Date.parse(plan.items[0].savedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(Date.parse(plan.items[0].updatedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(Date.parse(plan.items[0].payload!.createdAt)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("limites", () => {
  async function importedPlan(count = 2) {
    for (let index = 0; index < count; index += 1) await seedSimpleSession(`Sesion ${index + 1}`, 2, 1 + index * 10);
    const trip = await roundTrip();
    await resetScanStore();
    const plan = await planScanSessionsImport(trip.read);
    return { plan, decisions: defaultScanSessionDecisions(plan) };
  }

  it("una sesion de mas del tope del almacen es «no se puede importar» (tooLarge) y el resto sigue", async () => {
    await seedSimpleSession("Pequena", 1, 1);
    await seedSimpleSession("Grande", 3, 10);
    const trip = await roundTrip();
    await resetScanStore();
    const sizes = await planScanSessionsImport(trip.read);
    const [small, big] = sizes.items;
    expect(big.bytes).toBeGreaterThan(small.bytes);
    // 1 pagina de la pequena + sus 600 de gastos + 1 200 fijos: justo cabe; la grande no.
    __setScanSessionBytesCapForTests(small.bytes + 600 + 1200);
    const plan = await planScanSessionsImport(trip.read);
    expect(plan.items.map((item) => [item.name, item.status, item.reason])).toEqual([
      ["Pequena", "new", undefined],
      ["Grande", "invalid", "tooLarge"],
    ]);
  });

  it("checkScanSessionsLimits cuenta lo aprobado y compara con el sitio libre del navegador", async () => {
    const { plan, decisions } = await importedPlan();
    const free = checkScanSessionsLimits(plan, decisions);
    expect(free).toMatchObject({ wanted: 2, ok: true, free: null });
    expect(free.bytes).toBeGreaterThan(0);
    const none = checkScanSessionsLimits(plan, Object.fromEntries(Object.keys(decisions).map((key) => [key, "omit" as const])));
    expect(none).toMatchObject({ wanted: 0, bytes: 0, ok: true });
    const tight: ScanSessionsImportPlan = { ...plan, local: { count: 0, storage: { usage: 1000, quota: 1000 + free.bytes } } };
    expect(checkScanSessionsLimits(tight, decisions)).toMatchObject({ ok: false, free: expect.any(Number) });
    const roomy: ScanSessionsImportPlan = { ...plan, local: { count: 0, storage: { usage: 0, quota: free.bytes * 10 } } };
    expect(checkScanSessionsLimits(roomy, decisions).ok).toBe(true);
  });

  it("lo que no cabe NO se escribe (limit) y no se toca nada", async () => {
    const { plan, decisions } = await importedPlan();
    const tight: ScanSessionsImportPlan = { ...plan, local: { count: 0, storage: { usage: 0, quota: 10 } } };
    const result = await applyScanSessionsImport(tight, decisions);
    expect(result).toMatchObject({ ok: false, reason: "limit" });
    expect(await listScanSessionSummaries()).toEqual([]);
  });

  it("el plan lee el sitio libre del navegador (navigator.storage.estimate)", async () => {
    await seedSimpleSession("A", 1);
    const trip = await roundTrip();
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({ usage: 100, quota: 5000 }) } });
    try {
      const plan = await planScanSessionsImport(trip.read);
      expect(plan.local.storage).toEqual({ usage: 100, quota: 5000 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("si el almacen no puede guardar una sesion (tope), las demas SI se guardan y el fallo se cuenta con su motivo", async () => {
    const { plan, decisions } = await importedPlan(3);
    // El almacen real rechaza lo que pase de su propio tope: solo cabe lo pequeno.
    const sizes = plan.items.map((item) => item.bytes);
    expect(new Set(sizes).size).toBeGreaterThan(0);
    __setScanStoreLimitsForTests({ maxSessionBytes: 1200 + 2 * 600 + Math.min(...sizes) + 5 });
    const result = await applyScanSessionsImport(plan, decisions);
    __setScanStoreLimitsForTests();
    if (!result.ok) throw new Error("esperaba ok");
    expect(result.written + result.failed).toBe(3);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.failedReason).toBe("tooBig");
    expect((await listScanSessionSummaries()).length).toBe(result.written);
  });
});

describe("cambios concurrentes: nunca se pisa lo que cambio durante la revision", () => {
  async function packageAndPlan() {
    const a = await seedSimpleSession("Contrato A", 2, 1);
    const trip = await roundTrip();
    return { a, trip };
  }

  it("una sesion con ese id que aparecio DESPUES de la vista previa no se pisa con «Importar» (changed)", async () => {
    const { a, trip } = await packageAndPlan();
    await scanSessionStore.remove(a.id);
    const plan = await planScanSessionsImport(trip.read);
    expect(plan.items[0].status).toBe("new");
    // Mientras se revisaba, aparece una sesion con el mismo id y OTRO contenido.
    await seedScanSession({ ...a.session, name: "Aparecio despues", pages: [scanPage(77)] });
    const result = await applyScanSessionsImport(plan, defaultScanSessionDecisions(plan));
    expect(result).toMatchObject({ ok: true, written: 0, changed: 1 });
    expect((await scanSessionStore.load(a.id))?.name).toBe("Aparecio despues");
  });

  it("una sesion que cambio despues de la vista previa no se reemplaza (changed)", async () => {
    const { a, trip } = await packageAndPlan();
    const loaded = await scanSessionStore.load(a.id);
    await scanSessionStore.save({ ...loaded!, updatedAt: "2026-10-01T10:00:00.000Z", name: "Local viejo" });
    const plan = await planScanSessionsImport(trip.read);
    const item = plan.items[0];
    expect(item.status).toBe("different");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = await scanSessionStore.load(a.id);
    await scanSessionStore.save({ ...current!, name: "Cambiada mientras revisabas", pages: current!.pages.slice(0, 1) });
    const result = await applyScanSessionsImport(plan, { [item.key]: "replace" });
    expect(result).toMatchObject({ ok: true, written: 0, changed: 1 });
    expect((await scanSessionStore.load(a.id))?.name).toBe("Cambiada mientras revisabas");
  });

  it("una sesion que se borro despues de la vista previa tampoco se «reemplaza» (changed)", async () => {
    const { a, trip } = await packageAndPlan();
    const loaded = await scanSessionStore.load(a.id);
    await scanSessionStore.save({ ...loaded!, updatedAt: "2026-10-01T10:00:00.000Z", name: "Local viejo" });
    const plan = await planScanSessionsImport(trip.read);
    await scanSessionStore.remove(a.id);
    const result = await applyScanSessionsImport(plan, { [plan.items[0].key]: "replace" });
    expect(result).toMatchObject({ ok: true, written: 0, changed: 1 });
    expect(await listScanSessionSummaries()).toEqual([]);
  });

  it("si otra pestana guarda entre medias, el almacen guarda la copia aparte en vez de pisar (queda guardada con otro id)", async () => {
    const { a, trip } = await packageAndPlan();
    const loaded = await scanSessionStore.load(a.id);
    await scanSessionStore.save({ ...loaded!, updatedAt: "2026-10-01T10:00:00.000Z", name: "Local viejo" });
    const plan = await planScanSessionsImport(trip.read);
    const item = plan.items[0];
    const result = await applyScanSessionsImport(plan, { [item.key]: "replace" }, {
      beforeSave: async () => {
        // Otra pestana escribe justo antes de nuestro guardado.
        __setScanTabIdForTests("t-otra");
        const mid = await scanSessionStore.load(a.id);
        await scanSessionStore.save({ ...mid!, name: "Escrita por otra pestana" });
        // De vuelta en esta pestana, que NO conoce esa revision.
        __setScanTabIdForTests("t-main");
        __resetScanStoreMemoryForTests();
      },
    });
    if (!result.ok) throw new Error("esperaba ok");
    expect(result.written).toBe(1);
    expect(result.saved[0].id).not.toBe(a.id);
    expect((await scanSessionStore.load(a.id))?.name).toBe("Escrita por otra pestana");
    expect((await scanSessionStore.load(result.saved[0].id))?.name).toBe("Contrato A");
  });
});

describe("estados del modulo", () => {
  it("un paquete sin este modulo -> absent; una version de esquema mas nueva -> newerVersion (no se lee nada)", async () => {
    await seedSimpleSession("A", 1);
    const { module } = await exportScanSessionsDetailed();
    const blob = await buildPackage({ modules: [module] });
    const read = await readPackage(asFile(blob));
    expect(await planScanSessionsImport({ ...read, modules: [] })).toMatchObject({ state: "absent", items: [] });
    const newer = { ...read, modules: read.modules.map((m) => ({ ...m, declaredSchemaVersion: 2, status: "newerVersion" as const, message: "Creado con una versión más nueva de OptimusPDF; actualiza la página.", files: new Map() })) };
    expect(await planScanSessionsImport(newer)).toMatchObject({ state: "newerVersion", items: [] });
  });

  it("applyScanSessionsImport con un plan que no esta ok no escribe (blocked)", async () => {
    const plan = await planScanSessionsImport({ formatVersion: 1, createdAt: "", app: {}, encrypted: false, modules: [], warnings: [] });
    expect(await applyScanSessionsImport(plan, {})).toEqual({ ok: false, reason: "blocked" });
    expect(await applyScanSessionsImport(null as unknown as ScanSessionsImportPlan, {})).toEqual({ ok: false, reason: "blocked" });
  });
});
