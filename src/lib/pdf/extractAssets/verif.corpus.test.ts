import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { VERIF_CLASSES, evaluateVerifCorpus, formatVerifReport, loadVerifPdf, loadVerifTruth, type VerifClass, type VerifReport } from "./__fixtures__/verif/evaluate";
import { nodeExtractEnv } from "./__fixtures__/classify/nodeEnv";
import { extractWith } from "./orchestrate";

/**
 * Corpus INDEPENDIENTE del verificador (116 PDF sinteticos, 91 expectativas, 33 elementos senuelo): escrito por otra persona con otros
 * generadores (tipografias manuscritas del sistema, fotos JPEG con ruido y sombra, senuelos, `/Rotate`, CropBox). Los umbrales del
 * clasificador NO se afinaron con el: mide si lo ajustado al corpus propio (`classify.corpus.test.ts`) generaliza.
 * `VERIF_METRICS_OUT=ruta.json` guarda el informe. Los PDF estan guardados (el generador usa fuentes de macOS y no es reproducible en CI).
 *
 * Antes de las correcciones (informe de verificacion): firma P 0,92 / R 0,79; iniciales P 0,89 / R 0,44; logo P 0,40; sello 0,75 / 0,75;
 * marca de agua 1,00 / 1,00; senuelos ofrecidos como firma ~6-9 %.
 */

/** Objetivos tras las correcciones (los pedidos por el orquestador: iniciales R >= 0,80 y P >= 0,85; firma R >= 0,88 y P >= 0,90; logo P >= 0,85; senuelos <= 5 %). */
const TARGETS: Record<VerifClass, { precision: number; recall: number }> = {
  signature: { precision: 0.9, recall: 0.88 },
  initials: { precision: 0.85, recall: 0.8 },
  logo: { precision: 0.85, recall: 0.9 },
  stamp: { precision: 0.7, recall: 0.7 },
  watermark: { precision: 1, recall: 1 },
};
const MAX_DECOY_RATE = 0.05;

let report: VerifReport;
beforeAll(async () => {
  report = await evaluateVerifCorpus();
  if (process.env.VERIF_METRICS_OUT) fs.writeFileSync(process.env.VERIF_METRICS_OUT, `${JSON.stringify(report, null, 1)}\n`);
  console.info(`\nCorpus independiente (${report.cases} PDF, ${report.expectations} expectativas)\n${formatVerifReport(report)}\n`);
}, 600_000);

const row = (name: string, cond?: string) => {
  const found = report.rows.find((candidate) => candidate.name === name && (cond === undefined || candidate.cond === cond));
  if (!found) throw new Error(`sin fila para ${name}`);
  return found;
};

describe("corpus independiente · metricas", () => {
  it("tiene el tamano esperado (116 PDF, 91 expectativas) y todos los PDF guardados se leen", () => {
    expect(report.cases).toBe(116);
    expect(report.expectations).toBe(91);
    expect(loadVerifTruth().every((item) => loadVerifPdf(item.name).length > 100)).toBe(true);
  });

  it.each(VERIF_CLASSES)("%s: precision y recall alcanzan el objetivo", (cls) => {
    const m = report.perClass[cls];
    expect(m.precision, `precision ${cls}`).toBeGreaterThanOrEqual(TARGETS[cls].precision);
    expect(m.recall, `recall ${cls}`).toBeGreaterThanOrEqual(TARGETS[cls].recall);
  });

  it("senuelos ofrecidos como firma o iniciales: como mucho el 5 % de los elementos senuelo", () => {
    expect(report.decoys.elements).toBeGreaterThanOrEqual(30);
    expect(report.decoys.rate, report.decoys.offeredNames.join(", ")).toBeLessThanOrEqual(MAX_DECOY_RATE);
  });

  it("las iniciales de cualquier clase mal clasificada ya no acaban en «logo» (los 9 falsos logos del verificador)", () => {
    const logoFalse = report.falsePositives.filter((entry) => entry.kind === "logo");
    expect(logoFalse.map((entry) => entry.name)).toEqual([]);
  });
});

