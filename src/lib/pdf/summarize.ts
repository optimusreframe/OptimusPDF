import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  PdfError,
  closePdfDocument,
  openPdfDocument,
  renderPageToCanvas,
  throwIfAborted,
  toPdfError,
} from "@/lib/pdf/core";
import type { OcrLanguage } from "@/lib/pdf/ocr";

/**
 * Motor de resumen de PDF.
 *
 * ==================================================================
 * GARANTIA DE ALCANCE (leer antes de tocar este archivo)
 * ==================================================================
 * El resumen se genera con un modelo de lenguaje que se ejecuta DENTRO
 * del navegador, sobre WebGPU, via `@mlc-ai/web-llm`. No hay servicio en
 * la nube, ni clave de API, ni "modo degradado" que mande el documento a
 * ninguna parte: si el navegador no soporta WebGPU la herramienta se
 * niega a funcionar y lo dice (ver `detectWebGpuSupport`).
 *
 * La UNICA peticion de red de todo el flujo es la descarga de los pesos
 * del modelo (ficheros estaticos publicos en huggingface.co) y su
 * `.wasm` de MLC. Esa descarga:
 *   - solo ocurre tras un clic explicito del usuario (consentimiento),
 *   - no lleva ningun dato del documento,
 *   - queda en la Cache API del navegador para siguientes usos.
 * El texto extraido del PDF nunca se pasa a `fetch`, `XMLHttpRequest`,
 * `WebSocket`, `sendBeacon` ni a ninguna URL. Solo viaja a la memoria de
 * la pestana y al motor WebGPU local.
 *
 * ==================================================================
 * ESTRUCTURA
 * ==================================================================
 * 1. Registro de modelos y presupuesto de contexto  (puro)
 * 2. Preparacion de texto y troceado                 (puro, testeado)
 * 3. Construccion de prompts                         (puro, testeado)
 * 4. Render del documento de salida                  (puro, testeado)
 * 5. Capacidades del navegador                       (impuro, navegador)
 * 6. Extraccion de texto del PDF (pdf.js + OCR)      (impuro, navegador)
 * 7. Inferencia con WebLLM y orquestacion            (impuro, navegador)
 *
 * Las secciones 1-4 son funciones puras y son las que cubre
 * `summarize.test.ts`. Las secciones 5-7 necesitan WebGPU, canvas y una
 * descarga de cientos de megabytes: no se pueden ejecutar en Vitest bajo
 * `environment: "node"` (ver la cabecera del test).
 */

/* ------------------------------------------------------------------ *
 * 1. Modelos disponibles y presupuesto de contexto
 * ------------------------------------------------------------------ */

/**
 * Modelos elegidos de `prebuiltAppConfig.model_list` de web-llm 0.2.84.
 *
 * Criterio (documentado a proposito, porque condiciona todo lo demas):
 *
 * - Ambos son `q4f16_1`: cuantizacion de 4 bits con activaciones en
 *   fp16. Es la variante mas pequena que publica MLC para estos modelos
 *   y la unica que hace viable descargar un LLM en un navegador movil.
 *   A cambio EXIGE la caracteristica WebGPU `shader-f16`; sin ella el
 *   motor no arranca, por eso `detectWebGpuSupport` la comprueba antes
 *   de ofrecer nada.
 *
 * - `Llama-3.2-1B-Instruct-q4f16_1-MLC` es el modelo por defecto: es el
 *   instruct mas pequeno del catalogo que declara soporte oficial de
 *   espanol (Llama 3.2 se publica como multilingue) y cabe en ~0,9 GB de
 *   VRAM. Los modelos aun mas pequenos del catalogo (SmolLM2-135M/360M,
 *   Qwen2.5-0.5B) resumen visiblemente peor y tienden a inventar, que es
 *   justo lo que no queremos en un resumen.
 *
 * - `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` es la opcion "mejor calidad"
 *   para quien tenga memoria de sobra: ~150 MB mas de descarga y casi el
 *   doble de VRAM a cambio de resumenes mas fieles.
 *
 * `approxDownloadBytes` sale del tamano real de los ficheros publicados
 * en el repositorio de HuggingFace de cada modelo (suma de los blobs),
 * no de una estimacion: es la cifra que se le ensena al usuario antes de
 * pedirle permiso para descargar.
 *
 * `contextWindow` NO es la ventana nativa del modelo: es el
 * `overrides.context_window_size` que la propia `prebuiltAppConfig` de
 * web-llm aplica a estas entradas (4096 en las dos). Es el limite real
 * en tiempo de ejecucion y es el que manda para trocear.
 */
