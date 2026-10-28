import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuadCorners } from "@/lib/scan/perspective";

const decodeToRgba = vi.fn(async () => ({ data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 }));
vi.mock("@/lib/scan/renderIO", () => ({ decodeToRgba: (...args: unknown[]) => (decodeToRgba as (...a: unknown[]) => unknown)(...args), encodeRgba: vi.fn(), readDisplaySize: vi.fn(), reencodedSizes: vi.fn() }));
const corners: QuadCorners = { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.1 }, bottomRight: { x: 0.9, y: 0.9 }, bottomLeft: { x: 0.1, y: 0.9 } };
const findDocumentCorners = vi.fn(async (): Promise<QuadCorners | null> => corners);
vi.mock("@/lib/scan/findCorners", () => ({ findDocumentCorners: (...args: unknown[]) => (findDocumentCorners as (...a: unknown[]) => Promise<QuadCorners | null>)(...args) }));

import { runTask } from "@/lib/scan/renderTasks";

describe("tarea «detect» — src/lib/scan/renderTasks.ts", () => {
  beforeEach(() => {
    decodeToRgba.mockClear();
    findDocumentCorners.mockClear();
  });

  it("decodifica reducido, busca el documento con el modo y la cesion del llamador y devuelve SOLO las esquinas (ningun pixel)", async () => {
    const yielding = vi.fn();
    const source = new Blob(["x"]);
    const result = await runTask({ kind: "detect", source, maxSide: 800, mode: "receipt", token: "p1:detect" }, { yield: yielding });
    expect(result).toEqual({ kind: "detect", corners });
    expect(decodeToRgba).toHaveBeenCalledWith(source, 800, undefined);
    expect(findDocumentCorners).toHaveBeenCalledWith(expect.objectContaining({ width: 4, height: 4 }), "receipt", yielding);
    expect(Object.keys(result)).toEqual(["kind", "corners"]);
  });

  it("la imagen decodificada queda en cache bajo el token: el render siguiente de la misma pagina NO la decodifica otra vez", async () => {
    const source = new Blob(["x"]);
    await runTask({ kind: "detect", source, maxSide: 800, mode: "document", token: "p9:detect" });
    expect(decodeToRgba).toHaveBeenCalledTimes(1);
    const render = await runTask({
      kind: "render",
      source,
      job: { corners: null, rotation: 0, filter: "original", adjust: { brightness: 0, contrast: 0 }, mode: "document", maxSide: 100 },
      decodeMax: 1280,
      token: "p9:detect",
      thumbSide: null,
      encodeProcessed: false,
      measure: false,
      signature: false,
    });
    expect(render.kind).toBe("render");
    expect(decodeToRgba).toHaveBeenCalledTimes(1);
  });

  it("sin documento devuelve corners null", async () => {
    findDocumentCorners.mockResolvedValueOnce(null);
    expect(await runTask({ kind: "detect", source: new Blob(["x"]), maxSide: 800, mode: "document", token: "p2:detect" })).toEqual({ kind: "detect", corners: null });
  });

  it("una tarea ya abortada no decodifica ni detecta", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runTask({ kind: "detect", source: new Blob(["x"]), maxSide: 800, mode: "document", token: "p3:detect" }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(decodeToRgba).not.toHaveBeenCalled();
    expect(findDocumentCorners).not.toHaveBeenCalled();
  });
});
