import { describe, expect, it } from "vitest";
import {
  DHASH_GRID,
  DHASH_MARGIN,
  MAX_WORDS_PER_PAGE,
  MINHASH_SIZE,
  MIN_TEXT_CHARS,
  dhashFromGray,
  estimateJaccard,
  grayFromRgba,
  hammingDistance,
  hasUsefulText,
  hashString32,
  minhashOf,
  normalizeText,
  resizeGray,
  wordShingles,
} from "./fingerprintCore";
import { rng } from "./testing/syntheticContracts";

describe("normalizeText", () => {
  it("pasa a minúsculas, colapsa espacios y quita puntuación", () => {
    expect(normalizeText("  El   CONTRATISTA,\n se obliga...  ")).toBe("el contratista se obliga");
  });

  it("aplica NFKC (ligaduras y anchos completos) y quita caracteres invisibles", () => {
    expect(normalizeText("oﬃce ＡＢＣ")).toBe("office abc");
    expect(normalizeText("con­tra​to")).toBe("contrato");
  });

  it("quita fechas numéricas, textuales (es/en) y horas", () => {
    for (const date of [
      "15/10/2026",
      "2026-10-15",
      "15-10-26",
      "15.10.2026",
      "15 / 10 / 2026",
      "15 de octubre de 2026",
      "15 octubre 2026",
      "15 de octubre",
      "octubre de 2026",
      "October 15, 2026",
      "Oct 15th",
      "October 2026",
      "10:30",
      "10:30:15 pm",
      "9:05 a.m.",
    ]) {
      expect(normalizeText(`firmado el ${date} por el cliente`), date).toBe("firmado el por el cliente");
    }
  });

  it("quita folios, códigos e importes (token con cifras que no es un número de 1 a 3 cifras)", () => {
    expect(normalizeText("Folio 00012345 póliza CLM-2026-77412 total $1,500.00 año 2026")).toBe("folio póliza total año");
  });

  it("conserva los números cortos y las cláusulas numeradas: cambiarlos cambia el contrato", () => {
    expect(normalizeText("plazo de 30 días, cláusula 4.2")).toBe("plazo de 30 días cláusula 4 2");
    expect(normalizeText("plazo de 60 días, cláusula 4.2")).not.toBe(normalizeText("plazo de 30 días, cláusula 4.2"));
    // 1.2.3 NO es una fecha (con punto solo cuenta si hay año de 4 cifras).
    expect(normalizeText("sección 1.2.3")).toBe("sección 1 2 3");
  });

  it("el límite de «número corto» son 3 cifras: 120 se conserva, 1200 se descarta", () => {
    expect(normalizeText("cláusula 120 del anexo")).toBe("cláusula 120 del anexo");
    expect(normalizeText("cláusula 1200 del anexo")).toBe("cláusula del anexo");
  });

  it("no toca palabras que se parecen a un mes si no llevan número", () => {
    expect(normalizeText("el ajustador podrá marchar en mayo, mares y marzos")).toBe("el ajustador podrá marchar en mayo mares y marzos");
  });

  it("dos ejemplares del mismo contrato con otra fecha/folio dan el MISMO texto", () => {
    const a = "Folio: 00012345   Fecha: 15 de octubre de 2026\nEl asegurado autoriza la reparación.";
    const b = "Folio: 00099999   Fecha: 03/01/2027\nEl asegurado autoriza la reparación.";
    expect(normalizeText(a)).toBe(normalizeText(b));
  });

  it("es idempotente", () => {
    const text = normalizeText("Póliza No. A-1234, vence 15/10/2026. Pague $50 en 30 días.");
    expect(normalizeText(text)).toBe(text);
  });
});

describe("hasUsefulText", () => {
  it("exige MIN_TEXT_CHARS letras/cifras (sin espacios)", () => {
    expect(hasUsefulText("a".repeat(MIN_TEXT_CHARS))).toBe(true);
    expect(hasUsefulText("a".repeat(MIN_TEXT_CHARS - 1))).toBe(false);
    expect(hasUsefulText("a b ".repeat(MIN_TEXT_CHARS / 2))).toBe(true);
    expect(hasUsefulText("")).toBe(false);
  });
});

