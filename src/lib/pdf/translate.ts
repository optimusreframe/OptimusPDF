import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  openPdfDocument,
  renderPageToCanvas,
  scaleProgress,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor del INFORME DE TRADUCCION.
 *
 * Lo que esta herramienta hace y lo que NO hace
 * ---------------------------------------------
 * Produce un informe bilingue descargable (Markdown): por cada pagina,
 * el texto original y su traduccion automatica, uno detras de otro.
 *
 * NO produce un PDF traducido conservando la maquetacion. Esa version
 * "buena" exige rehacer el flujo de texto, cubrir la tipografia del
 * idioma destino, respetar el orden de lectura y no destrozar los
 * fondos: no es alcanzable de forma fiable en el navegador, y hacerlo
 * con calidad pediria un backend de traduccion + reconstruccion de
 * maquetacion. Se descarto por decision de producto (sin backend, sin
 * coste recurrente y sin enviar el contenido del documento a una API
 * ajena). El nombre de la herramienta y toda su copy dicen "informe",
 * no "PDF traducido", justamente por esto.
 *
 * Privacidad
 * ----------
 * Todo ocurre en la pestana. La UNICA peticion de red es la descarga de
 * los pesos del modelo desde el hub de Hugging Face, y va precedida de
 * consentimiento explicito del usuario (ver `consentedModel`). El texto
 * extraido del documento no viaja a ningun servidor: se tokeniza y se
 * ejecuta contra ONNX Runtime Web (WASM) dentro del propio navegador.
 *
 * Cadena de suministro (importante)
 * ---------------------------------
 * `@huggingface/transformers` declara `onnxruntime-node` y `sharp` como
 * dependencias NO opcionales, y `npm audit` marca un `adm-zip` de
 * severidad alta a traves de `onnxruntime-node`. Este modulo usa
 * exclusivamente el backend de navegador: el `import()` dinamico se
 * resuelve al bundle web del paquete (`dist/transformers.web.js`), que
 * lleva `// ignore-modules:onnxruntime-node` y deja ese modulo como un
 * objeto vacio, importando solo `onnxruntime-web`. `sharp` no aparece en
 * ese bundle. Ademas el `import()` esta dentro de una funcion que solo
 * se ejecuta tras un clic del usuario, asi que nada de esto se evalua
 * durante el render en servidor.
 */

/* ------------------------------------------------------------------ *
 * Idiomas y modelos
 * ------------------------------------------------------------------ */

/**
 * Malla completa de tres idiomas (es, en, fr): las seis direcciones
 * posibles, sin huecos y sin pivote.
 *
 * Por que OPUS-MT y no NLLB-200: `Xenova/nllb-200-distilled-600M` cubre
 * muchisimos idiomas pero son 600M de parametros (cientos de MB incluso
 * cuantizado, y lento en hardware modesto). Los OPUS-MT de Helsinki son
 * Marian de ~75M parametros: cuantizados a q8 rondan los 110-125 MB por
 * par, que es una descarga defendible y se ejecuta a velocidad razonable
 * en WASM. El precio es que cada modelo es bilingue y unidireccional,
 * lo que de hecho ayuda a mantener el alcance pequeno y honesto.
 *
 * El portugues se dejo fuera a proposito: no existe conversion ONNX
 * publicada (`Xenova/opus-mt-pt-en` y `Xenova/opus-mt-en-pt` responden
 * 401 en el hub), y preferimos no ofrecer un par que no podemos servir.
 */
export const TRANSLATE_LANGUAGES = ["es", "en", "fr"] as const;
export type TranslateLanguage = (typeof TRANSLATE_LANGUAGES)[number];

export type TranslationPair = {
  source: TranslateLanguage;
  target: TranslateLanguage;
  /** Repositorio del hub con la conversion ONNX. */
  model: string;
  /**
   * Descarga aproximada en MB de lo que el pipeline pide de verdad:
   * `encoder_model_quantized.onnx` + `decoder_model_merged_quantized.onnx`
   * + `tokenizer.json` + los JSON de config. Medido contra la API del
   * hub y redondeado HACIA ARRIBA: nunca prometemos menos de lo que
   * cuesta.
   */
  approxDownloadMb: number;
};

