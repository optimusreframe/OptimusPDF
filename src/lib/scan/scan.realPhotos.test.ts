import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { installScanicEnvironment, toNapiImageData } from "@/lib/scan/__fixtures__/testUtils";
import { selectCrop } from "@/lib/scan/cropGate";
import { detectDocumentCorners } from "@/lib/scan/documentDetection";
import { detectLiveQuad } from "@/lib/scan/liveDetect";
import { boxBlur, downscaleRgba, type Rgba } from "@/lib/scan/pixels";
import { measurePage } from "@/lib/scan/quality";

/**
 * FOTOS REALES (opcional, SOLO LOCAL): si `SCAN_REAL_PHOTOS_DIR` apunta a una carpeta con fotos reales SIN documento (techos,
 * por ejemplo; `*-image.jpg`), comprueba que no se recortan ni se marcan borrosas o con brillo por error, y que las mismas fotos
 * desenfocadas SI se marcan borrosas. Las fotos NO estan en el repositorio y el informe solo imprime cifras agregadas.
 *
 *   SCAN_REAL_PHOTOS_DIR=/ruta/a/fotos npx vitest run src/lib/scan/scan.realPhotos.test.ts
 */
const DIR = process.env.SCAN_REAL_PHOTOS_DIR;

async function load(file: string): Promise<Rgba> {
  const img = await loadImage(fs.readFileSync(file));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  return { data: new Uint8ClampedArray(data.data), width: img.width, height: img.height };
}

function blurred(image: Rgba, radius: number): Rgba {
  const out = new Uint8ClampedArray(image.data);
  for (let channel = 0; channel < 3; channel += 1) {
    const plane = new Float32Array(image.width * image.height);
    for (let i = 0; i < plane.length; i += 1) plane[i] = image.data[i * 4 + channel];
    let b: Float32Array = plane;
    for (let pass = 0; pass < 2; pass += 1) b = boxBlur(b, image.width, image.height, radius);
    for (let i = 0; i < plane.length; i += 1) out[i * 4 + channel] = b[i];
  }
  return { data: out, width: image.width, height: image.height };
}

describe.skipIf(!DIR)("fotos reales sin documento (local)", () => {
  it("no se recortan, no salen borrosas ni con brillo, y desenfocadas si salen borrosas", async () => {
    const restore = installScanicEnvironment();
    try {
      const files = fs
        .readdirSync(DIR as string)
        .filter((f) => f.endsWith("-image.jpg"))
        .map((f) => path.join(DIR as string, f));
      expect(files.length).toBeGreaterThan(0);
      let cropped = 0;
      let blurry = 0;
      let glare = 0;
      let blurredDetected = 0;
      for (const file of files) {
        const full = await load(file);
        const small = downscaleRgba(full, 800);
        const found = await detectDocumentCorners(toNapiImageData(small));
        const live = detectLiveQuad(small);
        const { quad } = selectCrop(found ? found.corners : null, live && live.confidence >= 0.9 && live.touchesBorder < 0.05 ? live.quad : null, small, "document", live?.confidence ?? 0);
        if (quad) cropped += 1;
        const quality = measurePage(downscaleRgba(full, 1280));
        if (quality.blurry) blurry += 1;
        if (quality.glare) glare += 1;
        if (measurePage(blurred(downscaleRgba(full, 1280), 8)).blurry) blurredDetected += 1;
      }
      const line = `fotos=${files.length} recortadas=${cropped} borrosas=${blurry} brillo=${glare} desenfocadas-detectadas=${blurredDetected}`;
      console.log(`[scan-real] ${line}`);
      if (process.env.REAL_OUT) fs.appendFileSync(process.env.REAL_OUT, `photos ${line}\n`);
      expect(cropped).toBe(0);
      expect(blurry).toBe(0);
      expect(glare).toBe(0);
      expect(blurredDetected / files.length).toBeGreaterThanOrEqual(0.9);
    } finally {
      restore();
    }
  }, 300_000);
});
