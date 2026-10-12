import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRIORITY_RADIUS,
  SIZE_BATCH,
  aspectsOf,
  emptySizes,
  geometryOf,
  useViewerDocument,
} from "@/app/pdf-pro/viewer/useViewerDocument";
import { makeSnapshot, mixedPages, pagesOf, pdfMocks } from "@/app/pdf-pro/viewer/viewerMocks";
import type { ViewerSnapshot } from "@/app/pdf-pro/viewer/viewerTypes";

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return { ...actual, openPdfDocument: utils.pdfMocks.open, closePdfDocument: utils.pdfMocks.close };
});

beforeEach(() => {
  pdfMocks.reset();
});
afterEach(cleanup);

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
const settle = async (times = 30) => {
  for (let i = 0; i < times; i += 1) await flush();
};

describe("tamanos de pagina", () => {
  it("emptySizes reserva un hueco por pagina sin medidas", () => {
    const sizes = emptySizes(4);
    expect(sizes.widths).toHaveLength(4);
    expect(sizes.views).toHaveLength(16);
    expect(sizes.measured).toBe(0);
  });

  it("aspectsOf da alto/ancho y 0 para las paginas sin medir", () => {
    const sizes = emptySizes(3);
    sizes.widths.set([100, 0, 200]);
    sizes.heights.set([150, 0, 100]);
    expect(Array.from(aspectsOf(sizes))).toEqual([1.5, 0, 0.5]);
  });

  it("geometryOf devuelve la geometria de pdf.js (caja visible y giro) o null sin medir", () => {
    const sizes = emptySizes(2);
    sizes.widths.set([480, 0]);
    sizes.heights.set([680, 0]);
    sizes.views.set([20, 20, 500, 700, 0, 0, 0, 0]);
    sizes.rotations.set([90, 0]);
    expect(geometryOf(sizes, 0)).toMatchObject({
      rotation: 90,
      box: { x: 20, y: 20, width: 480, height: 680 },
      viewWidth: 680,
      viewHeight: 480,
    });
    expect(geometryOf(sizes, 1)).toBeNull();
  });
});

