import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeFingerprintWith, fingerprintOfText, pageText } from "./fingerprintEngine";
import { compareFingerprints } from "./match";
import { nodeEnv } from "./testing/nodeEnv";
import { reorderObjects, resave } from "./testing/syntheticContracts";
import type { Fingerprint } from "./types";

/**
 * MEDICIÓN con contratos REALES, solo en local: se salta si `OPTIMUS_REAL_CONTRACTS_DIR` no apunta a una carpeta con
 * PDF (CI, o cualquiera sin los archivos). Los PDF NUNCA se copian al repositorio ni se imprimen sus nombres ni su texto:
 * solo salen números (la tabla se identifica por la posición alfabética del archivo: C1, C2…).
 *
 *   OPTIMUS_REAL_CONTRACTS_DIR=/ruta/a/la/carpeta npx vitest run --project engines src/lib/docLibrary/realContracts.test.ts
 *
 * Mide: (1) estabilidad con re-guardados y reordenados, (2) la matriz N×N de comparaciones entre documentos distintos
 * (ninguno debe llegar a «Coincide»), (3) cambiar el texto de una cláusula de una página (revisar SOLO esa), (4) tiempo
 * y memoria por documento.
 */

const DIR = process.env.OPTIMUS_REAL_CONTRACTS_DIR;
const files = DIR && fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((name) => name.toLowerCase().endsWith(".pdf")).sort() : [];

describe.skipIf(files.length === 0)("contratos reales (local)", () => {
  const bytes = files.map((name) => new Uint8Array(fs.readFileSync(path.join(DIR as string, name))));
  const labels = files.map((_, index) => `C${index + 1}`);
  const fps: Fingerprint[] = [];

  it("huella de cada documento: tiempo y memoria", async () => {
    for (let index = 0; index < files.length; index += 1) {
      const rssBefore = process.memoryUsage().rss;
      const started = performance.now();
      const fp = await computeFingerprintWith(bytes[index], nodeEnv());
      const ms = Math.round(performance.now() - started);
      fps.push(fp);
      console.info(`[reales] ${labels[index]}: ${fp.pageCount} págs, ${(bytes[index].length / 1e6).toFixed(2)} MB, ${ms} ms, +${Math.round((process.memoryUsage().rss - rssBefore) / 1e6)} MB RSS, páginas sin texto ${fp.pages.filter((page) => page.textHash === "").length}`);
      expect(fp.partial).toBeUndefined();
      expect(ms).toBeLessThan(5000);
    }
  }, 600_000);

  it("estabilidad: re-guardado, con y sin flujos de objetos y reordenado → «Coincide» con todas las páginas ≥ 0,90", async () => {
    for (let index = 0; index < files.length; index += 1) {
      for (const [name, transform] of [
        ["re-guardado", (b: Uint8Array) => resave(b, { useObjectStreams: false })],
        ["flujos de objetos", (b: Uint8Array) => resave(b, { useObjectStreams: true })],
        ["reordenado", reorderObjects],
      ] as const) {
        const variant = await transform(bytes[index]);
        const result = compareFingerprints(await computeFingerprintWith(variant, nodeEnv()), fps[index]);
        const min = Math.min(...result.pageMatches.map((page) => page.similarity));
        console.info(`[reales] estabilidad ${labels[index]} ${name}: ${result.level} ${result.percent} % (mín. página ${min.toFixed(3)})`);
        expect(result.level).toBe("match");
        expect(min).toBeGreaterThanOrEqual(0.9);
      }
    }
  }, 600_000);

  it("matriz N×N entre documentos distintos: ninguno llega a «Coincide»", () => {
    console.info(`[reales] matriz (nivel/% · páginas ≥ 0,90 · página máxima)  columnas: ${labels.join(" ")}`);
    for (let i = 0; i < fps.length; i += 1) {
      const row: string[] = [];
      for (let j = 0; j < fps.length; j += 1) {
        if (i === j) {
          row.push("   -   ");
          continue;
        }
        const result = compareFingerprints(fps[i], fps[j]);
        const over = result.pageMatches.filter((page) => page.similarity >= 0.9).length;
        const max = Math.max(...result.pageMatches.map((page) => page.similarity));
        row.push(`${result.level[0]}${result.percent}/${over}/${max.toFixed(2)}`);
        expect(["match", "exact"]).not.toContain(result.level);
      }
      console.info(`[reales] ${labels[i]}: ${row.join(" | ")}`);
    }
  });

  it("cambiar el texto de una cláusula de una página: «revisar» SOLO en esa", async () => {
    const env = nodeEnv();
    const pdfjs = await env.getPdfjs();
    for (let index = 0; index < files.length; index += 1) {
      const fp = fps[index];
      const target = Math.min(2, fp.pageCount - 1);
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes[index]), verbosity: 0, ...env.documentParams });
      const doc = await task.promise;
      const text = await pageText(await doc.getPage(target + 1));
      await task.destroy();
      const words = text.split(/\s+/);
      const from = Math.floor(words.length * 0.3);
      const to = Math.floor(words.length * 0.6);
      // Palabras SOLO de letras: un token con cifras se descarta al normalizar y no cambiaría nada.
      for (let w = from; w < to; w += 1) words[w] = `${String.fromCharCode(97 + (w % 26))}${String.fromCharCode(97 + (Math.floor(w / 26) % 26))}zq`;
      const replaced = await fingerprintOfText(words.join(" "), env.sha256);
      expect(replaced).not.toBeNull();
      const edited: Fingerprint = { ...fp, exact: "f".repeat(64), pages: fp.pages.map((page, i) => (i === target ? replaced! : page)) };
      const result = compareFingerprints(edited, fp);
      console.info(`[reales] ${labels[index]} cláusula cambiada en la pág. ${target + 1}: página ${result.pageMatches[target].similarity.toFixed(2)}, nivel ${result.level} ${result.percent} %, revisar [${result.reviewPages.map((p) => p + 1).join(",")}]`);
      expect(result.reviewPages).toEqual([target]);
      expect(result.pageMatches[target].similarity).toBeLessThan(0.9);
      expect(result.pageMatches.filter((_, i) => i !== target).every((page) => page.identical)).toBe(true);
    }
  }, 600_000);
});
