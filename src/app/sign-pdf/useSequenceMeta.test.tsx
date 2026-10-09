import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  MAX_THUMBS,
  thumbKey,
  thumbWindow,
  useSequenceMeta,
  type SequenceMeta,
} from "@/app/sign-pdf/useSequenceMeta";

/** Cuantas miniaturas hay de un documento. */
const thumbCount = (meta: SequenceMeta, id: string) =>
  Object.keys(meta.thumbs).filter((key) => key.startsWith(`${id}:`)).length;

/** Seguimiento de pdf.js: documentos abiertos a la vez, orden de aperturas y paginas renderizadas. */
const pdf = vi.hoisted(() => ({
  pagesOf: {} as Record<string, number>,
  open: 0,
  maxOpen: 0,
  opened: [] as string[],
  closed: 0,
  rendered: [] as string[],
  fail: new Set<string>(),
  /** Si hay una puerta, el render de miniaturas espera a que la abra la prueba. */
  gate: null as null | Promise<void>,
}));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async (file: File) => {
      if (pdf.fail.has(file.name)) throw new Error("boom");
      pdf.open += 1;
      pdf.maxOpen = Math.max(pdf.maxOpen, pdf.open);
      pdf.opened.push(file.name);
      return {
        numPages: pdf.pagesOf[file.name] ?? 2,
        getPage: async (number: number) => ({
          cleanup: () => {},
          __name: `${file.name}#${number}`,
        }),
      };
    },
    renderPageToDataUrl: async (page: { __name: string }) => {
      if (pdf.gate) await pdf.gate;
      pdf.rendered.push(page.__name);
      return `data:image/png;base64,${page.__name}`;
    },
    closePdfDocument: async () => {
      pdf.open -= 1;
      pdf.closed += 1;
    },
  };
});

