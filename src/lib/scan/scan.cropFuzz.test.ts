import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installScanicEnvironment, releaseScanicCanvases, settleMemory, toNapiImageData } from "@/lib/scan/__fixtures__/testUtils";
import { fuzzCardSpecs, fuzzSpecs, paperKept, renderScene, type SceneSpec } from "@/lib/scan/__fixtures__/scenes";
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

/** Tamano de las escenas: la deteccion trabaja a 800 px, asi que 1200 x 900 basta (y gasta la mitad de memoria que 1600 x 1200). */
const SCENE = { W: Number(process.env.FUZZ_W ?? 1200), H: Number(process.env.FUZZ_H ?? 900) };

async function crop(spec: SceneSpec, seed: number, mode: ScanMode = "document") {
  const scene = renderScene(spec, seed, SCENE);
  const small = downscaleRgba(scene.image, 800);
  const found = await detectDocumentCorners(toNapiImageData(small));
  releaseScanicCanvases();
  const live = detectLiveQuad(small);
  const { quad, verdict } = selectCrop(found ? found.corners : null, live && live.confidence >= 0.9 && live.touchesBorder < 0.05 ? live.quad : null, small, mode, live?.confidence ?? 0);
  const kept = quad ? paperKept(scene.quad, quad) : 1;
  await settleMemory();
  return { scene, quad, verdict, kept };
}

describe("fuzz del recorte automatico", () => {
  for (const [seed, count] of [[12345, 160], [777, 100]] as const) {
    it(`escenas variadas (semilla ${seed}, ${count}): en todo recorte aplicado se conserva >= 99 % del papel, y las hojas lisas SI se recortan`, async () => {
      const n = Number(process.env.FUZZ_N ?? count);
      const rows: Array<{ name: string; cropped: boolean; kept: number; reason: string | null }> = [];
      for (const [i, { name, spec }] of fuzzSpecs(n, Number(process.env.FUZZ_SEED ?? seed)).entries()) {
        if (i < Number(process.env.FUZZ_START ?? 0) || i >= Number(process.env.FUZZ_START ?? 0) + Number(process.env.FUZZ_COUNT ?? 1e9)) continue;
        const r = await crop(spec, 100 + i);
        rows.push({ name, cropped: !!r.quad, kept: r.kept, reason: r.verdict?.reason ?? null });
        if (process.env.FUZZ_OUT) fs.appendFileSync(process.env.FUZZ_OUT + ".progress", `${i} ${name} ${!!r.quad} ${r.kept.toFixed(3)} ${r.verdict?.reason}\n`);
      }
      if (process.env.FUZZ_OUT) fs.writeFileSync(process.env.FUZZ_OUT, JSON.stringify(rows, null, 1));
      const cropped = rows.filter((r) => r.cropped);
      const bad = cropped.filter((r) => r.kept < 0.99);
      if (process.env.FUZZ_OUT) fs.appendFileSync(process.env.FUZZ_OUT + ".txt", `N ${rows.length} cropped ${cropped.length} loss>1% ${bad.length} ${JSON.stringify(bad.map((b) => [b.name, +(b.kept * 100).toFixed(1)]))}\n`);
      expect(bad).toEqual([]);
      // Que no sea trivial: lo que no tiene membrete y llena el encuadre (hojas lisas) se recorta casi siempre. El umbral sale de medir
      // las MISMAS semillas en macOS y en Linux (Docker, node 24): 0,84-0,90 y 0,82-0,89 (el CI de GitHub dio 0,83-0,84 con escenas de 1600 x 1200). El canvas dibuja distinto en cada plataforma y
      // unas pocas escenas cambian de lado (se recortan o no); lo que NUNCA cambia es la seguridad (>= 99 % del papel, arriba).
      const plain = rows.filter((r) => !r.name.includes("hdr") && !r.name.includes("card") && r.reason !== "area");
      const plainCropped = plain.filter((r) => r.cropped);
      expect(plainCropped.length / Math.max(1, plain.length)).toBeGreaterThanOrEqual(0.7);
      expect(cropped.length).toBeGreaterThan(rows.length * 0.35);
    }, 600_000);
  }

  it("REGRESION del fuzz: escenas que en una plataforma quedaban recortadas perdiendo papel (membrete que se funde con la mesa, borde inclinado medible solo en parte)", async () => {
    // semilla 777 escena 84 (CI de Linux: se conservaba el 94,9 %: su texto quedaba a un punto del umbral) y semilla 5 escena 61 (98,3 % en Linux).
    for (const [seed, index] of [[777, 84], [5, 61]] as const) {
      const { name, spec } = fuzzSpecs(index + 1, seed)[index];
      const r = await crop(spec, 100 + index);
      expect(r.kept, `${name} (semilla ${seed})`).toBeGreaterThanOrEqual(0.99);
    }
  }, 120_000);

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

  it("tarjetas de identificacion (modo id-card, con cabecera oscura o de color, mesas incluida la azul): en todo recorte aplicado se conserva >= 99 % de la tarjeta", async () => {
    const n = Number(process.env.FUZZ_CARDS ?? 120);
    const rows: Array<{ name: string; cropped: boolean; kept: number; reason: string | null }> = [];
    for (const [i, { name, spec }] of fuzzCardSpecs(n, Number(process.env.FUZZ_CARD_SEED ?? 4321)).entries()) {
      const r = await crop(spec, 500 + i, "id-card");
      rows.push({ name, cropped: !!r.quad, kept: r.kept, reason: r.verdict?.reason ?? null });
    }
    if (process.env.FUZZ_OUT) fs.writeFileSync(process.env.FUZZ_OUT + ".cards", JSON.stringify(rows));
    const cropped = rows.filter((r) => r.cropped);
    expect(cropped.filter((r) => r.kept < 0.99)).toEqual([]);
    expect(cropped.length).toBeGreaterThan(rows.length * 0.25);
  }, 600_000);

  it("tarjeta con cabecera del color casi de la mesa (informe del verificador: #34495e sobre gris o azul, #222831 sobre madera): se recorta TODA o no se recorta", async () => {
    const cases: Array<[SceneSpec["bg"], string, number, string]> = [
      ["gray-dark", "#34495e", -6, "#cfe3cf"],
      ["gray-dark", "#34495e", -26, "#cfe3cf"],
      ["blue", "#34495e", 30, "#e8d8c0"],
      ["wood-dark", "#222831", 10, "#f0d0d0"],
      ["wood-dark", "#222831", -10, "#f0d0d0"],
    ];
    for (const [k, [bg, header, rot, paperColor]] of cases.entries()) {
      const spec: SceneSpec = { bg, shadow: 1, paperColor, header, header2: header, headerH: 0.22, paper: { cx: 0.5, cy: 0.5, ph: 0.4, asp: 1.586, rot: (rot * Math.PI) / 180 } };
      const r = await crop(spec, 71 + k, "id-card");
      expect(r.kept, `${bg} ${header} giro ${rot}`).toBeGreaterThanOrEqual(0.99);
    }
  }, 300_000);
});
