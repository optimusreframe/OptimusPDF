import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hammingDistance } from "./fingerprintCore";
import { computeFingerprintWith, fingerprintOfText, type FingerprintEnv, type PdfjsLike } from "./fingerprintEngine";
import { compareFingerprints } from "./match";
import { nodeEnv } from "./testing/nodeEnv";
import {
  appendSentence,
  buildContractModel,
  changeParagraph,
  decompressStreams,
  encryptWithPassword,
  makeBlankPdf,
  makeContractPdf,
  makeManyPagesPdf,
  makeScannedPdf,
  renderContract,
  reorderObjects,
  resave,
  truncate,
} from "./testing/syntheticContracts";
import { FINGERPRINT_VERSION, FingerprintError, type Fingerprint } from "./types";

/**
 * La huella sobre PDF REALES (pdf.js «legacy» en Node + `@napi-rs/canvas`), con contratos SINTÉTICOS generados con
 * pdf-lib. Cada caso del encargo: re-guardados con otros bytes, objetos reordenados, flujos de objetos, metadatos,
 * comprimido/descomprimido, fecha/folio distintos, una página cambiada, contratos distintos, casi iguales, escaneados,
 * cifrado/corrupto y el tope de páginas.
 */

const fingerprintOf = (bytes: Uint8Array, overrides: Partial<FingerprintEnv> = {}, options = {}) =>
  computeFingerprintWith(bytes, nodeEnv(overrides), options);
const VERBOSE = Boolean(process.env.DOCLIB_VERBOSE);
const log = (...args: unknown[]) => {
  if (VERBOSE) console.info("[docLibrary]", ...args);
};

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(FingerprintError);
  expect((error as FingerprintError).code).toBe(code);
}

const minPage = (result: ReturnType<typeof compareFingerprints>) => Math.min(...result.pageMatches.map((page) => page.similarity));