export const TRANSLATION_PAIRS: readonly TranslationPair[] = [
  { source: "es", target: "en", model: "Xenova/opus-mt-es-en", approxDownloadMb: 115 },
  { source: "en", target: "es", model: "Xenova/opus-mt-en-es", approxDownloadMb: 115 },
  { source: "fr", target: "en", model: "Xenova/opus-mt-fr-en", approxDownloadMb: 110 },
  { source: "en", target: "fr", model: "Xenova/opus-mt-en-fr", approxDownloadMb: 110 },
  { source: "es", target: "fr", model: "Xenova/opus-mt-es-fr", approxDownloadMb: 125 },
  { source: "fr", target: "es", model: "Xenova/opus-mt-fr-es", approxDownloadMb: 125 },
] as const;

/** Par de idiomas soportado, o `null` si esa direccion no existe. */
export function findPair(
  source: TranslateLanguage,
  target: TranslateLanguage,
): TranslationPair | null {
  return (
    TRANSLATION_PAIRS.find(
      (pair) => pair.source === source && pair.target === target,
    ) ?? null
  );
}

export function isSupportedPair(
  source: TranslateLanguage,
  target: TranslateLanguage,
): boolean {
  return findPair(source, target) !== null;
}

/** Destinos disponibles para un origen dado (excluye el propio origen). */
export function targetsFor(
  source: TranslateLanguage,
): readonly TranslateLanguage[] {
  return TRANSLATION_PAIRS.filter((pair) => pair.source === source).map(
    (pair) => pair.target,
  );
}

/** Codigo de tesseract.js equivalente, para el respaldo de OCR. */
const OCR_LANGUAGE_BY_TRANSLATE_LANGUAGE: Record<TranslateLanguage, string> = {
  es: "spa",
  en: "eng",
  fr: "fra",
};

/* ------------------------------------------------------------------ *
 * Troceado del texto (puro y testeable)
 * ------------------------------------------------------------------ */

/**
 * Presupuesto de caracteres por fragmento.
 *
 * Los OPUS-MT tienen `max_position_embeddings: 512`, asi que ni la
 * entrada ni la salida pueden pasar de 512 tokens. Con el tokenizador
 * SentencePiece de Marian, en es/en/fr, un token viene a ser ~3,5-4
 * caracteres; 700 caracteres son por tanto ~175-200 tokens, muy holgado
 * respecto al limite duro incluso cuando la traduccion se alarga
 * respecto al original. Se prefiere un margen amplio a exprimir el
 * modelo: pasarse del limite no da un error claro, da texto truncado.
 */
export const MAX_CHUNK_CHARS = 700;

/** Colapsa espacios y normaliza para que el troceado sea determinista. */
export function normalizeExtractedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const SENTENCE_TERMINATORS = ".!?…";
const SENTENCE_CLOSERS = "\"'”’)]»";

/**
 * Parte el texto en oraciones por puntuacion terminal seguida de
 * espacio.
 *
 * Limite conocido y aceptado: no distingue un punto de abreviatura
 * ("Sr. Lopez", "etc.") del punto final de una oracion, asi que puede
 * cortar de mas. Para lo que se usa aqui —agrupar despues en fragmentos
 * por debajo del limite del modelo— un corte de mas es inofensivo: el
 * fragmento sigue siendo texto coherente y traducible.
 */
export function splitSentences(text: string): string[] {
  const normalized = normalizeExtractedText(text);
  if (normalized.length === 0) return [];

  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    if (!SENTENCE_TERMINATORS.includes(normalized[index])) continue;

    // Absorbe seguidos de terminadores ("!?...") y cierres ("»", comillas).
    let end = index + 1;
    while (
      end < normalized.length &&
      (SENTENCE_TERMINATORS.includes(normalized[end]) ||
        SENTENCE_CLOSERS.includes(normalized[end]))
    ) {
      end += 1;
    }
    // Solo corta si de verdad termina ahi: si no hay espacio detras
    // (p.ej. "3.14"), no era un final de oracion.
    if (end < normalized.length && normalized[end] !== " ") continue;

    const piece = normalized.slice(start, end).trim();
    if (piece.length > 0) sentences.push(piece);
    start = end;
    index = end - 1;
  }

  const tail = normalized.slice(start).trim();
  if (tail.length > 0) sentences.push(tail);
  return sentences;
}

