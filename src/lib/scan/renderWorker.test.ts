import { beforeEach, describe, expect, it, vi } from "vitest";

const preloadDocumentDetection = vi.fn();
vi.mock("@/lib/scan/documentDetection", () => ({ preloadDocumentDetection: () => preloadDocumentDetection() }));
const runTask = vi.fn(async () => ({ kind: "detect" as const, corners: null }));
vi.mock("@/lib/scan/renderTasks", () => ({ runTask: (...args: unknown[]) => (runTask as (...a: unknown[]) => unknown)(...args) }));

type Handler = (event: { data: unknown }) => void;

describe("Web Worker del procesado — src/lib/scan/renderWorker.ts", () => {
  const posted: unknown[] = [];
  let scope: { onmessage: Handler | null; postMessage: (message: unknown) => void };

  beforeEach(async () => {
    vi.resetModules();
    posted.length = 0;
    preloadDocumentDetection.mockClear();
    runTask.mockClear();
    scope = { onmessage: null, postMessage: (message) => void posted.push(message) };
    vi.stubGlobal("self", scope);
    await import("@/lib/scan/renderWorker");
  });

  it("{ warm: true } precarga el detector (scanic) y no ejecuta ninguna tarea ni responde", () => {
    scope.onmessage?.({ data: { warm: true } });
    expect(preloadDocumentDetection).toHaveBeenCalledTimes(1);
    expect(runTask).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it("una tarea se ejecuta y se responde con su id", async () => {
    scope.onmessage?.({ data: { id: 7, request: { kind: "detect" } } });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ id: 7, ok: true, result: { kind: "detect", corners: null } });
    expect(preloadDocumentDetection).not.toHaveBeenCalled();
  });
});
