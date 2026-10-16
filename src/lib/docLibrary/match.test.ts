import { describe, expect, it } from "vitest";
import { MINHASH_SIZE } from "./fingerprintCore";
import {
  AMBIGUOUS_MARGIN,
  comparePages,
  compareFingerprints,
  dhashSimilarity,
  findBestMatch,
  matchLevelRank,
  sameSize,
} from "./match";
import { FINGERPRINT_VERSION, MATCH_THRESHOLDS, type Fingerprint, type PageFingerprint } from "./types";

/**
 * La lógica de comparación sobre huellas ARMADAS A MANO (sin pdf.js): se controla exactamente cuántas de las 128
 * posiciones del MinHash coinciden, así que cada umbral se prueba justo en su borde.
 */

const LETTER = { width: 612, height: 792 };
const hex64 = (n: number) => n.toString(16).padStart(64, "0");

/** MinHash de una página `id`: 128 valores distintos por página. */
function mh(id: number): number[] {
  return Array.from({ length: MINHASH_SIZE }, (_, i) => (id * 1000 + i) >>> 0);
}

/** Variante de `base` con exactamente `equal` posiciones iguales. */
function withEqual(base: number[], equal: number): number[] {
  return base.map((value, i) => (i < equal ? value : (value + 7_000_000) >>> 0));
}

function textPage(id: number, minhash = mh(id)): PageFingerprint {
  return { textHash: hex64(id), minhash };
}

/** Página igual a `textPage(id)` en 128·`similarity` posiciones (con otro `textHash`). */
function similarPage(id: number, equal: number): PageFingerprint {
  return { textHash: hex64(id + 5000), minhash: withEqual(mh(id), equal) };
}

function imagePage(dhash: string): PageFingerprint {
  return { textHash: "", minhash: [], dhash };
}

function fp(pages: PageFingerprint[], exact = "e", options: { sizes?: Array<{ width: number; height: number }> } = {}): Fingerprint {
  return {
    version: FINGERPRINT_VERSION,
    exact: exact.padEnd(64, "0"),
    pageCount: pages.length,
    pageSizes: options.sizes ?? pages.map(() => ({ ...LETTER })),
    pages,
  };
}

const base = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => textPage(offset + i + 1));

describe("umbrales por página (Jaccard)", () => {
  it("116/128 (0,906) coincide; 115/128 (0,898) solo se parece", () => {
    const template = fp(base(1));
    const match = compareFingerprints(fp([similarPage(1, 116)], "a"), template);
    expect(match.pageMatches[0].level).toBe("match");
    expect(match.pageMatches[0].similarity).toBeCloseTo(116 / 128, 10);
    expect(match.level).toBe("match");
    expect(match.reviewPages).toEqual([]);

    const similar = compareFingerprints(fp([similarPage(1, 115)], "a"), template);
    expect(similar.pageMatches[0].level).toBe("similar");
    expect(similar.pageMatches[0].review).toBe(true);
    expect(similar.reviewPages).toEqual([0]);
    expect(similar.level).toBe("similar");
  });

  it("90/128 (0,703) se empareja; 89/128 (0,695) no se aplica y se marca para revisar", () => {
    const template = fp(base(4));
    const near = compareFingerprints(fp([...base(3), similarPage(4, 90)], "a"), template);
    expect(near.mappedPages).toEqual([0, 1, 2, 3]);
    expect(near.pageMatches[3].level).toBe("similar");
    const far = compareFingerprints(fp([...base(3), similarPage(4, 89)], "a"), template);
    expect(far.mappedPages).toEqual([0, 1, 2, null]);
    expect(far.pageMatches[3]).toMatchObject({ documentPage: null, similarity: 0, level: "none", review: true });
    expect(far.reviewPages).toEqual([3]);
  });

  it("texto idéntico (mismo hash) vale 1 sin mirar el MinHash", () => {
    const a = textPage(1);
    const b = { ...textPage(1), minhash: mh(99) };
    expect(comparePages(a, b)).toMatchObject({ similarity: 1, level: "exact", identical: true, kind: "text" });
  });

  it("texto con imagen, o páginas que faltan, no se comparan", () => {
    expect(comparePages(textPage(1), imagePage("0000000000000000"))).toMatchObject({ similarity: 0, kind: "none" });
    expect(comparePages(undefined, textPage(1)).level).toBe("none");
    expect(comparePages(textPage(1), undefined).level).toBe("none");
    // Una página ilegible (sin texto ni dHash) tampoco coincide con otra ilegible.
    const unreadable: PageFingerprint = { textHash: "", minhash: [] };
    expect(comparePages(unreadable, unreadable).level).toBe("none");
  });

  it("una página con texto NO se compara por imagen aunque traiga dHash", () => {
    const withBoth: PageFingerprint = { ...textPage(1), dhash: "0000000000000000" };
    expect(comparePages(withBoth, imagePage("0000000000000000"))).toMatchObject({ similarity: 0, kind: "none" });
    expect(comparePages(imagePage("0000000000000000"), withBoth)).toMatchObject({ similarity: 0, kind: "none" });
  });

  it("un MinHash incompleto cuenta como 0", () => {
    const broken: PageFingerprint = { textHash: hex64(2), minhash: [1, 2, 3] };
    expect(comparePages(textPage(1), broken).similarity).toBe(0);
  });
});