/** Trocea por palabras algo que ya excede el limite por si solo. */
function hardSplit(piece: string, limit: number): string[] {
  const out: string[] = [];
  let current = "";

  for (const word of piece.split(" ")) {
    if (word.length === 0) continue;

    // Una sola "palabra" mas larga que el limite (URLs, cadenas sin
    // espacios de un PDF mal extraido): se parte a lo bruto.
    if (word.length > limit) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += limit) {
        out.push(word.slice(i, i + limit));
      }
      continue;
    }

    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (candidate.length > limit) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Agrupa oraciones en fragmentos que quepan en el modelo, sin partir una
 * oracion salvo que ella sola ya no quepa. Devuelve `[]` para texto
 * vacio: una pagina sin texto no genera trabajo de traduccion.
 */
export function chunkText(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const chunks: string[] = [];
  let current = "";

  for (const sentence of splitSentences(text)) {
    const pieces =
      sentence.length > limit ? hardSplit(sentence, limit) : [sentence];

    for (const piece of pieces) {
      const candidate = current.length > 0 ? `${current} ${piece}` : piece;
      if (candidate.length > limit && current.length > 0) {
        chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/* ------------------------------------------------------------------ *
 * Formato del informe (puro y testeable)
 * ------------------------------------------------------------------ */

/** De donde salio el texto de una pagina. */
export type PageTextSource = "text" | "ocr" | "empty";

export type TranslatedPage = {
  /** 1..n */
  pageNumber: number;
  original: string;
  translated: string;
  origin: PageTextSource;
};

/** El informe se redacta en el idioma de la interfaz, no en el del PDF. */
export type ReportLanguage = "es" | "en";

export type TranslationReportData = {
  fileName: string;
  source: TranslateLanguage;
  target: TranslateLanguage;
  model: string;
  pages: readonly TranslatedPage[];
  /** Se inyecta para que el formateo sea determinista en los tests. */
  generatedAt: Date;
  reportLanguage: ReportLanguage;
};

type ReportLabels = {
  title: string;
  document: string;
  direction: string;
  model: string;
  generated: string;
  pages: string;
  disclaimer: string;
  notATranslatedPdf: string;
  page: string;
  original: string;
  translation: string;
  viaOcr: string;
  noText: string;
  languageNames: Record<TranslateLanguage, string>;
};

const REPORT_LABELS: Record<ReportLanguage, ReportLabels> = {
  es: {
    title: "Informe de traducción",
    document: "Documento",
    direction: "Dirección",
    model: "Modelo",
    generated: "Generado",
    pages: "Páginas",
    disclaimer:
      "Traducción automática generada por IA en tu navegador. Puede contener errores, omisiones o contrasentidos. No la uses como traducción jurada, legal ni médica sin que la revise una persona.",
    notATranslatedPdf:
      "Esto es un informe bilingüe de texto, NO un PDF traducido con la maquetación original. La maquetación, las imágenes, las tablas y el formato del documento no se conservan.",
    page: "Página",
    original: "Original",
    translation: "Traducción",
    viaOcr: "texto obtenido por OCR",
    noText: "_(sin texto extraíble en esta página)_",
    languageNames: { es: "Español", en: "Inglés", fr: "Francés" },
  },
  en: {
    title: "Translation report",
    document: "Document",
    direction: "Direction",
    model: "Model",
    generated: "Generated",
    pages: "Pages",
    disclaimer:
      "Machine translation generated by AI in your browser. It may contain errors, omissions or reversals of meaning. Do not use it as a sworn, legal or medical translation without human review.",
    notATranslatedPdf:
      "This is a bilingual text report, NOT a translated PDF with the original layout. Layout, images, tables and document formatting are not preserved.",
    page: "Page",
    original: "Original",
    translation: "Translation",
    viaOcr: "text obtained via OCR",
    noText: "_(no extractable text on this page)_",
    languageNames: { es: "Spanish", en: "English", fr: "French" },
  },
};

/**
 * Serializa el informe a Markdown. Es una funcion pura: mismos datos,
 * mismo texto. El aviso de "esto no es un PDF traducido" y el de
 * "traduccion automatica" van en la cabecera Y se repiten al pie, para
 * que sigan estando cuando alguien copie solo un trozo.
 */
export function formatReportMarkdown(data: TranslationReportData): string {
  const labels = REPORT_LABELS[data.reportLanguage];
  const locale = data.reportLanguage === "es" ? "es-ES" : "en-GB";
  const lines: string[] = [];

  lines.push(`# ${labels.title}`);
  lines.push("");
  lines.push(`- **${labels.document}:** ${data.fileName}`);
  lines.push(
    `- **${labels.direction}:** ${labels.languageNames[data.source]} → ${labels.languageNames[data.target]}`,
  );
  lines.push(`- **${labels.model}:** \`${data.model}\``);
  lines.push(
    `- **${labels.generated}:** ${data.generatedAt.toLocaleString(locale)}`,
  );
  lines.push(`- **${labels.pages}:** ${data.pages.length}`);
  lines.push("");
  lines.push(`> ⚠️ ${labels.notATranslatedPdf}`);
  lines.push(">");
  lines.push(`> ⚠️ ${labels.disclaimer}`);
  lines.push("");
  lines.push("---");

  for (const page of data.pages) {
    lines.push("");
    const suffix = page.origin === "ocr" ? ` _(${labels.viaOcr})_` : "";
    lines.push(`## ${labels.page} ${page.pageNumber}${suffix}`);
    lines.push("");

    if (page.origin === "empty") {
      lines.push(labels.noText);
      lines.push("");
      continue;
    }

    lines.push(`### ${labels.original}`);
    lines.push("");
    lines.push(page.original);
    lines.push("");
    lines.push(`### ${labels.translation}`);
    lines.push("");
    lines.push(page.translated);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`_${labels.disclaimer}_`);
  lines.push("");
  lines.push(`_${labels.notATranslatedPdf}_`);
  lines.push("");

  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Extraccion de texto
 * ------------------------------------------------------------------ */

type TextLikeItem = { str: string; hasEOL?: boolean };

function isTextItem(item: unknown): item is TextLikeItem {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { str?: unknown }).str === "string"
  );
}

/**
 * Por debajo de esto se considera que la pagina no tiene capa de texto
 * util (numeros de pagina sueltos, marcas de agua) y entra el OCR si el
 * usuario lo pidio.
 */
export const MIN_TEXT_CHARS = 24;

/* ------------------------------------------------------------------ *
 * Opciones y motor
 * ------------------------------------------------------------------ */

export type TranslateOptions = {
  source: TranslateLanguage;
  target: TranslateLanguage;
  /** Reconocer con OCR las paginas sin capa de texto. */
  ocrFallback: boolean;
  /**
   * Consentimiento explicito para la descarga del modelo. Debe ser el
   * identificador EXACTO del modelo del par elegido: si el usuario
   * cambia de par despues de aceptar, el consentimiento deja de valer y
   * hay que volver a pedirlo. Fallar cerrado.
   */
  consentedModel: string | null;
  /** Idioma en el que se redacta el informe (el de la interfaz). */
  reportLanguage: ReportLanguage;
};

export const DEFAULT_TRANSLATE_OPTIONS: TranslateOptions = {
  source: "es",
  target: "en",
  ocrFallback: true,
  consentedModel: null,
  reportLanguage: "es",
};

/** Comprueba, sin efectos, si `process` puede arrancar. Lo usa la UI. */
export function canTranslate(options: TranslateOptions): boolean {
  const pair = findPair(options.source, options.target);
  if (!pair) return false;
  return options.consentedModel === pair.model;
}

/** Forma minima del pipeline de traduccion que consumimos. */
type TranslatorFn = (
  texts: string,
  options?: Record<string, unknown>,
) => Promise<Array<{ translation_text: string }>>;

/**
 * Carga el pipeline de traduccion en el navegador.
 *
 * `import()` dinamico a proposito: son ~1 MB de JS mas el runtime WASM,
 * y nadie que solo visite la pagina deberia pagarlos. Al estar dentro de
 * una funcion que solo corre tras el clic del usuario, tampoco se evalua
 * durante el render en servidor de Next.
 */
async function loadTranslator(
  model: string,
  onDownloadProgress: (fraction: number) => void,
): Promise<{ translate: TranslatorFn; dispose: () => Promise<void> }> {
  const transformers = await import("@huggingface/transformers");

  // Nada de buscar modelos en nuestro propio origen: no servimos pesos
  // desde `public/`, asi que el "modelo local" solo generaria 404s.
  transformers.env.allowLocalModels = false;
  // La Cache API del navegador evita repetir la descarga en cada uso.
  transformers.env.useBrowserCache = true;

  // Progreso agregado de todos los ficheros que pide el pipeline.
  const bytesByFile = new Map<string, { loaded: number; total: number }>();
  const report = () => {
    let loaded = 0;
    let total = 0;
    for (const entry of bytesByFile.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    if (total > 0) onDownloadProgress(Math.min(1, loaded / total));
  };

  const pipe = await transformers.pipeline("translation", model, {
    // q8 explicito (y no "auto") para que los ficheros descargados sean
    // exactamente los `*_quantized.onnx` cuyo tamano anunciamos al pedir
    // el consentimiento.
    dtype: "q8",
    device: "wasm",
    // El backend WASM de onnxruntime-web falla al crear la sesion con
    // estos grafos MatMulNBits cuantizados: la pasada de optimizacion
    // `TransposeDQWeightsForMatMulNBits` no encuentra un tensor de escala
    // que el grafo si trae (`Missing required scale: ...weight_merged_0_scale`).
    // Desactivar las optimizaciones de grafo evita esa pasada por completo;
    // confirmado que la traduccion sigue siendo correcta sin ellas.
    session_options: { graphOptimizationLevel: "disabled" },
    progress_callback: (event: unknown) => {
      const item = event as {
        status?: string;
        file?: string;
        loaded?: number;
        total?: number;
      };
      if (item.status !== "progress" || typeof item.file !== "string") return;
      bytesByFile.set(item.file, {
        loaded: item.loaded ?? 0,
        total: item.total ?? 0,
      });
      report();
    },
  });

  const translate = pipe as unknown as TranslatorFn;
  return {
    translate,
    dispose: async () => {
      const disposable = pipe as unknown as { dispose?: () => Promise<void> };
      await disposable.dispose?.();
    },
  };
}

/**
 * Extrae el texto de cada pagina, con respaldo opcional de OCR para las
 * paginas escaneadas. Se separa del resto para que el motor tenga una
 * sola responsabilidad por bloque.
 */
async function extractPages(
  file: File,
  options: TranslateOptions,
  onProgress: (fraction: number) => void,
  signal: AbortSignal | undefined,
): Promise<Array<{ text: string; origin: PageTextSource }>> {
  let viewer: PDFDocumentProxy | null = null;
  let worker: Awaited<
    ReturnType<typeof import("tesseract.js").createWorker>
  > | null = null;

  try {
    viewer = await openPdfDocument(file);
    const total = viewer.numPages;
    if (total === 0) throw new PdfError("corrupt");

    const pages: Array<{ text: string; origin: PageTextSource }> = [];
    const needsOcr: number[] = [];

    for (let number = 1; number <= total; number += 1) {
      throwIfAborted(signal);
      const page = await viewer.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : "";
      }
      page.cleanup();

      const normalized = normalizeExtractedText(text);
      if (normalized.length >= MIN_TEXT_CHARS) {
        pages.push({ text: normalized, origin: "text" });
      } else {
        pages.push({ text: normalized, origin: "empty" });
        needsOcr.push(number - 1);
      }
      onProgress((number / total) * (options.ocrFallback ? 0.5 : 1));
    }

    if (!options.ocrFallback || needsOcr.length === 0) {
      onProgress(1);
      return pages;
    }

    // Solo se paga tesseract.js si de verdad hay paginas sin texto.
    const tesseract = await import("tesseract.js");
    worker = await tesseract.createWorker(
      OCR_LANGUAGE_BY_TRANSLATE_LANGUAGE[options.source],
      tesseract.OEM.LSTM_ONLY,
    );

    for (let position = 0; position < needsOcr.length; position += 1) {
      throwIfAborted(signal);
      const index = needsOcr[position];
      const source = await viewer.getPage(index + 1);
      const canvas = await renderPageToCanvas(source, {
        scale: 2,
        // Obligatorio: rasterizado fuera de pantalla.
        intent: "print",
      });
      const result = await worker.recognize(canvas, {}, { text: true });
      canvas.width = 0;
      canvas.height = 0;
      source.cleanup();

      const recognized = normalizeExtractedText(result.data.text ?? "");
      if (recognized.length > 0) {
        pages[index] = { text: recognized, origin: "ocr" };
      }
      onProgress(0.5 + ((position + 1) / needsOcr.length) * 0.5);
    }

    return pages;
  } finally {
    if (worker) await worker.terminate();
    if (viewer) await closePdfDocument(viewer);
  }
}

export type TranslateRunResult = {
  blob: Blob;
  report: TranslationReportData;
};

/**
 * Motor completo: PDF -> texto -> traduccion local -> informe Markdown.
 *
 * Reparto del progreso: extraccion 0-0,20; carga/descarga del modelo
 * 0,20-0,55; traduccion 0,55-1. La descarga del modelo es la parte cara
 * la primera vez, por eso se lleva una franja propia y ancha.
 */
export async function translatePdfToReport(
  file: File,
  options: TranslateOptions = DEFAULT_TRANSLATE_OPTIONS,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<TranslateRunResult> {
  const pair = findPair(options.source, options.target);
  // Fallar cerrado: sin par soportado o sin consentimiento del modelo
  // EXACTO, no se descarga nada.
  if (!pair) throw new PdfError("nothingSelected");
  if (options.consentedModel !== pair.model) {
    throw new PdfError("consentRequired");
  }

  let translator: Awaited<ReturnType<typeof loadTranslator>> | null = null;

  try {
    throwIfAborted(signal);

    const pages = await extractPages(
      file,
      options,
      (fraction) => onProgress?.(scaleProgress(fraction, 0, 0.2)),
      signal,
    );

    const hasText = pages.some((page) => page.text.length > 0);
    if (!hasText) {
      // Documento sin capa de texto y sin OCR util. No hay nada que
      // traducir: se reutiliza `nothingSelected` ("marca algo antes de
      // procesar"), que es lo que el usuario tiene que hacer — activar
      // el respaldo de OCR — porque no podemos anadir codigos de error
      // nuevos sin tocar los diccionarios compartidos.
      throw new PdfError("nothingSelected");
    }

    throwIfAborted(signal);
    translator = await loadTranslator(pair.model, (fraction) =>
      onProgress?.(scaleProgress(fraction, 0.2, 0.55)),
    );

    // Trabajo total en fragmentos, para que la barra avance de forma
    // proporcional al coste real y no por paginas (una pagina densa
    // cuesta muchisimo mas que una portada).
    const chunksByPage = pages.map((page) => chunkText(page.text));
    const totalChunks = chunksByPage.reduce(
      (sum, chunks) => sum + chunks.length,
      0,
    );
    let doneChunks = 0;

    const translatedPages: TranslatedPage[] = [];

    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const chunks = chunksByPage[index];

      if (page.text.length === 0 || chunks.length === 0) {
        translatedPages.push({
          pageNumber: index + 1,
          original: "",
          translated: "",
          origin: "empty",
        });
        continue;
      }

      const parts: string[] = [];
      for (const chunk of chunks) {
        throwIfAborted(signal);
        const output = await translator.translate(chunk, {
          // Haz greedy: `num_beams: 4` del generation_config multiplica
          // por cuatro el coste en una CPU con WASM, y la ganancia de
          // calidad no compensa en un informe orientativo.
          num_beams: 1,
          do_sample: false,
          max_new_tokens: 512,
        });
        parts.push(output[0]?.translation_text?.trim() ?? "");
        doneChunks += 1;
        if (totalChunks > 0) {
          onProgress?.(scaleProgress(doneChunks / totalChunks, 0.55, 1));
        }
      }

      translatedPages.push({
        pageNumber: index + 1,
        original: page.text,
        translated: parts.filter((part) => part.length > 0).join(" "),
        origin: page.origin === "empty" ? "text" : page.origin,
      });
    }

    const report: TranslationReportData = {
      fileName: file.name,
      source: options.source,
      target: options.target,
      model: pair.model,
      pages: translatedPages,
      generatedAt: new Date(),
      reportLanguage: options.reportLanguage,
    };

    const blob = new Blob([formatReportMarkdown(report)], {
      type: "text/markdown;charset=utf-8",
    });
    onProgress?.(1);
    return { blob, report };
  } catch (error) {
    // DEBUG-TEMPORAL: quitar antes de cerrar la tarea.
    console.error("TRANSLATE_RAW_ERROR", error);
    throw toPdfError(error);
  } finally {
    if (translator) {
      try {
        await translator.dispose();
      } catch {
        // Liberar el pipeline es best-effort: no debe tapar el error real.
      }
    }
  }
}