describe("wordShingles", () => {
  it("genera trigramas de palabras", () => {
    expect(wordShingles("a b c d e")).toEqual(["a b c", "b c d", "c d e"]);
  });

  it("con menos de 3 palabras da un solo trigrama; vacío da ninguno", () => {
    expect(wordShingles("a b")).toEqual(["a b"]);
    expect(wordShingles("hola")).toEqual(["hola"]);
    expect(wordShingles("")).toEqual([]);
  });

  it("limita las palabras por página", () => {
    const text = Array.from({ length: MAX_WORDS_PER_PAGE + 50 }, (_, i) => `w${i % 7}x`).join(" ");
    expect(wordShingles(text)).toHaveLength(MAX_WORDS_PER_PAGE - 2);
  });
});

describe("MinHash", () => {
  const sentence = (n: number) =>
    Array.from({ length: n }, (_, i) => `palabra${i}`)
      .join(" ");

  it("tiene 128 posiciones y es determinista", () => {
    const a = minhashOf(wordShingles(sentence(60)));
    expect(a).toHaveLength(MINHASH_SIZE);
    expect(minhashOf(wordShingles(sentence(60)))).toEqual(a);
    expect(a.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)).toBe(true);
  });

  it("valores fijados (si cambian las semillas o el hash, hay que subir FINGERPRINT_VERSION)", () => {
    expect(hashString32("el contratista se")).toBe(GOLDEN.hash);
    const mh = minhashOf(["a b c", "b c d", "c d e"]);
    expect(mh.slice(0, 4)).toEqual(GOLDEN.mh);
    expect(mh.reduce((s, v) => (s + v) % 4294967291, 0)).toBe(GOLDEN.sum);
  });

  it("conjuntos iguales → 1; disjuntos → ~0", () => {
    const a = minhashOf(wordShingles(sentence(80)));
    expect(estimateJaccard(a, a)).toBe(1);
    const b = minhashOf(wordShingles(Array.from({ length: 80 }, (_, i) => `otra${i}`).join(" ")));
    expect(estimateJaccard(a, b)).toBeLessThan(0.05);
  });

  it("estima el Jaccard verdadero con error medio pequeño (200 pares aleatorios)", () => {
    const random = rng(42);
    let totalError = 0;
    let worst = 0;
    for (let trial = 0; trial < 200; trial += 1) {
      const universe = 300;
      const a = new Set<string>();
      const b = new Set<string>();
      const share = random();
      for (let i = 0; i < universe; i += 1) {
        const r = random();
        if (r < share * 0.6) {
          a.add(`s${i}`);
          b.add(`s${i}`);
        } else if (r < 0.8) a.add(`s${i}`);
        else b.add(`s${i}`);
      }
      let inter = 0;
      for (const x of a) if (b.has(x)) inter += 1;
      const exact = inter / (a.size + b.size - inter);
      const estimate = estimateJaccard(minhashOf([...a]), minhashOf([...b]));
      totalError += Math.abs(estimate - exact);
      worst = Math.max(worst, Math.abs(estimate - exact));
    }
    expect(totalError / 200).toBeLessThan(0.035);
    expect(worst).toBeLessThan(0.14);
  });

  it("estimateJaccard devuelve 0 si falta alguno de los 128 valores", () => {
    const a = minhashOf(["a b c"]);
    expect(estimateJaccard(a, [])).toBe(0);
    expect(estimateJaccard(a, a.slice(1))).toBe(0);
    expect(estimateJaccard(a, [...a, 5])).toBe(0);
    expect(estimateJaccard(a.slice(0, 64), a)).toBe(0);
    expect(estimateJaccard(a, a.slice(0, 64))).toBe(0);
  });
});

