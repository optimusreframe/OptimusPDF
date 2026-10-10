import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfError } from "@/lib/pdf/core";
import { useEditDocument, usePageText } from "@/app/edit-pdf/useEditDocument";
import type { PageTextAnalysis } from "@/lib/pdf/textBlocks";
import { makeBlock } from "@/app/edit-pdf/editTestUtils";

const open = vi.fn();
const close = vi.fn();

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: (...args: unknown[]) => open(...args),
    closePdfDocument: (...args: unknown[]) => close(...args),
  };
});

function fakeDoc(pages = 3): PDFDocumentProxy {
  return { numPages: pages } as unknown as PDFDocumentProxy;
}

const FILE_A = new File(["a"], "a.pdf", { type: "application/pdf" });
const FILE_B = new File(["b"], "b.pdf", { type: "application/pdf" });

beforeEach(() => {
  open.mockReset();
  close.mockReset();
});

describe("useEditDocument", () => {
  it("abre UN documento por archivo y expone el numero de paginas", async () => {
    const doc = fakeDoc(5);
    open.mockResolvedValue(doc);
    const { result } = renderHook(() => useEditDocument(FILE_A));
    expect(result.current.doc).toBeNull();
    await waitFor(() => expect(result.current.doc).toBe(doc));
    expect(result.current.pageCount).toBe(5);
    expect(result.current.error).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(FILE_A);
  });

  it("cierra el documento al desmontar", async () => {
    const doc = fakeDoc();
    open.mockResolvedValue(doc);
    const { result, unmount } = renderHook(() => useEditDocument(FILE_A));
    await waitFor(() => expect(result.current.doc).toBe(doc));
    unmount();
    expect(close).toHaveBeenCalledWith(doc);
  });

  it("al cambiar de archivo cierra el anterior y no muestra el documento viejo", async () => {
    const docA = fakeDoc(2);
    const docB = fakeDoc(7);
    open.mockResolvedValueOnce(docA).mockResolvedValueOnce(docB);
    const { result, rerender } = renderHook(({ file }) => useEditDocument(file), {
      initialProps: { file: FILE_A },
    });
    await waitFor(() => expect(result.current.doc).toBe(docA));
    rerender({ file: FILE_B });
    expect(result.current.doc).toBeNull();
    expect(close).toHaveBeenCalledWith(docA);
    await waitFor(() => expect(result.current.doc).toBe(docB));
    expect(result.current.pageCount).toBe(7);
  });

  it("un documento que llega tarde (archivo ya cambiado) se cierra y no se usa", async () => {
    let resolveA: (doc: PDFDocumentProxy) => void = () => undefined;
    const docA = fakeDoc(1);
    const docB = fakeDoc(2);
    open
      .mockImplementationOnce(() => new Promise((resolve) => (resolveA = resolve)))
      .mockResolvedValueOnce(docB);
    const { result, rerender } = renderHook(({ file }) => useEditDocument(file), {
      initialProps: { file: FILE_A },
    });
    rerender({ file: FILE_B });
    await waitFor(() => expect(result.current.doc).toBe(docB));
    await act(async () => resolveA(docA));
    expect(close).toHaveBeenCalledWith(docA);
    expect(result.current.doc).toBe(docB);
  });

  it("un archivo ilegible da su codigo de error y ningun documento", async () => {
    open.mockRejectedValue(new PdfError("encrypted"));
    const { result } = renderHook(() => useEditDocument(FILE_A));
    await waitFor(() => expect(result.current.error).toBe("encrypted"));
    expect(result.current.doc).toBeNull();
  });

  it("sin archivo no abre nada", () => {
    const { result } = renderHook(() => useEditDocument(null));
    expect(open).not.toHaveBeenCalled();
    expect(result.current).toEqual({ doc: null, pageCount: 0, error: null });
  });
});

function analysis(text: string, extra: Partial<PageTextAnalysis> = {}): PageTextAnalysis {
  return {
    blocks: [makeBlock("b", { text })],
    hiddenCount: 0,
    hasTextLayer: true,
    failed: false,
    ...extra,
  };
}

