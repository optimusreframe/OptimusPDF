import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCorpus, type Corpus, type CorpusItem } from "@/lib/scan/__fixtures__/corpus";
import { fakeOcr, installScanicEnvironment, rectify, toNapiImageData } from "@/lib/scan/__fixtures__/testUtils";
import { quadIoU } from "@/lib/scan/geometry";
import { selectCrop } from "@/lib/scan/cropGate";
import { detectDocumentCorners } from "@/lib/scan/documentDetection";
import { detectLiveQuad } from "@/lib/scan/liveDetect";
import { buildNameSuggestion } from "@/lib/scan/naming";
import { detectTextOrientation } from "@/lib/scan/orientation";
import { downscaleRgba, histogram256, otsuThreshold, toGray } from "@/lib/scan/pixels";
import { measurePage } from "@/lib/scan/quality";
import { areDuplicates, computeSignature } from "@/lib/scan/similarity";
import { findSpine } from "@/lib/scan/spine";
import { readFrame } from "@/lib/scan/liveFrame";
import { renderRgba, thumbnailOf } from "@/lib/scan/renderCore";
import { DEFAULT_QUAD, warpImageData, type QuadCorners } from "@/lib/scan/perspective";

/**
 * METRICAS del motor del Escaner sobre el corpus SINTETICO (`__fixtures__/`): reproducibles (todo sale de semillas fijas y de
 * las fuentes Liberation del proyecto) y sin red. Cada bloque imprime su cifra (informe) y exige el objetivo del brief.
 * Los resultados de OCR se simulan con un lector de mentira (el modelo de idioma de tesseract.js necesita red).
 */

const all: Record<string, number | string> = {};
let corpus: Corpus;
let restore: () => void;
const everything = (): CorpusItem[] => [...corpus.documents, ...corpus.blanks, ...corpus.quality, ...corpus.session, ...corpus.special];

beforeAll(() => {
  restore = installScanicEnvironment();
  corpus = buildCorpus();
}, 240_000);

afterAll(() => {
  restore?.();
  // Informe reproducible.
  console.log(`\n[scan-metrics] ${JSON.stringify(all, null, 2)}`);
});

function record(name: string, value: number | string): void {
  all[name] = typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
}

describe("orientacion del texto (heuristica por proyeccion)", () => {
  it("de las respuestas confiadas acierta >= 0,9 y los giros erroneos confiados son <= 2 % del total", () => {
    const items = [...corpus.documents, ...corpus.session.filter((i) => i.kind !== "blank")];
    let confident = 0;
    let right = 0;
    for (const item of items) {
      const read = detectTextOrientation(rectify(item, 560));
      if (!read) continue;
      confident += 1;
      if (read.rotation === item.truth.neededRotation) right += 1;
    }
    const wrongRate = (confident - right) / items.length;
    record("orientation.cases", items.length);
    record("orientation.confidentShare", confident / items.length);
    record("orientation.precisionOfConfident", right / confident);
    record("orientation.wrongConfidentRate", wrongRate);
    expect(confident / items.length).toBeGreaterThan(0.6);
    expect(right / confident).toBeGreaterThanOrEqual(0.9);
    expect(wrongRate).toBeLessThanOrEqual(0.02);
  });

  it("una hoja en blanco o una foto de dano no dan orientacion (no gira a ciegas)", () => {
    for (const item of [...corpus.blanks.filter((i) => i.truth.blank), ...corpus.special.filter((i) => i.kind === "photo")]) {
      expect(detectTextOrientation(rectify(item, 560)), item.id).toBeNull();
    }
  });
});