describe("umbrales del documento", () => {
  it("«Coincide» exige TODAS las páginas ≥ 0,90; una a 0,70-0,90 lo baja a «Parece»", () => {
    const template = fp(base(6));
    const allGood = compareFingerprints(fp(base(6), "a"), template);
    expect(allGood.level).toBe("match");
    const oneSimilar = compareFingerprints(fp([...base(5), similarPage(6, 100)], "a"), template);
    expect(oneSimilar.level).toBe("similar");
    expect(oneSimilar.reviewPages).toEqual([5]);
  });

  it("una página cambiada del todo: «Parece» con revisar SOLO en ella (6 páginas)", () => {
    const template = fp(base(6));
    const doc = fp([...base(2), textPage(77), ...base(3, 3)], "a");
    const result = compareFingerprints(doc, template);
    expect(result.level).toBe("similar");
    expect(result.mappedPages).toEqual([0, 1, null, 3, 4, 5]);
    expect(result.reviewPages).toEqual([2]);
    expect(result.percent).toBe(Math.round((5 / 6) * 100));
  });

  it("la media decide «Parece»: justo 0,75 sí; por debajo, no (8 páginas)", () => {
    const template = fp(base(8));
    const six = compareFingerprints(fp([...base(6), textPage(91), textPage(92)], "a"), template);
    expect(six.similarity).toBeCloseTo(0.75, 10);
    expect(six.level).toBe("similar");
    const five = compareFingerprints(fp([...base(5), textPage(91), textPage(92), textPage(93)], "a"), template);
    expect(five.similarity).toBeCloseTo(5 / 8, 10);
    expect(five.level).toBe("none");
    expect(five.percent).toBe(63);
    expect(five.reviewPages).toEqual([5, 6, 7]);
  });

  it("10 páginas con 7 iguales (media 0,70) NO llegan a «Parece»: el umbral del documento es 0,75", () => {
    const template = fp(base(10));
    const result = compareFingerprints(fp([...base(7), textPage(91), textPage(92), textPage(93)], "a"), template);
    expect(result.similarity).toBeCloseTo(0.7, 10);
    expect(result.level).toBe("none");
    const eight = compareFingerprints(fp([...base(8), textPage(91), textPage(92)], "a"), template);
    expect(eight.level).toBe("similar");
    expect(eight.percent).toBe(80);
  });

  it("MATCH_THRESHOLDS se mantiene (cambiarlo es una decisión de producto)", () => {
    expect(MATCH_THRESHOLDS).toMatchObject({ match: 0.9, similar: 0.7, documentSimilar: 0.75, pageSizeTolerance: 1, dhashMatchBits: 10, dhashSimilarBits: 20 });
  });

  it("«Parece» nunca dice 100 %; «Coincide» puede", () => {
    const template = fp(base(200));
    const doc = fp([...base(199), textPage(7777)], "a");
    const result = compareFingerprints(doc, template);
    expect(result.level).toBe("similar");
    expect(result.percent).toBe(99);
    expect(compareFingerprints(fp(base(3), "a"), fp(base(3))).percent).toBe(100);
  });
});

