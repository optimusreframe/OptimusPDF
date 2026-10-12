import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { PREVIEW_DEBOUNCE_MS, optionsKey, useOperationPreview } from "@/app/pdf-pro/tabs/useOperationPreview";
import { __resetPageInfoCacheForTests, PREVIEW_MAX_BYTES, readFirstPageMm, readFirstPagePdf } from "@/app/pdf-pro/ops/pageInfo";
import type { DocToolContext, DocToolDefinition } from "@/app/pdf-pro/tabs/docToolTypes";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";

/** Vista previa del resultado: debounce, estados, cancelacion y el PDF de una pagina. */

const render = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({ renderPreviewDataUrl: (...args: unknown[]) => render.fn(...args) }));

let bytes: Uint8Array;
const run = vi.fn();

function makeCtx(patch: Partial<DocToolContext> = {}): DocToolContext {
  return {
    language: "es", fileName: "a.pdf", pageCount: 3, byteLength: bytes.byteLength, bytes, snapshotId: "s1",
    signatures: "none", wasEncrypted: false, firstPage: null, ...patch,
  };
}

type Opts = { n: number };
function makeTool(previewOptions?: DocToolDefinition<Opts>["previewOptions"]): DocToolDefinition<Opts> {
  return {
    id: "watermark",
    tab: "home",
    icon: (() => null) as never,
    operation: { id: "x", labelKey: "k", kind: "document", run },
    defaults: () => ({ n: 0 }),
    canRun: () => ({ ok: true }),
    describe: () => "x",
    Panel: () => null,
    previewOptions,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  bytes = await makePdfBytes(3);
  __resetPageInfoCacheForTests();
  run.mockReset();
  run.mockImplementation(async (input: Uint8Array) => ({ bytes: input }));
  render.fn.mockReset();
  render.fn.mockResolvedValue("data:image/png;base64,AAA");
});
afterEach(() => vi.useRealTimers());

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 50);
  });
}