describe("useViewerDocument", () => {
  it("sin snapshot esta inactivo y no abre nada", async () => {
    const { result } = renderHook(() => useViewerDocument(null));
    await settle(3);
    expect(result.current.status).toBe("idle");
    expect(result.current.document).toBeNull();
    expect(pdfMocks.open).not.toHaveBeenCalled();
  });

  it("abre el documento y mide la primera pagina enseguida", async () => {
    const snapshot = makeSnapshot(mixedPages(8));
    const { result } = renderHook(() => useViewerDocument(snapshot));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document!.pageCount).toBe(8);
    expect(result.current.document!.snapshotId).toBe(snapshot.id);
    expect(result.current.document!.sizes.widths[0]).toBeGreaterThan(0);
  });

  it("mide el resto de las paginas por lotes, con el giro y el CropBox aplicados", async () => {
    const snapshot = makeSnapshot(mixedPages(SIZE_BATCH * 2 + 5));
    const { result } = renderHook(() => useViewerDocument(snapshot));
    await waitFor(() => expect(result.current.document?.sizes.measured).toBe(SIZE_BATCH * 2 + 5));
    const { sizes } = result.current.document!;
    // Pagina 6 de `mixedPages`: A4 girada 90 grados => ancho y alto intercambiados.
    expect(sizes.widths[5]).toBe(842);
    expect(sizes.heights[5]).toBe(595);
    expect(sizes.rotations[5]).toBe(90);
    // Pagina 8: CropBox [20,20,500,700] girada 270.
    expect(sizes.widths[7]).toBe(680);
    expect(sizes.heights[7]).toBe(480);
  });

  it("mide primero las paginas que se estan viendo (para que deshacer no deje estimaciones a la vista)", async () => {
    const snapshot = makeSnapshot(mixedPages(200));
    const { result } = renderHook(() => useViewerDocument(snapshot, () => 150));
    await waitFor(() => expect(result.current.document?.sizes.measured).toBe(200));
    const requested = pdfMocks.opened[0].getPage.mock.calls.map((call) => call[0] as number);
    // La primera es la pagina 1 (para tener un visor util al instante); luego las vecinas de la pagina 151.
    expect(requested[0]).toBe(1);
    const firstBatch = requested.slice(1, 1 + PRIORITY_RADIUS * 2 + 1);
    expect(Math.min(...firstBatch)).toBeGreaterThanOrEqual(151 - PRIORITY_RADIUS);
    expect(Math.max(...firstBatch)).toBeLessThanOrEqual(151 + PRIORITY_RADIUS);
    // Y cada pagina se mide una sola vez.
    expect(new Set(requested).size).toBe(requested.length);
  });

  it("sin pagina prioritaria mide en orden desde el principio", async () => {
    const snapshot = makeSnapshot(mixedPages(60));
    const { result } = renderHook(() => useViewerDocument(snapshot));
    await waitFor(() => expect(result.current.document?.sizes.measured).toBe(60));
    const requested = pdfMocks.opened[0].getPage.mock.calls.map((call) => call[0] as number);
    expect(requested.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("una pagina prioritaria fuera de rango se acota al documento", async () => {
    const snapshot = makeSnapshot(mixedPages(30));
    const { result } = renderHook(() => useViewerDocument(snapshot, () => 9999));
    await waitFor(() => expect(result.current.document?.sizes.measured).toBe(30));
  });

  it("500 paginas: llegan todas las medidas", async () => {
    const snapshot = makeSnapshot(mixedPages(500));
    const { result } = renderHook(() => useViewerDocument(snapshot));
    await waitFor(() => expect(result.current.document?.sizes.measured).toBe(500), { timeout: 10_000 });
    expect(pdfMocks.opened).toHaveLength(1);
  });

  it("un documento que no se abre da un error tipado y se puede reintentar", async () => {
    pdfMocks.state.openError = new Error("roto");
    const snapshot = makeSnapshot(3);
    const { result } = renderHook(() => useViewerDocument(snapshot));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).not.toBeNull();
    pdfMocks.state.openError = null;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.error).toBeNull();
  });

  it("al cambiar de snapshot el documento viejo sigue a la vista hasta que el nuevo esta listo, y entonces se cierra", async () => {
    pdfMocks.state.openDelay = 40;
    const first = makeSnapshot(pagesOf(5));
    const second = makeSnapshot(pagesOf(5));
    const { result, rerender } = renderHook(({ snapshot }: { snapshot: ViewerSnapshot }) => useViewerDocument(snapshot), {
      initialProps: { snapshot: first },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ snapshot: second });
    // Mientras se abre el nuevo, lo anterior sigue ahi.
    expect(result.current.document!.snapshotId).toBe(first.id);
    expect(pdfMocks.close).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.document!.snapshotId).toBe(second.id));
    await settle(3);
    expect(pdfMocks.close).toHaveBeenCalledTimes(1);
    expect(pdfMocks.opened).toHaveLength(2);
  });

  it("el documento nuevo hereda las proporciones del anterior si tiene las mismas paginas (barra de scroll estable)", async () => {
    const first = makeSnapshot(mixedPages(30));
    const second = makeSnapshot(mixedPages(30));
    const { result, rerender } = renderHook(({ snapshot }: { snapshot: ViewerSnapshot }) => useViewerDocument(snapshot), {
      initialProps: { snapshot: first },
    });
    await waitFor(() => expect(result.current.document?.sizes.measured).toBe(30));
    rerender({ snapshot: second });
    await waitFor(() => expect(result.current.document!.snapshotId).toBe(second.id));
    expect(result.current.document!.sizes.measured).toBeGreaterThan(1);
  });

  it("si el nuevo documento tiene otro numero de paginas no hereda medidas", async () => {
    const first = makeSnapshot(mixedPages(30));
    const second = makeSnapshot(mixedPages(10));
    const { result, rerender } = renderHook(({ snapshot }: { snapshot: ViewerSnapshot }) => useViewerDocument(snapshot), {
      initialProps: { snapshot: first },
    });
    await waitFor(() => expect(result.current.document?.sizes.measured).toBe(30));
    rerender({ snapshot: second });
    await waitFor(() => expect(result.current.document?.snapshotId).toBe(second.id));
    expect(result.current.document!.pageCount).toBe(10);
    await waitFor(() => expect(result.current.document!.sizes.measured).toBe(10));
  });

  it("cambios rapidos de snapshot: solo gana el ultimo y los abiertos de mas se cierran", async () => {
    pdfMocks.state.openDelay = 20;
    const a = makeSnapshot(3);
    const b = makeSnapshot(3);
    const c = makeSnapshot(3);
    const { result, rerender } = renderHook(({ snapshot }: { snapshot: ViewerSnapshot }) => useViewerDocument(snapshot), {
      initialProps: { snapshot: a },
    });
    rerender({ snapshot: b });
    rerender({ snapshot: c });
    await waitFor(() => expect(result.current.document?.snapshotId).toBe(c.id));
    await settle(5);
    expect(result.current.document!.snapshotId).toBe(c.id);
    // Los tres se abrieron, pero solo queda abierto el ultimo.
    expect(pdfMocks.close.mock.calls.length).toBe(pdfMocks.opened.length - 1);
  });

  it("el mismo snapshot no se vuelve a abrir al repintar", async () => {
    const snapshot = makeSnapshot(3);
    const { result, rerender } = renderHook(() => useViewerDocument(snapshot));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender();
    rerender();
    await settle(3);
    expect(pdfMocks.open).toHaveBeenCalledTimes(1);
  });

  it("al desmontar cierra el documento de pdf.js", async () => {
    const snapshot = makeSnapshot(3);
    const { result, unmount } = renderHook(() => useViewerDocument(snapshot));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    unmount();
    await settle(3);
    expect(pdfMocks.close).toHaveBeenCalledTimes(1);
  });

  it("al quitar el snapshot cierra el documento y vuelve a estar inactivo", async () => {
    const snapshot = makeSnapshot(3);
    const { result, rerender } = renderHook(({ snapshot }: { snapshot: ViewerSnapshot | null }) => useViewerDocument(snapshot), {
      initialProps: { snapshot: snapshot as ViewerSnapshot | null },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ snapshot: null });
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(pdfMocks.close).toHaveBeenCalledTimes(1);
  });

  it("un documento sin paginas se abre sin error y sin medir nada", async () => {
    const snapshot = makeSnapshot([]);
    const { result } = renderHook(() => useViewerDocument(snapshot));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document!.pageCount).toBe(0);
  });

  it("si una pagina no se puede leer las demas se miden igual", async () => {
    const snapshot = makeSnapshot(6);
    const original = pdfMocks.open.getMockImplementation()!;
    pdfMocks.open.mockImplementationOnce(async (source: Uint8Array) => {
      const doc = (await original(source)) as unknown as { getPage: (n: number) => Promise<unknown> };
      const getPage = doc.getPage.bind(doc);
      doc.getPage = async (n: number) => {
        if (n === 3) throw new Error("pagina rota");
        return getPage(n);
      };
      return doc as never;
    });
    const { result } = renderHook(() => useViewerDocument(snapshot));
    await waitFor(() => expect(result.current.document?.sizes.measured).toBe(5));
    expect(result.current.document!.sizes.widths[2]).toBe(0);
    expect(result.current.document!.sizes.widths[5]).toBeGreaterThan(0);
  });
});