describe("exacta y casos que no se pueden comparar", () => {
  it("basis: texto, imagen o mixto", () => {
    expect(compareFingerprints(fp(base(3), "a"), fp(base(3))).basis).toBe("text");
    expect(compareFingerprints(fp([imagePage("0000000000000000")], "a"), fp([imagePage("0000000000000000")])).basis).toBe("image");
    const mixedTemplate = fp([textPage(1), imagePage("0000000000000000"), textPage(3), textPage(4), textPage(5)]);
    const mixedDoc = fp([textPage(1), imagePage("0000000000000000"), textPage(3), textPage(4), textPage(5)], "a");
    expect(compareFingerprints(mixedDoc, mixedTemplate)).toMatchObject({ basis: "mixed", level: "similar" });
    expect(compareFingerprints(fp(base(2), "same"), fp(base(2), "same")).basis).toBeUndefined();
  });

  it("mismos bytes → exact 100 % con mapa identidad", () => {
    const a = fp(base(3), "same");
    const result = compareFingerprints(a, fp(base(3), "same"));
    expect(result).toMatchObject({ level: "exact", percent: 100, similarity: 1, mappedPages: [0, 1, 2], reviewPages: [] });
    expect(result.pageMatches.every((page) => page.identical && !page.review)).toBe(true);
  });

  it("mismos bytes aunque la huella sea parcial → exact", () => {
    const partial: Fingerprint = { version: FINGERPRINT_VERSION, exact: "p".padEnd(64, "0"), pageCount: 300, pageSizes: [], pages: [], partial: "tooManyPages" };
    expect(compareFingerprints(partial, { ...partial }).level).toBe("exact");
  });

  it("huella parcial con bytes distintos → none (partial)", () => {
    const partial: Fingerprint = { version: FINGERPRINT_VERSION, exact: "p".padEnd(64, "0"), pageCount: 300, pageSizes: [], pages: [], partial: "tooManyPages" };
    const other = { ...partial, exact: "q".padEnd(64, "0") };
    expect(compareFingerprints(partial, other)).toMatchObject({ level: "none", reason: "partial" });
    expect(compareFingerprints(fp(base(3), "a"), partial)).toMatchObject({ level: "none", reason: "partial" });
  });

  it("sin páginas → none (empty); otra versión del algoritmo → none (version)", () => {
    expect(compareFingerprints(fp([], "a"), fp([], "b"))).toMatchObject({ level: "none", reason: "empty" });
    const old = { ...fp(base(2), "a"), version: 0 as unknown as typeof FINGERPRINT_VERSION };
    expect(compareFingerprints(old, fp(base(2), "b"))).toMatchObject({ level: "none", reason: "version" });
  });
});

describe("tamaños de página", () => {
  it("±1 pt en ancho y alto; más no", () => {
    expect(sameSize({ width: 612, height: 792 }, { width: 613, height: 791 })).toBe(true);
    expect(sameSize({ width: 612, height: 792 }, { width: 613.01, height: 792 })).toBe(false);
    expect(sameSize({ width: 612, height: 792 }, { width: 612, height: 790.99 })).toBe(false);
  });

  it("una página de otro tamaño no se empareja aunque tenga el mismo texto", () => {
    const template = fp(base(4));
    const doc = fp(base(4), "a", { sizes: [LETTER, { width: 595.5, height: 842.25 }, LETTER, LETTER] });
    const result = compareFingerprints(doc, template);
    expect(result.mappedPages).toEqual([0, null, 2, 3]);
    expect(result.reviewPages).toEqual([1]);
    expect(result.level).toBe("similar");
  });
});

