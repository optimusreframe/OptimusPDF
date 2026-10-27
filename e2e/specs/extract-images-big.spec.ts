import { exec } from "node:child_process";
import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { downloadFile } from "../helpers/downloads";
import { bigImagesPdf } from "../helpers/big-image-pdf";
import { openRealEngine, runSearch } from "../helpers/extract-core-flow";
import { assetList } from "../helpers/extract-ui-flow";

/**
 * H11 · memoria con fotos ENORMES (motor REAL en el navegador): 3 imagenes de 40 MP (8000 x 5000, RGB con Flate) no se decodifican
 * enteras para buscar. Se comprueba lo que ve el usuario (3 elementos con las medidas reales y miniatura) y la memoria REAL del arbol
 * de procesos del navegador (no solo el heap de JS): lo que anade la BUSQUEDA (pico menos lo que habia al elegir el archivo) < 250 MB y el
 * pico total < 1000 MB, y sin tareas largas de mas de 100 ms en el hilo principal. (Elegir el PDF ya cuesta ~330 MB con 3 fotos de 40 MP:
 * la miniatura del selector de archivos `FileList` decodifica la pagina 1 con pdf.js; es un componente compartido, no el motor.) El PNG de
 * una foto sale a tamano completo. Chromium (la medida de procesos usa `ps`). Headless siempre.
 */

test.setTimeout(240_000);

/** Memoria proporcional (PSS, MB) de un proceso de Linux: las paginas compartidas se reparten entre quienes las usan (el RSS las cuenta enteras en cada proceso). */
function pssMb(pid: number): number {
  try {
    const match = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
    return match ? Number(match[1]) / 1024 : 0;
  } catch {
    return 0;
  }
}

/** Memoria (MB) de los procesos hijos de ESTE worker de Playwright (el navegador que lanza): RSS en macOS, PSS en Linux. */
function sampleRss(): Promise<number> {
  return new Promise((resolve) => {
    exec("ps -axo pid=,ppid=,rss=", (error, out) => {
      if (error) return resolve(0);
      const rows = String(out).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
      const kids = new Map<number, number[]>();
      const rss = new Map<number, number>();
      for (const [pid, ppid, size] of rows) {
        rss.set(pid, size);
        kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
      }
      let total = 0;
      const stack = [...(kids.get(process.pid) ?? [])];
      while (stack.length > 0) {
        const pid = stack.pop()!;
        total += process.platform === "linux" ? pssMb(pid) * 1024 : (rss.get(pid) ?? 0);
        stack.push(...(kids.get(pid) ?? []));
      }
      resolve(Math.round(total / 1024));
    });
  });
}

test("3 fotos de 40 MP: 3 elementos con medidas reales y miniatura, la busqueda anade < 250 MB y sin tareas largas", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "la medida de memoria por procesos usa Chromium");
  await page.addInitScript(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__long.push(Math.round(entry.duration));
      }).observe({ type: "longtask" });
    } catch {
      // sin soporte: no hay medida
    }
  });
  const upload = await bigImagesPdf(3, 8000, 5000);
  await openRealEngine(page, upload);
  // La comprobacion del archivo al elegirlo (lectura de 9 MB) no es la busqueda: se mide desde que «Buscar elementos» esta habilitado.
  await expect(page.getByRole("button", { name: "Buscar elementos" })).toBeEnabled({ timeout: 60_000 });
  // La miniatura del selector (pdf.js decodificando la pagina 1) sigue creciendo un rato: la base es la memoria ya ESTABLE (tres medidas seguidas
  // dentro de 40 MB), no la de un instante cualquiera.
  let base = await sampleRss();
  for (let stable = 0, i = 0; stable < 3 && i < 60; i += 1) {
    await page.waitForTimeout(500);
    const now = await sampleRss();
    stable = Math.abs(now - base) < 40 ? stable + 1 : 0;
    base = now;
  }
  // Las tareas largas se cuentan desde aqui: la miniatura del selector (otro componente) ya termino.
  await page.evaluate(() => {
    (window as unknown as { __long: number[] }).__long.length = 0;
  });
  let peak = base;
  const timer = setInterval(() => void sampleRss().then((value) => (peak = Math.max(peak, value))), 200);
  try {
    await runSearch(page, "es", 120_000);
  } finally {
    clearInterval(timer);
  }
  await expect(page.locator("[data-extract-heading]")).toHaveText("Encontramos 3 elementos en 1 página.");
  const list = assetList(page);
  await expect(list.getByRole("listitem")).toHaveCount(3);
  // Las medidas son las REALES de la imagen (no las de la version reducida con que se analizo).
  const names = await list.getByRole("listitem").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
  for (const name of names) expect(name).toContain("8000 × 5000 px");
  // Cada tarjeta tiene su miniatura (una version reducida de la foto, no un hueco).
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>("[data-asset-id] img")].filter((img) => img.complete && img.naturalWidth > 0).length), { timeout: 20_000 }).toBe(3);
  const thumb = await page.locator("[data-asset-id] img").first().evaluate((img) => ({ w: (img as HTMLImageElement).naturalWidth, h: (img as HTMLImageElement).naturalHeight }));
  expect(Math.max(thumb.w, thumb.h)).toBeLessThanOrEqual(256);
  expect(thumb.w / thumb.h).toBeCloseTo(1.6, 1);
  const longTasks = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  // 100 ms en una maquina libre; el CI es ~2,5 veces mas lento y comparte CPU con otro worker: holgura x2,5.
  expect(Math.max(0, ...longTasks), `tareas largas: ${longTasks.join(", ")} ms`).toBeLessThan(process.env.CI ? 250 : 100);
  // El total absoluto solo en macOS: el Chromium de un contenedor Linux arranca ya con 1,5-2 GB (GPU por software, memoria compartida).
  if (process.platform === "darwin") expect(peak, `pico del arbol del navegador: ${peak} MB`).toBeLessThan(1000);
  expect(peak - base, `la busqueda anade ${peak - base} MB (antes ${base} MB, pico ${peak} MB)`).toBeLessThan(250);
  console.info(`H11: 3 x 40 MP, antes de buscar ${base} MB, pico del arbol del navegador ${peak} MB, tareas largas [${longTasks.join(", ")}] ms`);
});

test("descargar una foto de 40 MP entrega el PNG a tamano completo (bajo demanda, de una en una)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "el PNG de 40 MP pesa decenas de MB: solo en Chromium de escritorio");
  const upload = await bigImagesPdf(2, 8000, 5000);
  await openRealEngine(page, upload);
  await runSearch(page, "es", 120_000);
  await expect(assetList(page).getByRole("listitem")).toHaveCount(2);
  const file = await downloadFile(page, () => page.getByRole("button", { name: /^Descargar: / }).first().click());
  expect(file.filename).toMatch(/^p01-[a-z-]+-01\.png$/);
  expect(file.bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  const width = file.bytes.readUInt32BE(16);
  const height = file.bytes.readUInt32BE(20);
  expect([width, height]).toEqual([8000, 5000]);
});
