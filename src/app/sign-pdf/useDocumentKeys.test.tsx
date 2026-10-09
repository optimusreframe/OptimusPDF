import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  documentContentKey,
  useDocumentKey,
  useDocumentKeys,
  type KeyedDoc,
} from "@/app/sign-pdf/documentKey";
import { duplicateGroups } from "@/app/sign-pdf/docSet";

/**
 * Cada llamada a `crypto.subtle.digest` se registra y se queda esperando una
 * puerta hasta que la prueba la abre: asi se controla en que orden llegan las
 * huellas y cuantas se calculan a la vez.
 */
type Call = { bytes: number[]; release: () => void; fail: (error: Error) => void };

let calls: Call[] = [];
let inFlight = 0;
let maxInFlight = 0;
let digestSpy: ReturnType<typeof vi.spyOn> | null = null;
let autoRelease = false;

beforeEach(() => {
  calls = [];
  inFlight = 0;
  maxInFlight = 0;
  autoRelease = false;
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest.bind(subtle);
  digestSpy = vi.spyOn(subtle, "digest").mockImplementation((async (
    algorithm: AlgorithmIdentifier,
    data: BufferSource,
  ) => {
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const call: Call = {
          bytes: Array.from(view),
          release: resolve,
          fail: reject,
        };
        calls.push(call);
        if (autoRelease) resolve();
      });
      return await original(algorithm, data);
    } finally {
      inFlight -= 1;
    }
  }) as typeof subtle.digest);
});

afterEach(() => {
  digestSpy?.mockRestore();
  digestSpy = null;
});

let seed = 1000;
/** Archivo nuevo en cada llamada: la huella se cachea por objeto `File`. */
function pdf(name: string, byte?: number): File {
  const b = byte ?? (seed += 1) % 250;
  return new File([new Uint8Array([b, b + 1, b + 2])], name, {
    type: "application/pdf",
  });
}

const docs = (...files: File[]): KeyedDoc[] =>
  files.map((file, index) => ({ id: `doc-${file.name}-${index}`, file }));

/** Espera a que haya `n` digests pendientes y devuelve el que corresponde a `bytes`. */
async function pending(n: number): Promise<void> {
  await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));
}

/** Huella real de `file`, calculada sin pasar por la puerta y sin dejar rastro en `calls`. */
async function keyOf(file: File): Promise<string> {
  const previous = autoRelease;
  autoRelease = true;
  const key = await documentContentKey(file);
  autoRelease = previous;
  calls = [];
  return key;
}

function release(index: number): void {
  act(() => calls[index].release());
}