function doc(id: string, name = `${id}.pdf`) {
  return { id, file: new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" }) };
}

beforeEach(() => {
  pdf.pagesOf = {};
  pdf.open = 0;
  pdf.maxOpen = 0;
  pdf.opened = [];
  pdf.closed = 0;
  pdf.rendered = [];
  pdf.fail = new Set();
  pdf.gate = null;
});

describe("thumbWindow — de que documentos se guardan miniaturas", () => {
  it("el activo y sus dos vecinos, en ese orden de prioridad", () => {
    expect(thumbWindow(["a", "b", "c", "d", "e"], "c")).toEqual(["c", "d", "b"]);
  });

  it("en los extremos solo el vecino que existe", () => {
    expect(thumbWindow(["a", "b", "c"], "a")).toEqual(["a", "b"]);
    expect(thumbWindow(["a", "b", "c"], "c")).toEqual(["c", "b"]);
  });

  it("un activo que no esta en la cola no deja ventana", () => {
    expect(thumbWindow(["a", "b"], "z")).toEqual([]);
  });
});

describe("useSequenceMeta — cola de pdf.js con concurrencia 1", () => {
  it("cuenta las paginas de TODOS los documentos y abre de uno en uno", async () => {
    pdf.pagesOf = { "d1.pdf": 3, "d2.pdf": 2, "d3.pdf": 4, "d4.pdf": 1 };
    const docs = [doc("d1"), doc("d2"), doc("d3"), doc("d4")];
    const { result } = renderHook(() => useSequenceMeta(docs, "d1"));
    await waitFor(() =>
      expect(result.current.counts).toEqual({ d1: 3, d2: 2, d3: 4, d4: 1 }),
    );
    expect(pdf.maxOpen).toBe(1);
    // Todo lo abierto se cerro: nada queda retenido.
    await waitFor(() => expect(pdf.open).toBe(0));
  });

  it("sin IntersectionObserver: primero el activo y sus vecinos (con miniaturas); los lejanos solo se cuentan", async () => {
    pdf.pagesOf = { "d1.pdf": 2, "d2.pdf": 2, "d3.pdf": 2, "d4.pdf": 2, "d5.pdf": 2 };
    const docs = [doc("d1"), doc("d2"), doc("d3"), doc("d4"), doc("d5")];
    const { result } = renderHook(() => useSequenceMeta(docs, "d3", false));
    await waitFor(() => expect(Object.keys(result.current.counts)).toHaveLength(5));
    expect(pdf.opened[0]).toBe("d3.pdf");
    expect(new Set(pdf.opened.slice(1, 3))).toEqual(new Set(["d2.pdf", "d4.pdf"]));
    expect(thumbCount(result.current, "d3")).toBe(2);
    expect(thumbCount(result.current, "d4")).toBe(2);
    expect(thumbCount(result.current, "d2")).toBe(2);
    expect(pdf.rendered.some((name) => name.startsWith("d1.pdf"))).toBe(false);
    expect(pdf.rendered.some((name) => name.startsWith("d5.pdf"))).toBe(false);
  });

  it("perezoso: solo se hacen las miniaturas que la tira tiene a la vista, y solo esas", async () => {
    pdf.pagesOf = { "d1.pdf": 30, "d2.pdf": 30 };
    const docs = [doc("d1"), doc("d2")];
    const { result } = renderHook(() => useSequenceMeta(docs, "d1", true));
    await waitFor(() => expect(result.current.counts).toEqual({ d1: 30, d2: 30 }));
    expect(pdf.rendered).toEqual([]);
    act(() =>
      result.current.setVisible(new Set([thumbKey("d2", 25), thumbKey("d2", 26), thumbKey("d1", 0)])),
    );
    await waitFor(() => expect(Object.keys(result.current.thumbs)).toHaveLength(3));
    expect(new Set(pdf.rendered)).toEqual(new Set(["d1.pdf#1", "d2.pdf#26", "d2.pdf#27"]));
    // El activo va primero.
    expect(pdf.rendered[0]).toBe("d1.pdf#1");
  });

  it("perezoso: lo que sale de la vista deja de pedirse (cancela entre pagina y pagina)", async () => {
    pdf.pagesOf = { "d1.pdf": 30 };
    const docs = [doc("d1")];
    let release: () => void = () => {};
    const { result } = renderHook(() => useSequenceMeta(docs, "d1", true));
    await waitFor(() => expect(result.current.counts.d1).toBe(30));
    pdf.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    act(() => result.current.setVisible(new Set([0, 1, 2, 3].map((p) => thumbKey("d1", p)))));
    await waitFor(() => expect(pdf.opened.length).toBeGreaterThan(1));
    // Salen de la vista antes de rasterizar: solo queda la ultima pagina.
    act(() => result.current.setVisible(new Set([thumbKey("d1", 29)])));
    pdf.gate = null;
    release();
    await waitFor(() => expect(result.current.thumbs[thumbKey("d1", 29)]).toBeTruthy());
    expect(result.current.thumbs[thumbKey("d1", 3)]).toBeUndefined();
    expect(result.current.thumbs[thumbKey("d1", 2)]).toBeUndefined();
  });

  it("perezoso: las miniaturas que ya salieron de la vista se conservan hasta el tope y despues se sueltan las mas viejas", async () => {
    pdf.pagesOf = { "d1.pdf": MAX_THUMBS + 20 };
    const docs = [doc("d1")];
    const { result } = renderHook(() => useSequenceMeta(docs, "d1", true));
    await waitFor(() => expect(result.current.counts.d1).toBe(MAX_THUMBS + 20));
    const first = Array.from({ length: MAX_THUMBS }, (_, page) => thumbKey("d1", page));
    act(() => result.current.setVisible(new Set(first)));
    await waitFor(() => expect(Object.keys(result.current.thumbs)).toHaveLength(MAX_THUMBS));
    // Se desplaza la tira: otras 20 a la vista y las primeras ya no.
    const last = Array.from({ length: 20 }, (_, i) => thumbKey("d1", MAX_THUMBS + i));
    act(() => result.current.setVisible(new Set(last)));
    await waitFor(() => expect(result.current.thumbs[thumbKey("d1", MAX_THUMBS + 19)]).toBeTruthy());
    expect(Object.keys(result.current.thumbs).length).toBeLessThanOrEqual(MAX_THUMBS);
    for (const key of last) expect(result.current.thumbs[key]).toBeTruthy();
    // Se soltaron las mas antiguas (las primeras), no las visibles.
    expect(result.current.thumbs[thumbKey("d1", 0)]).toBeUndefined();
  });

  it("perezoso: sin saber todavia que se ve (null) no se rasteriza nada", async () => {
    pdf.pagesOf = { "d1.pdf": 3 };
    const docs = [doc("d1")];
    const { result } = renderHook(() => useSequenceMeta(docs, "d1", true));
    await waitFor(() => expect(result.current.counts.d1).toBe(3));
    act(() => result.current.setVisible(null));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pdf.rendered).toEqual([]);
  });

  it("sin IntersectionObserver, al alejarse el activo se sueltan las miniaturas que salen de la ventana (por tope)", async () => {
    const docs = [doc("d1"), doc("d2"), doc("d3"), doc("d4")];
    const { result, rerender } = renderHook(
      ({ active }) => useSequenceMeta(docs, active, false),
      { initialProps: { active: "d1" } },
    );
    await waitFor(() => expect(thumbCount(result.current, "d2")).toBe(2));
    expect(thumbCount(result.current, "d1")).toBe(2);
    rerender({ active: "d4" });
    await waitFor(() => expect(thumbCount(result.current, "d4")).toBe(2));
    expect(thumbCount(result.current, "d3")).toBe(2);
    // El recuento se conserva.
    expect(result.current.counts.d1).toBe(2);
  });

  it("un documento que se quita deja de ocupar memoria y su trabajo pendiente se descarta", async () => {
    let release: () => void = () => {};
    pdf.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    pdf.pagesOf = { "d1.pdf": 4, "d2.pdf": 2 };
    const d1 = doc("d1");
    const d2 = doc("d2");
    const { result, rerender } = renderHook(
      ({ docs }) => useSequenceMeta(docs, "d1"),
      { initialProps: { docs: [d1, d2] } },
    );
    await waitFor(() => expect(pdf.opened).toContain("d1.pdf"));
    rerender({ docs: [d2] });
    release();
    await waitFor(() => expect(result.current.counts.d2).toBe(2));
    expect(result.current.counts.d1).toBeUndefined();
    expect(thumbCount(result.current, "d1")).toBe(0);
  });

  it("cede el turno si el activo cambia a mitad de un documento (sin IntersectionObserver)", async () => {
    pdf.pagesOf = { "d1.pdf": 4, "d2.pdf": 1, "d3.pdf": 1 };
    let release: () => void = () => {};
    pdf.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const docs = [doc("d1"), doc("d2"), doc("d3")];
    const { result, rerender } = renderHook(
      ({ active }) => useSequenceMeta(docs, active, false),
      { initialProps: { active: "d1" } },
    );
    await waitFor(() => expect(pdf.opened).toEqual(["d1.pdf"]));
    rerender({ active: "d3" });
    pdf.gate = null;
    release();
    await waitFor(() => expect(thumbCount(result.current, "d3")).toBe(1));
    expect(pdf.rendered.filter((name) => name.startsWith("d1.pdf")).length).toBeLessThan(4);
  });

  it("un documento que pdf.js no abre se marca como fallido y no bloquea al resto", async () => {
    pdf.fail.add("d2.pdf");
    const docs = [doc("d1"), doc("d2"), doc("d3")];
    const { result } = renderHook(() => useSequenceMeta(docs, "d1"));
    await waitFor(() => expect(result.current.counts.d3).toBe(2));
    expect(result.current.failed.d2).toBe(true);
    expect(result.current.counts.d2).toBeUndefined();
  });

  it("reportCount adelanta el recuento del documento que el lienzo ya abrio", async () => {
    pdf.gate = new Promise<void>(() => {});
    const docs = [doc("d1"), doc("d2")];
    const { result } = renderHook(() => useSequenceMeta(docs, "d1"));
    act(() => result.current.reportCount("d1", docs[0].file, 7));
    expect(result.current.counts.d1).toBe(7);
  });

  it("reportCount ignora un archivo que ya no es el del documento", async () => {
    pdf.gate = new Promise<void>(() => {});
    const docs = [doc("d1")];
    const { result } = renderHook(() => useSequenceMeta(docs, "d1"));
    act(() => result.current.reportCount("d1", doc("d1", "otro.pdf").file, 9));
    expect(result.current.counts.d1).not.toBe(9);
  });
});