describe("usePageText", () => {
  it("analiza PEREZOSAMENTE solo la pagina visible y mientras tanto esta 'analyzing'", async () => {
    const doc = fakeDoc();
    const analyze = vi.fn(async (_doc: PDFDocumentProxy, page: number) => analysis(`p${page}`));
    const { result } = renderHook(() => usePageText(doc, 1, analyze));
    expect(result.current.status).toBe("analyzing");
    expect(result.current.analysis).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.analysis?.blocks[0].text).toBe("p1");
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][1]).toBe(1);
  });

  it("volver a una pagina ya analizada es inmediato (cache) y no vuelve a analizar", async () => {
    const doc = fakeDoc();
    const analyze = vi.fn(async (_doc: PDFDocumentProxy, page: number) => analysis(`p${page}`));
    const { result, rerender } = renderHook(({ page }) => usePageText(doc, page, analyze), {
      initialProps: { page: 0 },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ page: 1 });
    expect(result.current.status).toBe("analyzing");
    await waitFor(() => expect(result.current.analysis?.blocks[0].text).toBe("p1"));
    rerender({ page: 0 });
    expect(result.current.status).toBe("ready");
    expect(result.current.analysis?.blocks[0].text).toBe("p0");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("al cambiar de pagina antes de empezar, la analisis de la pagina intermedia se cancela", async () => {
    const doc = fakeDoc(5);
    const analyze = vi.fn(async (_doc: PDFDocumentProxy, page: number) => analysis(`p${page}`));
    const { result, rerender } = renderHook(({ page }) => usePageText(doc, page, analyze), {
      initialProps: { page: 0 },
    });
    rerender({ page: 1 });
    rerender({ page: 2 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.analysis?.blocks[0].text).toBe("p2");
    expect(analyze.mock.calls.map((call) => call[1])).toEqual([2]);
  });

  it("el resultado tardio de una pagina ya abandonada se guarda para cuando se vuelva, sin pisar la actual", async () => {
    const doc = fakeDoc();
    const resolvers: Record<number, (value: PageTextAnalysis) => void> = {};
    const analyze = vi.fn(
      (_doc: PDFDocumentProxy, page: number) =>
        new Promise<PageTextAnalysis>((resolve) => {
          resolvers[page] = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ page }) => usePageText(doc, page, analyze), {
      initialProps: { page: 0 },
    });
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    rerender({ page: 1 });
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    await act(async () => resolvers[0](analysis("tarde")));
    expect(result.current.status).toBe("analyzing"); // la pagina 1 sigue sin resultado
    await act(async () => resolvers[1](analysis("actual")));
    expect(result.current.analysis?.blocks[0].text).toBe("actual");
    rerender({ page: 0 });
    expect(result.current.analysis?.blocks[0].text).toBe("tarde");
  });

  it("un documento nuevo olvida las paginas analizadas del anterior", async () => {
    const docA = fakeDoc();
    const docB = fakeDoc();
    const analyze = vi.fn(async (doc: PDFDocumentProxy) => analysis(doc === docA ? "A" : "B"));
    const { result, rerender } = renderHook(({ doc }) => usePageText(doc, 0, analyze), {
      initialProps: { doc: docA },
    });
    await waitFor(() => expect(result.current.analysis?.blocks[0].text).toBe("A"));
    rerender({ doc: docB });
    expect(result.current.status).toBe("analyzing");
    await waitFor(() => expect(result.current.analysis?.blocks[0].text).toBe("B"));
  });

  it("sin documento esta en reposo", () => {
    const { result } = renderHook(() => usePageText(null, 0, vi.fn()));
    expect(result.current).toEqual({ status: "idle", analysis: null });
  });

  it("una pagina sin capa de texto o un fallo llegan tal cual (la interfaz decide el aviso)", async () => {
    const doc = fakeDoc();
    const analyze = vi.fn(async (_doc: PDFDocumentProxy, page: number) =>
      page === 0
        ? { blocks: [], hiddenCount: 4, hasTextLayer: false, failed: false }
        : { blocks: [], hiddenCount: 0, hasTextLayer: false, failed: true },
    );
    const { result, rerender } = renderHook(({ page }) => usePageText(doc, page, analyze), {
      initialProps: { page: 0 },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.analysis).toMatchObject({ hasTextLayer: false, failed: false, hiddenCount: 4 });
    rerender({ page: 1 });
    await waitFor(() => expect(result.current.analysis?.failed).toBe(true));
  });
});
