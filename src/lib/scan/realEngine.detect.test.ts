import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRequest, TaskResult } from "@/lib/scan/renderTasks";
import type { QuadCorners } from "@/lib/scan/perspective";
import { DEFAULT_SCAN_SETTINGS } from "@/lib/scan/types";

const corners: QuadCorners = { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.1 }, bottomRight: { x: 0.9, y: 0.9 }, bottomLeft: { x: 0.1, y: 0.9 } };
const requests: TaskRequest[] = [];
const enqueueTask = vi.fn(async (request: TaskRequest): Promise<TaskResult> => {
  requests.push(request);
  if (request.kind === "detect") return { kind: "detect", corners };
  return {
    kind: "render",
    processed: null,
    processedSize: null,
    thumb: null,
    resolved: "original",
    quality: null,
    signature: null,
    pixels: null,
    sourceSize: { width: 100, height: 100 },
    passthrough: false,
    jpegSample: null,
  };
});
vi.mock("@/lib/scan/renderBrowser", () => ({ enqueueTask: (...args: unknown[]) => (enqueueTask as (...a: unknown[]) => unknown)(...args), ScanCancelled: class extends Error {} }));
vi.mock("@/lib/scan/renderIO", () => ({ readDisplaySize: async () => null }));

import { realEngine } from "@/lib/scan/realEngine";

describe("crear una pagina: la deteccion va al worker — src/lib/scan/realEngine.ts", () => {
  beforeEach(() => {
    requests.length = 0;
    enqueueTask.mockClear();
  });

  it("una sola tarea «detect» con el modo de la pagina y el token que reusa el render; las esquinas hallan su sitio en la pagina", async () => {
    const page = await realEngine.createPage(new Blob(["x"]), { source: "file", mode: "receipt", settings: DEFAULT_SCAN_SETTINGS });
    expect(requests.map((request) => request.kind)).toEqual(["detect", "render"]);
    const detect = requests[0];
    const render = requests[1];
    if (detect.kind !== "detect" || render.kind !== "render") throw new Error("tareas inesperadas");
    expect(detect.mode).toBe("receipt");
    expect(detect.maxSide).toBe(800);
    expect(render.token).toBe(detect.token);
    expect(page.corners).toEqual(corners);
    expect(render.job.corners).toEqual(corners);
  });

  it("el modo foto no recorta: no se pide detectar", async () => {
    const page = await realEngine.createPage(new Blob(["x"]), { source: "file", mode: "photo", settings: DEFAULT_SCAN_SETTINGS });
    expect(requests.map((request) => request.kind)).toEqual(["render"]);
    expect(page.corners).toBeNull();
  });
});
