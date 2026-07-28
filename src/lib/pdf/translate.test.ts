import { describe, expect, it } from "vitest";
import { PdfError } from "@/lib/pdf/core";
import {
  DEFAULT_TRANSLATE_OPTIONS,
  MAX_CHUNK_CHARS,
  TRANSLATE_LANGUAGES,
  TRANSLATION_PAIRS,
  canTranslate,
  chunkText,
  findPair,
  formatReportMarkdown,
  isSupportedPair,
  normalizeExtractedText,
  splitSentences,
  targetsFor,
  translatePdfToReport,
  type TranslationReportData,
} from "@/lib/pdf/translate";

/**
 * Alcance de esta suite (y lo que queda deliberadamente fuera).
 *
 * `translate.ts` mezcla tres cosas de naturaleza muy distinta:
 *
 *  1. Logica pura: validacion de pares de idiomas, troceado del texto y
 *     formateo del informe. TODO ESO se prueba aqui, y es la razon por
 *     la que esas funciones se exportan por separado del motor.
 *  2. Extraccion de texto con pdf.js (+ tesseract.js como respaldo).
 *     No se puede ejecutar bajo `environment: "node"`: pdf.js revienta
 *     en Node en este proyecto (`DOMMatrix is not defined`, y tras un
 *     shim, el worker estatico "/pdf.worker.min.mjs" no resuelve como
 *     modulo de Node). Es la misma limitacion ya documentada en
 *     `core.test.ts`, `compare.test.ts` y `ocr.test.ts`.
 *  3. Inferencia real del modelo de traduccion
 *     (`@huggingface/transformers` sobre ONNX Runtime Web). Tampoco se
 *     puede: exige descargar ~110-125 MB de pesos desde el hub de
 *     Hugging Face y ejecutar WASM. Un test unitario que hiciera eso
 *     dejaria de ser unitario (red, minutos de ejecucion, y ademas
 *     resolveria el paquete por su condicion "node", que es justo el
 *     backend que esta herramienta evita a proposito).
 *
 * Por tanto, de `translatePdfToReport` solo se ejercitan aqui las
 * guardas que ocurren ANTES de tocar pdf.js: par no soportado y falta de
 * consentimiento del modelo. La traduccion de punta a punta se verifico
 * en navegador real, fuera de esta suite.
 */

