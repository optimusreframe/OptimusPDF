/* eslint-disable @typescript-eslint/no-explicit-any -- el codigo de `page.evaluate` se ejecuta en el navegador sobre `window.__lab` (motor empaquetado), sin tipos en este lado */
import { expect, test, type Page } from "@playwright/test";
import { openLab } from "../helpers/scan-engine-lab";
import { buildScanFixtures, type PhotoFixture } from "../helpers/scan-engine-fixtures";
import { engineOf } from "../helpers/engine";

/**
 * Sesion PERSISTENTE del Escaner (E1) en un NAVEGADOR REAL y headless (IndexedDB de verdad): guardar la sesion, recargar la
 * pagina, listar, recuperar con los ORIGINALES intactos (mismo SHA-256), guardado incremental, expiracion a los 14 dias, cuota
 * simulada, dos pestanas (conflicto y avisos) y la integracion con «Recientes» (Continuar y Descartar sobre la pagina real).
 *
 * Mismo patron que `scan-engine.spec.ts` (motor empaquetado con Vite e inyectado en `/privacy`; sin red, fotos sinteticas).
 * Chromium: por defecto. iPad (WebKit): `PW_BROWSERS=webkit-ipad PW_CROSS_FULL=1 ... --project=webkit-ipad`.
 */

test.use({ locale: "es-ES" });
test.setTimeout(240_000);
const SLACK = process.env.CI ? 2.5 : 1;

let fixtures: Record<string, PhotoFixture> = {};
test.beforeAll(() => {
  fixtures = buildScanFixtures();
});

const open = (page: Page) => openLab(page, fixtures);

/** Crea `ids.length` paginas con el motor real y devuelve la sesion (en la pagina: `window.__session`) y los SHA-256 de sus originales. */
async function makeSession(page: Page, ids: string[], name = "Escaneo de prueba"): Promise<{ id: string; hashes: string[]; pageIds: string[] }> {
  return page.evaluate(
    async ({ list, title }) => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const pages = [];
      const hashes = [];
      for (const id of list) {
        const created = await lab.make(id);
        pages.push(created);
        hashes.push(await lab.sha(created.original));
      }
      const session = { id: lab.L.newScanSessionId(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), name: title, pages, settings: { ...lab.L.DEFAULT_SCAN_SETTINGS } };
      (window as unknown as { __session: unknown }).__session = session;
      return { id: session.id, hashes, pageIds: pages.map((p: { id: string }) => p.id) };
    },
    { list: ids, title: name },
  );
}

