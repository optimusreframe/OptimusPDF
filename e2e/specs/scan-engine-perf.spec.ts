/* eslint-disable @typescript-eslint/no-explicit-any -- el codigo de `page.evaluate` se ejecuta en el navegador sobre `window.__lab` (motor empaquetado) */
import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { openLab as openLabWith } from "../helpers/scan-engine-lab";
import { engineOf } from "../helpers/engine";
import { renderScene, type SceneSpec } from "../../src/lib/scan/__fixtures__/scenes";

/**
 * El analisis de la sesion (hojas repetidas, calidad) con MUCHAS fotos grandes no congela el hilo principal: las comparaciones de
 * hojas se reparten en trozos cediendo el hilo (antes una sola tarea de ~2-3 s con 36 fotos de 12 MP, durante la cual el
 * overlay y «Cancelar» no respondian). Fotos sinteticas (hojas con texto parecido sobre distintas mesas, giradas).
 */

test.setTimeout(600_000);
const SLACK = process.env.CI ? 2.5 : 1;
/** Con `CI=1` fotos mas pequenas (el coste de comparar hojas no depende de la resolucion y WebKit en el contenedor agotaba la memoria con 12 MP). */
const BIG = process.env.CI ? { W: 2400, H: 1800 } : { W: 4032, H: 3024 };
const PHOTOS = Number(process.env.SCAN_PERF_PHOTOS ?? (process.env.CI ? 12 : 24));

function sceneJpeg(spec: SceneSpec, seed: number): string {
  const scene = renderScene(spec, seed, BIG);
  const canvas: Canvas = createCanvas(scene.width, scene.height);
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(scene.width, scene.height);
  data.data.set(scene.image.data);
  ctx.putImageData(data, 0, 0);
  return canvas.toBuffer("image/jpeg", 85).toString("base64");
}

/**
 * Pagina densa de 12 MP (celdas oscuras sueltas por todo el papel: una trama con mucha «tinta»): todas se parecen a gran escala (mismo
 * papel) pero ninguna es copia de otra, que es lo que mas cuesta comparar (hay que mirar bloque a bloque).
 */
function denseJpeg(seed: number): string {
  const W = BIG.W;
  const H = BIG.H;
  const canvas: Canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e9e7e1";
  ctx.fillRect(0, 0, W, H);
  let s = seed * 2654435761 >>> 0 || 1;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  ctx.fillStyle = "#333";
  for (let y = 60; y < H - 60; y += 10) for (let x = 60; x < W - 60; x += 10) if (rnd() < 0.3) ctx.fillRect(x, y, 6, 6);
  return canvas.toBuffer("image/jpeg", 85).toString("base64");
}

const SPECS: SceneSpec[] = [
  { bg: "wood-dark", shadow: 1, paper: { cx: 0.5, cy: 0.5, pw: 0.62, ph: 0.8 } },
  { bg: "gray-dark", shadow: 1, paper: { cx: 0.5, cy: 0.5, pw: 0.56, ph: 0.72, rot: (9 * Math.PI) / 180 } },
  { bg: "beige", shadow: 1, paper: { cx: 0.5, cy: 0.5, pw: 0.6, ph: 0.8, rot: (4 * Math.PI) / 180 } },
  { bg: "wood-dark", shadow: 1, gradient: true, paper: { cx: 0.5, cy: 0.5, pw: 0.6, ph: 0.78, rot: (6 * Math.PI) / 180 } },
];

test.describe("analisis de la sesion con muchas fotos grandes", () => {
  test(`analyzeSession con ${PHOTOS} fotos grandes: ninguna tarea larga del hilo principal pasa de ~100 ms, y repetirlo es instantaneo`, async ({ page }) => {
    const dir = process.env.SCAN_PERF_DIR;
    const photos = dir
      ? fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().slice(0, PHOTOS).map((f) => fs.readFileSync(path.join(dir, f)).toString("base64"))
      : Array.from({ length: PHOTOS }, (_, i) => (i % 3 === 0 ? sceneJpeg(SPECS[(i / 3) % SPECS.length | 0], 300 + i) : denseJpeg(900 + i)));
    await openLabWith(page, {}, { worker: true });
    const out = await page.evaluate(async (list: string[]) => {
      const lab = (window as any).__lab;
      const pages = [];
      for (const b64 of list) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        pages.push(await lab.L.realEngine.createPage(new Blob([bytes], { type: "image/jpeg" }), { source: "library", mode: "document", settings: lab.settings("document") }));
      }
      const beat = lab.heartbeat();
      const t0 = performance.now();
      const flags = await lab.L.realEngine.analyzeSession(pages);
      const first = performance.now() - t0;
      const stats = beat.stop();
      const t1 = performance.now();
      const again = await lab.L.realEngine.analyzeSession(pages);
      const second = performance.now() - t1;
      return { first, second, maxGap: stats.maxGap, longTasks: stats.longTasks, flagged: Object.keys(flags).length, dups: Object.values(flags).filter((f: any) => f.duplicateOf).length, same: JSON.stringify(flags) === JSON.stringify(again) };
    }, photos);
    const longest = Math.max(0, ...out.longTasks);
    console.log(`[scan-perf] ${engineOf(page)} analyzeSession ${PHOTOS} fotos: ${Math.round(out.first)} ms (repetido ${Math.round(out.second)} ms); mayor tarea larga ${Math.round(longest)} ms; mayor pausa del hilo ${Math.round(out.maxGap)} ms; tareas largas ${out.longTasks.length}; duplicadas ${out.dups}`);
    expect(out.flagged).toBe(PHOTOS);
    expect(out.same).toBe(true);
    expect(out.maxGap).toBeLessThan(150 * SLACK);
    expect(longest).toBeLessThan(120 * SLACK);
    // Repetir el analisis reutiliza lo medido y lo comparado.
    expect(out.second).toBeLessThan(Math.max(500, out.first * 0.5));
  });
});
