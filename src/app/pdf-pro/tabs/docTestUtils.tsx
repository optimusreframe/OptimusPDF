import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { LanguageProvider } from "@/lib/i18n";
import { createProWorkingDoc, type ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { ProWorkingDocProvider } from "@/app/pdf-pro/useProWorkingDoc";
import { makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";

/**
 * Utilidades SOLO PARA PRUEBAS de las herramientas de documento (U5): montan una pestaña dentro de un
 * documento de trabajo REAL (motores reales, sin pdf.js) y leen el resultado con pdf.js «legacy».
 */

export type MountedTab = ReturnType<typeof render> & { doc: ProWorkingDoc; original: Uint8Array };

export async function mountTab(
  ui: ReactNode,
  options: { pages?: number; name?: string; bytes?: Uint8Array; encrypted?: boolean; signatures?: "none" | "active" | "unknown" } = {},
): Promise<MountedTab> {
  const original = options.bytes ?? (await makePdfBytes(options.pages ?? 3));
  const doc = createProWorkingDoc({
    fingerprint: async () => "f".repeat(64),
    inspectSignatures: async () => options.signatures ?? "none",
  });
  const opened = await doc.open(pdfFile(original, options.name ?? "informe.pdf"), {
    ...(options.encrypted ? { encrypted: true } : {}),
  });
  if (!opened.ok) throw new Error(`no se pudo abrir: ${opened.code}`);
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc}>{ui}</ProWorkingDocProvider>
      </LanguageProvider>,
    );
  });
  return Object.assign(utils, { doc, original });
}

export const labelsOf = (doc: ProWorkingDoc): string[] =>
  doc.getState().document?.snapshots.slice(0, (doc.getState().document?.cursor ?? 0) + 1).map((snapshot) => snapshot.label) ?? [];

const FONTS = `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`;

/** Texto de cada pagina con pdf.js (build legacy, apto para Node). */
export async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS });
  const document = await task.promise;
  try {
    const out: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      out.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return out;
  } finally {
    await task.destroy();
  }
}

export async function infoOf(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const document = await task.promise;
  try {
    return (await document.getMetadata()).info as Record<string, unknown>;
  } finally {
    await task.destroy();
  }
}

export async function cropBoxes(bytes: Uint8Array): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.getPages().map((page) => page.getCropBox());
}

export async function rotations(bytes: Uint8Array): Promise<number[]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.getPages().map((page) => page.getRotation().angle);
}
