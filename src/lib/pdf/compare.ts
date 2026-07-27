import {
  PdfError,
  closePdfDocument,
  openPdfDocument,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de comparacion: extrae el texto de cada pagina con pdf.js y lo
 * enfrenta palabra a palabra con un LCS propio (sin dependencias
 * nuevas). El resultado se muestra en pantalla; no genera archivo.
 */

export type DiffOp = "equal" | "insert" | "delete";

export type DiffToken = {
  op: DiffOp;
  text: string;
};

export type ComparePage = {
  /** 1..max(paginasA, paginasB) */
  pageNumber: number;
  existsInA: boolean;
  existsInB: boolean;
  /** Version A: fragmentos iguales y eliminados. */
  left: DiffToken[];
  /** Version B: fragmentos iguales e insertados. */
  right: DiffToken[];
  added: number;
  removed: number;
  changed: boolean;
  /** El diff se degrado a bloque por tamano (ver LCS_CELL_LIMIT). */
  coarse: boolean;
};

export type CompareResult = {
  pages: ComparePage[];
  changedPages: number[];
  totalAdded: number;
  totalRemoved: number;
  pageCountA: number;
  pageCountB: number;
  /** Ninguno de los dos documentos tenia texto extraible. */
  noTextLayer: boolean;
};

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
 * Texto por pagina usando la misma configuracion de worker que el resto
 * del motor (`openPdfDocument` de core.ts).
 */
export async function extractPageTexts(
  file: File,
  onProgress?: ProgressCallback,
): Promise<string[]> {
  const document = await openPdfDocument(file);
  try {
    const texts: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : "";
      }
      page.cleanup();
      texts.push(text.replace(/\s+/g, " ").trim());
      onProgress?.(number / document.numPages);
    }
    return texts;
  } finally {
    await closePdfDocument(document);
  }
}

/* ------------------------------------------------------------------ *
 * Diff palabra a palabra (LCS)
 * ------------------------------------------------------------------ */

export function tokenizeWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * Tope de celdas de la tabla de programacion dinamica (~4M celdas =
 * 16 MB con Uint32Array). Por encima se marca el bloque entero como
 * cambiado en vez de bloquear la pestana.
 */
const LCS_CELL_LIMIT = 4_000_000;

type DiffResult = {
  left: DiffToken[];
  right: DiffToken[];
  added: number;
  removed: number;
  coarse: boolean;
};

function pushToken(list: DiffToken[], op: DiffOp, words: string[]): void {
  if (words.length === 0) return;
  const text = words.join(" ");
  const last = list[list.length - 1];
  if (last && last.op === op) {
    last.text = `${last.text} ${text}`;
    return;
  }
  list.push({ op, text });
}

export function diffWords(a: string[], b: string[]): DiffResult {
  // Prefijo y sufijo comunes: barato y decisivo en documentos casi iguales.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const prefix = a.slice(0, head);
  const suffix = a.slice(a.length - tail);
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const left: DiffToken[] = [];
  const right: DiffToken[] = [];
  pushToken(left, "equal", prefix);
  pushToken(right, "equal", prefix);

  let added = 0;
  let removed = 0;
  let coarse = false;

  if (midA.length === 0 || midB.length === 0) {
    pushToken(left, "delete", midA);
    pushToken(right, "insert", midB);
    removed += midA.length;
    added += midB.length;
  } else if ((midA.length + 1) * (midB.length + 1) > LCS_CELL_LIMIT) {
    coarse = true;
    pushToken(left, "delete", midA);
    pushToken(right, "insert", midB);
    removed += midA.length;
    added += midB.length;
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);

    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    let equalRun: string[] = [];
    let deleteRun: string[] = [];
    let insertRun: string[] = [];

    const flushChanges = () => {
      if (deleteRun.length > 0) {
        pushToken(left, "delete", deleteRun);
        removed += deleteRun.length;
        deleteRun = [];
      }
      if (insertRun.length > 0) {
        pushToken(right, "insert", insertRun);
        added += insertRun.length;
        insertRun = [];
      }
    };

    const flushEqual = () => {
      if (equalRun.length === 0) return;
      pushToken(left, "equal", equalRun);
      pushToken(right, "equal", equalRun);
      equalRun = [];
    };

    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        flushChanges();
        equalRun.push(midA[i]);
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        flushEqual();
        deleteRun.push(midA[i]);
        i += 1;
      } else {
        flushEqual();
        insertRun.push(midB[j]);
        j += 1;
      }
    }
    flushEqual();
    while (i < n) {
      deleteRun.push(midA[i]);
      i += 1;
    }
    while (j < m) {
      insertRun.push(midB[j]);
      j += 1;
    }
    flushChanges();
  }

  pushToken(left, "equal", suffix);
  pushToken(right, "equal", suffix);

  return { left, right, added, removed, coarse };
}

/* ------------------------------------------------------------------ *
 * Comparacion completa
 * ------------------------------------------------------------------ */

export async function comparePdfFiles(
  fileA: File,
  fileB: File,
  onProgress?: ProgressCallback,
): Promise<CompareResult> {
  try {
    const textsA = await extractPageTexts(fileA, (value) =>
      onProgress?.(value * 0.4),
    );
    const textsB = await extractPageTexts(fileB, (value) =>
      onProgress?.(0.4 + value * 0.4),
    );

    const total = Math.max(textsA.length, textsB.length);
    if (total === 0) throw new PdfError("corrupt");

    const pages: ComparePage[] = [];
    const changedPages: number[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (let index = 0; index < total; index += 1) {
      const rawA = textsA[index] ?? "";
      const rawB = textsB[index] ?? "";
      const diff = diffWords(tokenizeWords(rawA), tokenizeWords(rawB));
      const changed = diff.added > 0 || diff.removed > 0;

      pages.push({
        pageNumber: index + 1,
        existsInA: index < textsA.length,
        existsInB: index < textsB.length,
        left: diff.left,
        right: diff.right,
        added: diff.added,
        removed: diff.removed,
        changed,
        coarse: diff.coarse,
      });

      if (changed) changedPages.push(index + 1);
      totalAdded += diff.added;
      totalRemoved += diff.removed;
      onProgress?.(0.8 + ((index + 1) / total) * 0.2);
    }

    const noTextLayer =
      textsA.every((text) => text.length === 0) &&
      textsB.every((text) => text.length === 0);

    return {
      pages,
      changedPages,
      totalAdded,
      totalRemoved,
      pageCountA: textsA.length,
      pageCountB: textsB.length,
      noTextLayer,
    };
  } catch (error) {
    throw toPdfError(error);
  }
}