export type SummarizerModelKey = "llama-3.2-1b" | "qwen2.5-1.5b";

export type SummarizerModel = {
  key: SummarizerModelKey;
  /** `model_id` exacto de `prebuiltAppConfig`. */
  id: string;
  /** Suma real de los ficheros del repo del modelo. */
  approxDownloadBytes: number;
  /** `vram_required_MB` declarado por web-llm. */
  approxVramMb: number;
  /** `overrides.context_window_size` efectivo. */
  contextWindow: number;
};

export const SUMMARIZER_MODELS: Record<SummarizerModelKey, SummarizerModel> = {
  "llama-3.2-1b": {
    key: "llama-3.2-1b",
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    approxDownloadBytes: 710_000_000,
    approxVramMb: 879,
    contextWindow: 4096,
  },
  "qwen2.5-1.5b": {
    key: "qwen2.5-1.5b",
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    approxDownloadBytes: 880_000_000,
    approxVramMb: 1630,
    contextWindow: 4096,
  },
};

export const SUMMARIZER_MODEL_KEYS: readonly SummarizerModelKey[] = [
  "llama-3.2-1b",
  "qwen2.5-1.5b",
] as const;

export const DEFAULT_SUMMARIZER_MODEL: SummarizerModelKey = "llama-3.2-1b";

/**
 * Estimacion conservadora de caracteres por token.
 *
 * No hay tokenizador disponible antes de cargar el modelo (el
 * tokenizador viaja con los pesos), asi que se estima. 3 caracteres por
 * token INFRAVALORA a proposito la eficiencia real (ingles ~4, espanol
 * ~3,5): preferimos trozos algo mas cortos de la cuenta a que un prompt
 * desborde la ventana y el modelo se coma el principio del texto en
 * silencio.
 */
export const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export type ChunkBudget = {
  /** Ventana de contexto efectiva del modelo, en tokens. */
  contextTokens: number;
  /** Tokens que se reservan para la respuesta del modelo. */
  reservedOutputTokens: number;
  /** Tokens que ocupan las instrucciones fijas del prompt. */
  reservedPromptTokens: number;
  /** Colchon frente al error de la estimacion de tokens. */
  safetyTokens: number;
};

export const DEFAULT_CHUNK_BUDGET: ChunkBudget = {
  contextTokens: 4096,
  reservedOutputTokens: 384,
  reservedPromptTokens: 320,
  safetyTokens: 192,
};

/** Tokens de texto del documento que caben en un solo prompt. */
export function chunkTokenBudget(budget: ChunkBudget): number {
  const available =
    budget.contextTokens -
    budget.reservedOutputTokens -
    budget.reservedPromptTokens -
    budget.safetyTokens;
  // Nunca menos de 128 tokens: por debajo el troceado deja de tener
  // sentido y devolveria miles de trozos de una linea.
  return Math.max(128, available);
}

/** El mismo presupuesto expresado en caracteres. */
export function chunkCharBudget(budget: ChunkBudget): number {
  return chunkTokenBudget(budget) * CHARS_PER_TOKEN;
}

/**
 * Tope de trozos que se envian al modelo. Cada trozo cuesta decenas de
 * segundos en una GPU normal, asi que un documento de 400 paginas
 * tardaria horas. Se corta y se DICE que se ha cortado
 * (`SummaryResult.truncated`), nunca en silencio.
 */
export const MAX_CHUNKS = 24;

/* ------------------------------------------------------------------ *
 * 2. Preparacion de texto y troceado
 * ------------------------------------------------------------------ */

/** De donde salio el texto de una pagina. */
export type PageTextSource = "text" | "ocr" | "empty";

export type PageText = {
  /** 1..n, tal y como lo ve el usuario. */
  pageNumber: number;
  text: string;
  source: PageTextSource;
};

/** Caracteres invisibles que ensucian el conteo y no aportan nada. */
const INVISIBLE = new RegExp(
  "[\\u00ad\\u200b\\u200c\\u200d\\ufeff\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]",
  "g",
);

/** Guion de corte de palabra al final de linea: "in-\nforme" -> "informe". */
const LINE_HYPHEN = new RegExp("(\\p{L})-\\s*\\n\\s*(\\p{L})", "gu");

/**
 * Deja el texto crudo de una pagina en una sola linea limpia.
 *
 * pdf.js entrega fragmentos sueltos con saltos donde el PDF cambia de
 * linea, no donde termina la frase. Unir los guiones de corte antes de
 * colapsar el espacio evita que el modelo lea "in forme" como dos
 * palabras.
 */