describe("dHash", () => {
  const ramp = (width: number, height: number, f: (x: number, y: number) => number) =>
    Float32Array.from({ length: width * height }, (_, i) => f(i % width, Math.floor(i / width)));

  it("una imagen lisa da el hash vacío (estable ante el ruido)", () => {
    expect(dhashFromGray(new Float32Array(32 * 32).fill(255))).toBe("0000000000000000");
    const noisy = ramp(32, 32, () => 255 + (Math.random() - 0.5) * 0.4);
    expect(dhashFromGray(noisy)).toBe("0000000000000000");
  });

  it("un degradado de claro a oscuro (izquierda→derecha) activa todos los bits", () => {
    expect(dhashFromGray(ramp(32, 32, (x) => 255 - x * 6))).toBe("ffffffffffffffff");
    expect(dhashFromGray(ramp(32, 32, (x) => x * 6))).toBe("0000000000000000");
  });

  it("el margen decide: una diferencia menor que DHASH_MARGIN no cuenta, una mayor sí", () => {
    // Cada celda 9×8 cubre ~3,5 columnas de 32: un escalón de 1 nivel por columna → ~3,5 por celda.
    const gentle = ramp(32, 32, (x) => 255 - x * (DHASH_MARGIN / 3.5) * 0.5);
    const steep = ramp(32, 32, (x) => 255 - x * (DHASH_MARGIN / 3.5) * 2);
    expect(dhashFromGray(gentle)).toBe("0000000000000000");
    expect(dhashFromGray(steep)).toBe("ffffffffffffffff");
  });

  it("el rasterizado de 2 px desplazado y con ruido queda a ≤ 10 bits en una imagen con estructura", () => {
    const random = rng(7);
    const base = ramp(256, 256, (x, y) => (Math.sin(x / 19) + Math.cos(y / 23) + Math.sin((x + y) / 41)) * 40 + 140);
    const shifted = ramp(256, 256, (x, y) => (Math.sin((x + 2) / 19) + Math.cos((y + 2) / 23) + Math.sin((x + y + 4) / 41)) * 40 + 140 + (random() - 0.5) * 8);
    const a = dhashFromGray(resizeGray(base, 256, 256, DHASH_GRID, DHASH_GRID));
    const b = dhashFromGray(resizeGray(shifted, 256, 256, DHASH_GRID, DHASH_GRID));
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(10);
  });

  it("hammingDistance cuenta bits y rechaza hashes mal formados", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("0000000000000001", "0000000000000000")).toBe(1);
    expect(hammingDistance("8000000000000000", "0000000000000001")).toBe(2);
    expect(hammingDistance("abc", "0000000000000000")).toBe(Infinity);
    expect(hammingDistance("000000000000000g", "0000000000000000")).toBe(Infinity);
  });

  it("resizeGray promedia áreas (constante → constante; media conservada)", () => {
    const flat = resizeGray(new Float32Array(100 * 60).fill(77), 100, 60, 9, 8);
    expect([...flat].every((v) => Math.abs(v - 77) < 1e-3)).toBe(true);
    const half = ramp(10, 2, (x) => (x < 5 ? 0 : 100));
    expect([...resizeGray(half, 10, 2, 2, 1)].map(Math.round)).toEqual([0, 100]);
    const mean = resizeGray(ramp(7, 7, (x, y) => x * 10 + y), 7, 7, 1, 1)[0];
    expect(mean).toBeCloseTo(30 + 3, 3);
  });

  it("grayFromRgba compone el alfa sobre blanco", () => {
    const rgba = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
    const gray = grayFromRgba(rgba, 3, 1);
    expect(gray[0]).toBeCloseTo(0, 3);
    expect(gray[1]).toBeCloseTo(255, 3);
    expect(gray[2]).toBeCloseTo(255, 3);
  });
});

const GOLDEN = { hash: 3167345295, mh: [1401352315, 835772304, 2668868644, 944395735], sum: 1144496202 };