describe("distinto número de páginas (alineamiento)", () => {
  it("una página añadida en medio no desplaza el resto: se mapea y nunca es «Coincide»", () => {
    const template = fp(base(4));
    const doc = fp([textPage(1), textPage(2), textPage(900), textPage(3), textPage(4)], "a");
    const result = compareFingerprints(doc, template);
    expect(result.mappedPages).toEqual([0, 1, 3, 4]);
    expect(result.reviewPages).toEqual([]);
    expect(result.level).toBe("similar");
    expect(result.similarity).toBeCloseTo(4 / 5, 10);
  });

  it("una página quitada: la de la plantilla sin correspondiente queda para revisar", () => {
    const template = fp(base(5));
    const doc = fp([textPage(1), textPage(2), textPage(4), textPage(5)], "a");
    const result = compareFingerprints(doc, template);
    expect(result.mappedPages).toEqual([0, 1, null, 2, 3]);
    expect(result.reviewPages).toEqual([2]);
    expect(result.level).toBe("similar");
  });

  it("no se queda con un emparejamiento débil al final si el óptimo es otro", () => {
    // La plantilla [A, B] contra [A, B, B~]: B~ se parece a B (0,75), pero B se empareja MEJOR con la B de verdad.
    const template = fp([textPage(1), textPage(2)]);
    const doc = fp([textPage(1), textPage(2), similarPage(2, 96)], "a");
    const result = compareFingerprints(doc, template);
    expect(result.mappedPages).toEqual([0, 1]);
    expect(result.pageMatches[1].similarity).toBe(1);
  });

  it("el alineamiento conserva el orden (no cruza páginas)", () => {
    const template = fp([textPage(1), textPage(2)]);
    const doc = fp([textPage(2), textPage(1), textPage(3)], "a");
    const result = compareFingerprints(doc, template);
    // O se empareja 1→1 o 2→2, pero no las dos cruzadas.
    const mapped = result.mappedPages.filter((value) => value !== null);
    expect(mapped).toHaveLength(1);
  });

  it("con páginas idénticas repetidas prefiere la diagonal", () => {
    const blank = textPage(5);
    const template = fp([textPage(1), blank, blank, textPage(2)]);
    const doc = fp([textPage(1), blank, blank, textPage(2), textPage(30)], "a");
    expect(compareFingerprints(doc, template).mappedPages).toEqual([0, 1, 2, 3]);
  });

  it("muy distinto número de páginas con poco en común → none (pages)", () => {
    const result = compareFingerprints(fp([textPage(1), textPage(40), textPage(41), textPage(42)], "a"), fp(base(2)));
    expect(result.level).toBe("none");
    expect(result.reason).toBe("pages");
  });
});