describe("forma de la huella", () => {
  it("exact = SHA-256 de los bytes; páginas, tamaños, texto y MinHash de cada página", async () => {
    const bytes = await makeContractPdf({ seed: 1, pages: 4 });
    const fp = await fingerprintOf(bytes);
    expect(fp.version).toBe(FINGERPRINT_VERSION);
    expect(fp.exact).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(fp.pageCount).toBe(4);
    expect(fp.pageSizes).toEqual(Array.from({ length: 4 }, () => ({ width: 612, height: 792 })));
    expect(fp.pages).toHaveLength(4);
    for (const page of fp.pages) {
      expect(page.textHash).toMatch(/^[0-9a-f]{64}$/);
      expect(page.minhash).toHaveLength(128);
      expect(page.dhash).toBeUndefined();
    }
    expect(fp.partial).toBeUndefined();
  });

  it("es determinista y no modifica los bytes de entrada", async () => {
    const bytes = await makeContractPdf({ seed: 2, pages: 3 });
    const copy = bytes.slice();
    const a = await fingerprintOf(bytes);
    const b = await fingerprintOf(bytes);
    expect(b).toEqual(a);
    expect(bytes).toEqual(copy);
  });

  it("páginas de distinto contenido tienen hash de texto distinto", async () => {
    const fp = await fingerprintOf(await makeContractPdf({ seed: 3, pages: 4 }));
    expect(new Set(fp.pages.map((page) => page.textHash)).size).toBe(4);
  });

  it("el tamaño de página es el visible (A4 y rotación aplicada)", async () => {
    const a4 = await fingerprintOf(await renderContract(buildContractModel({ seed: 1, pages: 1 }), { size: [595.28, 841.89] }));
    expect(a4.pageSizes[0]).toEqual({ width: 595.28, height: 841.89 });
  });

  it("emite el progreso página a página", async () => {
    const seen: Array<[number, number]> = [];
    await fingerprintOf(await makeContractPdf({ seed: 4, pages: 3 }), {}, { onProgress: (done: number, total: number) => seen.push([done, total]) });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("cede el control tras cada página cuando el entorno lo pide", async () => {
    let yields = 0;
    await fingerprintOf(await makeContractPdf({ seed: 4, pages: 3 }), { yieldToMain: async () => void (yields += 1) });
    expect(yields).toBe(3);
  });
});

describe("el mismo contenido con otros bytes sigue siendo «Coincide»", () => {
  it.each([
    ["re-guardado con pdf-lib", (b: Uint8Array) => resave(b)],
    ["con flujos de objetos", (b: Uint8Array) => resave(b, { useObjectStreams: true })],
    ["sin flujos de objetos", (b: Uint8Array) => resave(b, { useObjectStreams: false })],
    ["metadatos distintos", (b: Uint8Array) => resave(b, { title: "Otro título", author: "Otra persona" })],
    ["objetos reordenados", reorderObjects],
    ["flujos descomprimidos", decompressStreams],
    ["reordenado y descomprimido", async (b: Uint8Array) => decompressStreams(await reorderObjects(b))],
  ])("%s", async (_name, transform) => {
    const original = await makeContractPdf({ seed: 5, pages: 5, shareCommon: true });
    const variant = await transform(original);
    expect(variant).not.toEqual(original);
    const [a, b] = [await fingerprintOf(original), await fingerprintOf(variant)];
    expect(b.exact).not.toBe(a.exact);
    const result = compareFingerprints(b, a);
    expect(result.level).toBe("match");
    expect(result.reviewPages).toEqual([]);
    expect(result.mappedPages).toEqual([0, 1, 2, 3, 4]);
    expect(result.pageMatches.every((page) => page.identical)).toBe(true);
  });

  it("la misma huella exacta de los mismos bytes", async () => {
    const bytes = await makeContractPdf({ seed: 5, pages: 3 });
    const result = compareFingerprints(await fingerprintOf(bytes), await fingerprintOf(bytes));
    expect(result.level).toBe("exact");
  });

  it("otra fecha, otro folio y otro número de póliza siguen siendo «Coincide» (páginas con el mismo texto)", async () => {
    const model = buildContractModel({ seed: 6, pages: 6 });
    const a = await fingerprintOf(await renderContract(model, { date: "15 de octubre de 2026", folio: "00012345", policy: "CLM-2026-77412" }));
    const b = await fingerprintOf(await renderContract(model, { date: "03/01/2027", folio: "00099999", policy: "CLM-2027-00001" }));
    const c = await fingerprintOf(await renderContract(model, { date: "January 3, 2027", folio: "7700000", policy: "X-9" }));
    for (const other of [b, c]) {
      const result = compareFingerprints(other, a);
      expect(result.level).toBe("match");
      expect(result.pageMatches.every((page) => page.identical)).toBe(true);
    }
  });

  it("otra fuente y otro tamaño de papel (mismo texto) NO se confunden por tamaño: se emparejan solo si cabe ±1 pt", async () => {
    const model = buildContractModel({ seed: 7, pages: 3 });
    const letter = await fingerprintOf(await renderContract(model));
    const a4 = await fingerprintOf(await renderContract(model, { size: [595.28, 841.89] }));
    const result = compareFingerprints(a4, letter);
    expect(result.mappedPages).toEqual([null, null, null]);
    expect(result.level).toBe("none");
    const times = await fingerprintOf(await renderContract(model, { font: "times" }));
    expect(compareFingerprints(times, letter).level).toBe("match");
  });
});

describe("una página cambiada de verdad", () => {
  it("6 páginas: «Parece» con revisar SOLO en la página cambiada y las demás emparejadas", async () => {
    const model = buildContractModel({ seed: 8, pages: 6 });
    const template = await fingerprintOf(await renderContract(model));
    const changed = changeParagraph(changeParagraph(changeParagraph(model, 2, 0, 71), 2, 1, 72), 2, 2, 73);
    const doc = await fingerprintOf(await renderContract(changed));
    const result = compareFingerprints(doc, template);
    expect(result.level).toBe("similar");
    expect(result.reviewPages).toEqual([2]);
    expect(result.mappedPages).toEqual([0, 1, null, 3, 4, 5]);
    expect(result.percent).toBeGreaterThanOrEqual(75);
    expect(result.percent).toBeLessThan(100);
  });

  it("una cláusula entera (1 de 5 párrafos) de una página: no llega a «Coincide»", async () => {
    const model = buildContractModel({ seed: 9, pages: 5 });
    const template = await fingerprintOf(await renderContract(model));
    const doc = await fingerprintOf(await renderContract(changeParagraph(model, 2, 1, 55)));
    const result = compareFingerprints(doc, template);
    log("una cláusula de 5: página 3 →", result.pageMatches[2].similarity.toFixed(3), result.level);
    expect(result.level).not.toBe("match");
    expect(result.level).not.toBe("exact");
    expect(result.pageMatches[2].review).toBe(true);
    expect(result.pageMatches.filter((page, index) => index !== 2 && page.identical)).toHaveLength(4);
  });

  it("LÍMITE conocido: una frase suelta añadida en una página (≈ 5 % del texto) sigue siendo «Coincide»", async () => {
    const model = buildContractModel({ seed: 10, pages: 5 });
    const template = await fingerprintOf(await renderContract(model));
    const edited = appendSentence(model, 2, 1, "Se agrega la obligación de notificar cualquier cambio de domicilio dentro de cinco días hábiles.");
    const doc = await fingerprintOf(await renderContract(edited));
    const result = compareFingerprints(doc, template);
    expect(result.level).toBe("match");
    expect(result.pageMatches[2].identical).toBe(false);
    expect(result.pageMatches[2].similarity).toBeGreaterThanOrEqual(0.9);
    expect(result.pageMatches[2].similarity).toBeLessThan(1);
  });
});

describe("contratos distintos y casi iguales", () => {
  it("dos contratos distintos → none", async () => {
    const a = await fingerprintOf(await makeContractPdf({ seed: 11, pages: 4, shareCommon: true }));
    const b = await fingerprintOf(await makeContractPdf({ seed: 12, pages: 4, shareCommon: true }));
    const result = compareFingerprints(b, a);
    expect(result.level).toBe("none");
    expect(Math.max(...result.pageMatches.map((page) => page.similarity))).toBeLessThan(0.5);
  });

  it("mismo patrón que dos contratos reales de una empresa: 9 y 8 páginas con 6 páginas comunes → no «Coincide» ni «Parece»", async () => {
    // A (9 págs): 0-2 comunes, 3-5 propias, 6-8 comunes. B (8 págs): las mismas 6 comunes y 2 propias en medio.
    const a = buildContractModel({ seed: 20, pages: 9 });
    const own = buildContractModel({ seed: 21, pages: 2 });
    const b = { title: a.title, pages: [...a.pages.slice(0, 3), ...own.pages, ...a.pages.slice(6)] };
    const fa = await fingerprintOf(await renderContract(a));
    const fb = await fingerprintOf(await renderContract(b));
    const result = compareFingerprints(fb, fa);
    log("9 vs 8 págs, 6 comunes:", result.level, result.percent, result.mappedPages);
    expect(result.level).toBe("none");
    expect(result.similarity).toBeLessThan(0.7);
    expect(result.mappedPages.filter((page) => page !== null)).toHaveLength(6);
    // En el sentido contrario también.
    expect(compareFingerprints(fa, fb).level).toBe("none");
    // Y cada uno sigue reconociéndose a sí mismo re-exportado.
    expect(compareFingerprints(await fingerprintOf(await resave(await renderContract(a))), fa).level).toBe("match");
    expect(compareFingerprints(await fingerprintOf(await resave(await renderContract(b), { useObjectStreams: true })), fb).level).toBe("match");
  });

  it("8 páginas contra 8 con 5 comunes (62 %) → none", async () => {
    const a = buildContractModel({ seed: 22, pages: 8 });
    const other = buildContractModel({ seed: 23, pages: 3 });
    const b = { title: a.title, pages: [...a.pages.slice(0, 2), ...other.pages, ...a.pages.slice(5)] };
    const result = compareFingerprints(await fingerprintOf(await renderContract(b)), await fingerprintOf(await renderContract(a)));
    expect(result.level).toBe("none");
  });

  it("la 'familia' de contratos con cláusulas comunes (30 %): ningún par llega a «Parece»", async () => {
    const fps: Fingerprint[] = [];
    for (let seed = 30; seed < 36; seed += 1) fps.push(await fingerprintOf(await makeContractPdf({ seed, pages: 6, shareCommon: true })));
    for (let i = 0; i < fps.length; i += 1) {
      for (let j = 0; j < fps.length; j += 1) if (i !== j) expect(compareFingerprints(fps[i], fps[j]).level).toBe("none");
    }
  });
});

describe("corpus: falsos positivos y falsos negativos medidos", () => {
  it("20 contratos distintos: 0 coincidencias cruzadas ≥ 0,90 en ninguna página, ninguno llega a «Parece»", async () => {
    const fps: Fingerprint[] = [];
    for (let seed = 100; seed < 120; seed += 1) {
      fps.push(await fingerprintOf(await makeContractPdf({ seed, pages: 3 + (seed % 4), shareCommon: seed % 2 === 0 })));
    }
    let pairs = 0;
    let pagePairsOver90 = 0;
    let docsAbove = 0;
    let maxPage = 0;
    for (let i = 0; i < fps.length; i += 1) {
      for (let j = i + 1; j < fps.length; j += 1) {
        const result = compareFingerprints(fps[i], fps[j]);
        pairs += 1;
        if (result.level !== "none") docsAbove += 1;
        for (const page of result.pageMatches) {
          maxPage = Math.max(maxPage, page.similarity);
          if (page.similarity >= 0.9) pagePairsOver90 += 1;
        }
      }
    }
    log(`falsos positivos: ${pairs} pares, ${docsAbove} a nivel de documento, ${pagePairsOver90} páginas ≥ 0,90, máx. página ${maxPage.toFixed(3)}`);
    expect(pairs).toBe(190);
    expect(docsAbove).toBe(0);
    expect(pagePairsOver90).toBe(0);
  }, 120_000);

  it("20 re-exportaciones: 100 % «Coincide» con todas las páginas ≥ 0,90", async () => {
    const transforms = [
      (b: Uint8Array) => resave(b),
      (b: Uint8Array) => resave(b, { useObjectStreams: true }),
      reorderObjects,
      decompressStreams,
    ];
    let ok = 0;
    let worst = 1;
    for (let index = 0; index < 20; index += 1) {
      const original = await makeContractPdf({ seed: 200 + index, pages: 3 + (index % 4), shareCommon: true }, { date: `${10 + (index % 18)}/0${1 + (index % 9)}/2026`, folio: String(10000 + index) });
      const variant = await transforms[index % transforms.length](original);
      const result = compareFingerprints(await fingerprintOf(variant), await fingerprintOf(original));
      worst = Math.min(worst, minPage(result));
      if (result.level === "match" && minPage(result) >= 0.9) ok += 1;
    }
    log(`falsos negativos: ${20 - ok} de 20; peor página ${worst.toFixed(3)}`);
    expect(ok).toBe(20);
  }, 120_000);
});

describe("escaneados (sin texto)", () => {
  it("una página sin texto usa dHash (16 hex) y no tiene MinHash", async () => {
    const fp = await fingerprintOf(await makeScannedPdf({ seed: 1, pages: 2 }));
    for (const page of fp.pages) {
      expect(page.textHash).toBe("");
      expect(page.minhash).toEqual([]);
      expect(page.dhash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("el mismo escaneado con ruido y 2 px de desplazamiento queda a ≤ 10 bits (20 documentos × 2 páginas)", async () => {
    let worst = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const clean = await fingerprintOf(await makeScannedPdf({ seed, pages: 2 }));
      const noisy = await fingerprintOf(await makeScannedPdf({ seed, pages: 2, noise: 8, shift: { x: 2, y: 2 }, quality: 60 }));
      clean.pages.forEach((page, index) => {
        worst = Math.max(worst, hammingDistance(page.dhash!, noisy.pages[index].dhash!));
      });
      const result = compareFingerprints(noisy, clean);
      expect(result.reviewPages).toEqual([]);
      expect(result.level).toBe("similar"); // por imagen nunca «Coincide»
    }
    log(`escaneados: peor distancia con ruido+desplazamiento = ${worst} bits`);
    expect(worst).toBeLessThanOrEqual(10);
  }, 240_000);

  it("una hoja en blanco (sin texto ni imagen) da el dHash vacío; dos hojas en blanco coinciden", async () => {
    const fp = await fingerprintOf(await makeBlankPdf(2));
    expect(fp.pages.map((page) => page.dhash)).toEqual(["0000000000000000", "0000000000000000"]);
    expect(compareFingerprints(fp, await fingerprintOf(await makeBlankPdf(2))).level).toBe("exact");
  });

  it("documento mixto: páginas de texto por texto y la escaneada por imagen", async () => {
    const text = await makeContractPdf({ seed: 3, pages: 1 });
    const scan = await makeScannedPdf({ seed: 3, pages: 1 });
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const merged = await PDFDocument.create();
    for (const source of [text, scan]) {
      const doc = await PDFDocument.load(source);
      for (const page of await merged.copyPages(doc, doc.getPageIndices())) merged.addPage(page);
    }
    const fp = await fingerprintOf(await merged.save());
    expect(fp.pages[0].textHash).not.toBe("");
    expect(fp.pages[1].textHash).toBe("");
    expect(fp.pages[1].dhash).toBeDefined();
  });
});

describe("entradas inservibles", () => {
  it("vacío → empty", async () => {
    await expectCode(fingerprintOf(new Uint8Array()), "empty");
  });

  it("texto que no es un PDF y PDF truncado → corrupt", async () => {
    await expectCode(fingerprintOf(new TextEncoder().encode("esto no es un pdf, es solo texto")), "corrupt");
    await expectCode(fingerprintOf(truncate(await makeContractPdf({ seed: 1, pages: 4 }), 0.4)), "corrupt");
  });

  it("PDF con contraseña de apertura → encrypted (con un mensaje claro)", async () => {
    const encrypted = await encryptWithPassword(await makeContractPdf({ seed: 1, pages: 2 }), "secreto");
    await expectCode(fingerprintOf(encrypted), "encrypted");
    const error = await fingerprintOf(encrypted).catch((reason: unknown) => reason as FingerprintError);
    expect((error as FingerprintError).message).toContain("contraseña");
  });

  it("PDF cifrado SOLO con restricciones (se abre sin contraseña) sí tiene huella", async () => {
    const restricted = await encryptWithPassword(await makeContractPdf({ seed: 1, pages: 2 }), "dueno", "");
    const fp = await fingerprintOf(restricted);
    expect(fp.pageCount).toBe(2);
    expect(fp.pages[0].textHash).not.toBe("");
  });

  it("cancelable: ya cancelado, o a mitad de camino", async () => {
    const bytes = await makeContractPdf({ seed: 1, pages: 6 });
    const pre = new AbortController();
    pre.abort();
    await expectCode(fingerprintOf(bytes, {}, { signal: pre.signal }), "aborted");

    const controller = new AbortController();
    const seen: number[] = [];
    await expectCode(
      fingerprintOf(bytes, {}, {
        signal: controller.signal,
        onProgress: (done: number) => {
          seen.push(done);
          if (done === 2) controller.abort();
        },
      }),
      "aborted",
    );
    expect(seen).toEqual([1, 2]);
  });

  it("si pdf.js no se puede cargar → unavailable", async () => {
    await expectCode(fingerprintOf(await makeBlankPdf(1), { getPdfjs: () => Promise.reject(new Error("sin red")) }), "unavailable");
  });

  it("una página ilegible no tumba el cálculo: queda sin texto ni dHash y no se empareja", async () => {
    const bytes = await makeContractPdf({ seed: 40, pages: 5 });
    const healthy = await fingerprintOf(bytes);
    const base = nodeEnv();
    const broken = await fingerprintOf(bytes, {
      getPdfjs: async () => {
        const pdfjs = await base.getPdfjs();
        return {
          getDocument: (source) => {
            const task = pdfjs.getDocument(source);
            return {
              destroy: () => task.destroy(),
              promise: task.promise.then((doc) => {
                const getPage = doc.getPage.bind(doc);
                doc.getPage = async (n: number) => {
                  if (n === 2) throw new Error("página rota");
                  return getPage(n);
                };
                return doc;
              }),
            };
          },
        } satisfies PdfjsLike;
      },
    });
    expect(broken.pages[1]).toEqual({ textHash: "", minhash: [] });
    expect(broken.pages[0]).toEqual(healthy.pages[0]);
    // (con bytes distintos: con los mismos, la comparación sería «exact» y no miraría las páginas)
    const result = compareFingerprints(broken, await fingerprintOf(await resave(bytes)));
    expect(result.mappedPages).toEqual([0, null, 2, 3, 4]);
    expect(result.reviewPages).toEqual([1]);
  });
});

describe("tope de páginas", () => {
  it("201 páginas → huella parcial: solo exact y pageCount", async () => {
    const bytes = await makeManyPagesPdf(201);
    const fp = await fingerprintOf(bytes);
    expect(fp.partial).toBe("tooManyPages");
    expect(fp.pageCount).toBe(201);
    expect(fp.pages).toEqual([]);
    expect(fp.pageSizes).toEqual([]);
    expect(fp.exact).toBe(createHash("sha256").update(bytes).digest("hex"));
    // Mismos bytes → «exact»; otros bytes → none (partial).
    expect(compareFingerprints(fp, fp).level).toBe("exact");
    expect(compareFingerprints(await fingerprintOf(await resave(bytes)), fp)).toMatchObject({ level: "none", reason: "partial" });
  }, 120_000);

  it("200 páginas exactas SÍ tienen huella completa", async () => {
    const fp = await fingerprintOf(await makeManyPagesPdf(200));
    expect(fp.partial).toBeUndefined();
    expect(fp.pages).toHaveLength(200);
    expect(fp.pageSizes).toHaveLength(200);
  }, 120_000);

  it("`maxPages` se puede bajar", async () => {
    const fp = await fingerprintOf(await makeContractPdf({ seed: 1, pages: 3 }), {}, { maxPages: 2 });
    expect(fp.partial).toBe("tooManyPages");
    expect(fp.pageCount).toBe(3);
  });
});

describe("fingerprintOfText", () => {
  const sha = async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

  it("devuelve null si no hay texto útil", async () => {
    expect(await fingerprintOfText("   12   ", sha)).toBeNull();
    expect(await fingerprintOfText("Página 3 de 7", sha)).toBeNull();
  });

  it("hash del texto normalizado y MinHash de 128", async () => {
    const a = await fingerprintOfText("El contratista se obliga a ejecutar los trabajos. Fecha: 15/10/2026", sha);
    const b = await fingerprintOfText("EL CONTRATISTA se obliga a ejecutar los trabajos.   Fecha: 03/01/2027", sha);
    expect(a?.minhash).toHaveLength(128);
    expect(a).toEqual(b);
  });
});

describe("rendimiento (Node, referencia; el de navegador se mide en E2E)", () => {
  it("6 páginas y 100 páginas", async () => {
    const six = await makeContractPdf({ seed: 50, pages: 6 });
    await fingerprintOf(six); // calienta
    let t0 = performance.now();
    await fingerprintOf(six);
    const sixMs = performance.now() - t0;
    const hundred = await makeManyPagesPdf(100);
    t0 = performance.now();
    await fingerprintOf(hundred);
    const hundredMs = performance.now() - t0;
    log(`Node: 6 páginas ${sixMs.toFixed(0)} ms, 100 páginas ${hundredMs.toFixed(0)} ms`);
    expect(sixMs).toBeLessThan(2000);
    expect(hundredMs).toBeLessThan(15_000);
  }, 120_000);
});