describe("corpus independiente · cada defecto reportado", () => {
  it("H1 · iniciales con «Initials:/Iniciales:» al lado: JPEG con tinta gruesa, PNG y varias paginas, todas iniciales y probables", () => {
    for (const index of [0, 1, 2, 3, 4]) {
      for (const mode of ["png-label", "jpg-label"]) {
        const item = row(`i-${index}-${mode}`);
        expect(item.gotKind, item.name).toBe("initials");
        expect(item.confidence, item.name).toBeGreaterThanOrEqual(0.85);
        expect(item.reasons.some((reason) => reason.startsWith("cerca de")), item.name).toBe(true);
      }
    }
  });
  it("H1 · el PDF firmado con iniciales en el pie de 4 paginas: las dos iniciales y las dos firmas", () => {
    const items = report.rows.filter((item) => item.name === "s-optimus-4pages-2signers-mine");
    expect(items.every((item) => item.ok)).toBe(true);
    expect(items.filter((item) => item.expCls === "initials")).toHaveLength(2);
  });
  it("H1 · iniciales sin etiqueta en el pie de 3 paginas: iniciales POSIBLES (nunca «probables»), no un logo", () => {
    for (const index of [0, 1, 2, 3, 4]) {
      const item = row(`i-${index}-png-nolabel`);
      expect(item.gotKind, item.name).toBe("initials");
      expect(item.confidence ?? 1, item.name).toBeLessThan(0.85);
    }
  });
  it("H2 · iniciales azules recortadas al ras: iniciales, no sello", () => {
    expect(row("i-single-page").gotKind).toBe("initials");
  });
  it("H3 · firmas en paginas giradas (apaisadas): se aceptan", () => {
    expect(row("s-rotate-90").gotKind).toBe("signature");
    expect(row("s-rotate-270").gotKind).toBe("signature");
    expect(row("s-rotate-180").gotKind).toBe("signature");
  });
  it("H3 · una firma grande (mas del 8 % de la altura) con su etiqueta, recortada: se acepta", () => {
    expect(row("s-large").gotKind).toBe("signature");
  });
  it("H5 · sello rectangular 3:1: sello", () => {
    expect(row("st-rect-blue").gotKind).toBe("stamp");
  });
  it("H6 · el icono de «visto» junto a «Signature» y el logo manuscrito repetido en la cabecera no son firma", () => {
    expect(report.falsePositives.filter((entry) => ["d-check-icon-near-label", "d-script-wordmark-header-x3"].includes(entry.name) && (entry.kind === "signature" || entry.kind === "initials"))).toEqual([]);
    expect(row("d-script-wordmark-header-x3").gotKind).toBe("logo");
  });
  it("H7 · «Rúbrica» es firma; fotos con sombra y oscuras con etiqueta, firma", () => {
    expect(row("s-label-14-rubrica").gotKind).toBe("signature");
    expect(row("s-photo-jpeg-shadow-label").gotKind).toBe("signature");
    expect(row("s-photo-jpeg-dark-photo-label").gotKind).toBe("signature");
  });
  it("«Firmado por:» se reconoce como etiqueta de firma (motivo «cerca de», probable)", () => {
    const item = row("s-label-04-firmadopor");
    expect(item.gotKind).toBe("signature");
    expect(item.confidence ?? 0).toBeGreaterThanOrEqual(0.85);
  });
  it("lo que se deja fuera a proposito: fotos opacas SIN etiqueta (un escaneo de texto o un dibujo no es una firma)", () => {
    for (const name of ["s-photo-jpeg-white-nolabel", "s-photo-jpeg-gray-scan-nolabel", "s-photo-jpeg-dark-photo-nolabel"]) expect(row(name).ok, name).toBe(false);
  });
  it("H4 · un campo /Sig vacio sigue saliendo del motor SIN formatos (la interfaz no lo ofrece como tarjeta)", async () => {
    const result = await extractWith(nodeExtractEnv, loadVerifPdf("a-sig-widget-empty"));
    const field = result.assets.find((asset) => asset.source === "sig-widget");
    expect(field?.formats).toEqual([]);
    expect(field?.pixel).toBeNull();
  });
});
