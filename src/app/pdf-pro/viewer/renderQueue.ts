/*
 * Cola de renders del visor (Wave 7 · U3): concurrencia limitada, prioridad por cercania a la pagina
 * central y cancelacion real. Modulo puro (sin React ni pdf.js): `run` recibe un `AbortSignal` que se
 * dispara si el trabajo deja de interesar (la pagina salio de la ventana, cambio el zoom, se cerro el
 * documento) y debe cancelar el render de pdf.js.
 */

export type RenderJob<T> = {
  /** Identifica el trabajo: pedir la misma clave dos veces no lo duplica. */
  key: string;
  /** Menor = antes (distancia a la pagina central). */
  priority: number;
  run: (signal: AbortSignal) => Promise<T>;
  onDone: (result: T) => void;
  onError?: (error: unknown) => void;
};

type Entry = {
  job: RenderJob<unknown>;
  controller: AbortController;
  state: "pending" | "running";
};

export class RenderQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly concurrency: number;
  private running = 0;
  private disposed = false;

  constructor(concurrency = 2) {
    this.concurrency = Math.max(1, concurrency);
  }

  get runningCount(): number {
    return this.running;
  }

  get pendingCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.state === "pending") n += 1;
    return n;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Fija el conjunto de trabajos que interesan AHORA: los demas (pendientes o en curso) se cancelan, los que
   * ya estaban se conservan (con su prioridad nueva) y los nuevos se encolan.
   */
  retarget<T>(wanted: readonly RenderJob<T>[]): void {
    if (this.disposed) return;
    const keep = new Set(wanted.map((job) => job.key));
    for (const [key, entry] of [...this.entries]) {
      if (!keep.has(key)) this.cancel(key, entry);
    }
    for (const job of wanted) {
      const existing = this.entries.get(job.key);
      if (existing) existing.job = job as RenderJob<unknown>;
      else this.entries.set(job.key, { job: job as RenderJob<unknown>, controller: new AbortController(), state: "pending" });
    }
    this.pump();
  }

  /** Cancela todo (cierre del documento o desmontaje). */
  cancelAll(): void {
    for (const [key, entry] of [...this.entries]) this.cancel(key, entry);
  }

  dispose(): void {
    this.cancelAll();
    this.disposed = true;
  }

  private cancel(key: string, entry: Entry): void {
    this.entries.delete(key);
    if (entry.state === "running") entry.controller.abort();
  }

  private pump(): void {
    while (!this.disposed && this.running < this.concurrency) {
      let next: Entry | null = null;
      for (const entry of this.entries.values()) {
        if (entry.state !== "pending") continue;
        if (!next || entry.job.priority < next.job.priority) next = entry;
      }
      if (!next) return;
      this.start(next);
    }
  }

  private start(entry: Entry): void {
    entry.state = "running";
    this.running += 1;
    const { job, controller } = entry;
    void (async () => {
      try {
        const result = await job.run(controller.signal);
        // Si se cancelo (o se sustituyo) mientras corria, su resultado ya no interesa.
        if (!controller.signal.aborted && this.entries.get(job.key) === entry) {
          this.entries.delete(job.key);
          job.onDone(result);
        }
      } catch (error) {
        if (!controller.signal.aborted && this.entries.get(job.key) === entry) {
          this.entries.delete(job.key);
          job.onError?.(error);
        }
      } finally {
        if (this.entries.get(job.key) === entry) this.entries.delete(job.key);
        this.running -= 1;
        this.pump();
      }
    })();
  }
}
