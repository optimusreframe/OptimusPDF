import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  DEFAULT_CHUNK_BUDGET,
  MAX_CHUNKS,
  SUMMARIZER_MODELS,
  SUMMARIZER_MODEL_KEYS,
  buildChunkPrompt,
  buildSynthesisPrompt,
  chunkCharBudget,
  chunkPageTexts,
  chunkTokenBudget,
  cleanModelOutput,
  estimateTokens,
  formatPageRange,
  groupSummariesForSynthesis,
  normalizePageText,
  pageMarker,
  renderChunkSummaryLine,
  sanitizePageCitations,
  renderSummaryDocument,
  splitIntoSegments,
  trimToLastSentence,
  type ChunkBudget,
  type ChunkSummary,
  type PageText,
  type SummaryResult,
} from "@/lib/pdf/summarize";

/**
 * ==================================================================
 * QUE SE PRUEBA AQUI Y QUE NO (limitacion de entorno, explicita)
 * ==================================================================
 *
 * `summarize.ts` tiene dos mitades muy distintas:
 *
 * (A) LOGICA PURA — preparacion de texto, troceado respetando la
 *     ventana de contexto, citas de pagina, construccion de prompts,
 *     agrupacion para la sintesis y render del documento descargable.
 *     Es lo que cubre este fichero, de forma exhaustiva.
 *
 * (B) LOGICA DE NAVEGADOR — `detectWebGpuSupport`, `isModelCached`,
 *     `extractDocumentText` y `summarizePdf`. NO se pueden ejecutar en
 *     esta suite y no se simulan:
 *
 *     - La inferencia real necesita WebGPU (`navigator.gpu`), que no
 *       existe en Node, y una descarga de ~0,7 GB de pesos del modelo.
 *       Montar un mock del motor solo probaria el mock.
 *     - `extractDocumentText` usa pdf.js, que bajo `environment: "node"`
 *       falla por `DOMMatrix` y por `PDF_WORKER_SRC` ("/pdf.worker.min.mjs",
 *       una ruta de `public/`): la misma limitacion ya documentada en
 *       `compare.test.ts` y `core.test.ts`. Ademas la reserva de OCR
 *       necesita `canvas` y tesseract.js.
 *
 *     Verificacion de (B): manual, en navegador. Lo unico que NO se ha
 *     podido verificar de extremo a extremo es la inferencia con el
 *     modelo cargado, por falta de GPU con `shader-f16` en el entorno de
 *     desarrollo; queda declarado como pendiente en el informe.
 *
 * El invariante de negocio que estos tests protegen es el que rompe la
 * herramienta si falla: NINGUN prompt puede desbordar la ventana de
 * contexto del modelo, porque el desbordamiento no da error — el motor
 * descarta silenciosamente el principio del texto y el resumen sale
 * incompleto sin avisar.
 */

function page(pageNumber: number, text: string): PageText {
  return { pageNumber, text, source: text.length > 0 ? "text" : "empty" };
}

function repeat(word: string, times: number): string {
  return Array.from({ length: times }, () => word).join(" ");
}

/* ------------------------------------------------------------------ *
 * Registro de modelos
 * ------------------------------------------------------------------ */

