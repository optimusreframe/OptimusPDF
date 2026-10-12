import { describe, expect, it, vi } from "vitest";
import { RenderQueue, type RenderJob } from "@/app/pdf-pro/viewer/renderQueue";

/** Un trabajo que se resuelve a mano (control exacto del orden y de la cancelacion). */
function manualJob(key: string, priority: number, log: string[] = []) {
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const signals: AbortSignal[] = [];
  const done = vi.fn((value: string) => log.push(`done:${value}`));
  const failed = vi.fn();
  const job: RenderJob<string> = {
    key,
    priority,
    run: (signal) => {
      log.push(`start:${key}`);
      signals.push(signal);
      return promise;
    },
    onDone: done,
    onError: failed,
  };
  return { job, resolve, reject, done, failed, signal: () => signals[0] };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("RenderQueue", () => {
  it("nunca ejecuta mas trabajos a la vez que la concurrencia (2)", async () => {
    const queue = new RenderQueue(2);
    const jobs = [0, 1, 2, 3].map((n) => manualJob(`j${n}`, n));
    queue.retarget(jobs.map((j) => j.job));
    await flush();
    expect(queue.runningCount).toBe(2);
    expect(queue.pendingCount).toBe(2);
  });

  it("empieza por la prioridad mas baja (la pagina mas cercana al centro)", async () => {
    const log: string[] = [];
    const queue = new RenderQueue(1);
    const far = manualJob("far", 9, log);
    const near = manualJob("near", 0, log);
    const mid = manualJob("mid", 3, log);
    queue.retarget([far.job, near.job, mid.job]);
    await flush();
    expect(log).toEqual(["start:near"]);
    near.resolve("n");
    await flush();
    expect(log.filter((l) => l.startsWith("start"))).toEqual(["start:near", "start:mid"]);
    mid.resolve("m");
    await flush();
    expect(log.filter((l) => l.startsWith("start"))).toEqual(["start:near", "start:mid", "start:far"]);
  });

  it("al terminar uno arranca el siguiente y entrega el resultado", async () => {
    const queue = new RenderQueue(1);
    const a = manualJob("a", 0);
    const b = manualJob("b", 1);
    queue.retarget([a.job, b.job]);
    await flush();
    a.resolve("A");
    await flush();
    expect(a.done).toHaveBeenCalledWith("A");
    expect(queue.runningCount).toBe(1);
    b.resolve("B");
    await flush();
    expect(b.done).toHaveBeenCalledWith("B");
    expect(queue.runningCount).toBe(0);
    expect(queue.keys()).toEqual([]);
  });

  it("retarget cancela lo que ya no interesa: pendiente (no arranca) y en curso (aborta su senal)", async () => {
    const log: string[] = [];
    const queue = new RenderQueue(1);
    const running = manualJob("running", 0, log);
    const pending = manualJob("pending", 1, log);
    queue.retarget([running.job, pending.job]);
    await flush();
    queue.retarget([]);
    expect(running.signal().aborted).toBe(true);
    expect(queue.keys()).toEqual([]);
    running.resolve("late");
    await flush();
    // El resultado tardio de un trabajo cancelado se ignora.
    expect(running.done).not.toHaveBeenCalled();
    expect(log).toEqual(["start:running"]);
    expect(queue.runningCount).toBe(0);
  });

  it("un trabajo que ya estaba se conserva (no se reinicia ni se duplica) y recibe la prioridad nueva", async () => {
    const log: string[] = [];
    const queue = new RenderQueue(1);
    const a = manualJob("a", 5, log);
    queue.retarget([a.job]);
    await flush();
    queue.retarget([{ ...a.job, priority: 0 }]);
    await flush();
    expect(log.filter((l) => l === "start:a")).toHaveLength(1);
    expect(queue.keys()).toEqual(["a"]);
  });

  it("pedir dos veces la misma clave no la ejecuta dos veces", async () => {
    const log: string[] = [];
    const queue = new RenderQueue(2);
    const a = manualJob("a", 0, log);
    queue.retarget([a.job, a.job]);
    await flush();
    expect(log.filter((l) => l === "start:a")).toHaveLength(1);
  });

  it("un trabajo que falla avisa por onError y libera el hueco", async () => {
    const queue = new RenderQueue(1);
    const bad = manualJob("bad", 0);
    const good = manualJob("good", 1);
    queue.retarget([bad.job, good.job]);
    await flush();
    bad.reject(new Error("boom"));
    await flush();
    expect(bad.failed).toHaveBeenCalledTimes(1);
    expect(queue.runningCount).toBe(1);
    good.resolve("ok");
    await flush();
    expect(good.done).toHaveBeenCalledWith("ok");
  });

  it("un fallo de un trabajo cancelado no se notifica", async () => {
    const queue = new RenderQueue(1);
    const job = manualJob("x", 0);
    queue.retarget([job.job]);
    await flush();
    queue.retarget([]);
    job.reject(new Error("RenderingCancelled"));
    await flush();
    expect(job.failed).not.toHaveBeenCalled();
  });

  it("cancelAll aborta lo que corre y vacia la cola", async () => {
    const queue = new RenderQueue(2);
    const a = manualJob("a", 0);
    const b = manualJob("b", 1);
    const c = manualJob("c", 2);
    queue.retarget([a.job, b.job, c.job]);
    await flush();
    queue.cancelAll();
    expect(a.signal().aborted).toBe(true);
    expect(b.signal().aborted).toBe(true);
    expect(queue.keys()).toEqual([]);
  });

  it("tras dispose ya no acepta trabajos", async () => {
    const queue = new RenderQueue(2);
    queue.dispose();
    const a = manualJob("a", 0);
    queue.retarget([a.job]);
    await flush();
    expect(queue.runningCount).toBe(0);
    expect(queue.keys()).toEqual([]);
  });

  it("se puede volver a pedir una clave cancelada: el resultado viejo no pisa al nuevo", async () => {
    const queue = new RenderQueue(1);
    const first = manualJob("page", 0);
    queue.retarget([first.job]);
    await flush();
    queue.retarget([]);
    const second = manualJob("page", 0);
    queue.retarget([second.job]);
    first.resolve("old");
    await flush();
    expect(first.done).not.toHaveBeenCalled();
    second.resolve("new");
    await flush();
    expect(second.done).toHaveBeenCalledWith("new");
  });

  it("500 trabajos con concurrencia 2: nunca mas de 2 a la vez y salen por prioridad", async () => {
    const queue = new RenderQueue(2);
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const jobs: RenderJob<number>[] = Array.from({ length: 500 }, (_, i) => ({
      key: `p${i}`,
      priority: Math.abs(i - 250),
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(i);
        await Promise.resolve();
        active -= 1;
        return i;
      },
      onDone: () => undefined,
    }));
    queue.retarget(jobs);
    for (let i = 0; i < 600; i += 1) await Promise.resolve();
    await flush();
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(order[0]).toBe(250);
    expect(order).toHaveLength(500);
  });
});
