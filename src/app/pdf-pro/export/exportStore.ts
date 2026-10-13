import type { Language } from "@/lib/i18n";
import { downloadBlob, toPdfError, type PdfErrorCode } from "@/lib/pdf/core";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import type { ExportFormatId } from "@/app/pdf-pro/export/exportTypes";
import type { ProExport } from "@/app/pdf-pro/ops/proExports";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

/**
 * Estado y motor de la EXPORTACION de PDF Pro (Wave 9 · «exportacion persistente»).
 *
 * Antes la exportacion vivia en la tarjeta de «Convertir»: cambiar de pestaña la desmontaba y la cancelaba. Ahora vive
 * AQUI, en un nivel estable por encima de las pestañas (un almacen por documento de trabajo, como `getPagesStore`):
 * la exportacion sigue corriendo mientras el usuario cambia de pestaña, abre un modo o navega por Paginas; al volver a
 * «Convertir» la tarjeta lee de aqui el progreso o el resultado, y el indicador de la barra superior (`ExportIndicator`)
 * la muestra, y permite cancelarla, desde cualquier pestaña. Modulo sin React: `useExportStore` lo conecta.
 *
 * REGLAS (cada una con su prueba en `exportStore.test.ts`):
 *  1. COPIA FIJA. Al empezar se toma el snapshot ACTUAL (bytes, `File`, nombre, etiqueta de la version) y se retiene
 *     hasta que acabe: aunque el usuario aplique otra operacion, deshaga o el historial recorte/vuelque ese paso, el
 *     resultado es de la version de inicio y asi lo dice (`versionLabel`). Se retiene el `Uint8Array`, no el objeto
 *     `ProSnapshot`: el historial vacia su `bytes` al volcarlo a disco.
 *  2. UNA a la vez. `start` con otra en curso devuelve `busy` (la interfaz explica que hay que esperar o cancelar).
 *  3. Sin carreras: terminar y cancelar pasan por la MISMA compuerta (`phase === "running"` del trabajo vigente), asi
 *     que gana el primero que llega, de forma determinista; nunca hay doble descarga ni descarga tras cancelar.
 *  4. El documento manda. Cerrar el documento, abrir otro o descartar cancela la exportacion y borra su estado (el
 *     almacen escucha al documento de trabajo): nunca queda un motor huerfano ni una descarga de otro documento.
 *  5. Terminada (hecha, con error o cancelada) suelta los bytes y el `File`: solo queda el texto del resultado.
 */

export type ExportJobPhase = "running" | "done" | "error" | "cancelled";

/** Lo que la interfaz ve de una exportacion (sin bytes: esos viven en `ExportStore.active`). */
export type ExportJob = {
  /** Numero creciente: identifica ESTA exportacion (carreras entre terminar, cancelar y empezar otra). */
  id: number;
  formatId: ExportFormatId;
  phase: ExportJobPhase;
  /** 0..1, redondeado al 1 % (el almacen solo avisa cuando cambia el porcentaje). */
  progress: number;
  /** Documento de trabajo del que sale (`ProDocument.id`). */
  docId: string;
  /** Snapshot del que sale la exportacion (puede dejar de ser el actual mientras corre). */
  snapshotId: string;
  /** Etiqueta de esa version («Original», «Rotar 90°»). */
  versionLabel: string;
  /** Nombre del archivo generado (`done`). */
  filename: string | null;
  /** Error tipado (`error`); `errorCopy` lo traduce. */
  error: PdfErrorCode | null;
};

export type ExportStoreState = {
  job: ExportJob | null;
  /**
   * Opciones elegidas por formato. Viven aqui (no en la tarjeta) para que sobrevivan a cambiar de pestaña: al volver,
   * la tarjeta que esta exportando muestra las opciones con las que se lanzo. Se reinician con el documento.
   */
  options: Readonly<Record<string, unknown>>;
};

export type StartExportRequest = {
  entry: ProExport;
  options: unknown;
  /** Paginas elegidas en el visor/organizador AHORA (0-based). */
  selectedPages: readonly number[];
  language: Language;
};

export type StartExportResult = { ok: true; jobId: number } | { ok: false; reason: "busy" | "noDocument" | "unsupported" };