test.describe("sesion persistente · navegador real", () => {
  test("guardar -> recargar -> listar -> recuperar: los originales vuelven INTACTOS (mismo SHA-256) y la pagina sigue usable", async ({ page }) => {
    await open(page);
    const made = await makeSession(page, ["text0", "text90", "formA", "other", "blank"]);
    const saved = await page.evaluate(() => (window as unknown as { __lab: any; __session: unknown }).__lab.L.scanSessionStore.save((window as unknown as { __session: unknown }).__session));
    expect(saved).toMatchObject({ ok: true, rev: 1 });
    // «Cerrar la pestana»: una carga nueva, sin nada en memoria.
    await open(page);
    const out = await page.evaluate(async (id) => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const list = await lab.L.scanSessionStore.list();
      const loaded = await lab.L.scanSessionStore.load(id);
      const hashes = [];
      for (const p of loaded.pages) hashes.push(await lab.sha(p.original));
      const thumbs = [];
      for (const p of loaded.pages) thumbs.push(await lab.dims(p.thumb));
      // La pagina recuperada se puede seguir procesando desde su original.
      const rendered = await lab.L.realEngine.renderPage({ ...loaded.pages[0], filter: "enhance" });
      return {
        list: list.map((s: any) => ({ id: s.id, name: s.name, pageCount: s.pageCount, thumb: !!s.thumb })),
        coverDims: list[0].thumb ? await lab.dims(list[0].thumb) : null,
        ids: loaded.pages.map((p: any) => p.id),
        hashes,
        thumbs,
        flags: loaded.pages.map((p: any) => p.flags),
        corners: loaded.pages.map((p: any) => !!p.corners),
        lost: loaded.lostPages ?? 0,
        processed: !!rendered.processed,
        mode: loaded.pages[0].mode,
      };
    }, made.id);
    expect(out.list).toEqual([{ id: made.id, name: "Escaneo de prueba", pageCount: 5, thumb: true }]);
    expect(Math.max(out.coverDims!.width, out.coverDims!.height)).toBe(360);
    expect(out.ids).toEqual(made.pageIds);
    expect(out.hashes).toEqual(made.hashes);
    for (const t of out.thumbs) expect(Math.max(t.width, t.height)).toBe(360);
    expect(out.flags[4]).toMatchObject({ blank: true });
    expect(out.corners).toEqual([true, true, true, true, true]);
    expect(out.lost).toBe(0);
    expect(out.processed).toBe(true);
    expect(out.mode).toBe("document");
  });

  test("autoguardado pagina a pagina: si la pestana se cierra a mitad, lo escaneado hasta ahi esta guardado", async ({ page }) => {
    await open(page);
    const id = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const session = { id: lab.L.newScanSessionId(), createdAt: "", updatedAt: "", name: "En curso", pages: [] as any[], settings: { ...lab.L.DEFAULT_SCAN_SETTINGS } };
      // Como la interfaz: cada pagina nueva dispara un guardado.
      for (const pid of ["text0", "text90", "formA"]) {
        session.pages = [...session.pages, await lab.make(pid)];
        const result = await lab.L.scanSessionStore.save(session);
        if (!result.ok) throw new Error("no se pudo guardar");
      }
      return session.id;
    });
    await page.reload();
    await open(page);
    const out = await page.evaluate(async (sid) => (await (window as unknown as { __lab: any }).__lab.L.scanSessionStore.load(sid)).pages.length, id);
    expect(out).toBe(3);
  });

  test("guardado incremental: tocar UNA pagina de 30 escribe UNA fila (no 30), y sin cambios no escribe nada", async ({ page }) => {
    await open(page);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const base = await lab.make("big");
      const pages = [];
      const bytes = new Uint8Array(await base.original.arrayBuffer());
      // 30 originales DISTINTOS (un byte final distinto): el guardado completo escribe de verdad ~40 MB.
      for (let i = 0; i < 30; i += 1) pages.push({ ...base, id: `p-bulk-${i}-${Math.random().toString(36).slice(2, 8)}`, original: new Blob([bytes, new Uint8Array([i])], { type: "image/jpeg" }) });
      const session = { id: lab.L.newScanSessionId(), createdAt: "", updatedAt: "", name: "Muchas", pages, settings: { ...lab.L.DEFAULT_SCAN_SETTINGS } };
      const store = lab.L.scanSessionStore;
      // Cuenta las escrituras reales a IndexedDB por almacen (lo que de verdad cuesta).
      const counts: Record<string, number> = {};
      const realPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        counts[this.name] = (counts[this.name] ?? 0) + 1;
        return realPut.call(this, value, key);
      };
      const timed = async (value: any) => {
        for (const key of Object.keys(counts)) delete counts[key];
        const start = performance.now();
        const result = await store.save(value);
        return { ms: performance.now() - start, ok: result.ok, writes: { ...counts } };
      };
      const full = await timed(session);
      const none = await timed(session);
      const one = await timed({ ...session, pages: session.pages.map((p: any, i: number) => (i === 7 ? { ...p, rotation: 90 } : p)) });
      IDBObjectStore.prototype.put = realPut;
      return { full, none, one, size: base.original.size };
    });
    console.log(`[scan-persist] ${engineOf(page)} 30 paginas (${(out.size / 1024).toFixed(0)} KB c/u): completo ${out.full.ms.toFixed(0)} ms, sin cambios ${out.none.ms.toFixed(0)} ms, una pagina ${out.one.ms.toFixed(0)} ms`);
    expect(out.full.ok && out.none.ok && out.one.ok).toBe(true);
    // (WebKit sin Blob en IndexedDB repite el guardado completo con bytes: puede contar el doble.)
    expect(out.full.writes.pages).toBeGreaterThanOrEqual(30);
    expect(out.full.writes.originals).toBeGreaterThanOrEqual(30);
    expect(out.none.writes).toEqual({});
    // Girar una pagina escribe su fila y la ficha, NO su foto original.
    expect(out.one.writes).toEqual({ pages: 1, meta: 1 });
    expect(out.none.ms).toBeLessThan(25 * SLACK + 25);
  });

  test("expiracion a los 14 dias: a los 13 sigue, pasados los 14 se borra todo (ficha, paginas y originales)", async ({ page }) => {
    await open(page);
    await makeSession(page, ["text0", "formA"]);
    const out = await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any; __session: any }).__lab;
      const session = (window as unknown as { __session: any }).__session;
      await lab.L.scanSessionStore.save(session);
      const day = 24 * 3600 * 1000;
      const before = await lab.L.scanSessionStore.purgeExpired(Date.now() + 13 * day);
      const stillThere = (await lab.L.scanSessionStore.list()).length;
      const purged = await lab.L.scanSessionStore.purgeExpired(Date.now() + 15 * day);
      const counts = await new Promise<number[]>((resolve) => {
        const request = indexedDB.open(lab.L.SCAN_DB_NAME);
        request.onsuccess = () => {
          const db = request.result;
          const names = ["meta", "pages", "originals"];
          const results: number[] = [];
          let pending = names.length;
          names.forEach((name, i) => {
            const count = db.transaction(name, "readonly").objectStore(name).count();
            count.onsuccess = () => { results[i] = count.result; if (--pending === 0) { db.close(); resolve(results); } };
          });
        };
      });
      return { before, stillThere, purged, counts, ttl: lab.L.SCAN_SESSION_TTL_MS / day };
    });
    expect(out.ttl).toBe(14);
    expect(out.before).toBe(0);
    expect(out.stillThere).toBe(1);
    expect(out.purged).toBe(1);
    expect(out.counts).toEqual([0, 0, 0]);
  });

  test("cuota simulada: sin sitio el guardado devuelve `quota` con un mensaje tipado, no lanza y la sesion anterior queda intacta", async ({ page }) => {
    await open(page);
    const made = await makeSession(page, ["text0"]);
    const out = await page.evaluate(async (id) => {
      const lab = (window as unknown as { __lab: any; __session: any }).__lab;
      const session = (window as unknown as { __session: any }).__session;
      const store = lab.L.scanSessionStore;
      await store.save(session);
      // El navegador dice que casi no queda cupo (se define `navigator.storage` propio: WebKit de Linux no lo trae).
      Object.defineProperty(navigator, "storage", { configurable: true, value: { estimate: async () => ({ usage: 990_000, quota: 1_000_000 }) } });
      const bigger = { ...session, pages: [...session.pages, await lab.make("formA")] };
      const refused = await store.save(bigger);
      delete (navigator as any).storage;
      const intact = (await store.load(id)).pages.length;
      const retry = await store.save(bigger);
      return { refused, intact, retry: retry.ok, now: (await store.load(id)).pages.length };
    }, made.id);
    expect(out.refused).toEqual({ ok: false, reason: "quota" });
    expect(out.intact).toBe(1);
    expect(out.retry).toBe(true);
    expect(out.now).toBe(2);
  });

  test("dos pestanas: la segunda ve los avisos, y si guarda sin haber cargado NO pisa a la primera (se bifurca)", async ({ page, context }) => {
    await open(page);
    const second = await context.newPage();
    await open(second);
    // B escucha los cambios de las sesiones.
    await second.evaluate(() => {
      const lab = (window as unknown as { __lab: any }).__lab;
      (window as unknown as { __heard: number }).__heard = 0;
      lab.L.subscribeToScanSessions(() => { (window as unknown as { __heard: number }).__heard += 1; });
    });
    const made = await makeSession(page, ["text0"], "Pestana A");
    await page.evaluate(() => (window as unknown as { __lab: any; __session: any }).__lab.L.scanSessionStore.save((window as unknown as { __session: any }).__session));
    await expect.poll(() => second.evaluate(() => (window as unknown as { __heard: number }).__heard)).toBeGreaterThan(0);
    const listedInB = await second.evaluate(async () => (await (window as unknown as { __lab: any }).__lab.L.scanSessionStore.list()).map((s: any) => s.name));
    expect(listedInB).toEqual(["Pestana A"]);
    // B crea su copia de la MISMA sesion (mismo id) sin haberla cargado y guarda: conflicto.
    const conflict = await second.evaluate(async (id) => {
      const lab = (window as unknown as { __lab: any }).__lab;
      const created = await lab.make("formA");
      const session = { id, createdAt: "", updatedAt: "", name: "Pestana B", pages: [created], settings: { ...lab.L.DEFAULT_SCAN_SETTINGS } };
      const result = await lab.L.scanSessionStore.save(session);
      return { result, forkedAs: result.forkedAs ?? null };
    }, made.id);
    expect(conflict.result.ok).toBe(true);
    expect(conflict.forkedAs).not.toBeNull();
    // A sigue viendo lo suyo; la copia de B existe aparte.
    const aStill = await page.evaluate(async (id) => (await (window as unknown as { __lab: any }).__lab.L.scanSessionStore.load(id)).name, made.id);
    expect(aStill).toBe("Pestana A");
    const names = await page.evaluate(async () => (await (window as unknown as { __lab: any }).__lab.L.scanSessionStore.list()).map((s: any) => s.name).sort());
    expect(names).toEqual(["Pestana A", "Pestana B"]);
    await second.close();
  });

  test("«Recientes»: la sesion sin terminar aparece con su miniatura y «Continuar» (?resume=scan:<id>) y «Descartar» la borra de verdad", async ({ page }) => {
    await open(page);
    const made = await makeSession(page, ["text0", "formA", "other"], "Contrato de servicio · 2026-10-26");
    await page.evaluate(() => (window as unknown as { __lab: any; __session: any }).__lab.L.scanSessionStore.save((window as unknown as { __session: any }).__session));
    await page.goto("/recent");
    const row = page.locator(`[data-unfinished-key="scan:${made.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Contrato de servicio · 2026-10-26");
    await expect(row.locator("img[data-unfinished-thumb]")).toBeVisible();
    await expect(row.getByRole("link", { name: /Continuar/ })).toHaveAttribute("href", `/scan-to-pdf?resume=scan:${made.id}`);
    await row.getByRole("button", { name: /^Descartar/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Descartar", exact: true }).click();
    await expect(row).toHaveCount(0);
    await open(page);
    const left = await page.evaluate(async (id) => ({ list: (await (window as unknown as { __lab: any }).__lab.L.scanSessionStore.list()).length, load: await (window as unknown as { __lab: any }).__lab.L.scanSessionStore.load(id) }), made.id);
    expect(left).toEqual({ list: 0, load: null });
  });

  test("P2-10 · un cambio hecho justo antes de recargar (girar y recargar a los 100 ms) NO se pierde: lo apuntado con stage se vuelca al irse la pagina", async ({ page }) => {
    await open(page);
    const made = await makeSession(page, ["text0", "formA"]);
    await page.evaluate(async () => {
      const lab = (window as unknown as { __lab: any; __session: any }).__lab;
      await lab.L.scanSessionStore.save((window as unknown as { __session: any }).__session);
    });
    // La persona gira la pagina 2 y la interfaz apunta el cambio; el autoguardado (500 ms) aun no ha escrito.
    await page.evaluate(() => {
      const lab = (window as unknown as { __lab: any; __session: any }).__lab;
      const session = (window as unknown as { __session: any }).__session;
      const changed = { ...session, pages: session.pages.map((p: any, i: number) => (i === 1 ? { ...p, rotation: 90 } : p)) };
      lab.L.scanSessionStore.stage(changed);
    });
    await page.reload();
    await open(page);
    const rotations = await page.evaluate(async (id) => (await (window as unknown as { __lab: any }).__lab.L.scanSessionStore.load(id)).pages.map((p: any) => p.rotation), made.id);
    expect(rotations).toEqual([0, 90]);
  });

  test("P2-10 · flush() escribe lo apuntado a peticion y espera a que termine", async ({ page }) => {
    await open(page);
    const made = await makeSession(page, ["text0"]);
    const rotation = await page.evaluate(async (id) => {
      const lab = (window as unknown as { __lab: any; __session: any }).__lab;
      const session = (window as unknown as { __session: any }).__session;
      await lab.L.scanSessionStore.save(session);
      lab.L.scanSessionStore.stage({ ...session, pages: [{ ...session.pages[0], rotation: 270 }] });
      await lab.L.scanSessionStore.flush();
      return (await lab.L.scanSessionStore.load(id)).pages[0].rotation;
    }, made.id);
    expect(rotation).toBe(270);
  });
});
