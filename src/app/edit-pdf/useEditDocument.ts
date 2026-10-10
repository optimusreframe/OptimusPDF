"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  closePdfDocument,
  openPdfDocument,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import { analyzeDocPageText, type PageTextAnalysis } from "@/lib/pdf/textBlocks";

/**
 * Documento de pdf.js y analisis de texto por pagina del editor inline (U4a).
 *
 * - UN `PDFDocumentProxy` por archivo y sesion: lo comparten el render de la
 *   hoja y la extraccion de bloques; se cierra al desmontar o cambiar de archivo.
 * - La extraccion es PEREZOSA (solo la pagina visible) y se guarda por pagina:
 *   volver a una pagina ya analizada es inmediato. Al cambiar de pagina antes de
 *   empezar, la analisis pendiente se cancela (pdf.js no permite abortar una ya
 *   iniciada, pero su resultado se guarda igualmente para cuando se vuelva).
 */

export type EditDocumentState = {
  doc: PDFDocumentProxy | null;
  pageCount: number;
  error: PdfErrorCode | null;
};

type Loaded = {
  file: File;
  doc: PDFDocumentProxy | null;
  error: PdfErrorCode | null;
};

export function useEditDocument(file: File | null): EditDocumentState {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const doc = await openPdfDocument(file);
        if (cancelled) {
          void closePdfDocument(doc);
          return;
        }
        opened = doc;
        setLoaded({ file, doc, error: null });
      } catch (error) {
        if (!cancelled) setLoaded({ file, doc: null, error: toPdfError(error).code });
      }
    })();
    return () => {
      cancelled = true;
      if (opened) void closePdfDocument(opened);
    };
  }, [file]);

  const current = loaded && loaded.file === file ? loaded : null;
  return {
    doc: current?.doc ?? null,
    pageCount: current?.doc?.numPages ?? 0,
    error: current?.error ?? null,
  };
}

export type PageTextStatus = "idle" | "analyzing" | "ready";

export type PageTextState = {
  status: PageTextStatus;
  analysis: PageTextAnalysis | null;
};

type Analyses = { doc: PDFDocumentProxy; byPage: Record<number, PageTextAnalysis> };

/** Retardo antes de analizar: pasar rapido por paginas no analiza las intermedias. */
const ANALYZE_DEBOUNCE_MS = 40;

export function usePageText(
  doc: PDFDocumentProxy | null,
  pageIndex: number,
  analyze: typeof analyzeDocPageText = analyzeDocPageText,
): PageTextState {
  const [analyses, setAnalyses] = useState<Analyses | null>(null);
  const analyzeRef = useRef(analyze);
  useEffect(() => {
    analyzeRef.current = analyze;
  });

  const ownAnalyses = analyses && analyses.doc === doc ? analyses : null;
  const analysis = ownAnalyses?.byPage[pageIndex] ?? null;
  const needed = doc !== null && analysis === null;

  useEffect(() => {
    if (!needed || !doc) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        const result = await analyzeRef.current(doc, pageIndex);
        // Se guarda aunque se haya cambiado de pagina (cache), nunca de otro documento.
        setAnalyses((previous) => ({
          doc,
          byPage: { ...(previous && previous.doc === doc ? previous.byPage : {}), [pageIndex]: result },
        }));
      })();
    }, ANALYZE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [needed, doc, pageIndex]);

  if (!doc) return { status: "idle", analysis: null };
  return analysis ? { status: "ready", analysis } : { status: "analyzing", analysis: null };
}