describe("useOperationPreview", () => {
  it("sin `previewOptions` no hay vista previa", () => {
    const { result } = renderHook(() => useOperationPreview(makeTool(), { n: 1 }, makeCtx()));
    expect(result.current).toEqual({ status: "none" });
  });

  it("sin contexto no hay vista previa y no falla", () => {
    const { result } = renderHook(() => useOperationPreview(makeTool((o) => o), { n: 1 }, null));
    expect(result.current).toEqual({ status: "none" });
  });

  it("pasa por «loading» y llega a «ready» con la imagen", async () => {
    const tool = makeTool((o) => o);
    const ctx = makeCtx();
    const { result } = renderHook(() => useOperationPreview(tool, { n: 1 }, ctx));
    expect(result.current).toEqual({ status: "loading" });
    await settle();
    expect(result.current).toEqual({ status: "ready", url: "data:image/png;base64,AAA" });
  });

  it("espera el debounce antes de ejecutar y agrupa los cambios rapidos en una sola ejecucion", async () => {
    const tool = makeTool((o) => o);
    const ctx = makeCtx();
    const { rerender } = renderHook(({ options }) => useOperationPreview(tool, options, ctx), { initialProps: { options: { n: 1 } } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 100);
    });
    expect(run).not.toHaveBeenCalled();
    rerender({ options: { n: 2 } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 100);
    });
    rerender({ options: { n: 3 } });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual({ n: 3 });
  });

  it("la operacion se ejecuta sobre un PDF de UNA pagina", async () => {
    const tool = makeTool((o) => o);
    renderHook(() => useOperationPreview(tool, { n: 1 }, makeCtx()));
    await settle();
    const input = run.mock.calls[0][0] as Uint8Array;
    expect((await PDFDocument.load(input)).getPageCount()).toBe(1);
  });

  it("si la pagina 1 no se ve afectada («null») queda «outOfRange» y no ejecuta nada", async () => {
    const tool = makeTool(() => null);
    const { result } = renderHook(() => useOperationPreview(tool, { n: 1 }, makeCtx()));
    await settle();
    expect(result.current).toEqual({ status: "outOfRange" });
    expect(run).not.toHaveBeenCalled();
  });

  it("si la operacion falla queda «unavailable» (nunca bloquea)", async () => {
    run.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useOperationPreview(makeTool((o) => o), { n: 1 }, makeCtx()));
    await settle();
    expect(result.current).toEqual({ status: "unavailable" });
  });

  it("si no se puede dibujar queda «unavailable»", async () => {
    render.fn.mockResolvedValue(null);
    const { result } = renderHook(() => useOperationPreview(makeTool((o) => o), { n: 1 }, makeCtx()));
    await settle();
    expect(result.current).toEqual({ status: "unavailable" });
  });

  it("con otras opciones conserva la imagen anterior mientras calcula (sin parpadeo)", async () => {
    const tool = makeTool((o) => o);
    const ctx = makeCtx();
    const { result, rerender } = renderHook(({ options }) => useOperationPreview(tool, options, ctx), { initialProps: { options: { n: 1 } } });
    await settle();
    expect(result.current.status).toBe("ready");
    rerender({ options: { n: 2 } });
    expect(result.current.status).toBe("ready");
  });

  it("un resultado tardio de unas opciones viejas se descarta", async () => {
    let release!: () => void;
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ bytes: new Uint8Array(1) });
        }),
    );
    run.mockImplementation(async () => ({ bytes: new Uint8Array(2) }));
    render.fn.mockImplementation(async (data: Uint8Array) => `data:len${data.length}`);
    const tool = makeTool((o) => o);
    const ctx = makeCtx();
    const { result, rerender } = renderHook(({ options }) => useOperationPreview(tool, options, ctx), { initialProps: { options: { n: 1 } } });
    await settle();
    rerender({ options: { n: 2 } });
    await settle();
    expect(result.current).toEqual({ status: "ready", url: "data:len2" });
    await act(async () => release());
    expect(result.current).toEqual({ status: "ready", url: "data:len2" });
  });

  it("`enabled = false` lo apaga", () => {
    const { result } = renderHook(() => useOperationPreview(makeTool((o) => o), { n: 1 }, makeCtx(), false));
    expect(result.current).toEqual({ status: "none" });
  });

  it("al desmontar no deja trabajo pendiente", async () => {
    const { unmount } = renderHook(() => useOperationPreview(makeTool((o) => o), { n: 1 }, makeCtx()));
    unmount();
    await settle();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("optionsKey", () => {
  it("es estable y distingue opciones", () => {
    expect(optionsKey({ a: 1, b: [1, 2] })).toBe(optionsKey({ a: 1, b: [1, 2] }));
    expect(optionsKey({ a: 1 })).not.toBe(optionsKey({ a: 2 }));
  });

  it("un File cuenta por nombre y peso, no por contenido", () => {
    const a = new File(["abc"], "a.png", { lastModified: 1 });
    const b = new File(["abcd"], "a.png", { lastModified: 1 });
    expect(optionsKey({ image: a })).not.toBe(optionsKey({ image: b }));
    expect(optionsKey({ image: a })).toBe(optionsKey({ image: new File(["xyz"], "a.png", { lastModified: 1 }) }));
  });
});

describe("pageInfo", () => {
  it("mide la primera pagina en mm", async () => {
    const mm = await readFirstPageMm("a", bytes);
    expect(mm?.width).toBeCloseTo((300 * 25.4) / 72, 6);
    expect(mm?.height).toBeCloseTo((400 * 25.4) / 72, 6);
  });

  it("la cache evita volver a leer el mismo snapshot y se renueva con otro", async () => {
    const first = readFirstPageMm("a", bytes);
    expect(readFirstPageMm("a", bytes)).toBe(first);
    expect(readFirstPageMm("b", bytes)).not.toBe(first);
  });

  it("bytes ilegibles dan `null`, no una excepcion", async () => {
    expect(await readFirstPageMm("x", new Uint8Array([1, 2, 3]))).toBeNull();
    expect(await readFirstPagePdf("x", new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("el PDF de una pagina conserva el tamano de la primera", async () => {
    const one = await readFirstPagePdf("a", bytes);
    const doc = await PDFDocument.load(one!);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
  });

  it("un documento enorme no genera vista previa", async () => {
    const big = new Uint8Array(PREVIEW_MAX_BYTES + 1);
    expect(await readFirstPagePdf("big", big)).toBeNull();
  });
});
