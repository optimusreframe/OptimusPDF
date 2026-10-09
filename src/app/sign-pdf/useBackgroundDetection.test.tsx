import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  BACKGROUND_DETECTION_DELAY_MS,
  needsDetection,
  startBackgroundDetection,
  takeBackgroundDetection,
  useBackgroundDetection,
} from "@/app/sign-pdf/useBackgroundDetection";
import { EMPTY_DOC_STATE, type DocState } from "@/app/sign-pdf/docSet";
import { detectFields, type DetectedField } from "@/lib/pdf/detectFields";

vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn() };
});

function field(id: string): DetectedField {
  return {
    id,
    pageIndex: 0,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
    source: "acroform",
    confidence: "high",
  };
}

function doc(id: string) {
  return { id, file: new File([new Uint8Array([1, 2])], `${id}.pdf`, { type: "application/pdf" }) };
}

/** Seguimiento del orden y la concurrencia de las detecciones. */
let running = 0;
let maxRunning = 0;
let calls: string[] = [];

beforeEach(() => {
  running = 0;
  maxRunning = 0;
  calls = [];
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockImplementation(async (file: File) => {
    calls.push(file.name);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await Promise.resolve();
    running -= 1;
    return [field(`f-${file.name}`)];
  });
  vi.useFakeTimers();
});

function states(patch: Record<string, Partial<DocState>> = {}) {
  const out: Record<string, DocState> = {};
  for (const [id, change] of Object.entries(patch)) out[id] = { ...EMPTY_DOC_STATE, ...change };
  return out;
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BACKGROUND_DETECTION_DELAY_MS + 5);
  });
}

describe("needsDetection", () => {
  it("un documento sin campos y sin deteccion necesita detectarse", () => {
    expect(needsDetection(EMPTY_DOC_STATE)).toBe(true);
  });

  it("con campos puestos a mano, o ya detectado, no", () => {
    expect(needsDetection({ ...EMPTY_DOC_STATE, textFields: [field("x")] })).toBe(false);
    expect(needsDetection({ ...EMPTY_DOC_STATE, textFieldsDetectedFor: "huella" })).toBe(false);
  });
});

describe("startBackgroundDetection / takeBackgroundDetection", () => {
  it("la deteccion en marcha se comparte y el flujo la toma UNA sola vez", async () => {
    const { file } = doc("x");
    const first = startBackgroundDetection(file);
    expect(startBackgroundDetection(file)).toBe(first);
    expect(detectFields).toHaveBeenCalledTimes(1);
    expect(takeBackgroundDetection(file)).toBe(first);
    expect(takeBackgroundDetection(file)).toBeNull();
    await first;
  });

  it("sin deteccion en segundo plano no hay nada que tomar (el flujo detecta como siempre)", () => {
    expect(takeBackgroundDetection(doc("y").file)).toBeNull();
  });
});

describe("useBackgroundDetection — campos de los documentos aun sin abrir", () => {
  it("espera el respiro antes de empezar y no toca el documento activo", async () => {
    const docs = [doc("a"), doc("b"), doc("c")];
    const onDetected = vi.fn();
    renderHook(() =>
      useBackgroundDetection({
        enabled: true,
        docs,
        activeId: "a",
        docStates: states(),
        onDetected,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_DETECTION_DELAY_MS - 50);
    });
    expect(detectFields).not.toHaveBeenCalled();
    await flush();
    expect(calls).not.toContain("a.pdf");
    expect(calls).toEqual(["b.pdf", "c.pdf"]);
  });

  it("de uno en uno y de los mas cercanos al activo a los mas lejanos", async () => {
    const docs = [doc("a"), doc("b"), doc("c"), doc("d")];
    renderHook(() =>
      useBackgroundDetection({
        enabled: true,
        docs,
        activeId: "c",
        docStates: states(),
        onDetected: () => {},
      }),
    );
    await flush();
    await flush();
    expect(maxRunning).toBe(1);
    expect(calls).toEqual(["b.pdf", "d.pdf", "a.pdf"]);
  });

  it("entrega los campos de cada documento con su archivo", async () => {
    const docs = [doc("a"), doc("b")];
    const onDetected = vi.fn();
    renderHook(() =>
      useBackgroundDetection({
        enabled: true,
        docs,
        activeId: "a",
        docStates: states(),
        onDetected,
      }),
    );
    await flush();
    expect(onDetected).toHaveBeenCalledWith("b", docs[1].file, [field("f-b.pdf")]);
  });

  it("no detecta los documentos que ya tienen campos o ya se detectaron", async () => {
    const docs = [doc("a"), doc("b"), doc("c")];
    renderHook(() =>
      useBackgroundDetection({
        enabled: true,
        docs,
        activeId: "a",
        docStates: states({
          b: { textFields: [field("mano")] },
          c: { textFieldsDetectedFor: "huella" },
        }),
        onDetected: () => {},
      }),
    );
    await flush();
    expect(detectFields).not.toHaveBeenCalled();
  });

  it("desactivado (sin lienzo a la vista) no hace nada", async () => {
    const docs = [doc("a"), doc("b")];
    renderHook(() =>
      useBackgroundDetection({
        enabled: false,
        docs,
        activeId: "a",
        docStates: states(),
        onDetected: () => {},
      }),
    );
    await flush();
    expect(detectFields).not.toHaveBeenCalled();
  });

  it("al desmontar cancela lo pendiente: ni empieza la deteccion ni entrega resultados", async () => {
    const docs = [doc("a"), doc("b")];
    const onDetected = vi.fn();
    const { unmount } = renderHook(() =>
      useBackgroundDetection({
        enabled: true,
        docs,
        activeId: "a",
        docStates: states(),
        onDetected,
      }),
    );
    unmount();
    await flush();
    expect(detectFields).not.toHaveBeenCalled();
    expect(onDetected).not.toHaveBeenCalled();
  });

  it("un fallo de deteccion no detiene al resto ni entrega nada del que fallo", async () => {
    vi.mocked(detectFields).mockImplementation(async (file: File) => {
      calls.push(file.name);
      if (file.name === "b.pdf") throw new Error("boom");
      return [field(`f-${file.name}`)];
    });
    const docs = [doc("a"), doc("b"), doc("c")];
    const onDetected = vi.fn();
    renderHook(() =>
      useBackgroundDetection({
        enabled: true,
        docs,
        activeId: "a",
        docStates: states(),
        onDetected,
      }),
    );
    await flush();
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onDetected.mock.calls[0][0]).toBe("c");
  });

  it("al cambiar el activo, el nuevo activo no se detecta aparte y el anterior pasa a ser candidato", async () => {
    const docs = [doc("a"), doc("b")];
    const { rerender } = renderHook(
      ({ active }) =>
        useBackgroundDetection({
          enabled: true,
          docs,
          activeId: active,
          docStates: states(),
          onDetected: () => {},
        }),
      { initialProps: { active: "a" } },
    );
    await flush();
    expect(calls).toEqual(["b.pdf"]);
    rerender({ active: "b" });
    await flush();
    // a.pdf es nuevo candidato; b.pdf (ahora activo) no se repite.
    expect(calls).toEqual(["b.pdf", "a.pdf"]);
  });
});