describe("pares de idiomas", () => {
  it("expone una malla completa de las tres lenguas soportadas", () => {
    // 3 idiomas => 3*2 = 6 direcciones posibles, sin huecos.
    expect(TRANSLATION_PAIRS).toHaveLength(6);
    for (const source of TRANSLATE_LANGUAGES) {
      for (const target of TRANSLATE_LANGUAGES) {
        if (source === target) continue;
        expect(isSupportedPair(source, target)).toBe(true);
      }
    }
  });

  it("no ofrece traducir un idioma a si mismo", () => {
    for (const language of TRANSLATE_LANGUAGES) {
      expect(isSupportedPair(language, language)).toBe(false);
      expect(findPair(language, language)).toBeNull();
      expect(targetsFor(language)).not.toContain(language);
    }
  });

  it("cada par declara un modelo distinto y un tamano de descarga creible", () => {
    const models = new Set<string>();
    for (const pair of TRANSLATION_PAIRS) {
      expect(pair.model).toMatch(/^Xenova\/opus-mt-/);
      models.add(pair.model);
      // Los OPUS-MT cuantizados rondan los 110-125 MB. Un valor fuera de
      // este rango significa que alguien cambio de modelo sin actualizar
      // la cifra que se le ensena al usuario al pedir consentimiento.
      expect(pair.approxDownloadMb).toBeGreaterThanOrEqual(100);
      expect(pair.approxDownloadMb).toBeLessThanOrEqual(140);
    }
    expect(models.size).toBe(TRANSLATION_PAIRS.length);
  });

  it("el identificador del modelo codifica la direccion que declara", () => {
    for (const pair of TRANSLATION_PAIRS) {
      expect(pair.model).toBe(`Xenova/opus-mt-${pair.source}-${pair.target}`);
    }
  });

  it("cada par fija un commit SHA real, no la rama movil 'main'", () => {
    // Cadena de suministro: si Hugging Face sirviera otro contenido bajo
    // el mismo nombre de repo, un commit fijo no lo notaria -- pero al
    // menos no cambia de peso sin que este codigo se entere.
    const revisions = new Set<string>();
    for (const pair of TRANSLATION_PAIRS) {
      expect(pair.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(pair.revision).not.toBe("main");
      revisions.add(pair.revision);
    }
    // Cada par es un repo distinto: no deberian compartir revision.
    expect(revisions.size).toBe(TRANSLATION_PAIRS.length);
  });

  it("targetsFor devuelve los dos destinos restantes", () => {
    expect([...targetsFor("es")].sort()).toEqual(["en", "fr"]);
    expect([...targetsFor("en")].sort()).toEqual(["es", "fr"]);
    expect([...targetsFor("fr")].sort()).toEqual(["en", "es"]);
  });
});

describe("consentimiento (canTranslate)", () => {
  const base = { ...DEFAULT_TRANSLATE_OPTIONS, source: "es", target: "en" } as const;

  it("bloquea sin consentimiento", () => {
    expect(canTranslate({ ...base, consentedModel: null })).toBe(false);
  });

  it("permite con el consentimiento del modelo exacto", () => {
    expect(
      canTranslate({ ...base, consentedModel: "Xenova/opus-mt-es-en" }),
    ).toBe(true);
  });

  it("invalida el consentimiento si se cambia de par (fallar cerrado)", () => {
    // Acepto descargar es->en y despues cambio el destino: el modelo ya
    // no es el mismo, asi que hay que volver a consentir.
    expect(
      canTranslate({
        ...base,
        target: "fr",
        consentedModel: "Xenova/opus-mt-es-en",
      }),
    ).toBe(false);
  });

  it("bloquea un par inexistente aunque haya consentimiento", () => {
    expect(
      canTranslate({
        ...base,
        target: "es",
        consentedModel: "Xenova/opus-mt-es-en",
      }),
    ).toBe(false);
  });
});

describe("guardas del motor previas a cualquier descarga", () => {
  const file = new File(["irrelevante"], "documento.pdf", {
    type: "application/pdf",
  });

  it("rechaza un par no soportado sin tocar red ni pdf.js", async () => {
    await expect(
      translatePdfToReport(file, {
        ...DEFAULT_TRANSLATE_OPTIONS,
        source: "es",
        target: "es",
        consentedModel: "Xenova/opus-mt-es-en",
      }),
    ).rejects.toMatchObject({ code: "nothingSelected" });
  });

  it("rechaza la falta de consentimiento sin tocar red ni pdf.js", async () => {
    await expect(
      translatePdfToReport(file, {
        ...DEFAULT_TRANSLATE_OPTIONS,
        source: "es",
        target: "en",
        consentedModel: null,
      }),
    ).rejects.toMatchObject({ code: "consentRequired" });
  });

  it("rechaza el consentimiento de OTRO modelo", async () => {
    const error = await translatePdfToReport(file, {
      ...DEFAULT_TRANSLATE_OPTIONS,
      source: "es",
      target: "fr",
      consentedModel: "Xenova/opus-mt-es-en",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PdfError);
    expect((error as PdfError).code).toBe("consentRequired");
  });

  it("por defecto no hay consentimiento", () => {
    expect(DEFAULT_TRANSLATE_OPTIONS.consentedModel).toBeNull();
  });
});

describe("normalizeExtractedText", () => {
  it("colapsa espacios y saltos de linea del extractor", () => {
    expect(normalizeExtractedText("  hola\n\n  mundo \t ")).toBe("hola mundo");
  });

  it("un texto solo de espacios queda vacio", () => {
    expect(normalizeExtractedText(" \n\t ")).toBe("");
  });
});

describe("splitSentences", () => {
  it("corta por punto, exclamacion e interrogacion", () => {
    expect(splitSentences("Uno. Dos! Tres? Cuatro")).toEqual([
      "Uno.",
      "Dos!",
      "Tres?",
      "Cuatro",
    ]);
  });

  it("no corta dentro de un numero decimal", () => {
    expect(splitSentences("El valor es 3.14 exactamente.")).toEqual([
      "El valor es 3.14 exactamente.",
    ]);
  });

  it("mantiene los cierres pegados a la oracion", () => {
    expect(splitSentences('Dijo "vete." Y se fue.')).toEqual([
      'Dijo "vete."',
      "Y se fue.",
    ]);
  });

  it("texto vacio no produce oraciones", () => {
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("chunkText", () => {
  it("no trocea lo que ya cabe", () => {
    const text = "Una frase corta. Y otra mas.";
    expect(chunkText(text)).toEqual([text]);
  });

  it("respeta el limite de caracteres", () => {
    const sentence = `${"palabra ".repeat(30).trim()}.`;
    const text = Array.from({ length: 20 }, () => sentence).join(" ");
    const chunks = chunkText(text, 200);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  it("no pierde ni inventa palabras al trocear", () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `Oracion numero ${index} con algo de relleno.`,
    ).join(" ");

    const rejoined = chunkText(text, 120).join(" ");
    expect(rejoined).toBe(normalizeExtractedText(text));
  });

  it("parte una oracion que por si sola excede el limite", () => {
    const long = `${"palabra ".repeat(100).trim()}.`;
    const chunks = chunkText(long, 80);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
    }
  });

  it("parte una palabra unica mas larga que el limite", () => {
    // Caso real: un PDF mal extraido que devuelve una tira sin espacios.
    const blob = "x".repeat(500);
    const chunks = chunkText(blob, 100);

    expect(chunks).toHaveLength(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(blob);
  });

  it("texto vacio no genera fragmentos (ni trabajo de traduccion)", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("el limite por defecto deja margen bajo las 512 posiciones del modelo", () => {
    // ~3,5-4 caracteres por token en es/en/fr => 700 chars ~ 200 tokens.
    expect(MAX_CHUNK_CHARS).toBeLessThanOrEqual(900);
    expect(MAX_CHUNK_CHARS).toBeGreaterThan(0);
  });
});

describe("formatReportMarkdown", () => {
  const base: TranslationReportData = {
    fileName: "informe.pdf",
    source: "es",
    target: "en",
    model: "Xenova/opus-mt-es-en",
    generatedAt: new Date("2026-07-27T10:00:00Z"),
    reportLanguage: "es",
    pages: [
      {
        pageNumber: 1,
        original: "Hola mundo.",
        translated: "Hello world.",
        origin: "text",
      },
    ],
  };

  it("incluye original y traduccion de cada pagina", () => {
    const markdown = formatReportMarkdown(base);
    expect(markdown).toContain("Hola mundo.");
    expect(markdown).toContain("Hello world.");
    expect(markdown).toContain("Página 1");
  });

  it("etiqueta el resultado como traduccion automatica de IA", () => {
    const markdown = formatReportMarkdown(base);
    expect(markdown).toMatch(/Traducción automática generada por IA/);
    expect(formatReportMarkdown({ ...base, reportLanguage: "en" })).toMatch(
      /Machine translation generated by AI/,
    );
  });

  it("advierte de que NO es un PDF traducido, arriba y abajo", () => {
    const markdown = formatReportMarkdown(base);
    const occurrences = markdown.split("NO un PDF traducido").length - 1;
    // Cabecera y pie: si alguien copia solo un trozo, el aviso sigue ahi.
    expect(occurrences).toBe(2);
  });

  it("identifica el modelo y la direccion usados", () => {
    const markdown = formatReportMarkdown(base);
    expect(markdown).toContain("Xenova/opus-mt-es-en");
    expect(markdown).toContain("Español → Inglés");
  });

  it("marca las paginas reconocidas por OCR", () => {
    const markdown = formatReportMarkdown({
      ...base,
      pages: [{ ...base.pages[0], origin: "ocr" }],
    });
    expect(markdown).toContain("texto obtenido por OCR");
  });

  it("declara sin rodeos las paginas sin texto", () => {
    const markdown = formatReportMarkdown({
      ...base,
      pages: [
        { pageNumber: 1, original: "", translated: "", origin: "empty" },
      ],
    });
    expect(markdown).toContain("sin texto extraíble");
    expect(markdown).not.toContain("### Traducción");
  });

  it("es determinista: mismos datos, mismo informe", () => {
    expect(formatReportMarkdown(base)).toBe(formatReportMarkdown(base));
  });

  it("respeta el idioma del informe en las cabeceras", () => {
    const english = formatReportMarkdown({ ...base, reportLanguage: "en" });
    expect(english).toContain("# Translation report");
    expect(english).toContain("Page 1");
    expect(english).toContain("Spanish → English");
    expect(english).not.toContain("Página");
  });
});
