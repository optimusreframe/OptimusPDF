import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { LanguageProvider } from "@/lib/i18n";
import { loadPdf } from "@/lib/pdf/core";
import { createInputGuard, type InputGuard } from "@/lib/pdf/inputGuard";
import { ProWorkingDocProvider } from "@/app/pdf-pro/useProWorkingDoc";
import { createProWorkingDoc, type ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { makeRichPdf } from "@/lib/pdf/testing/pageAssemblyFixtures";

/**
 * Utilidades SOLO PARA PRUEBAS del organizador de paginas: un documento de trabajo con PDF reales
 * (pdf-lib en Node), sin huella ni firmas, y el arbol de proveedores minimo.
 */

export function pdfFileOf(bytes: Uint8Array, name = "informe.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

export async function openRichDoc(
  options: Parameters<typeof makeRichPdf>[0] = { pages: 5 },
  name = "informe.pdf",
): Promise<{ doc: ProWorkingDoc; bytes: Uint8Array }> {
  const bytes = await makeRichPdf(options);
  const doc = createProWorkingDoc({
    fingerprint: async () => null,
    inspectSignatures: async () => "none",
  });
  const result = await doc.open(pdfFileOf(bytes, name));
  if (!result.ok) throw new Error(`no se pudo abrir: ${result.code}`);
  return { doc, bytes };
}

export function withProviders(doc: ProWorkingDoc, ui: ReactNode, guard?: InputGuard | null) {
  const tree = (
    <LanguageProvider>
      <ProWorkingDocProvider doc={doc}>{ui}</ProWorkingDocProvider>
    </LanguageProvider>
  );
  return guard === undefined ? tree : <InputGuardContext.Provider value={guard}>{tree}</InputGuardContext.Provider>;
}

export function renderWithDoc(doc: ProWorkingDoc, ui: ReactNode, guard?: InputGuard | null) {
  return render(withProviders(doc, ui, guard));
}

/** Comprobacion de entrada para pruebas: abre con pdf-lib (no hay pdf.js en jsdom) y descifra con el motor real. */
export function testInputGuard(): InputGuard {
  return createInputGuard({
    open: async (file) => {
      await loadPdf(file);
    },
  });
}

/** Miniaturas falsas: `openPdfDocument` devuelve un documento con `numPages` y `renderPageToDataUrl` una data URL por pagina. */
export function fakePdfJs(): { restore: () => void } {
  return { restore: () => vi.restoreAllMocks() };
}