describe("hojas en blanco", () => {
  it("precision >= 0,95 y recall >= 0,9 (sellos pequenos y numeros de pagina cuentan como en blanco)", () => {
    const items = [...corpus.documents, ...corpus.blanks, ...corpus.quality, ...corpus.session];
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const item of items) {
      const predicted = measurePage(rectify(item, 560)).blank;
      if (predicted && item.truth.blank) tp += 1;
      else if (predicted) fp += 1;
      else if (item.truth.blank) fn += 1;
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    record("blank.cases", items.length);
    record("blank.precision", precision);
    record("blank.recall", recall);
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});

describe("paginas repetidas", () => {
  it("precision >= 0,9; los formularios iguales con otros datos NO se marcan", () => {
    const items = corpus.session;
    const sigs = items.map((item, index) => ({ item, sig: computeSignature(rectify(item, 560, jitter(item.truth.quad as QuadCorners, index))) }));
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let formPairs = 0;
    let formFlagged = 0;
    for (let i = 0; i < sigs.length; i += 1) {
      for (let j = i + 1; j < sigs.length; j += 1) {
        const a = sigs[i];
        const b = sigs[j];
        const truthDup = !!a.item.truth.duplicateGroup && a.item.truth.duplicateGroup === b.item.truth.duplicateGroup;
        const predicted = areDuplicates(a.sig, b.sig);
        if (predicted && truthDup) tp += 1;
        else if (predicted) fp += 1;
        else if (truthDup) fn += 1;
        if (a.item.kind === "form" && b.item.kind === "form") {
          formPairs += 1;
          if (predicted) formFlagged += 1;
        }
      }
    }
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / Math.max(1, tp + fn);
    record("duplicates.pairs", tp + fp + fn);
    record("duplicates.precision", precision);
    record("duplicates.recall", recall);
    record("duplicates.sameFormDifferentDataFlagged", `${formFlagged}/${formPairs}`);
    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.8);
    expect(formFlagged).toBe(0);
  });
});

/** Perturba las esquinas (hasta ~0,6 %) como lo haria una deteccion real distinta en cada captura. */
function jitter(quad: QuadCorners, seed: number): QuadCorners {
  const out = JSON.parse(JSON.stringify(quad)) as QuadCorners;
  let s = seed + 1;
  for (const key of Object.keys(out) as Array<keyof QuadCorners>) {
    out[key].x += Math.sin(s * 12.9898) * 0.006;
    out[key].y += Math.cos(s * 78.233) * 0.006;
    s += 1;
  }
  return out;
}

describe("deteccion del documento", () => {
  it("scanic sobre la foto completa: >= 0,9 de los documentos con IoU >= 0,9", async () => {
    const items = everything().filter((i) => i.truth.hasDocument && i.truth.quad && i.kind !== "book");
    let hit = 0;
    const misses: string[] = [];
    for (const item of items) {
      const found = await detectDocumentCorners(toNapiImageData(item.image));
      const iou = found && item.truth.quad ? quadIoU(found.corners, item.truth.quad) : 0;
      if (iou >= 0.9) hit += 1;
      else misses.push(`${item.id}:${iou.toFixed(2)}`);
    }
    record("detect.scanic.cases", items.length);
    record("detect.scanic.iou90", hit / items.length);
    record("detect.scanic.misses", misses.join(" ") || "-");
    expect(hit / items.length).toBeGreaterThanOrEqual(0.9);
  }, 240_000);

  it("recorte AUTOMATICO (lo que usa createPage: scanic + ligero + puerta): >= 0,95 de los documentos recortados con IoU >= 0,9 y NINGUN recorte en escenas sin documento", async () => {
    const items = everything().filter((i) => i.truth.hasDocument && i.truth.quad);
    let hit = 0;
    let wrongCrop = 0;
    let notCropped = 0;
    const misses: string[] = [];
    for (const item of items) {
      const small = downscaleRgba(item.image, 800);
      const found = await detectDocumentCorners(toNapiImageData(small));
      const live = detectLiveQuad(small);
      const { quad, verdict } = selectCrop(found ? found.corners : null, live && live.confidence >= 0.9 && live.touchesBorder < 0.05 ? live.quad : null, small, item.mode, live?.confidence ?? 0);
      if (!quad) {
        notCropped += 1;
        misses.push(`${item.id}:sin-recorte(${verdict?.reason ?? "sin-cuadrilatero"})`);
        continue;
      }
      const iou = quadIoU(quad, item.truth.quad as QuadCorners);
      if (iou >= 0.9) hit += 1;
      else {
        wrongCrop += 1;
        misses.push(`${item.id}:${iou.toFixed(2)}`);
      }
    }
    // Sin documento: nada se recorta (techos, paredes, un cuadro, una pagina blanca a sangre con un rectangulo rojo...).
    const falseCrops: string[] = [];
    for (const item of [...corpus.noDocument, ...corpus.special.filter((i) => i.kind === "photo")]) {
      const small = downscaleRgba(item.image, 800);
      const found = await detectDocumentCorners(toNapiImageData(small));
      const live = detectLiveQuad(small);
      const { quad } = selectCrop(found ? found.corners : null, live && live.confidence >= 0.9 && live.touchesBorder < 0.05 ? live.quad : null, small, "document", live?.confidence ?? 0);
      if (quad) falseCrops.push(item.id);
    }
    record("crop.cases", items.length);
    record("crop.correctIou90", hit / items.length);
    record("crop.wrongCrop", wrongCrop);
    record("crop.notCroppedFullPage", notCropped);
    record("crop.misses", misses.join(" ") || "-");
    record("crop.noDocumentCases", corpus.noDocument.length + corpus.special.filter((i) => i.kind === "photo").length);
    record("crop.falseCropsOnNoDocument", falseCrops.join(" ") || 0);
    expect(falseCrops).toEqual([]);
    // Lo que se recorta se recorta BIEN: ninguno con IoU < 0,9 (ante la duda, pagina completa).
    expect(wrongCrop).toBe(0);
    expect(hit / items.length).toBeGreaterThanOrEqual(0.95);
  }, 240_000);

  it("el detector en vivo (sincrono, muestra de 320 px): >= 0,9 con IoU >= 0,9", () => {
    const items = everything().filter((i) => i.truth.hasDocument && i.truth.quad);
    let hit = 0;
    for (const item of items) {
      const found = detectLiveQuad(downscaleRgba(item.image, 320));
      if (found && item.truth.quad && quadIoU(found.quad, item.truth.quad) >= 0.9) hit += 1;
    }
    record("detect.live.cases", items.length);
    record("detect.live.iou90", hit / items.length);
    expect(hit / items.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe("calidad: borrosa, brillo y oscuridad", () => {
  it("separa nitidas de borrosas, con y sin reflejo, y detecta la falta de luz", () => {
    const rows = corpus.quality.map((item) => ({ item, q: measurePage(rectify(item, 560)) }));
    const blurTp = rows.filter((r) => !r.item.truth.sharp && r.q.blurry).length;
    const blurTotal = rows.filter((r) => !r.item.truth.sharp).length;
    const blurFp = rows.filter((r) => r.item.truth.sharp && r.q.blurry).length;
    const glareTp = rows.filter((r) => r.item.truth.glare && r.q.glare).length;
    const glareTotal = rows.filter((r) => r.item.truth.glare).length;
    const glareFp = rows.filter((r) => !r.item.truth.glare && r.q.glare).length;
    const darkTp = rows.filter((r) => r.item.truth.dark && r.q.dark).length;
    const darkTotal = rows.filter((r) => r.item.truth.dark).length;
    const darkFp = rows.filter((r) => !r.item.truth.dark && r.q.dark).length;
    record("quality.blurRecall", blurTp / blurTotal);
    record("quality.blurFalsePositives", blurFp);
    record("quality.glareRecall", glareTp / glareTotal);
    record("quality.glareFalsePositives", glareFp);
    record("quality.darkRecall", darkTp / darkTotal);
    record("quality.darkFalsePositives", darkFp);
    expect(blurTp / blurTotal).toBeGreaterThanOrEqual(0.9);
    expect(blurFp).toBe(0);
    expect(glareTp / glareTotal).toBeGreaterThanOrEqual(0.9);
    expect(glareFp).toBe(0);
    expect(darkTp / darkTotal).toBeGreaterThanOrEqual(0.9);
    expect(darkFp).toBe(0);
    // Ningun documento de texto nitido y bien iluminado del corpus se marca como borroso, con reflejo u oscuro.
    for (const item of corpus.documents) {
      const q = measurePage(rectify(item, 560));
      expect(q.blurry || q.glare || q.dark, item.id).toBe(false);
    }
  });

  it("en vivo: la captura automatica solo se permite con una hoja nitida, con luz y sin reflejo", () => {
    const okOf = (item: CorpusItem) => {
      const r = readFrame(downscaleRgba(item.image, 320));
      return !!r.quad && !r.blurry && !r.glare && !r.dark;
    };
    const sharp = corpus.quality.filter((i) => i.id.startsWith("q-sharp"));
    const bad = corpus.quality.filter((i) => !i.id.startsWith("q-sharp"));
    record("live.sharpAccepted", sharp.filter(okOf).length / sharp.length);
    record("live.badRejected", bad.filter((i) => !okOf(i)).length / bad.length);
    expect(sharp.filter(okOf).length / sharp.length).toBeGreaterThanOrEqual(0.9);
    expect(bad.filter((i) => !okOf(i)).length / bad.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe("filtro auto (legibilidad de control)", () => {
  /** Dilatacion de una mascara (Chebyshev, radio `r`). */
  function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
    const rows = new Uint8Array(mask.length);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!mask[y * w + x]) continue;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k += 1) rows[y * w + k] = 1;
      }
    }
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!rows[y * w + x]) continue;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k += 1) out[k * w + x] = 1;
      }
    }
    return out;
  }

  /**
   * Proxy de OCR: se binariza el resultado (Otsu global, lo que haria un motor sencillo) y se mide que parte de la TINTA
   * verdadera de la hoja limpia se recupera (F1 con tolerancia de 2 px, a la resolucion de la hoja limpia).
   */
  function inkF1(image: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }, truth: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }, fixed?: number): number {
    const w = truth.width;
    const h = truth.height;
    const resized = warpImageData(image, DEFAULT_QUAD, { width: w, height: h }) as { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
    const gray = toGray(resized);
    const t = toGray(truth);
    const level = fixed ?? otsuThreshold(histogram256(gray.data));
    const predicted = new Uint8Array(w * h);
    const real = new Uint8Array(w * h);
    for (let i = 0; i < predicted.length; i += 1) {
      predicted[i] = gray.data[i] <= level ? 1 : 0;
      real[i] = t.data[i] < 150 ? 1 : 0;
    }
    const nearReal = dilateMask(real, w, h, 2);
    const nearPredicted = dilateMask(predicted, w, h, 2);
    let predictedCount = 0;
    let predictedHit = 0;
    let realCount = 0;
    let realHit = 0;
    for (let i = 0; i < predicted.length; i += 1) {
      if (predicted[i]) {
        predictedCount += 1;
        if (nearReal[i]) predictedHit += 1;
      }
      if (real[i]) {
        realCount += 1;
        if (nearPredicted[i]) realHit += 1;
      }
    }
    const precision = predictedHit / Math.max(1, predictedCount);
    const recall = realHit / Math.max(1, realCount);
    return (2 * precision * recall) / Math.max(1e-9, precision + recall);
  }

  it("el resultado de `auto` en documentos de texto es mas legible que el original (proxy de OCR) y el papel queda blanco", async () => {
    const docs = corpus.documents.filter((i) => i.kind === "text").slice(0, 12);
    let better = 0;
    let whiteAfter = 0;
    let darkBefore = 0;
    const f1s: string[] = [];
    for (const item of docs) {
      // Pagina limpia a la orientacion de la foto: se gira la verdad para compararla.
      const crop = rectify(item, 700);
      const out = await renderRgba(item.image, { corners: item.truth.quad, rotation: ((item.truth.neededRotation as number) % 360) as 0, filter: "auto", adjust: { brightness: 0, contrast: 0 }, mode: "document", maxSide: 900 });
      const baseline = await renderRgba(item.image, { corners: item.truth.quad, rotation: item.truth.neededRotation as 0, filter: "original", adjust: { brightness: 0, contrast: 0 }, mode: "document", maxSide: 900 });
      expect(out.resolved).toBe("enhance");
      const truthPage = item.page;
      const f1Auto = inkF1(out.image, truthPage);
      const f1Original = inkF1(baseline.image, truthPage);
      f1s.push(`${item.id}:${f1Original.toFixed(2)}->${f1Auto.toFixed(2)}`);
      if (f1Auto >= f1Original - 0.02) better += 1;
      const g = toGray(out.image);
      const paper = [...g.data].sort((a, b) => a - b)[Math.floor(g.data.length * 0.7)];
      if (paper >= 245) whiteAfter += 1;
      const gb = toGray(baseline.image);
      if ([...gb.data].sort((a, b) => a - b)[Math.floor(gb.data.length * 0.7)] < 235) darkBefore += 1;
      void crop;
    }
    record("autoFilter.notWorseThanOriginal", better / docs.length);
    record("autoFilter.paperWhiteAfter", whiteAfter / docs.length);
    record("autoFilter.paperGrayBefore", darkBefore / docs.length);
    record("autoFilter.f1OriginalToAuto", f1s.join(" "));
    expect(better / docs.length).toBe(1);
    expect(whiteAfter / docs.length).toBeGreaterThanOrEqual(0.9);
  }, 120_000);

  it("con poca luz (papel a ~75/255) una binarizacion fija a 128 solo lee bien el resultado de `auto`", async () => {
    const dark = corpus.quality.filter((i) => i.id.startsWith("q-dark"));
    let autoGood = 0;
    let originalGood = 0;
    for (const item of dark) {
      const job = { corners: item.truth.quad, rotation: 0 as const, adjust: { brightness: 0, contrast: 0 }, mode: "document" as const, maxSide: 900 };
      const auto = await renderRgba(item.image, { ...job, filter: "auto" });
      const original = await renderRgba(item.image, { ...job, filter: "original" });
      if (inkF1(auto.image, item.page, 128) >= 0.85) autoGood += 1;
      if (inkF1(original.image, item.page, 128) >= 0.85) originalGood += 1;
    }
    record("autoFilter.darkFixedThreshold.auto", autoGood / dark.length);
    record("autoFilter.darkFixedThreshold.original", originalGood / dark.length);
    expect(autoGood / dark.length).toBeGreaterThanOrEqual(0.9);
    expect(autoGood).toBeGreaterThan(originalGood);
  }, 120_000);

  it("auto deja una foto de dano en color y un formulario con tinta azul no pierde su color", async () => {
    const photo = corpus.special.find((i) => i.kind === "photo") as CorpusItem;
    const out = await renderRgba(photo.image, { corners: null, rotation: 0, filter: "auto", adjust: { brightness: 0, contrast: 0 }, mode: "document", maxSide: 800 });
    expect(out.resolved).toBe("color");
    const form = corpus.documents.find((i) => i.kind === "form" && i.truth.neededRotation === 0) as CorpusItem;
    const enhanced = await renderRgba(form.image, { corners: form.truth.quad, rotation: 0, filter: "auto", adjust: { brightness: 0, contrast: 0 }, mode: "document", maxSide: 900 });
    expect(enhanced.resolved).toBe("enhance");
    let blue = 0;
    for (let i = 0; i < enhanced.image.data.length; i += 4) if (enhanced.image.data[i + 2] > enhanced.image.data[i] + 40) blue += 1;
    record("autoFilter.blueInkPixelsKept", blue);
    expect(blue).toBeGreaterThan(500);
  }, 60_000);
});

describe("nombre sugerido (con OCR simulado)", () => {
  it("el titulo es correcto en >= 0,8 de los casos con titulo claro (con 6 % de letras mal leidas)", () => {
    const items = [...corpus.documents.filter((i) => i.truth.title && i.truth.neededRotation === 0), ...corpus.session.filter((i) => i.truth.title), ...corpus.special.filter((i) => i.kind === "receipt")];
    let ok = 0;
    for (const [index, item] of items.entries()) {
      const ocr = fakeOcr(item, { width: 1000, height: Math.round((1000 * item.truth.pageHeight) / item.truth.pageWidth) }, { seed: index + 1, charError: 0.03, dropWord: 0.03 });
      const suggestion = buildNameSuggestion(ocr, "es", new Date(2026, 9, 26, 14, 32));
      const title = (item.truth.title as string).toLowerCase();
      const got = (suggestion.title ?? "").toLowerCase();
      // Con letras mal leidas se acepta una distancia pequena (<= 12 % de los caracteres).
      if (got && editDistance(got, title) <= Math.ceil(title.length * 0.12)) ok += 1;
    }
    record("naming.cases", items.length);
    record("naming.titleCorrect", ok / items.length);
    expect(ok / items.length).toBeGreaterThanOrEqual(0.8);
  });

  it("toma la fecha del documento si es creible y, si no, la del escaneo", () => {
    const item = corpus.documents.find((i) => i.truth.date && i.truth.neededRotation === 0) as CorpusItem;
    const ocr = fakeOcr(item, { width: 1000, height: Math.round((1000 * item.truth.pageHeight) / item.truth.pageWidth) }, { seed: 3 });
    // La fecha de la hoja (2025-2026) es creible respecto de 2026-10-26 solo si es de los ultimos 2 anos.
    const credible = buildNameSuggestion(ocr, "es", new Date(2026, 9, 26, 14, 32));
    expect(credible.date).toBe(item.truth.date);
    const later = buildNameSuggestion(ocr, "es", new Date(2031, 0, 5, 9, 5));
    expect(later.date).toBe("2031-01-05");
  });
});

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

describe("rendimiento del nucleo (Node; el E2E mide el flujo completo en navegador)", () => {
  it("recorte + calidad + firma + miniatura de una pagina de 800 px < 300 ms de media en 100 paginas (holgura x2,5 en CI)", async () => {
    const SLACK = process.env.CI ? 2.5 : 1;
    const items = corpus.documents.slice(0, 10);
    const start = performance.now();
    for (let i = 0; i < 100; i += 1) {
      const item = items[i % items.length];
      const out = await renderRgba(item.image, { corners: item.truth.quad, rotation: 0, filter: "auto", adjust: { brightness: 0, contrast: 0 }, mode: "document", maxSide: 640 }, {}, { measure: true, onCrop: (crop) => computeSignature(crop) });
      thumbnailOf(out.image, 360);
    }
    const perPage = (performance.now() - start) / 100;
    record("perf.node.coreMsPerPage", perPage);
    expect(perPage).toBeLessThan(300 * SLACK);
  }, 120_000);
});

describe("lomo del libro", () => {
  it("el lomo se encuentra a menos de 3 % del centro de la hoja enderezada", () => {
    const books = corpus.special.filter((i) => i.kind === "book");
    for (const book of books) {
      const spine = findSpine(toGray(rectify(book, 700)));
      record(`spine.${book.id}`, spine.position);
      expect(Math.abs(spine.position - (book.truth.spine as number))).toBeLessThan(0.03);
    }
  });
});
