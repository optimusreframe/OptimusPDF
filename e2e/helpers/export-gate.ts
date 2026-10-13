/**
 * Compuerta de la exportacion de PDF Pro para los E2E (B9).
 *
 * POR QUE EXISTE. Un PDF de 40-60 hojas a 216 DPI se exporta a PNG en ~0,6 s en una maquina normal (15 ms por hoja:
 * son paginas casi vacias). Antes los E2E mantenian la exportacion «en curso» frenando la CPU de la pagina
 * (`Emulation.setCPUThrottlingRate`), pero eso solo la alarga EN PROPORCION a la maquina: x6 son ~4 s, y una prueba que
 * hace tres pasadas de axe, abre y cierra una hoja y luego pulsa «Cancelar» tarda ~6-8 s. Si la exportacion termina
 * antes, el indicador ya no esta y el clic espera 20 s para nada (la carrera es de la PRUEBA, no del producto: la
 * pagina ya mostraba «Exportado: acta-imagenes.zip» y descargo el ZIP).
 *
 * LO QUE HACE. Retiene, DENTRO de la pagina, la devolucion de `HTMLCanvasElement.prototype.toBlob` (la unica espera
 * asincrona por hoja del motor de imagenes): el motor deja pasar `pages` hojas, se queda quieto en la siguiente y no
 * avanza hasta que la prueba lo ordena (`release`/`releaseAll`). Asi la exportacion esta viva tanto tiempo como la
 * prueba necesite, a cualquier velocidad de CPU, y avanza exactamente cuando la prueba lo decide. El producto no se
 * toca (la compuerta solo vive en el contexto de la pagina de la prueba) y el resultado es el mismo: solo se retrasa
 * cuando se entrega cada imagen.
 *
 * `PW_CPU_THROTTLE=4` (opcional) frena ademas la CPU de la pagina: sirve para comprobar que las pruebas siguen
 * pasando en una maquina lenta. No hace falta para que sean deterministas.
 */
import type { Page } from "@playwright/test";
import { expect } from "./tool-flow";

type GateApi = {
  arm: (pages: number) => void;
  release: (pages: number) => void;
  releaseAll: () => void;
  queued: () => number;
  passed: () => number;
};

type GateWindow = Window & { __exportGate?: GateApi };

export type ExportGate = {
  /**
   * (Re)arma la compuerta para la SIGUIENTE exportacion: deja pasar `pages` hojas y retiene el resto. Suelta antes lo
   * que quedara retenido de una exportacion anterior (ya cancelada o cerrada: su motor termina y no descarga nada).
   */
  hold: (pages?: number) => Promise<void>;
  /** Espera a que el motor haya llegado a la compuerta: la exportacion esta en vuelo Y quieta. */
  whenHeld: () => Promise<void>;
  /** Deja avanzar `pages` hojas mas. */
  release: (pages: number) => Promise<void>;
  /** Abre la compuerta del todo: la exportacion corre hasta el final a su ritmo. */
  releaseAll: () => Promise<void>;
  /** Hojas que han pasado la compuerta desde que se armo. */
  passed: () => Promise<number>;
};

/** Parche de `toBlob` (se serializa y corre en la pagina; no puede usar nada de este modulo). */
function install(): void {
  const w = window as unknown as GateWindow;
  if (w.__exportGate) return;
  const original = HTMLCanvasElement.prototype.toBlob;
  const state = { armed: false, tokens: 0, passed: 0, queue: [] as Array<() => void> };
  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement["toBlob"]>) {
    if (!state.armed) return original.apply(this, args);
    const pass = () => {
      state.passed += 1;
      original.apply(this, args);
    };
    if (state.tokens > 0) {
      state.tokens -= 1;
      pass();
    } else state.queue.push(pass);
  };
  const flush = () => {
    while (state.queue.length > 0 && (state.tokens > 0 || !state.armed)) {
      if (state.armed) state.tokens -= 1;
      state.queue.shift()!();
    }
  };
  w.__exportGate = {
    arm: (pages) => {
      state.armed = false;
      flush();
      state.armed = true;
      state.tokens = pages;
      state.passed = 0;
    },
    release: (pages) => {
      state.tokens += pages;
      flush();
    },
    releaseAll: () => {
      state.armed = false;
      flush();
    },
    queued: () => state.queue.length,
    passed: () => state.passed,
  };
}

/**
 * Instala la compuerta en la pagina YA abierta (el parche vive hasta que se recargue) y la arma. Va justo donde antes
 * iba el freno de CPU: despues de abrir el documento y antes de pulsar «Exportar».
 */
export async function holdExport(page: Page, options: { pages?: number } = {}): Promise<ExportGate> {
  await page.evaluate(install);
  const gate: ExportGate = {
    hold: (pages = 2) => page.evaluate((count) => (window as unknown as GateWindow).__exportGate!.arm(count), pages),
    whenHeld: async () => {
      await expect
        .poll(() => page.evaluate(() => (window as unknown as GateWindow).__exportGate!.queued()), {
          message: "la exportacion debe llegar a la compuerta (en vuelo y quieta)",
          timeout: 20_000,
        })
        .toBeGreaterThan(0);
    },
    release: (pages) => page.evaluate((count) => (window as unknown as GateWindow).__exportGate!.release(count), pages),
    releaseAll: () => page.evaluate(() => (window as unknown as GateWindow).__exportGate!.releaseAll()),
    passed: () => page.evaluate(() => (window as unknown as GateWindow).__exportGate!.passed()),
  };
  await gate.hold(options.pages ?? 2);

  const rate = Number(process.env.PW_CPU_THROTTLE ?? 0);
  if (rate > 1) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate });
  }
  return gate;
}
