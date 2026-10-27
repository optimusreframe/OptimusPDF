import type { Page } from "@playwright/test";
import { scanBundles } from "./scan-engine-bundle";
import type { PhotoFixture } from "./scan-engine-fixtures";

/**
 * Pagina de laboratorio del Escaner: inyecta el motor empaquetado en una pagina real de la app (`/privacy`, con su CSP) y deja
 * `window.__lab` con ayudantes (crear paginas desde las fotos sinteticas, hashes, dimensiones, pixeles, latido del hilo).
 */

export const LAB = String.raw`
(() => {
  const L = window.ScanLab;
  const fx = window.__fx;
  const blobOf = (id) => {
    const bin = atob(fx[id].base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: "image/jpeg" });
  };
  const settings = (mode, extra) => ({ ...L.DEFAULT_SCAN_SETTINGS, mode, ...(extra || {}) });
  const make = (id, mode = "document", extra) => L.realEngine.createPage(blobOf(id), { source: "library", mode, settings: settings(mode, extra) });
  async function sha(blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function dims(blob) {
    const bitmap = await createImageBitmap(blob);
    const out = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return out;
  }
  async function pixels(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const out = { width: bitmap.width, height: bitmap.height, data };
    bitmap.close();
    return out;
  }
  function heartbeat() {
    let last = performance.now(); let maxGap = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
    const longTasks = [];
    let observer = null;
    try { observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); }); observer.observe({ type: "longtask", buffered: false }); } catch { observer = null; }
    return { stop() { clearInterval(timer); if (observer) observer.disconnect(); return { maxGap, longTasks }; } };
  }
  const meanLuma = (p, x0, y0, x1, y1) => {
    let sum = 0; let n = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const o = (y * p.width + x) * 4; sum += p.data[o] * 0.299 + p.data[o + 1] * 0.587 + p.data[o + 2] * 0.114; n += 1; }
    return sum / n;
  };
  window.__lab = { L, blobOf, make, sha, dims, pixels, heartbeat, meanLuma, settings };
})();
`;

export async function openLab(page: Page, fixtures: Record<string, PhotoFixture>, options: { worker: boolean } = { worker: true }): Promise<void> {
  const bundles = await scanBundles();
  await page.goto("/privacy");
  await page.evaluate((payload) => {
    (window as unknown as { __fx: unknown }).__fx = payload;
  }, fixtures);
  await page.addScriptTag({ content: bundles.engine });
  await page.addScriptTag({ content: LAB });
  await page.evaluate(
    ({ code, useWorker }) => {
      const lab = (window as unknown as { __lab: { L: { setScanWorkerFactory: (f: (() => Worker) | null, o?: { disabled?: boolean }) => void } } }).__lab;
      if (useWorker) {
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        lab.L.setScanWorkerFactory(() => new Worker(url));
      } else {
        lab.L.setScanWorkerFactory(null, { disabled: true });
      }
    },
    { code: bundles.worker, useWorker: options.worker },
  );
}

export function trackRequests(page: Page): { external: string[]; nonGet: string[] } {
  const seen = { external: [] as string[], nonGet: [] as string[] };
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
    const base = new URL(page.url() === "about:blank" ? "http://localhost" : page.url()).origin;
    if (new URL(url).origin !== base && !url.startsWith("http://localhost")) seen.external.push(url);
    if (request.method() !== "GET" && request.method() !== "HEAD") seen.nonGet.push(`${request.method()} ${url}`);
  });
  return seen;
}