export function normalizePageText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(LINE_HYPHEN, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** "p.3" o "p.3-5". Es la cita de pagina que se pide al modelo. */
export function formatPageRange(firstPage: number, lastPage: number): string {
  return firstPage === lastPage
    ? `p.${firstPage}`
    : `p.${firstPage}-${lastPage}`;
}

/** Marca que se antepone al texto de cada pagina dentro de un trozo. */
export function pageMarker(pageNumber: number): string {
  return `[p.${pageNumber}]`;
}

/** Reconoce `[p.4]` o `[p.4-6]` dentro del texto generado por el modelo. */
const PAGE_CITATION = /\[p\.(\d+)(?:-(\d+))?\]/g;

/**
 * Quita las citas de pagina que el modelo pudo inventar fuera del rango
 * real del documento (visto en pruebas: un modelo de 1B parametros puede
 * citar `[p.3]` en un documento de 2 paginas, extrapolando el patron
 * numerico de las citas legitimas en vez de razonar sobre el limite real).
 * No se corrige el numero -- inventar un reemplazo seria el mismo problema
 * con otro numero -- se quita la marca y se deja el resto de la frase.
 */
export function sanitizePageCitations(text: string, totalPages: number): string {
  if (totalPages <= 0) return text;
  return text
    .replace(PAGE_CITATION, (match, first: string, last?: string) => {
      const firstPage = Number(first);
      const lastPage = last ? Number(last) : firstPage;
      const inRange =
        firstPage >= 1 &&
        lastPage >= firstPage &&
        lastPage <= totalPages &&
        firstPage <= totalPages;
      return inRange ? match : "";
    })
    // La cita fuera de rango puede dejar un espacio doble o un espacio
    // antes de la puntuacion; se recorta sin tocar el resto del texto.
    .replace(/ {2,}/g, " ")
    .replace(/ ([.,;:])/g, "$1")
    .trim();
}

export type TextChunk = {
  /** Posicion del trozo en la secuencia, base 0. */
  index: number;
  firstPage: number;
  lastPage: number;
  /** Texto listo para el prompt, con las marcas `[p.N]` incrustadas. */
  text: string;
  estimatedTokens: number;
  /**
   * El trozo es un fragmento de una pagina que no cabia entera. Lo
   * senala la UI para no prometer que el resumen cubre la pagina
   * completa en un solo bloque.
   */
  partialPage: boolean;
};

/**
 * Parte un texto largo en segmentos que quepan en `maxChars`, cortando
 * por final de frase cuando se puede y por espacio en el peor caso.
 * Nunca corta a mitad de palabra.
 */
export function splitIntoSegments(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  if (text.length <= limit) return text.length > 0 ? [text] : [];

  const segments: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // 1) ultimo final de frase dentro de la ventana.
    let cut = -1;
    for (const match of window.matchAll(/[.!?…]["')\]]?\s/g)) {
      cut = match.index + match[0].length;
    }
    // 2) si no hay frase, ultimo espacio.
    if (cut <= 0) cut = window.lastIndexOf(" ") + 1;
    // 3) si tampoco hay espacio (palabra kilometrica), corte duro.
    if (cut <= 0) cut = limit;

    const piece = rest.slice(0, cut).trim();
    if (piece.length > 0) segments.push(piece);
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) segments.push(rest);
  return segments;
}

/**
 * Agrupa las paginas en trozos que quepan en la ventana del modelo.
 *
 * Reglas:
 *  - Las paginas sin texto no generan trozo (pero siguen contando para
 *    la numeracion: las citas usan el numero real de pagina).
 *  - Se empaquetan paginas consecutivas mientras quepan; el rango de
 *    paginas del trozo es el que luego se cita ("p.3-5: ...").
 *  - Una pagina que no cabe entera se parte por frases y cada fragmento
 *    es su propio trozo, marcado con `partialPage`.
 */
export function chunkPageTexts(
  pages: readonly PageText[],
  budget: ChunkBudget = DEFAULT_CHUNK_BUDGET,
): TextChunk[] {
  const maxChars = chunkCharBudget(budget);
  const chunks: TextChunk[] = [];

  let buffer = "";
  let firstPage = 0;
  let lastPage = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    chunks.push({
      index: chunks.length,
      firstPage,
      lastPage,
      text: buffer,
      estimatedTokens: estimateTokens(buffer),
      partialPage: false,
    });
    buffer = "";
  };

  for (const page of pages) {
    const text = page.text.trim();
    if (text.length === 0) continue;

    const marker = pageMarker(page.pageNumber);
    const block = `${marker} ${text}`;

    if (block.length > maxChars) {
      // La pagina sola ya desborda: se cierra lo acumulado y se parte.
      flush();
      const room = Math.max(1, maxChars - marker.length - 1);
      for (const segment of splitIntoSegments(text, room)) {
        chunks.push({
          index: chunks.length,
          firstPage: page.pageNumber,
          lastPage: page.pageNumber,
          text: `${marker} ${segment}`,
          estimatedTokens: estimateTokens(`${marker} ${segment}`),
          partialPage: true,
        });
      }
      continue;
    }

    const candidate = buffer.length === 0 ? block : `${buffer}\n${block}`;
    if (candidate.length > maxChars) {
      flush();
      buffer = block;
      firstPage = page.pageNumber;
      lastPage = page.pageNumber;
    } else {
      if (buffer.length === 0) firstPage = page.pageNumber;
      buffer = candidate;
      lastPage = page.pageNumber;
    }
  }

  flush();
  return chunks;
}

/* ------------------------------------------------------------------ *
 * 3. Construccion de prompts
 * ------------------------------------------------------------------ */

export type SummaryLanguage = "es" | "en";

export type SummaryLength = "short" | "medium";

export type Prompt = {
  system: string;
  user: string;
};

/**
 * Numero de frases que se pide por trozo. No es una garantia: un modelo
 * de 1B obedece "mas o menos", y por eso la UI nunca promete longitud.
 */
const CHUNK_SENTENCES: Record<SummaryLength, number> = {
  short: 2,
  medium: 4,
};

const FINAL_SENTENCES: Record<SummaryLength, number> = {
  short: 4,
  medium: 8,
};

const SYSTEM_BY_LANGUAGE: Record<SummaryLanguage, string> = {
  es:
    "Eres un asistente que resume documentos. Resume UNICAMENTE con la " +
    "informacion del fragmento que recibes. No inventes datos, cifras ni " +
    "nombres que no aparezcan. Si el fragmento no dice algo, no lo digas. " +
    "Responde siempre en espanol.",
  en:
    "You are an assistant that summarises documents. Summarise ONLY with " +
    "the information in the excerpt you receive. Do not invent facts, " +
    "figures or names that are not there. If the excerpt does not say " +
    "something, do not say it. Always answer in English.",
};

/**
 * Prompt de un trozo. El texto llega con marcas `[p.N]` para que el
 * modelo pueda citar la pagina; se le pide explicitamente que las use.
 */
export function buildChunkPrompt(
  chunk: TextChunk,
  options: { language: SummaryLanguage; length: SummaryLength },
): Prompt {
  const sentences = CHUNK_SENTENCES[options.length];
  const range = formatPageRange(chunk.firstPage, chunk.lastPage);

  const instruction =
    options.language === "es"
      ? [
          `Fragmento del documento (${range}). Cada bloque empieza con la`,
          "marca de su pagina, por ejemplo [p.4].",
          "",
          "---",
          chunk.text,
          "---",
          "",
          `Resume el fragmento en ${sentences} frases como maximo.`,
          "Condensa con tus palabras: no copies frases literales del",
          "fragmento. Cita la pagina entre parentesis cuando afirmes algo",
          "concreto, con el formato (p.4). No anadas titulo ni preambulo:",
          "escribe solo el resumen.",
        ].join("\n")
      : [
          `Document excerpt (${range}). Each block starts with its page`,
          "marker, for example [p.4].",
          "",
          "---",
          chunk.text,
          "---",
          "",
          `Summarise the excerpt in at most ${sentences} sentences.`,
          "Condense in your own words: do not copy sentences verbatim",
          "from the excerpt. Cite the page in brackets when you state",
          "something concrete, using the format (p.4). Do not add a title",
          "or preamble: write the summary only.",
        ].join("\n");

  return { system: SYSTEM_BY_LANGUAGE[options.language], user: instruction };
}

export type ChunkSummary = {
  firstPage: number;
  lastPage: number;
  text: string;
  partialPage: boolean;
};

/** Una linea de resumen parcial tal y como entra en la sintesis. */
export function renderChunkSummaryLine(summary: ChunkSummary): string {
  return `${formatPageRange(summary.firstPage, summary.lastPage)}: ${summary.text.trim()}`;
}

/**
 * Reparte los resumenes parciales en grupos que quepan en un prompt de
 * sintesis. Con documentos cortos devuelve un solo grupo; con muchos
 * trozos, el orquestador reduce por rondas hasta que quede uno.
 */
export function groupSummariesForSynthesis(
  summaries: readonly ChunkSummary[],
  budget: ChunkBudget = DEFAULT_CHUNK_BUDGET,
): ChunkSummary[][] {
  const maxChars = chunkCharBudget(budget);
  const groups: ChunkSummary[][] = [];
  let current: ChunkSummary[] = [];
  let size = 0;

  for (const summary of summaries) {
    const line = renderChunkSummaryLine(summary);
    const cost = line.length + 1;
    // Un resumen suelto que ya desborda entra solo en su grupo: partirlo
    // aqui perderia la correspondencia con su rango de paginas.
    if (current.length > 0 && size + cost > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(summary);
    size += cost;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

/** Prompt de sintesis: combina resumenes parciales en uno coherente. */
export function buildSynthesisPrompt(
  summaries: readonly ChunkSummary[],
  options: {
    language: SummaryLanguage;
    length: SummaryLength;
    /** Ronda intermedia de reduccion, no el resumen final. */
    intermediate?: boolean;
  },
): Prompt {
  const sentences = options.intermediate
    ? CHUNK_SENTENCES[options.length] * 2
    : FINAL_SENTENCES[options.length];
  const body = summaries.map(renderChunkSummaryLine).join("\n");

  const instruction =
    options.language === "es"
      ? [
          "Resumenes parciales de un mismo documento, en orden, cada uno",
          "precedido por sus paginas:",
          "",
          "---",
          body,
          "---",
          "",
          `Escribe un unico resumen coherente de ${sentences} frases como`,
          "maximo que cubra todo el documento. Manten las citas de pagina",
          "con el formato (p.4) o (p.4-6) cuando afirmes algo concreto. No",
          "repitas la misma idea dos veces. No anadas informacion que no",
          "este en los resumenes parciales.",
        ].join("\n")
      : [
          "Partial summaries of one document, in order, each preceded by",
          "its pages:",
          "",
          "---",
          body,
          "---",
          "",
          `Write a single coherent summary of at most ${sentences}`,
          "sentences covering the whole document. Keep page citations in",
          "the format (p.4) or (p.4-6) when stating something concrete. Do",
          "not repeat the same idea twice. Do not add information that is",
          "not in the partial summaries.",
        ].join("\n");

  return { system: SYSTEM_BY_LANGUAGE[options.language], user: instruction };
}

/**
 * Limpia la salida del modelo: quita preambulos tipicos ("Claro, aqui
 * tienes...") y comillas envolventes. Un modelo de 1B los cuela a
 * menudo y ensucian el resumen.
 */
export function cleanModelOutput(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "");
  text = text.replace(
    /^(claro|por supuesto|sure|certainly|of course)[,:!.]*\s*/i,
    "",
  );
  text = text.replace(
    /^(aqu[ií] (?:tienes|est[aá])|here (?:is|are))[^:\n]{0,40}:\s*/i,
    "",
  );
  text = text.replace(/^(resumen|summary)\s*:\s*/i, "");
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  return text.trim();
}

/**
 * Recorta hasta la ultima frase COMPLETA.
 *
 * Se usa cuando el modelo se queda sin presupuesto de tokens a mitad de
 * frase: dejar "...revisiones ligeras cada 10.000" en pantalla parece un
 * fallo de la herramienta y ademas invita a leer un dato cortado como si
 * estuviera completo. Si al recortar quedaria menos del 40% del texto se
 * devuelve el original: mejor una frase inacabada que perder el resumen.
 */
export function trimToLastSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";

  let cut = -1;
  for (const match of trimmed.matchAll(/[.!?…]["')\]]?(\s|$)/g)) {
    cut = match.index + match[0].trimEnd().length;
  }
  if (cut <= 0) return trimmed;
  if (cut >= trimmed.length) return trimmed;
  if (cut < trimmed.length * 0.4) return trimmed;
  return trimmed.slice(0, cut).trim();
}

/* ------------------------------------------------------------------ *
 * 4. Resultado y documento descargable
 * ------------------------------------------------------------------ */

export type SummaryResult = {
  /** Resumen final combinado. */
  overview: string;
  /** Resumenes por trozo, en orden, con su rango de paginas. */
  sections: ChunkSummary[];
  pageCount: number;
  /** Paginas cuyo texto salio de OCR (menos fiable). */
  ocrPages: number[];
  /** Paginas sin texto legible ni siquiera tras OCR. */
  emptyPages: number[];
  /** `model_id` que genero el resumen. */
  modelId: string;
  /** Se alcanzo `MAX_CHUNKS` y el resumen no cubre todo el documento. */
  truncated: boolean;
  /** Ultima pagina realmente resumida cuando `truncated`. */
  coveredUpToPage: number;
};

export type SummaryDocumentLabels = {
  title: string;
  aiWarning: string;
  overviewTitle: string;
  sectionsTitle: string;
  modelLine: (modelId: string) => string;
  truncatedLine: (page: number) => string;
  ocrLine: (pages: string) => string;
};

/**
 * Texto plano descargable. Incluye SIEMPRE el aviso de que lo ha escrito
 * una IA local y puede equivocarse: el fichero sale del navegador y se
 * reenvia sin el contexto de la interfaz.
 */
export function renderSummaryDocument(
  result: SummaryResult,
  labels: SummaryDocumentLabels,
): string {
  const lines: string[] = [];
  lines.push(labels.title);
  lines.push("=".repeat(labels.title.length));
  lines.push("");
  lines.push(labels.aiWarning);
  lines.push(labels.modelLine(result.modelId));
  if (result.truncated) lines.push(labels.truncatedLine(result.coveredUpToPage));
  if (result.ocrPages.length > 0) {
    lines.push(labels.ocrLine(result.ocrPages.join(", ")));
  }
  lines.push("");
  lines.push(labels.overviewTitle);
  lines.push("");
  lines.push(result.overview);
  lines.push("");
  lines.push(labels.sectionsTitle);
  lines.push("");
  for (const section of result.sections) {
    lines.push(
      `${formatPageRange(section.firstPage, section.lastPage)}: ${section.text}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ *
 * 5. Capacidades del navegador (impuro)
 * ------------------------------------------------------------------ */

/**
 * Por que se comprueba a mano y no con `@webgpu/types`: anadir esa
 * dependencia solo por tipar `navigator.gpu` no compensa. Se declara
 * aqui la forma minima que se usa.
 */
type MinimalGpuAdapter = { features: { has: (name: string) => boolean } };
type MinimalGpu = {
  requestAdapter: (options?: {
    powerPreference?: string;
  }) => Promise<MinimalGpuAdapter | null>;
};

export type WebGpuStatus =
  /** Aun comprobando. */
  | "checking"
  /** WebGPU disponible y con `shader-f16`: se puede ofrecer la herramienta. */
  | "ready"
  /** El navegador no expone `navigator.gpu`. */
  | "noApi"
  /** Hay API pero ninguna GPU utilizable (driver bloqueado, VM...). */
  | "noAdapter"
  /** Hay GPU pero sin `shader-f16`: los modelos q4f16_1 no arrancan. */
  | "noF16"
  /** La comprobacion fallo por una excepcion inesperada. */
  | "error";

/**
 * Comprueba si el navegador puede ejecutar los modelos de esta
 * herramienta. Pedir un adaptador NO descarga nada ni requiere permiso:
 * es una consulta local al driver.
 */
export async function detectWebGpuSupport(): Promise<WebGpuStatus> {
  try {
    if (typeof navigator === "undefined") return "noApi";
    const gpu = (navigator as unknown as { gpu?: MinimalGpu }).gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") return "noApi";

    const adapter = await gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) return "noAdapter";
    if (!adapter.features.has("shader-f16")) return "noF16";
    return "ready";
  } catch {
    return "error";
  }
}

/** ¿Estan ya los pesos en la cache del navegador? Decide el copy del consentimiento. */
export async function isModelCached(model: SummarizerModel): Promise<boolean> {
  try {
    const webllm = await import("@mlc-ai/web-llm");
    return await webllm.hasModelInCache(model.id, webllm.prebuiltAppConfig);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 6. Extraccion de texto del PDF (impuro)
 * ------------------------------------------------------------------ */

export type SummarizerStage =
  | "extracting"
  | "ocr"
  | "loadingModel"
  | "summarizing"
  | "synthesizing";

export type SummarizerProgress = {
  stage: SummarizerStage;
  /** 0..1 dentro de la etapa. */
  progress: number;
  /** Texto libre del motor (mensaje de carga de WebLLM, pagina en curso...). */
  detail?: string;
  step?: number;
  stepCount?: number;
};

export type SummarizerReporter = (progress: SummarizerProgress) => void;

/**
 * Por debajo de estos caracteres se considera que la pagina no tiene
 * capa de texto util (portadas escaneadas, paginas de solo imagen) y se
 * intenta OCR.
 */
const MIN_TEXT_CHARS_PER_PAGE = 24;

const OCR_SCALE = 2;
const MAX_RASTER_SIDE = 4000;

type TextLikeItem = { str: string; hasEOL?: boolean };

function isTextItem(item: unknown): item is TextLikeItem {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { str?: unknown }).str === "string"
  );
}

export type ExtractOptions = {
  /** Intentar OCR en las paginas sin capa de texto. */
  ocrFallback: boolean;
  ocrLanguage: OcrLanguage;
};

/**
 * Texto por pagina con reserva de OCR.
 *
 * Sigue el patron ya establecido en `lib/pdf/ocr.ts`: pdf.js rasteriza
 * con `intent: "print"` (obligatorio fuera de pantalla) y tesseract.js
 * se carga con `import()` dinamico y SOLO si alguna pagina lo necesita,
 * para no descargar megabytes de WebAssembly por nada.
 */
export async function extractDocumentText(
  file: File,
  options: ExtractOptions,
  report?: SummarizerReporter,
  signal?: AbortSignal,
): Promise<PageText[]> {
  let viewer: PDFDocumentProxy | null = null;
  let worker: Awaited<
    ReturnType<typeof import("tesseract.js").createWorker>
  > | null = null;

  try {
    viewer = await openPdfDocument(file);
    const total = viewer.numPages;
    if (total === 0) throw new PdfError("corrupt");

    const pages: PageText[] = [];

    for (let number = 1; number <= total; number += 1) {
      throwIfAborted(signal);

      const page = await viewer.getPage(number);
      const content = await page.getTextContent();
      let raw = "";
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        raw += item.str;
        raw += item.hasEOL ? "\n" : "";
      }
      const text = normalizePageText(raw);

      if (text.length >= MIN_TEXT_CHARS_PER_PAGE || !options.ocrFallback) {
        page.cleanup();
        pages.push({
          pageNumber: number,
          text,
          source: text.length > 0 ? "text" : "empty",
        });
        report?.({ stage: "extracting", progress: number / total });
        continue;
      }

      // Reserva OCR: solo para paginas sin capa de texto util.
      report?.({
        stage: "ocr",
        progress: number / total,
        step: number,
        stepCount: total,
      });

      if (!worker) {
        const tesseract = await import("tesseract.js");
        worker = await tesseract.createWorker(
          options.ocrLanguage,
          tesseract.OEM.LSTM_ONLY,
        );
      }

      const base = page.getViewport({ scale: 1 });
      const longest = Math.max(base.width, base.height, 1);
      const scale = Math.max(
        0.1,
        Math.min(OCR_SCALE, MAX_RASTER_SIDE / longest),
      );
      const canvas = await renderPageToCanvas(page, { scale, intent: "print" });
      page.cleanup();

      const recognised = await worker.recognize(canvas, {}, { text: true });
      canvas.width = 0;
      canvas.height = 0;

      const ocrText = normalizePageText(recognised.data.text ?? "");
      pages.push({
        pageNumber: number,
        text: ocrText,
        source: ocrText.length > 0 ? "ocr" : "empty",
      });
      report?.({ stage: "extracting", progress: number / total });
    }

    return pages;
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (worker) await worker.terminate();
    if (viewer) await closePdfDocument(viewer);
  }
}

/* ------------------------------------------------------------------ *
 * 7. Inferencia local con WebLLM y orquestacion (impuro)
 * ------------------------------------------------------------------ */

export type SummarizeOptions = {
  model: SummarizerModelKey;
  language: SummaryLanguage;
  length: SummaryLength;
  ocrFallback: boolean;
  ocrLanguage: OcrLanguage;
};

export const DEFAULT_SUMMARIZE_OPTIONS: SummarizeOptions = {
  model: DEFAULT_SUMMARIZER_MODEL,
  language: "es",
  length: "medium",
  ocrFallback: true,
  ocrLanguage: "spa",
};

type EngineLike = {
  chat: {
    completions: {
      create: (request: {
        messages: Array<{ role: "system" | "user"; content: string }>;
        temperature?: number;
        max_tokens?: number;
        stream?: false;
      }) => Promise<{
        choices: Array<{
          message: { content?: string | null };
          finish_reason?: string | null;
        }>;
      }>;
    };
  };
  unload: () => Promise<void>;
};

/**
 * Carga el modelo en la GPU. Aqui y solo aqui ocurre la unica peticion
 * de red del flujo: los pesos del modelo. El documento del usuario no ha
 * entrado todavia en juego.
 */
async function loadEngine(
  model: SummarizerModel,
  report?: SummarizerReporter,
): Promise<EngineLike> {
  const webllm = await import("@mlc-ai/web-llm");
  const engine = await webllm.CreateMLCEngine(
    model.id,
    {
      initProgressCallback: (progressReport) => {
        report?.({
          stage: "loadingModel",
          progress: progressReport.progress,
          detail: progressReport.text,
        });
      },
    },
    { context_window_size: model.contextWindow },
  );
  return engine as unknown as EngineLike;
}

async function complete(
  engine: EngineLike,
  prompt: Prompt,
  maxTokens: number,
): Promise<string> {
  const response = await engine.chat.completions.create({
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    // Baja a proposito: en un resumen queremos fidelidad, no creatividad.
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false,
  });
  const choice = response.choices[0];
  const text = cleanModelOutput(choice?.message?.content ?? "");
  // "length" = el modelo se quedo sin presupuesto, no es que hubiera
  // terminado. En ese caso la ultima frase esta cortada a medias.
  return choice?.finish_reason === "length" ? trimToLastSentence(text) : text;
}

/**
 * Flujo completo: extraer -> trocear -> resumir cada trozo -> sintetizar.
 *
 * El texto del documento solo se pasa a `engine.chat.completions.create`,
 * que ejecuta el modelo en la GPU local. No hay ninguna otra salida.
 */
export async function summarizePdf(
  file: File,
  options: SummarizeOptions,
  report?: SummarizerReporter,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const model = SUMMARIZER_MODELS[options.model];
  const budget: ChunkBudget = {
    ...DEFAULT_CHUNK_BUDGET,
    contextTokens: model.contextWindow,
  };

  const pages = await extractDocumentText(
    file,
    { ocrFallback: options.ocrFallback, ocrLanguage: options.ocrLanguage },
    report,
    signal,
  );
  throwIfAborted(signal);

  const allChunks = chunkPageTexts(pages, budget);
  if (allChunks.length === 0) {
    // Ni capa de texto ni OCR util: no hay nada que resumir y se dice.
    throw new PdfError("corrupt", "no extractable text");
  }

  const chunks = allChunks.slice(0, MAX_CHUNKS);
  const truncated = allChunks.length > chunks.length;

  let engine: EngineLike | null = null;
  try {
    engine = await loadEngine(model, report);
    throwIfAborted(signal);

    const sections: ChunkSummary[] = [];
    for (const chunk of chunks) {
      throwIfAborted(signal);
      report?.({
        stage: "summarizing",
        progress: chunk.index / chunks.length,
        step: chunk.index + 1,
        stepCount: chunks.length,
      });
      const rawText = await complete(
        engine,
        buildChunkPrompt(chunk, {
          language: options.language,
          length: options.length,
        }),
        budget.reservedOutputTokens,
      );
      // El modelo cita paginas por convencion aprendida, no por indice real:
      // puede extrapolar mas alla del ultimo numero que de verdad vio.
      const text = sanitizePageCitations(rawText, pages.length);
      // Un trozo del que el modelo no saca nada no genera seccion: mejor
      // una seccion menos que una cita de pagina vacia.
      if (text.length === 0) continue;
      sections.push({
        firstPage: chunk.firstPage,
        lastPage: chunk.lastPage,
        text,
        partialPage: chunk.partialPage,
      });
    }

    // Sintesis por rondas: mientras los resumenes parciales no quepan en
    // un solo prompt, se reducen por grupos.
    let current = sections;
    if (current.length === 0) {
      throw new PdfError("unknown", "model returned empty summaries");
    }

    let round = 0;
    while (current.length > 1) {
      throwIfAborted(signal);
      const groups = groupSummariesForSynthesis(current, budget);
      const last = groups.length === 1;
      report?.({
        stage: "synthesizing",
        progress: last ? 0.75 : Math.min(0.7, 0.2 + round * 0.15),
        step: round + 1,
      });

      const next: ChunkSummary[] = [];
      for (const group of groups) {
        throwIfAborted(signal);
        const rawText = await complete(
          engine,
          buildSynthesisPrompt(group, {
            language: options.language,
            length: options.length,
            intermediate: !last,
          }),
          budget.reservedOutputTokens,
        );
        const text = sanitizePageCitations(rawText, pages.length);
        next.push({
          firstPage: group[0].firstPage,
          lastPage: group[group.length - 1].lastPage,
          text,
          partialPage: false,
        });
      }

      // Salvaguarda: si una ronda no reduce, se corta para no dar vueltas.
      if (next.length >= current.length) {
        current = [next[0]];
        break;
      }
      current = next;
      round += 1;
    }

    report?.({ stage: "synthesizing", progress: 1 });

    return {
      overview: current[0].text,
      sections,
      pageCount: pages.length,
      ocrPages: pages
        .filter((page) => page.source === "ocr")
        .map((page) => page.pageNumber),
      emptyPages: pages
        .filter((page) => page.source === "empty")
        .map((page) => page.pageNumber),
      modelId: model.id,
      truncated,
      coveredUpToPage: chunks[chunks.length - 1].lastPage,
    };
  } catch (error) {
    throw toPdfError(error);
  } finally {
    if (engine) {
      try {
        await engine.unload();
      } catch {
        // Descargar el modelo de la GPU es best-effort.
      }
    }
  }
}
