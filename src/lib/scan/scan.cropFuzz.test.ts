import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installScanicEnvironment, toNapiImageData } from "@/lib/scan/__fixtures__/testUtils";
import { fuzzSpecs, paperKept, renderScene, type SceneSpec } from "@/lib/scan/__fixtures__/scenes";
import { selectCrop } from "@/lib/scan/cropGate";
import { detectDocumentCorners } from "@/lib/scan/documentDetection";
import { detectLiveQuad } from "@/lib/scan/liveDetect";
import { downscaleRgba } from "@/lib/scan/pixels";
import type { ScanMode } from "@/lib/scan/types";

/**
 * Recorte automatico con escenas sinteticas variadas (membretes oscuros o de color, giros 0-30 grados, mesas oscuras, claras y de
 * madera, sombras, tarjetas): en TODOS los recortes que se aplican se conserva >= 99 % del papel; si no, no se aplica el recorte.
 */

let restore: () => void;
beforeAll(() => {
  restore = installScanicEnvironment();
});
afterAll(() => restore());

async function crop(spec: SceneSpec, seed: number, mode: ScanMode = "document") {
  const scene = renderScene(spec, seed);
  const small = downscaleRgba(scene.image, 800);
  const found = await detectDocumentCorners(toNapiImageData(small));
  const live = detectLiveQuad(small);
  const { quad, verdict } = selectCrop(found ? found.corners : null, live && live.confidence >= 0.9 && live.touchesBorder < 0.05 ? live.quad : null, small, mode, live?.confidence ?? 0);
  return { scene, quad, verdict, kept: quad ? paperKept(scene.quad, quad) : 1 };
}

describe("fuzz del recorte automatico", () => {
  for (const [seed, count] of [[12345, 160], [777, 100]] as const) {
    it(`escenas variadas (semilla ${seed}, ${count}): en todo recorte aplicado se conserva >= 99 % del papel, y las hojas lisas SI se recortan`, async () => {
      const n = Number(process.env.FUZZ_N ?? count);
      const rows: Array<{ name: string; cropped: boolean; kept: number; reason: string | null }> = [];
      for (const [i, { name, spec }] of fuzzSpecs(n, Number(process.env.FUZZ_SEED ?? seed)).entries()) {
        const r = await crop(spec, 100 + i);
        rows.push({ name, cropped: !!r.quad, kept: r.kept, reason: r.verdict?.reason ?? null });
      }
      if (process.env.FUZZ_OUT) fs.writeFileSync(process.env.FUZZ_OUT, JSON.stringify(rows, null, 1));
      const cropped = rows.filter((r) => r.cropped);
      const bad = cropped.filter((r) => r.kept < 0.99);
      if (process.env.FUZZ_OUT) fs.appendFileSync(process.env.FUZZ_OUT + ".txt", `N ${rows.length} cropped ${cropped.length} loss>1% ${bad.length} ${JSON.stringify(bad.map((b) => [b.name, +(b.kept * 100).toFixed(1)]))}\n`);
      expect(bad).toEqual([]);
      // Que no sea trivial: lo que no tiene membrete y llena el encuadre (hojas lisas) se recorta casi siempre.
      const plain = rows.filter((r) => !r.name.includes("hdr") && !r.name.includes("card") && r.reason !== "area");
      const plainCropped = plain.filter((r) => r.cropped);
      expect(plainCropped.length / Math.max(1, plain.length)).toBeGreaterThanOrEqual(0.9);
      expect(cropped.length).toBeGreaterThan(rows.length * 0.35);
    }, 600_000);
  }

  it("membrete oscuro o de color pegado a un papel girado sobre una mesa (informe del verificador): se recorta TODO o no se recorta", async () => {
    const base = { bg: "wood-dark", shadow: 1, paper: { cx: 0.5, cy: 0.5, pw: 0.62, ph: 0.8 } } as const;
    const header = [
      { header: "#222831", header2: "#444b57", headerH: 0.11 },
      { header: "#1f4e8c", header2: "#1f4e8c", headerH: 0.14 },
      { header: "#c0392b", header2: "#c0392b", headerH: 0.1 },
      { header: "#2e7d32", header2: "#2e7d32", headerH: 0.12 },
    ];
    for (const [k, h] of header.entries()) {
      for (const rot of [0, 13, -24]) {
        const spec: SceneSpec = { ...base, paper: { ...base.paper, rot: (rot * Math.PI) / 180 }, ...h };
        const r = await crop(spec, 31 + k);
        expect(r.kept, `membrete ${h.header} giro ${rot}`).toBeGreaterThanOrEqual(0.99);
      }
    }
  }, 300_000);
});