/** Lo que se retiene mientras corre (no es estado de React: nada lo lee salvo el propio motor). */
type ActiveExport = {
  job: ExportJob;
  controller: AbortController;
  bytes: Uint8Array;
  file: File;
};

const EMPTY_STATE: ExportStoreState = { job: null, options: {} };

export class ExportStore {
  private state: ExportStoreState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private active: ActiveExport | null = null;
  private nextJobId = 0;
  private docId: string | null;
  private language: Language = "es";
  private views = 0;
  private readonly unwatch: () => void;

  constructor(private readonly doc: ProWorkingDoc) {
    this.docId = doc.getState().document?.id ?? null;
    // El documento manda (regla 4): cada cambio de documento (cerrar, abrir otro, descartar) pasa por aqui.
    this.unwatch = doc.subscribe(() => this.onDocumentChange());
  }

  /* ---------------- suscripcion (useSyncExternalStore) ---------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): ExportStoreState => this.state;

  private set(next: ExportStoreState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Idioma de los anuncios que el almacen hace por su cuenta (el de cada exportacion lo fija `start`). */
  setLanguage(language: Language): void {
    this.language = language;
  }

  /**
   * La pestaña «Convertir» esta montada: ella muestra el error de una exportacion fallida (con su propia alerta). Sin
   * ninguna a la vista, el almacen lo anuncia en la region viva. Devuelve la funcion que lo retira.
   */
  registerView(): () => void {
    this.views += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.views -= 1;
    };
  }

  /* ---------------- opciones por formato ---------------- */

  /** Fusiona `patch` en las opciones de ese formato (`base` = las actuales o las de por defecto). */
  setOptions(formatId: string, base: unknown, patch: Record<string, unknown>): void {
    const current = this.state.options[formatId] ?? base;
    this.set({
      ...this.state,
      options: { ...this.state.options, [formatId]: { ...(current as Record<string, unknown>), ...patch } },
    });
  }

  /* ---------------- ciclo de una exportacion ---------------- */

  /** `true` mientras una exportacion corre. */
  get running(): boolean {
    return this.active !== null && this.active.job.phase === "running";
  }

  /** La exportacion en curso (o `null`). */
  get runningJob(): ExportJob | null {
    return this.running ? this.active!.job : null;
  }

  /**
   * Empieza una exportacion del snapshot ACTUAL. Sincrono hasta que el motor arranca: dos pulsaciones seguidas no
   * pueden lanzar dos motores (la segunda ve `busy`).
   */
  start(request: StartExportRequest): StartExportResult {
    const { entry } = request;
    const run = entry.run;
    if (!run) return { ok: false, reason: "unsupported" };
    if (this.running) return { ok: false, reason: "busy" };
    const document = this.doc.getState().document;
    const snapshot = this.doc.currentSnapshot();
    const bytes = snapshot?.bytes;
    const file = this.doc.currentFile();
    // El snapshot actual nunca esta volcado a disco: sus bytes son el PDF entero. Vacio = no hay nada que exportar.
    if (!document || !snapshot || !bytes || bytes.byteLength === 0 || !file) return { ok: false, reason: "noDocument" };

    const formatId = entry.id as ExportFormatId;
    this.language = request.language;
    const job: ExportJob = {
      id: (this.nextJobId += 1),
      formatId,
      phase: "running",
      progress: 0,
      docId: document.id,
      snapshotId: snapshot.id,
      versionLabel: snapshot.label,
      filename: null,
      error: null,
    };
    const active: ActiveExport = { job, controller: new AbortController(), bytes, file };
    this.active = active;
    this.set({ ...this.state, job });

    const name = document.name;
    const pageCount = snapshot.pageCount;
    void (async () => {
      try {
        const result = await run.call(entry, bytes, {
          name,
          language: request.language,
          signal: active.controller.signal,
          onProgress: (value) => this.progress(job.id, value),
          options: request.options,
          selectedPages: request.selectedPages,
          pageCount,
          file,
        });
        this.finish(job.id, { kind: "result", blob: result.blob, filename: result.filename });
      } catch (caught) {
        this.finish(job.id, { kind: "failed", caught });
      }
    })();
    return { ok: true, jobId: job.id };
  }

  /** Cancela la exportacion en curso y lo anuncia. Devuelve `false` si no habia ninguna que cancelar. */
  cancel(): boolean {
    const active = this.active;
    if (!active || active.job.phase !== "running") return false;
    active.controller.abort();
    this.settle(active, { ...active.job, phase: "cancelled" });
    this.doc.announce(getExportStrings(this.language).card.cancelled);
    return true;
  }

  /**
   * Aborta lo que corra y olvida el trabajo (terminado o no) SIN anunciar nada: lo usa el cierre/cambio de documento,
   * que ya se anuncia por su cuenta («Documento cerrado»), y tras confirmar la hoja de «se cancelara la exportacion».
   */
  discard(): void {
    this.active?.controller.abort();
    this.active = null;
    if (this.state.job !== null) this.set({ ...this.state, job: null });
  }

  /** Cierra el aviso de una exportacion TERMINADA (error, cancelada o hecha). No toca una que corre. */
  dismiss(): void {
    if (this.state.job && this.state.job.phase !== "running") this.set({ ...this.state, job: null });
  }

  /** Suelta el almacen (el documento de trabajo se descarta): aborta y deja de escuchar. */
  dispose(): void {
    this.unwatch();
    this.discard();
  }

  /* ---------------- internos ---------------- */

  private progress(jobId: number, value: number): void {
    const active = this.active;
    if (!active || active.job.id !== jobId || active.job.phase !== "running") return;
    const next = Math.min(100, Math.max(0, Math.round((Number.isFinite(value) ? value : 0) * 100))) / 100;
    if (next === active.job.progress) return;
    active.job = { ...active.job, progress: next };
    this.set({ ...this.state, job: active.job });
  }

  /**
   * Compuerta unica de la regla 3: solo el trabajo VIGENTE y todavia `running` puede terminar. Cancelar, cerrar el
   * documento o empezar otro lo dejan fuera, asi un resultado tardio no descarga nada.
   */
  private finish(
    jobId: number,
    outcome: { kind: "result"; blob: Blob; filename: string } | { kind: "failed"; caught: unknown },
  ): void {
    const active = this.active;
    if (!active || active.job.id !== jobId || active.job.phase !== "running") return;
    const own = getExportStrings(this.language);
    const format = own.formatsShort[active.job.formatId];
    if (outcome.kind === "result") {
      try {
        downloadBlob(outcome.blob, outcome.filename);
      } catch (caught) {
        this.fail(active, caught, own.notices.failedAway(format));
        return;
      }
      this.settle(active, { ...active.job, phase: "done", progress: 1, filename: outcome.filename });
      this.doc.announce(own.card.done(outcome.filename));
      return;
    }
    this.fail(active, outcome.caught, own.notices.failedAway(format));
  }

  private fail(active: ActiveExport, caught: unknown, awayNotice: string): void {
    const code = toPdfError(caught).code;
    if (code === "cancelled" || active.controller.signal.aborted) {
      this.settle(active, { ...active.job, phase: "cancelled" });
      this.doc.announce(getExportStrings(this.language).card.cancelled);
      return;
    }
    this.settle(active, { ...active.job, phase: "error", error: code });
    // Con la pestaña «Convertir» a la vista, su alerta ya lo anuncia; sin ella nadie lo diria.
    if (this.views === 0) this.doc.announce(awayNotice);
  }

  /** Pasa el trabajo a un estado final y SUELTA los bytes y el `File`. */
  private settle(active: ActiveExport, job: ExportJob): void {
    if (this.active === active) this.active = null;
    this.set({ ...this.state, job });
  }

  private onDocumentChange(): void {
    const id = this.doc.getState().document?.id ?? null;
    if (id === this.docId) return;
    this.docId = id;
    // Otro documento (o ninguno): la exportacion y las opciones elegidas eran del anterior.
    this.active?.controller.abort();
    this.active = null;
    this.set(EMPTY_STATE);
  }

  /** Solo para pruebas: ¿se retiene aun el snapshot de la exportacion? */
  heldBytesForTests(): Uint8Array | null {
    return this.active?.bytes ?? null;
  }
}

const stores = new WeakMap<ProWorkingDoc, ExportStore>();

/** El almacen de exportacion de ese documento de trabajo (uno por instancia; sobrevive a cambiar de pestaña). */
export function getExportStore(doc: ProWorkingDoc): ExportStore {
  let store = stores.get(doc);
  if (!store) {
    store = new ExportStore(doc);
    stores.set(doc, store);
  }
  return store;
}
