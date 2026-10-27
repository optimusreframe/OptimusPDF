import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { installScanicEnvironment, toNapiImageData } from "@/lib/scan/__fixtures__/testUtils";
import { paperKept } from "@/lib/scan/__fixtures__/scenes";
import { selectCrop } from "@/lib/scan/cropGate";
import { detectDocumentCorners } from "@/lib/scan/documentDetection";
import { detectLiveQuad } from "@/lib/scan/liveDetect";
import { downscaleRgba, type Rgba } from "@/lib/scan/pixels";
import { measurePage } from "@/lib/scan/quality";
import type { QuadCorners } from "@/lib/scan/perspective";

/**
 * DOCUMENTOS REALES (opcional, SOLO LOCAL): `SCAN_REAL_DOCS_DIR` con PDFs reales (contratos). Cada pagina se coloca sobre una mesa
 * sintetica (madera, gris, beige, gris claro; giros de 0 a 24 grados; sombra) y se comprueba el recorte y los avisos de calidad.
 * Los PDFs NO estan en el repositorio y solo se imprimen cifras agregadas.
 *
 *   SCAN_REAL_DOCS_DIR=/ruta npx vitest run src/lib/scan/scan.realDocs.test.ts
 */
const DIR = process.env.SCAN_REAL_DOCS_DIR;
const BGS: Record<string, [number, number, number]> = { wood: [74, 52, 36], gray: [70, 72, 76], beige: [201, 184, 150], light: [196, 198, 200] };
const CASES: Array<[number, string]> = [[0, "wood"], [9, "gray"], [-15, "beige"], [24, "wood"], [3, "light"]];

let restore: () => void;
beforeAll(() => {
  restore = installScanicEnvironment();
});
afterAll(() => restore?.());

describe.skipIf(!DIR)("documentos reales (local)", () => {
  it("recorte sin perdida de papel y avisos de calidad sin falsos positivos", async () => {
    const lib = await import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    const files = fs.readdirSync(DIR as string).filter((f) => /\.pdf$/i.test(f)).sort();
    const pages = Number(process.env.SCAN_REAL_DOCS_PAGES ?? 3);
    let total = 0;
    let cropped = 0;
    let lossy = 0;
    let minKept = 1;
    let blurry = 0;
    let blank = 0;
    let glare = 0;
    let sparse = 0;
    const detected: Record<number, number> = { 6: 0, 12: 0, 20: 0 };
    let measured = 0;
    for (const f of files) {
      const doc = await lib.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(DIR as string, f))), useSystemFonts: true }).promise;
      for (let n = 1; n <= Math.min(pages, doc.numPages); n += 1) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1.4 });
        const pc = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
        await page.render({ canvasContext: pc.getContext("2d"), viewport: vp, canvas: pc }).promise;
        for (const [deg, bgn] of CASES) {
          const W = 1600;
          const H = 1200;
          const rot = (deg * Math.PI) / 180;
          const cv = createCanvas(W, H);
          const ctx = cv.getContext("2d");
          ctx.fillStyle = `rgb(${BGS[bgn]})`;
          ctx.fillRect(0, 0, W, H);
          const ph = H * 0.8;
          const pw = ph * (pc.width / pc.height);
          const c = Math.cos(rot);
          const s = Math.sin(rot);
          const pts = [[-pw / 2, -ph / 2], [pw / 2, -ph / 2], [pw / 2, ph / 2], [-pw / 2, ph / 2]].map(([x, y]) => [W / 2 + x * c - y * s, H / 2 + x * s + y * c] as [number, number]);
          ctx.save();
          ctx.shadowColor = "rgba(0,0,0,0.5)";
          ctx.shadowBlur = 26;
          ctx.shadowOffsetX = 12;
          ctx.shadowOffsetY = 16;
          ctx.beginPath();
          ctx.moveTo(...pts[0]);
          pts.slice(1).forEach((p) => ctx.lineTo(...p));
          ctx.closePath();
          ctx.fillStyle = "#fff";
          ctx.fill();
          ctx.restore();
          ctx.save();
          ctx.translate(...pts[0]);
          ctx.rotate(rot);
          ctx.scale(pw / pc.width, pw / pc.width);
          ctx.drawImage(pc, 0, 0);
          ctx.restore();
          const data = ctx.getImageData(0, 0, W, H);
          const image: Rgba = { data: new Uint8ClampedArray(data.data), width: W, height: H };
          const small = downscaleRgba(image, 800);
          const found = await detectDocumentCorners(toNapiImageData(small));
          const live = detectLiveQuad(small);
          const { quad } = selectCrop(found ? found.corners : null, live && live.confidence >= 0.9 && live.touchesBorder < 0.05 ? live.quad : null, small, "document", live?.confidence ?? 0);
          total += 1;
          const truth: QuadCorners = { topLeft: { x: pts[0][0] / W, y: pts[0][1] / H }, topRight: { x: pts[1][0] / W, y: pts[1][1] / H }, bottomRight: { x: pts[2][0] / W, y: pts[2][1] / H }, bottomLeft: { x: pts[3][0] / W, y: pts[3][1] / H } };
          if (quad) {
            cropped += 1;
            const kept = paperKept(truth, quad);
            minKept = Math.min(minKept, kept);
            if (kept < 0.99) lossy += 1;
          }
          // Calidad sobre la hoja entera (pagina real nitida): ni borrosa ni en blanco ni con brillo.
          const flat = downscaleRgba({ data: new Uint8ClampedArray(pc.getContext("2d").getImageData(0, 0, pc.width, pc.height).data), width: pc.width, height: pc.height }, 1280);
          if (deg === 0) {
            const q = measurePage(flat);
            if (q.blurry) blurry += 1;
            if (q.blank) blank += 1;
            if (q.glare) glare += 1;
            if (q.sparse) sparse += 1;
            // El mismo texto desenfocado (sigma en px de la pagina a 833 px de ancho): debe salir «borrosa», no «en blanco».
            measured += 1;
            for (const sigma of [6, 12, 20]) {
              const blurred = createCanvas(pc.width, pc.height);
              const bctx = blurred.getContext("2d");
              bctx.filter = `blur(${sigma}px)`;
              bctx.drawImage(pc, 0, 0);
              const bq = measurePage(downscaleRgba({ data: new Uint8ClampedArray(bctx.getImageData(0, 0, pc.width, pc.height).data), width: pc.width, height: pc.height }, 1280));
              if (bq.blurry && !bq.blank) detected[sigma] += 1;
            }
          }
        }
      }
    }
    const pagesMeasured = total / CASES.length;
    fs.appendFileSync(process.env.REAL_OUT ?? path.join(process.cwd(), "..", "realdocs.txt"), `docs ${files.length} pages ${pagesMeasured} cases ${total} cropped ${cropped} lossy(<99%) ${lossy} minKept ${(minKept * 100).toFixed(2)} | quality: blurry ${blurry} blank ${blank} sparse ${sparse} glare ${glare} | blurred detected sigma6 ${detected[6]}/${measured} sigma12 ${detected[12]}/${measured} sigma20 ${detected[20]}/${measured}\n`);
    expect(lossy).toBe(0);
    expect(blurry).toBe(0);
    expect(blank + sparse).toBe(0);
    expect(detected[12] / Math.max(1, measured)).toBeGreaterThanOrEqual(0.9);
  }, 900_000);
});