describe("escaneados (dHash)", () => {
  /** Un dHash con exactamente `bits` bits a 1 (a distancia `bits` del hash vacío). */
  const flip = (bits: number) => (BigInt(2) ** BigInt(bits) - BigInt(1)).toString(16).padStart(16, "0");

  it("distancia ≤ 10 bits coincide; 11-20 se parece; > 20 no", () => {
    const zero = imagePage("0000000000000000");
    expect(comparePages(zero, imagePage(flip(0)))).toMatchObject({ level: "exact", identical: true, kind: "image", similarity: 1 });
    expect(comparePages(zero, imagePage(flip(10))).level).toBe("match");
    expect(comparePages(zero, imagePage(flip(11))).level).toBe("similar");
    expect(comparePages(zero, imagePage(flip(20))).level).toBe("similar");
    expect(comparePages(zero, imagePage(flip(21))).level).toBe("none");
  });

  it("similitud: 10 bits = 0,90, 20 bits = 0,70, monótona y acotada", () => {
    expect(dhashSimilarity(0)).toBe(1);
    expect(dhashSimilarity(10)).toBeCloseTo(0.9, 10);
    expect(dhashSimilarity(11)).toBeCloseTo(0.88, 10);
    expect(dhashSimilarity(20)).toBeCloseTo(0.7, 10);
    expect(dhashSimilarity(21)).toBeLessThan(0.7);
    expect(dhashSimilarity(64)).toBe(0);
    expect(dhashSimilarity(Infinity)).toBe(0);
    let previous = 2;
    for (let bits = 0; bits <= 64; bits += 1) {
      const value = dhashSimilarity(bits);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it("un escaneado de 5 páginas con ruido «Parece» (nunca «Coincide»); con una página distinta, revisar solo esa", () => {
    const template = fp([imagePage(flip(0)), imagePage("00000000000000ff"), imagePage("ff00000000000000"), imagePage("0f0f0f0f0f0f0f0f"), imagePage("1234567812345678")]);
    const noisy = fp([imagePage(flip(3)), imagePage("00000000000000f7"), imagePage("ff00000000000001"), imagePage("0f0f0f0f0f0f0f0e"), imagePage("1234567812345679")], "a");
    // Por imagen nunca «Coincide» (no se aplica sola): «Parece», con todas las páginas bien emparejadas.
    const same = compareFingerprints(noisy, template);
    expect(same.level).toBe("similar");
    expect(same.reviewPages).toEqual([]);
    expect(same.mappedPages).toEqual([0, 1, 2, 3, 4]);
    expect(same.pageMatches.every((page) => page.kind === "image" && page.level === "match")).toBe(true);
    expect(same.basis).toBe("image");
    const changed = fp([imagePage(flip(3)), imagePage("00000000000000f7"), imagePage("00ffffffffffffff"), imagePage("0f0f0f0f0f0f0f0e"), imagePage("1234567812345679")], "a");
    const result = compareFingerprints(changed, template);
    expect(result.level).toBe("similar");
    expect(result.reviewPages).toEqual([2]);
  });

  it("los mismos bytes siguen siendo «exact» aunque sea un escaneado", () => {
    const pages = [imagePage(flip(0)), imagePage(flip(4))];
    expect(compareFingerprints(fp(pages, "same"), fp(pages, "same")).level).toBe("exact");
  });
});

describe("findBestMatch", () => {
  const cand = (id: string, fingerprint: Fingerprint, updatedAt = "2026-10-01T00:00:00.000Z") => ({ id, fingerprint, updatedAt });

  it("null si nadie llega a «Parece»", () => {
    expect(findBestMatch(fp(base(3), "a"), [cand("x", fp(base(3, 100)))])).toBeNull();
    expect(findBestMatch(fp(base(3), "a"), [])).toBeNull();
  });

  it("prefiere exacta > coincide > parece, y devuelve el id", () => {
    const doc = fp(base(6), "same");
    const result = findBestMatch(doc, [
      cand("similar", fp([...base(5), textPage(88)], "s")),
      cand("match", fp([...base(5), similarPage(6, 120)], "m")),
      cand("exact", fp(base(6), "same")),
    ]);
    expect(result?.candidateId).toBe("exact");
    expect(result?.level).toBe("exact");
    expect(result?.ambiguous).toBe(false);
    expect(findBestMatch(doc, [cand("similar", fp([...base(5), textPage(88)], "s")), cand("match", fp([...base(5), similarPage(6, 120)], "m"))])?.candidateId).toBe("match");
  });

  it("varias plantillas con la MISMA huella → la más reciente y ambiguous:true", () => {
    const doc = fp(base(4), "a");
    const result = findBestMatch(doc, [
      cand("viejo", fp(base(4), "t1"), "2026-01-01T00:00:00.000Z"),
      cand("nuevo", fp(base(4), "t2"), "2026-09-01T00:00:00.000Z"),
      cand("medio", fp(base(4), "t3"), "2026-05-01T00:00:00.000Z"),
    ]);
    expect(result?.candidateId).toBe("nuevo");
    expect(result?.ambiguous).toBe(true);
    expect(result?.alternatives).toEqual(["medio", "viejo"]);
  });

  it("empate total de fecha: gana el id menor (determinista)", () => {
    const doc = fp(base(2), "a");
    const result = findBestMatch(doc, [cand("b", fp(base(2), "t1")), cand("a", fp(base(2), "t2"))]);
    expect(result?.candidateId).toBe("a");
  });

  it("dos candidatos del mismo nivel a menos de AMBIGUOUS_MARGIN → ambiguo; más lejos → no", () => {
    const doc = fp([similarPage(1, 128), similarPage(2, 128)].map((p, i) => ({ ...p, textHash: hex64(100 + i) })), "a");
    // Candidatos cuyas páginas coinciden en 128 y en 128 - 2 posiciones (diferencia 0,0156 < 0,02): ambiguo.
    const mk = (equal: number) => fp([{ textHash: hex64(1), minhash: withEqual(mh(1), equal) }, { textHash: hex64(2), minhash: withEqual(mh(2), equal) }], "t" + equal);
    const base1 = fp([{ textHash: hex64(1), minhash: mh(1) }, { textHash: hex64(2), minhash: mh(2) }], "t128");
    const close = findBestMatch(doc, [cand("a", base1), cand("b", mk(126))]);
    expect(close?.candidateId).toBe("a");
    expect(close?.ambiguous).toBe(true);
    expect(AMBIGUOUS_MARGIN).toBe(0.02);
    const far = findBestMatch(doc, [cand("a", base1), cand("b", mk(120))]);
    expect(far?.candidateId).toBe("a");
    expect(far?.ambiguous).toBe(false);
    expect(far?.alternatives).toEqual([]);
  });

  it("un empate de similitud con distinto nivel no es ambiguo", () => {
    const doc = fp(base(4), "a");
    const result = findBestMatch(doc, [cand("m", fp(base(4), "t1")), cand("s", fp([...base(3), textPage(99)], "t2"))]);
    expect(result?.candidateId).toBe("m");
    expect(result?.ambiguous).toBe(false);
  });

  it("matchLevelRank ordena los niveles", () => {
    expect(matchLevelRank("none")).toBeLessThan(matchLevelRank("similar"));
    expect(matchLevelRank("similar")).toBeLessThan(matchLevelRank("match"));
    expect(matchLevelRank("match")).toBeLessThan(matchLevelRank("exact"));
  });
});