describe("SUMMARIZER_MODELS", () => {
  it("declara los dos modelos con ventana de contexto real de web-llm", () => {
    for (const key of SUMMARIZER_MODEL_KEYS) {
      const model = SUMMARIZER_MODELS[key];
      expect(model.key).toBe(key);
      // `prebuiltAppConfig` de web-llm 0.2.84 sobreescribe
      // `context_window_size: 4096` en ambas entradas.
      expect(model.contextWindow).toBe(4096);
      expect(model.id).toMatch(/q4f16_1-MLC$/);
      expect(model.approxDownloadBytes).toBeGreaterThan(0);
    }
  });

  it("el modelo por defecto es el de menor descarga", () => {
    const sizes = SUMMARIZER_MODEL_KEYS.map(
      (key) => SUMMARIZER_MODELS[key].approxDownloadBytes,
    );
    expect(SUMMARIZER_MODELS["llama-3.2-1b"].approxDownloadBytes).toBe(
      Math.min(...sizes),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Estimacion de tokens y presupuesto
 * ------------------------------------------------------------------ */

describe("estimateTokens", () => {
  it("devuelve 0 para texto vacio", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estima al alza (nunca por debajo del ratio elegido)", () => {
    const text = repeat("palabra", 100);
    expect(estimateTokens(text)).toBe(Math.ceil(text.length / CHARS_PER_TOKEN));
  });

  it("es conservador frente al ratio real del ingles (~4 car/token)", () => {
    const english = repeat("summary", 200);
    const realistic = Math.ceil(english.length / 4);
    expect(estimateTokens(english)).toBeGreaterThan(realistic);
  });
});

describe("chunkTokenBudget / chunkCharBudget", () => {
  it("descuenta salida, prompt y colchon de la ventana", () => {
    expect(chunkTokenBudget(DEFAULT_CHUNK_BUDGET)).toBe(
      4096 - 384 - 320 - 192,
    );
  });

  it("nunca baja de 128 tokens aunque las reservas se pasen", () => {
    const absurd: ChunkBudget = {
      contextTokens: 512,
      reservedOutputTokens: 400,
      reservedPromptTokens: 400,
      safetyTokens: 400,
    };
    expect(chunkTokenBudget(absurd)).toBe(128);
  });

  it("convierte a caracteres con el ratio declarado", () => {
    expect(chunkCharBudget(DEFAULT_CHUNK_BUDGET)).toBe(
      chunkTokenBudget(DEFAULT_CHUNK_BUDGET) * CHARS_PER_TOKEN,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Normalizacion de texto
 * ------------------------------------------------------------------ */

describe("normalizePageText", () => {
  it("colapsa cualquier espacio en blanco en uno solo", () => {
    expect(normalizePageText("hola   mundo\t\tcruel\n\n\nmundo")).toBe(
      "hola mundo cruel mundo",
    );
  });

  it("une palabras partidas por guion al final de linea", () => {
    expect(normalizePageText("in-\nforme anual")).toBe("informe anual");
    expect(normalizePageText("compa-\n  ñía")).toBe("compañía");
  });

  it("no toca guiones que no cortan linea", () => {
    expect(normalizePageText("teórico-práctico")).toBe("teórico-práctico");
  });

  it("elimina invisibles (soft hyphen, zero width, BOM)", () => {
    expect(normalizePageText("in­for​me﻿")).toBe("informe");
  });

  it("recorta extremos y tolera texto vacio", () => {
    expect(normalizePageText("   \n\t  ")).toBe("");
    expect(normalizePageText("")).toBe("");
  });
});

/* ------------------------------------------------------------------ *
 * Citas de pagina
 * ------------------------------------------------------------------ */

describe("formatPageRange / pageMarker", () => {
  it("usa una sola pagina cuando el rango no abarca mas", () => {
    expect(formatPageRange(3, 3)).toBe("p.3");
  });

  it("usa rango cuando abarca varias", () => {
    expect(formatPageRange(3, 5)).toBe("p.3-5");
  });

  it("la marca incrustada es reconocible dentro del texto", () => {
    expect(pageMarker(12)).toBe("[p.12]");
  });
});

describe("sanitizePageCitations", () => {
  it("deja intacta una cita de una sola pagina dentro de rango", () => {
    expect(sanitizePageCitations("Texto [p.2] con dato.", 2)).toBe(
      "Texto [p.2] con dato.",
    );
  });

  it("deja intacta una cita de rango dentro de limite", () => {
    expect(sanitizePageCitations("Ver [p.1-2] para mas.", 2)).toBe(
      "Ver [p.1-2] para mas.",
    );
  });

  it("quita una cita que excede el total real de paginas (alucinacion observada en pruebas Tier 3)", () => {
    expect(sanitizePageCitations("Dato final [p.3].", 2)).toBe("Dato final.");
  });

  it("quita una cita de rango cuyo extremo superior excede el total", () => {
    expect(sanitizePageCitations("Resumen [p.2-4] completo.", 2)).toBe(
      "Resumen completo.",
    );
  });

  it("quita una cita con pagina 0 o negativa (fuera de rango por abajo)", () => {
    expect(sanitizePageCitations("Nota [p.0] rara.", 2)).toBe("Nota rara.");
  });

  it("quita un rango invertido (firstPage > lastPage)", () => {
    expect(sanitizePageCitations("Caso [p.4-2] raro.", 5)).toBe("Caso raro.");
  });

  it("conserva varias citas cuando todas son validas", () => {
    expect(
      sanitizePageCitations("[p.1] uno, [p.2] dos, [p.3] tres.", 3),
    ).toBe("[p.1] uno, [p.2] dos, [p.3] tres.");
  });

  it("quita solo la cita invalida y conserva las validas del mismo texto", () => {
    expect(sanitizePageCitations("[p.1] uno, [p.9] nueve.", 1)).toBe(
      "[p.1] uno, nueve.",
    );
  });

  it("no hace nada si totalPages es 0 o negativo (documento no medido)", () => {
    expect(sanitizePageCitations("Dato [p.3].", 0)).toBe("Dato [p.3].");
  });

  it("no toca texto sin citas de pagina", () => {
    expect(sanitizePageCitations("Sin citas aqui.", 2)).toBe(
      "Sin citas aqui.",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Troceado
 * ------------------------------------------------------------------ */

describe("splitIntoSegments", () => {
  it("devuelve el texto intacto si ya cabe", () => {
    expect(splitIntoSegments("corto", 100)).toEqual(["corto"]);
  });

  it("devuelve lista vacia con texto vacio", () => {
    expect(splitIntoSegments("", 100)).toEqual([]);
  });

  it("corta por final de frase cuando puede", () => {
    const text = "Primera frase. Segunda frase. Tercera frase.";
    const segments = splitIntoSegments(text, 30);
    expect(segments[0]).toBe("Primera frase. Segunda frase.");
    expect(segments.join(" ")).toBe(text);
  });

  it("nunca parte una palabra por la mitad si hay espacios", () => {
    const text = repeat("palabra", 60);
    for (const segment of splitIntoSegments(text, 50)) {
      for (const word of segment.split(" ")) {
        expect(word).toBe("palabra");
      }
    }
  });

  it("respeta el limite en todos los segmentos", () => {
    const text = repeat("palabra", 200);
    for (const segment of splitIntoSegments(text, 50)) {
      expect(segment.length).toBeLessThanOrEqual(50);
    }
  });

  it("no pierde ni duplica contenido", () => {
    const text = repeat("alfa", 40);
    expect(splitIntoSegments(text, 37).join(" ")).toBe(text);
  });

  it("hace corte duro si una sola palabra desborda el limite", () => {
    const monster = "x".repeat(120);
    const segments = splitIntoSegments(monster, 40);
    expect(segments).toHaveLength(3);
    expect(segments.join("")).toBe(monster);
  });
});

describe("chunkPageTexts", () => {
  const budget = DEFAULT_CHUNK_BUDGET;
  const maxChars = chunkCharBudget(budget);

  it("agrupa paginas cortas consecutivas en un solo trozo", () => {
    const chunks = chunkPageTexts(
      [page(1, "Uno."), page(2, "Dos."), page(3, "Tres.")],
      budget,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].firstPage).toBe(1);
    expect(chunks[0].lastPage).toBe(3);
    expect(chunks[0].partialPage).toBe(false);
  });

  it("incrusta la marca de pagina de cada pagina incluida", () => {
    const chunks = chunkPageTexts([page(1, "Uno."), page(4, "Cuatro.")], budget);
    expect(chunks[0].text).toContain("[p.1]");
    expect(chunks[0].text).toContain("[p.4]");
  });

  it("ignora las paginas sin texto pero conserva la numeracion real", () => {
    const chunks = chunkPageTexts(
      [page(1, ""), page(2, "   "), page(3, "Contenido.")],
      budget,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].firstPage).toBe(3);
    expect(chunks[0].lastPage).toBe(3);
    expect(chunks[0].text).toBe("[p.3] Contenido.");
  });

  it("devuelve lista vacia si ninguna pagina tiene texto", () => {
    expect(chunkPageTexts([page(1, ""), page(2, "")], budget)).toEqual([]);
  });

  it("NINGUN trozo supera el presupuesto (invariante critico)", () => {
    const pages: PageText[] = Array.from({ length: 40 }, (_, index) =>
      page(index + 1, repeat("contenido", 400)),
    );
    const chunks = chunkPageTexts(pages, budget);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(
        chunkTokenBudget(budget),
      );
    }
  });

  it("parte una pagina que no cabe y la marca como parcial", () => {
    const huge = repeat("parrafo", Math.ceil(maxChars / 4));
    const chunks = chunkPageTexts([page(7, huge)], budget);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.partialPage).toBe(true);
      expect(chunk.firstPage).toBe(7);
      expect(chunk.lastPage).toBe(7);
      expect(chunk.text.startsWith("[p.7] ")).toBe(true);
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("cierra el trozo en curso antes de partir una pagina gigante", () => {
    const huge = repeat("parrafo", Math.ceil(maxChars / 4));
    const chunks = chunkPageTexts([page(1, "Breve."), page(2, huge)], budget);
    expect(chunks[0].text).toBe("[p.1] Breve.");
    expect(chunks[0].partialPage).toBe(false);
    expect(chunks[1].partialPage).toBe(true);
  });

  it("numera los trozos de forma correlativa desde 0", () => {
    const pages: PageText[] = Array.from({ length: 30 }, (_, index) =>
      page(index + 1, repeat("dato", 500)),
    );
    const chunks = chunkPageTexts(pages, budget);
    chunks.forEach((chunk, index) => expect(chunk.index).toBe(index));
  });

  it("los rangos de pagina son crecientes y no se solapan", () => {
    const pages: PageText[] = Array.from({ length: 30 }, (_, index) =>
      page(index + 1, repeat("dato", 500)),
    );
    const chunks = chunkPageTexts(pages, budget);
    for (let i = 0; i < chunks.length; i += 1) {
      expect(chunks[i].lastPage).toBeGreaterThanOrEqual(chunks[i].firstPage);
      if (i > 0) {
        expect(chunks[i].firstPage).toBeGreaterThanOrEqual(
          chunks[i - 1].lastPage,
        );
      }
    }
  });

  it("respeta una ventana de contexto menor", () => {
    const small: ChunkBudget = { ...budget, contextTokens: 1024 };
    const smallMax = chunkCharBudget(small);
    expect(smallMax).toBeLessThan(maxChars);
    const pages: PageText[] = Array.from({ length: 10 }, (_, index) =>
      page(index + 1, repeat("texto", 200)),
    );
    for (const chunk of chunkPageTexts(pages, small)) {
      expect(chunk.text.length).toBeLessThanOrEqual(smallMax);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Prompts
 * ------------------------------------------------------------------ */

describe("buildChunkPrompt", () => {
  const [chunk] = chunkPageTexts([page(4, "El informe cierra en verde.")]);

  it("incluye el texto del trozo y su rango de paginas", () => {
    const prompt = buildChunkPrompt(chunk, {
      language: "es",
      length: "medium",
    });
    expect(prompt.user).toContain("El informe cierra en verde.");
    expect(prompt.user).toContain("p.4");
  });

  it("pide citar la pagina", () => {
    const prompt = buildChunkPrompt(chunk, { language: "es", length: "short" });
    expect(prompt.user).toContain("(p.4)");
  });

  it("prohibe inventar en el system prompt, en los dos idiomas", () => {
    expect(
      buildChunkPrompt(chunk, { language: "es", length: "short" }).system,
    ).toMatch(/no inventes/i);
    expect(
      buildChunkPrompt(chunk, { language: "en", length: "short" }).system,
    ).toMatch(/do not invent/i);
  });

  it("pide menos frases en el resumen corto que en el medio", () => {
    const short = buildChunkPrompt(chunk, {
      language: "es",
      length: "short",
    }).user;
    const medium = buildChunkPrompt(chunk, {
      language: "es",
      length: "medium",
    }).user;
    expect(short).toContain("2 frases");
    expect(medium).toContain("4 frases");
  });

  it("cabe en la ventana junto con la salida reservada", () => {
    const pages: PageText[] = Array.from({ length: 20 }, (_, index) =>
      page(index + 1, repeat("contenido", 300)),
    );
    for (const item of chunkPageTexts(pages)) {
      const prompt = buildChunkPrompt(item, {
        language: "es",
        length: "medium",
      });
      const total =
        estimateTokens(prompt.system) +
        estimateTokens(prompt.user) +
        DEFAULT_CHUNK_BUDGET.reservedOutputTokens;
      expect(total).toBeLessThanOrEqual(DEFAULT_CHUNK_BUDGET.contextTokens);
    }
  });
});

describe("renderChunkSummaryLine", () => {
  it("antepone el rango de paginas al resumen", () => {
    expect(
      renderChunkSummaryLine({
        firstPage: 2,
        lastPage: 5,
        text: "  Resultados al alza.  ",
        partialPage: false,
      }),
    ).toBe("p.2-5: Resultados al alza.");
  });
});

describe("groupSummariesForSynthesis", () => {
  function summary(first: number, last: number, text: string): ChunkSummary {
    return { firstPage: first, lastPage: last, text, partialPage: false };
  }

  it("devuelve un solo grupo cuando todo cabe", () => {
    const groups = groupSummariesForSynthesis([
      summary(1, 2, "Uno."),
      summary(3, 4, "Dos."),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("devuelve lista vacia sin entradas", () => {
    expect(groupSummariesForSynthesis([])).toEqual([]);
  });

  it("parte en grupos que caben cuando hay demasiados resumenes", () => {
    const many = Array.from({ length: 24 }, (_, index) =>
      summary(index + 1, index + 1, repeat("frase", 200)),
    );
    const groups = groupSummariesForSynthesis(many);
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      const size = group
        .map(renderChunkSummaryLine)
        .reduce((total, line) => total + line.length + 1, 0);
      expect(size).toBeLessThanOrEqual(chunkCharBudget(DEFAULT_CHUNK_BUDGET));
    }
  });

  it("conserva el orden y no pierde resumenes", () => {
    const many = Array.from({ length: 24 }, (_, index) =>
      summary(index + 1, index + 1, repeat("frase", 200)),
    );
    const flat = groupSummariesForSynthesis(many).flat();
    expect(flat).toHaveLength(many.length);
    expect(flat.map((item) => item.firstPage)).toEqual(
      many.map((item) => item.firstPage),
    );
  });

  it("reduce en cada ronda (la sintesis termina)", () => {
    let current = Array.from({ length: MAX_CHUNKS }, (_, index) =>
      summary(index + 1, index + 1, repeat("frase", 200)),
    );
    let rounds = 0;
    while (current.length > 1 && rounds < 10) {
      const groups = groupSummariesForSynthesis(current);
      expect(groups.length).toBeLessThan(current.length);
      current = groups.map((group) =>
        summary(group[0].firstPage, group[group.length - 1].lastPage, "x"),
      );
      rounds += 1;
    }
    expect(current).toHaveLength(1);
  });
});

describe("buildSynthesisPrompt", () => {
  const summaries: ChunkSummary[] = [
    { firstPage: 1, lastPage: 2, text: "Introduccion.", partialPage: false },
    { firstPage: 3, lastPage: 5, text: "Resultados.", partialPage: false },
  ];

  it("incluye todos los resumenes parciales con sus paginas", () => {
    const prompt = buildSynthesisPrompt(summaries, {
      language: "es",
      length: "medium",
    });
    expect(prompt.user).toContain("p.1-2: Introduccion.");
    expect(prompt.user).toContain("p.3-5: Resultados.");
  });

  it("pide mantener las citas de pagina", () => {
    const prompt = buildSynthesisPrompt(summaries, {
      language: "en",
      length: "medium",
    });
    expect(prompt.user).toMatch(/page citations/i);
  });

  it("la ronda intermedia pide menos frases que la final", () => {
    const intermediate = buildSynthesisPrompt(summaries, {
      language: "es",
      length: "medium",
      intermediate: true,
    }).user;
    const last = buildSynthesisPrompt(summaries, {
      language: "es",
      length: "medium",
    }).user;
    expect(intermediate).toContain("8 frases");
    expect(last).toContain("8 frases");
    const short = buildSynthesisPrompt(summaries, {
      language: "es",
      length: "short",
      intermediate: true,
    }).user;
    expect(short).toContain("4 frases");
  });
});

/* ------------------------------------------------------------------ *
 * Limpieza de la salida del modelo
 * ------------------------------------------------------------------ */

describe("cleanModelOutput", () => {
  it("quita preambulos de cortesia en espanol e ingles", () => {
    expect(cleanModelOutput("Claro, aquí tienes el resumen: El informe.")).toBe(
      "El informe.",
    );
    expect(cleanModelOutput("Sure! Here is a summary: The report.")).toBe(
      "The report.",
    );
  });

  it("quita la etiqueta Resumen:/Summary:", () => {
    expect(cleanModelOutput("Resumen: El informe.")).toBe("El informe.");
    expect(cleanModelOutput("Summary: The report.")).toBe("The report.");
  });

  it("quita vallas de codigo y comillas envolventes", () => {
    expect(cleanModelOutput("```\nEl informe.\n```")).toBe("El informe.");
    expect(cleanModelOutput('"El informe."')).toBe("El informe.");
  });

  it("no toca un resumen ya limpio", () => {
    expect(cleanModelOutput("El informe cierra en verde (p.4).")).toBe(
      "El informe cierra en verde (p.4).",
    );
  });

  it("tolera cadena vacia", () => {
    expect(cleanModelOutput("   ")).toBe("");
  });

  it("no destroza una comilla de apertura sin cierre", () => {
    expect(cleanModelOutput('"El informe')).toBe('"El informe');
  });
});

describe("trimToLastSentence", () => {
  it("corta la frase incompleta que deja un max_tokens agotado", () => {
    expect(
      trimToLastSentence(
        "La flota tiene 20 vehiculos. El mantenimiento se hace cada 10.000",
      ),
    ).toBe("La flota tiene 20 vehiculos.");
  });

  it("no toca un texto que ya termina en frase completa", () => {
    const text = "Uno. Dos. Tres.";
    expect(trimToLastSentence(text)).toBe(text);
  });

  it("prefiere una frase inacabada a perder casi todo el resumen", () => {
    // Recortar dejaria menos del 40%: se devuelve tal cual.
    const text = "Si. " + "palabra ".repeat(40);
    expect(trimToLastSentence(text)).toBe(text.trim());
  });

  it("devuelve el texto entero si no hay ningun final de frase", () => {
    expect(trimToLastSentence("sin puntuacion alguna aqui")).toBe(
      "sin puntuacion alguna aqui",
    );
  });

  it("tolera cadena vacia", () => {
    expect(trimToLastSentence("   ")).toBe("");
  });

  it("respeta signos de cierre tras el punto", () => {
    expect(trimToLastSentence('Dijo "vale." Luego se fue a')).toBe(
      'Dijo "vale."',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Documento descargable
 * ------------------------------------------------------------------ */

describe("renderSummaryDocument", () => {
  const labels = {
    title: "Resumen",
    aiWarning: "Generado por IA local: puede contener errores.",
    overviewTitle: "RESUMEN GENERAL",
    sectionsTitle: "POR SECCIONES",
    modelLine: (modelId: string) => `Modelo: ${modelId}`,
    truncatedLine: (page_: number) => `Solo hasta la pagina ${page_}.`,
    ocrLine: (pages: string) => `Paginas por OCR: ${pages}.`,
  };

  const result: SummaryResult = {
    overview: "El documento trata de X (p.1-3).",
    sections: [
      { firstPage: 1, lastPage: 3, text: "Intro.", partialPage: false },
      { firstPage: 4, lastPage: 4, text: "Cierre.", partialPage: false },
    ],
    pageCount: 4,
    ocrPages: [],
    emptyPages: [],
    modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    truncated: false,
    coveredUpToPage: 4,
  };

  it("incluye SIEMPRE el aviso de IA (el fichero viaja sin la interfaz)", () => {
    expect(renderSummaryDocument(result, labels)).toContain(labels.aiWarning);
  });

  it("nombra el modelo que lo genero", () => {
    expect(renderSummaryDocument(result, labels)).toContain(
      "Modelo: Llama-3.2-1B-Instruct-q4f16_1-MLC",
    );
  });

  it("lista las secciones con su rango de paginas", () => {
    const text = renderSummaryDocument(result, labels);
    expect(text).toContain("p.1-3: Intro.");
    expect(text).toContain("p.4: Cierre.");
  });

  it("avisa del recorte solo cuando lo hubo", () => {
    expect(renderSummaryDocument(result, labels)).not.toContain("Solo hasta");
    expect(
      renderSummaryDocument({ ...result, truncated: true }, labels),
    ).toContain("Solo hasta la pagina 4.");
  });

  it("avisa de las paginas que vinieron de OCR", () => {
    expect(
      renderSummaryDocument({ ...result, ocrPages: [2, 3] }, labels),
    ).toContain("Paginas por OCR: 2, 3.");
  });

  it("termina en salto de linea", () => {
    expect(renderSummaryDocument(result, labels).endsWith("\n")).toBe(true);
  });
});
