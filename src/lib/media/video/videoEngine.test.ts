import { describe, expect, it, vi } from "vitest";
import { createVideoEngine } from "@/lib/media/video/videoEngine";
import type { ConversionPlan } from "@/lib/media/video/plan";
import type { VideoInfo } from "@/lib/media/video/types";
import type { WorkerRequest, WorkerResponse } from "@/lib/media/video/workerProtocol";

/** Worker simulado: responde lo que le diga `behave` a cada peticion. */
class FakeWorker extends EventTarget {
  terminated = false;
  posted: WorkerRequest[] = [];
  constructor(private behave: (request: WorkerRequest, reply: (response: WorkerResponse) => void, fail: () => void) => void) {
    super();
  }
  postMessage(message: WorkerRequest) {
    this.posted.push(message);
    queueMicrotask(() =>
      this.behave(
        message,
        (response) => this.dispatchEvent(new MessageEvent("message", { data: response })),
        () => this.dispatchEvent(new Event("error")),
      ),
    );
  }
  terminate() {
    this.terminated = true;
  }
}

const INFO = { container: "MP4", duration: 3, width: 640, height: 360 } as VideoInfo;
const PLAN = { mime: "video/webm" } as ConversionPlan;
const file = new File(["x"], "clip.mp4", { type: "video/mp4" });

describe("createVideoEngine · con worker", () => {
  it("lee la cabecera en el worker", async () => {
    const worker = new FakeWorker((request, reply) => reply({ type: "probed", id: (request as { id: number }).id, info: INFO }));
    const engine = createVideoEngine({ workerFactory: () => worker as unknown as Worker });
    await expect(engine.probe(file)).resolves.toEqual(INFO);
    expect(worker.posted[0].type).toBe("probe");
  });

  it("convierte, repite el progreso real y entrega un Blob con el tipo del formato", async () => {
    const worker = new FakeWorker((request, reply) => {
      const id = (request as { id: number }).id;
      reply({ type: "progress", id, progress: 0.25, seconds: 1 });
      reply({ type: "progress", id, progress: 0.75, seconds: 2 });
      reply({ type: "converted", id, buffer: new ArrayBuffer(8), audioDropped: true });
    });
    const engine = createVideoEngine({ workerFactory: () => worker as unknown as Worker });
    const seen: number[] = [];
    const result = await engine.convert(file, PLAN, { signal: new AbortController().signal, onProgress: (progress) => seen.push(progress) });
    expect(seen).toEqual([0.25, 0.75]);
    expect(result.blob.type).toBe("video/webm");
    expect(result.blob.size).toBe(8);
    expect(result.audioDropped).toBe(true);
  });

  it("ignora respuestas de otra peticion", async () => {
    const worker = new FakeWorker((request, reply) => {
      const id = (request as { id: number }).id;
      reply({ type: "converted", id: id + 99, buffer: new ArrayBuffer(1), audioDropped: false });
      reply({ type: "converted", id, buffer: new ArrayBuffer(5), audioDropped: false });
    });
    const engine = createVideoEngine({ workerFactory: () => worker as unknown as Worker });
    const result = await engine.convert(file, PLAN, { signal: new AbortController().signal, onProgress: () => {} });
    expect(result.blob.size).toBe(5);
  });

  it("un fallo del worker llega como VideoError con su codigo", async () => {
    const worker = new FakeWorker((request, reply) => reply({ type: "failed", id: (request as { id: number }).id, code: "noVideoTrack", message: "x" }));
    const engine = createVideoEngine({ workerFactory: () => worker as unknown as Worker });
    await expect(engine.probe(file)).rejects.toMatchObject({ name: "VideoError", code: "noVideoTrack" });
  });

  it("cancelar termina el worker en el acto y rechaza con «cancelled»", async () => {
    const worker = new FakeWorker(() => {
      /* nunca contesta: la conversion sigue en marcha */
    });
    const engine = createVideoEngine({ workerFactory: () => worker as unknown as Worker });
    const controller = new AbortController();
    const pending = engine.convert(file, PLAN, { signal: controller.signal, onProgress: () => {} });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(worker.terminated).toBe(true);
  });

  it("tras cancelar, la siguiente operacion crea un worker nuevo", async () => {
    const created: FakeWorker[] = [];
    const factory = () => {
      const worker = new FakeWorker((request, reply) => {
        if (request.type === "probe") reply({ type: "probed", id: request.id, info: INFO });
      });
      created.push(worker);
      return worker as unknown as Worker;
    };
    const engine = createVideoEngine({ workerFactory: factory });
    const controller = new AbortController();
    const pending = engine.convert(file, PLAN, { signal: controller.signal, onProgress: () => {} });
    controller.abort();
    await pending.catch(() => {});
    await expect(engine.probe(file)).resolves.toEqual(INFO);
    expect(created).toHaveLength(2);
    expect(created[0].terminated).toBe(true);
  });

  it("una senal ya abortada ni siquiera manda la peticion", async () => {
    const worker = new FakeWorker(() => {});
    const engine = createVideoEngine({ workerFactory: () => worker as unknown as Worker });
    const controller = new AbortController();
    controller.abort();
    await expect(engine.convert(file, PLAN, { signal: controller.signal, onProgress: () => {} })).rejects.toMatchObject({ code: "cancelled" });
    expect(worker.posted).toHaveLength(0);
  });

  it("dispose termina el worker", async () => {
    const worker = new FakeWorker((request, reply) => reply({ type: "probed", id: (request as { id: number }).id, info: INFO }));
    const engine = createVideoEngine({ workerFactory: () => worker as unknown as Worker });
    await engine.probe(file);
    engine.dispose();
    expect(worker.terminated).toBe(true);
  });
});

describe("createVideoEngine · sin worker", () => {
  it("si el worker no se puede crear, usa el hilo principal (mismo motor) y no vuelve a intentarlo", async () => {
    const core = await import("@/lib/media/video/convertCore");
    const probe = vi.spyOn(core, "probeVideo").mockResolvedValue(INFO);
    const factory = vi.fn(() => {
      throw new Error("sin workers");
    });
    const engine = createVideoEngine({ workerFactory: factory });
    await expect(engine.probe(file)).resolves.toEqual(INFO);
    await expect(engine.probe(file)).resolves.toEqual(INFO);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2);
    probe.mockRestore();
  });

  it("si el worker falla al CARGAR (error antes de contestar), sigue en el hilo principal", async () => {
    const core = await import("@/lib/media/video/convertCore");
    const probe = vi.spyOn(core, "probeVideo").mockResolvedValue(INFO);
    const worker = new FakeWorker((_request, _reply, fail) => fail());
    const engine = createVideoEngine({ workerFactory: () => worker as unknown as Worker });
    await expect(engine.probe(file)).resolves.toEqual(INFO);
    expect(worker.terminated).toBe(true);
    probe.mockRestore();
  });

  it("la conversion en el hilo principal tambien entrega un Blob y respeta la cancelacion previa", async () => {
    const core = await import("@/lib/media/video/convertCore");
    const convert = vi.spyOn(core, "convertVideo").mockResolvedValue({ buffer: new ArrayBuffer(4), audioDropped: false });
    const engine = createVideoEngine({ inline: true });
    const result = await engine.convert(file, PLAN, { signal: new AbortController().signal, onProgress: () => {} });
    expect(result.blob.size).toBe(4);
    expect(result.blob.type).toBe("video/webm");
    convert.mockRestore();
  });
});
