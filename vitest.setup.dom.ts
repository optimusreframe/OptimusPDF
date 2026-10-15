import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";

/**
 * Plazo por defecto de `waitFor` / `findBy*` / `waitForElementToBeRemoved`.
 *
 * Testing Library lo deja en 1000 ms. En esta suite hay ~17 workers de
 * jsdom a la vez y flujos que encadenan varios efectos asincronos (carga
 * del PDF, miniaturas, autoguardado en IndexedDB falso, foco tras
 * desmontar), asi que con la maquina cargada un `waitFor` que en reposo
 * resuelve en 100-400 ms llega a necesitar mas de 1 s y fallaba de forma
 * intermitente. El plazo SOLO es el techo de espera: un `waitFor` que se
 * cumple vuelve en el primer intento que lo ve cumplido, asi que subirlo
 * no alarga ninguna ejecucion correcta, solo retrasa el fallo cuando de
 * verdad nunca ocurre. Los `waitFor` que ya fijan su `timeout` lo conservan.
 */
configure({ asyncUtilTimeout: 10_000 });

/**
 * Las animaciones de `motion` (muelles de Sheet, salidas de AnimatePresence,
 * barras, etc.) tardan ~1 s de tiempo REAL en asentarse (el muelle
 * `gentle` de la Sheet, p. ej., ~1030-1100 ms), justo el plazo por defecto
 * de `waitFor`, y se estiran mas con la CPU cargada: los tests que esperan
 * una salida animada para comprobar foco/ARIA/desmontaje pasaban rozando el
 * limite. Con `skipAnimations` cada animacion salta a su estado final en el
 * siguiente frame: se conserva el orden de eventos (la salida sigue
 * terminando de forma asincrona, `onExitComplete` se sigue disparando y el
 * desmontaje ocurre despues), pero ya no depende de cuanto tarde el muelle.
 *
 * Los pocos tests que prueban una animacion A MEDIAS (agarrar una hoja
 * mientras se cierra, el propio motor en `motion.reduced.test.tsx`) lo
 * desactivan localmente y lo restauran al terminar.
 */
MotionGlobalConfig.skipAnimations = true;

/**
 * Piezas que jsdom no implementa y de las que dependen los componentes
 * del lienzo (`FieldPlacer`, `EditCanvas`, `SignaturePlacer`): captura de
 * puntero y `ResizeObserver`. Sin ellas cualquier `pointerdown` revienta
 * antes de llegar a la logica que se quiere comprobar.
 */

if (!Element.prototype.setPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function setPointerCapture(id: number) {
    const set = captured.get(this) ?? new Set<number>();
    set.add(id);
    captured.set(this, set);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(
    id: number,
  ) {
    captured.get(this)?.delete(id);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(
    id: number,
  ) {
    return captured.get(this)?.has(id) ?? false;
  };
}

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
}

/**
 * Node 22+ define `localStorage`/`sessionStorage` como globales propias
 * (detras de `--localstorage-file`) y esas globales tapan la
 * implementacion real de jsdom en `window.localStorage`: cualquier
 * acceso revienta con "Cannot read properties of undefined". Se
 * reemplaza por un Storage en memoria de verdad para que el codigo bajo
 * prueba (drafts, historial de valores, ajustes) pueda usarlo tal cual
 * lo haria en un navegador real.
 */
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

for (const key of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(window, key, {
    value: createMemoryStorage(),
    writable: true,
    configurable: true,
  });
}

afterEach(cleanup);

/**
 * La sesion de Firmar vive en la direccion (`/sign-pdf?s=<id>`, F0 · U0.3) y jsdom conserva `window.location` entre los
 * casos de un mismo archivo: sin esto, un caso que dejo trabajo en pantalla haria que el SIGUIENTE montase la herramienta
 * y restaurase su borrador (lo mismo que hace una recarga real). Cada caso empieza en `/`, como una pestana nueva.
 */
afterEach(() => {
  window.history.replaceState(null, "", "/");
});