describe("useDocumentKeys — src/app/sign-pdf/documentKey.ts", () => {
  it("sin documentos devuelve un registro vacio", () => {
    const { result } = renderHook(() => useDocumentKeys([]));
    expect(result.current).toEqual({});
  });

  it("devuelve null mientras se calcula y la huella real despues, indexada por DocId", async () => {
    autoRelease = true;
    const a = pdf("a.pdf");
    const b = pdf("b.pdf");
    const list = docs(a, b);
    const { result } = renderHook(() => useDocumentKeys(list));
    expect(result.current[list[0].id]).toBeNull();
    await waitFor(() => expect(result.current[list[0].id]).not.toBeNull());
    await waitFor(() => expect(result.current[list[1].id]).not.toBeNull());
    expect(result.current[list[0].id]).toBe(await keyOf(a));
    expect(result.current[list[1].id]).toBe(await keyOf(b));
  });

  it("limita la concurrencia: nunca lee mas de 2 PDF a la vez", async () => {
    const list = docs(pdf("1.pdf"), pdf("2.pdf"), pdf("3.pdf"), pdf("4.pdf"));
    renderHook(() => useDocumentKeys(list));
    await pending(2);
    expect(calls).toHaveLength(2);
    release(0);
    await pending(3);
    expect(calls).toHaveLength(3);
    release(1);
    await pending(4);
    release(2);
    release(3);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("respeta una concurrencia de 1 si se pide", async () => {
    const list = docs(pdf("1.pdf"), pdf("2.pdf"), pdf("3.pdf"));
    renderHook(() => useDocumentKeys(list, 1));
    await pending(1);
    expect(calls).toHaveLength(1);
    release(0);
    await pending(2);
    expect(calls).toHaveLength(2);
    release(1);
    await pending(3);
    release(2);
    expect(maxInFlight).toBe(1);
  });

  it("procesa en el orden de la cola de documentos", async () => {
    const first = pdf("primero.pdf", 10);
    const second = pdf("segundo.pdf", 20);
    const third = pdf("tercero.pdf", 30);
    const list = docs(first, second, third);
    renderHook(() => useDocumentKeys(list, 1));
    await pending(1);
    expect(calls[0].bytes[0]).toBe(10);
    release(0);
    await pending(2);
    expect(calls[1].bytes[0]).toBe(20);
    release(1);
    await pending(3);
    expect(calls[2].bytes[0]).toBe(30);
    release(2);
  });

  it("descarta el resultado de un documento retirado antes de que llegue su huella (carrera a4)", async () => {
    const a = pdf("a.pdf");
    const b = pdf("b.pdf");
    const [docA, docB] = docs(a, b);
    const { result, rerender } = renderHook(
      ({ list }: { list: KeyedDoc[] }) => useDocumentKeys(list),
      { initialProps: { list: [docA, docB] } },
    );
    await pending(2);
    // A se quita ANTES de que llegue su huella.
    rerender({ list: [docB] });
    release(0);
    release(1);
    await waitFor(() => expect(result.current[docB.id]).not.toBeNull());
    expect(docA.id in result.current).toBe(false);
    expect(Object.keys(result.current)).toEqual([docB.id]);
  });

  it("quitar y subir otro: la huella de A nunca aparece bajo el DocId de B (carrera a5)", async () => {
    const a = pdf("a.pdf", 11);
    const c = pdf("c.pdf", 99);
    const docA = { id: "doc-A", file: a };
    const docC = { id: "doc-C", file: c };
    const keyA = await keyOf(a);
    const keyC = await keyOf(c);
    const { result, rerender } = renderHook(
      ({ list }: { list: KeyedDoc[] }) => useDocumentKeys(list),
      { initialProps: { list: [docA] } },
    );
    await pending(1);
    rerender({ list: [docC] });
    await pending(2);
    // La huella de A llega tarde, despues de que C ya ocupa su sitio.
    release(0);
    expect(result.current["doc-C"]).toBeNull();
    release(1);
    await waitFor(() => expect(result.current["doc-C"]).not.toBeNull());
    expect(result.current["doc-C"]).toBe(keyC);
    expect(result.current["doc-C"]).not.toBe(keyA);
  });

  it("si el mismo DocId pasa a otro archivo, no hereda la huella del anterior", async () => {
    const a = pdf("a.pdf", 41);
    const b = pdf("b.pdf", 77);
    const keyB = await keyOf(b);
    const { result, rerender } = renderHook(
      ({ list }: { list: KeyedDoc[] }) => useDocumentKeys(list),
      { initialProps: { list: [{ id: "doc-X", file: a }] } },
    );
    await pending(1);
    rerender({ list: [{ id: "doc-X", file: b }] });
    release(0);
    expect(result.current["doc-X"]).toBeNull();
    await pending(2);
    release(1);
    await waitFor(() => expect(result.current["doc-X"]).toBe(keyB));
  });

  it("dos copias identicas se aceptan: misma huella con distinto DocId", async () => {
    autoRelease = true;
    const one = pdf("copia.pdf", 5);
    const two = pdf("copia.pdf", 5);
    const list = [
      { id: "doc-1", file: one },
      { id: "doc-2", file: two },
    ];
    const { result } = renderHook(() => useDocumentKeys(list));
    await waitFor(() => {
      expect(result.current["doc-1"]).not.toBeNull();
      expect(result.current["doc-2"]).not.toBeNull();
    });
    expect(result.current["doc-1"]).toBe(result.current["doc-2"]);
    expect(duplicateGroups(result.current, ["doc-1", "doc-2"])).toEqual([["doc-1", "doc-2"]]);
  });

  it("un fallo del calculo deja la huella en null y no se reintenta en cada render", async () => {
    const a = pdf("a.pdf");
    const list = docs(a);
    const { result, rerender } = renderHook(() => useDocumentKeys(list));
    await pending(1);
    act(() => calls[0].fail(new Error("sin crypto")));
    await waitFor(() => expect(inFlight).toBe(0));
    rerender();
    rerender();
    expect(result.current[list[0].id]).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("comparte la lectura con useDocumentKey: un mismo archivo no se hashea dos veces", async () => {
    const shared = pdf("compartido.pdf", 66);
    const list = [{ id: "doc-S", file: shared }];
    const { result } = renderHook(() => ({
      many: useDocumentKeys(list),
      one: useDocumentKey(shared),
    }));
    await pending(1);
    release(0);
    await waitFor(() => expect(result.current.many["doc-S"]).not.toBeNull());
    await waitFor(() => expect(result.current.one).not.toBeNull());
    expect(calls).toHaveLength(1);
    expect(result.current.many["doc-S"]).toBe(result.current.one);
  });

  it("un archivo ya calculado se sirve sin volver a leerlo", async () => {
    autoRelease = true;
    const known = pdf("conocido.pdf", 70);
    const list = [{ id: "doc-K", file: known }];
    const first = renderHook(() => useDocumentKeys(list));
    await waitFor(() => expect(first.result.current["doc-K"]).not.toBeNull());
    const key = first.result.current["doc-K"];
    first.unmount();
    const before = calls.length;
    const second = renderHook(() => useDocumentKeys(list));
    await waitFor(() => expect(second.result.current["doc-K"]).toBe(key));
    expect(calls.length).toBe(before);
  });

  it("anadir documentos a una cola en marcha solo calcula los nuevos", async () => {
    autoRelease = true;
    const a = pdf("a.pdf");
    const b = pdf("b.pdf");
    const first = { id: "doc-a", file: a };
    const second = { id: "doc-b", file: b };
    const { result, rerender } = renderHook(
      ({ list }: { list: KeyedDoc[] }) => useDocumentKeys(list),
      { initialProps: { list: [first] } },
    );
    await waitFor(() => expect(result.current["doc-a"]).not.toBeNull());
    const done = calls.length;
    rerender({ list: [first, second] });
    await waitFor(() => expect(result.current["doc-b"]).not.toBeNull());
    expect(calls.length).toBe(done + 1);
  });
});
