/* eslint-disable @typescript-eslint/no-explicit-any -- el codigo de `page.evaluate` se ejecuta en el navegador sobre `window.__lab` (motor empaquetado) */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { openLab as openLabWith } from "../helpers/scan-engine-lab";
import { engineOf } from "../helpers/engine";
import { renderScene, type SceneSpec } from "../../src/lib/scan/__fixtures__/scenes";

/**
 * ESTIMACION DE TAMANO de paginas PROCESADAS (filtro documento / B/N, recortadas) y de paginas de documento a pantalla completa,
 * en un navegador real: estimado frente al PDF real, por preset. Imagenes sinteticas siempre; con `SCAN_REAL_DOCS_DIR` (solo local)
 * tambien paginas de PDFs reales como «fotos» a pantalla completa (solo se imprimen cifras agregadas).
 *
 * Criterio: el total por preset queda dentro de +-12 % y NO se subestima (sesgo hacia arriba).
 */

test.setTimeout(600_000);
const openLab = (page: Page) => openLabWith(page, {}, { worker: true });

function jpeg(canvas: Canvas, quality = 88): string {
  return canvas.toBuffer("image/jpeg", quality).toString("base64");
}

/** Con `CI=1` menos escenas y mas pequenas (dos navegadores a la vez con fotos de varios MP agotaban la memoria del contenedor). */
const IN_CI = !!process.env.CI;
const SIZE = IN_CI ? { W: 2400, H: 1800 } : { W: 3200, H: 2400 };

const SCENES_ALL: Array<[string, SceneSpec]> = [
  ["mesa-oscura", { bg: "wood-dark", shadow: 1, paper: { cx: 0.5, cy: 0.5, pw: 0.62, ph: 0.8 } }],
  ["rotado-12", { bg: "wood-dark", shadow: 1, paper: { cx: 0.5, cy: 0.5, pw: 0.56, ph: 0.72, rot: (12 * Math.PI) / 180 } }],
  ["beige", { bg: "beige", shadow: 1, paper: { cx: 0.5, cy: 0.5, pw: 0.6, ph: 0.8, rot: (4 * Math.PI) / 180 } }],
  ["luz-desigual", { bg: "wood-dark", shadow: 1, gradient: true, paper: { cx: 0.5, cy: 0.5, pw: 0.6, ph: 0.78, rot: (6 * Math.PI) / 180 } }],
  ["gris-claro", { bg: "gray-light", shadow: 1, paper: { cx: 0.5, cy: 0.5, pw: 0.6, ph: 0.8 } }],
  ["membrete", { bg: "gray-dark", shadow: 1, header: "#1f4e8c", paper: { cx: 0.5, cy: 0.5, pw: 0.6, ph: 0.8 } }],
];

const SCENES = IN_CI ? SCENES_ALL.slice(0, 4) : SCENES_ALL;

async function measure(page: Page, photos: string[], filter: string, mode: string) {
  return page.evaluate(
    async ({ photos, filter, mode }) => {
      const lab = (window as any).__lab;
      const pages = [];
      for (const b64 of photos) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const settings = lab.settings(mode, { defaultFilter: filter });
        pages.push(await lab.L.realEngine.createPage(new Blob([bytes], { type: "image/jpeg" }), { source: "library", mode, settings }));
      }
      const rows: Record<string, { estimate: number; real: number }> = {};
      for (const preset of ["original", "high", "balanced", "compact"]) {
        const estimate = lab.L.realEngine.estimateSize(pages, { preset, searchable: false }).bytes;
        const blob = await lab.L.realEngine.buildPdf({ id: "sc-est-0001", createdAt: "", updatedAt: "", name: "n", pages, settings: lab.settings(mode, { defaultFilter: filter }) }, { preset, pageSize: "fit", margin: "none" });
        rows[preset] = { estimate, real: blob.size };
      }
      return { rows, input: photos.reduce((s, b) => s + Math.floor((b.length * 3) / 4), 0) };
    },
    { photos, filter, mode },
  );
}

const report = (label: string, page: Page, out: Awaited<ReturnType<typeof measure>>) => {
  const parts = Object.entries(out.rows).map(([k, v]) => `${k} ${(((v.estimate - v.real) / v.real) * 100).toFixed(1)}% (${Math.round(v.estimate / 1024)}/${Math.round(v.real / 1024)} kB)`);
  console.log(`[scan-estimate] ${engineOf(page)} ${label}: ${parts.join("; ")}`);
};

test.describe("estimacion de tamano · paginas procesadas", () => {
  for (const filter of ["auto", "bw", "enhance"]) {
    test(`escenas sinteticas (3200x2400; 2400x1800 con CI) recortadas, filtro ${filter}: dentro de +-12 % y sin subestimar`, async ({ page }) => {
      await openLab(page);
      const photos = SCENES.map(([, spec], i) => jpeg(sceneCanvas(spec, 50 + i)));
      const out = await measure(page, photos, filter, "document");
      report(`escenas/${filter}`, page, out);
      for (const [preset, v] of Object.entries(out.rows)) {
        const error = (v.estimate - v.real) / v.real;
        expect(error, `${filter}/${preset}`).toBeLessThanOrEqual(0.12);
        expect(error, `${filter}/${preset}`).toBeGreaterThanOrEqual(-0.12);
      }
    });
  }

  const DOCS = process.env.SCAN_REAL_DOCS_DIR;
  test("paginas de PDFs reales como fotos a pantalla completa (local)", async ({ page }) => {
    test.skip(!DOCS, "sin SCAN_REAL_DOCS_DIR");
    const lib = await import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    const files = fs.readdirSync(DOCS as string).filter((f) => /\.pdf$/i.test(f)).sort().slice(0, 10);
    const photos: string[] = [];
    for (const f of files) {
      const doc = await lib.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(DOCS as string, f))), useSystemFonts: true }).promise;
      const p = await doc.getPage(1);
      const vp = p.getViewport({ scale: 2.2 });
      const pc = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      await p.render({ canvasContext: pc.getContext("2d"), viewport: vp, canvas: pc }).promise;
      const c = createCanvas(pc.width, pc.height);
      const x = c.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(pc, 0, 0);
      x.globalCompositeOperation = "multiply";
      x.fillStyle = "rgb(236,234,228)";
      x.fillRect(0, 0, c.width, c.height);
      photos.push(jpeg(c, 85));
    }
    await openLab(page);
    for (const filter of ["auto", "bw", "enhance"]) {
      const out = await measure(page, photos, filter, "document");
      report(`paginas reales/${filter}`, page, out);
      for (const [preset, v] of Object.entries(out.rows)) {
        const error = (v.estimate - v.real) / v.real;
        expect(error, `${filter}/${preset}`).toBeLessThanOrEqual(0.12);
        expect(error, `${filter}/${preset}`).toBeGreaterThanOrEqual(-0.12);
      }
    }
  });
});

function sceneCanvas(spec: SceneSpec, seed: number): Canvas {
  const scene = renderScene(spec, seed, SIZE);
  const canvas = createCanvas(scene.width, scene.height);
  const ctx = canvas.getContext("2d");
  const data = ctx.createImageData(scene.width, scene.height);
  data.data.set(scene.image.data);
  ctx.putImageData(data, 0, 0);
  return canvas;
}
