import type { Page } from "@playwright/test";
import { expect as baseExpect, test } from "../helpers/tool-flow";
import { makePdf } from "../helpers/test-files";
import { es } from "../../src/lib/locales/es";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";

/**
 * PDF Pro · observador FOTOGRAMA A FOTOGRAMA del foco (Wave 7), navegador real y headless.
 *
 * Las pruebas de foco habituales miran el estado tras `await`s, es decir, MUCHOS fotogramas despues de la accion: un foco
 * que cae a <body> un instante y se recupera pasa desapercibido, pero un lector de pantalla lo anuncia y el usuario de
 * teclado lo percibe. Aqui se instala en la pagina un bucle `requestAnimationFrame` que, en CADA fotograma, anota si
 * `document.activeElement` es <body>/<html> (y que elemento lo tiene si no lo es), y se ejecutan x30 repeticiones de:
 *
 *  1. Abrir un documento (`setInputFiles` en el estado vacio): desde el fotograma en que aparece el titulo del
 *     documento, ningun fotograma con el foco en <body> (antes de elegir el archivo el foco puede estar donde sea).
 *  2. Abrir una herramienta de Inicio («Abrir Marca de agua»): desde el clic, el foco pasa a su titulo sin tocar <body>.
 *  3. «Volver a herramientas»: desde el clic, el foco va al boton de esa misma herramienta sin tocar <body>.
 *  4. «Cerrar documento» + confirmar en la hoja: desde que desaparece la suite, el foco esta en la zona de carga del
 *     estado vacio; en ningun fotograma pasa por <body> (ni durante la salida de la hoja).
 *  5-7. Extras con el mismo observador: cancelar la confirmacion de cierre, la paleta y la hoja «Guardar como…»
 *     devuelven el foco al control que los abrio, sin pasar por <body> al cerrarse.
 *
 * Criterio: maximo de fotogramas CONSECUTIVOS con el foco en <body> = 0 en el tramo posterior a la accion. Es la prueba de
 * `useFocusTarget` en `DocumentTab` (abrir y volver) y del `useLayoutEffect` de `ProToolClient` (abrir y cerrar).
 * Tambien hay una prueba de sensibilidad: el observador SI detecta un foco que cae a <body>.
 *
 * Verificado con mutaciones sobre una copia del repositorio: quitar el enfoque sincrono del `useLayoutEffect` de `ProToolClient`
 * (solo reintento con `requestAnimationFrame`) deja 1 fotograma en <body> en CADA repeticion de los flujos 1 y 4, y retrasar
 * 90 ms el foco de `DocumentTab` deja 10-11 fotogramas seguidos en los flujos 2 y 3; las dos mutaciones hacen fallar el spec.
 *
 * Uso: `PW_PORT=3673 npx playwright test e2e/specs/pdf-pro-focus-frames.spec.ts --project=chromium --workers=4`
 */

// Con varios navegadores a la vez los 5 s de `expect` por defecto se quedan cortos al esperar hojas y descargas.
const expect = baseExpect.configure({ timeout: 12_000 });

const S = PRO_STRINGS.es;
const T = S.docTools;
const REPETITIONS = 30;
const DOC_NAME = "informe.pdf";
const TOOL_TITLE = T.tools.watermark.title;

test.use({ locale: "es-ES", actionTimeout: 20_000 });
// Cada prueba abre su propio navegador y no comparte nada con las demas: pueden correr a la vez (`--workers=N`).
test.describe.configure({ mode: "parallel" });

/* ------------------------------------------------------------------ *
 * Observador
 * ------------------------------------------------------------------ */

type Frame = {
  t: number;
  body: boolean;
  active: string;
  title: boolean;
  suite: boolean;
  runner: boolean;
  launcher: boolean;
  empty: boolean;
};
type FocusEvent2 = { t: number; type: "focusin" | "focusout"; target: string; related: string };

type ObserverWindow = Window & {
  __focusFrames?: {
    start: () => void;
    stop: () => { frames: Frame[]; events: FocusEvent2[] };
  };
};

/** Instala el bucle de fotogramas antes de que cargue la pagina. `start()` abre una grabacion; `stop()` la devuelve. */
async function installObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as ObserverWindow;
    if (w.__focusFrames) return;
    let on = false;
    let started = 0;
    let frames: Frame[] = [];
    let events: FocusEvent2[] = [];
    const describe = (element: Element | null): string => {
      if (!element || element === document.body || element === document.documentElement) return "<body>";
      const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 36);
      return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""} «${label}»`;
    };
    const now = () => Math.round(performance.now() - started);
    const tick = () => {
      if (on) {
        const active = document.activeElement;
        frames.push({
          t: now(),
          body: !active || active === document.body || active === document.documentElement,
          active: describe(active),
          // Marcas del DOM de ese fotograma: de ellas se deduce «desde cuando» se exige el foco.
          title: document.querySelector('[data-pro-region="top"] h1') !== null,
          suite: document.querySelector("section[data-pro-suite]") !== null,
          runner: document.querySelector("[data-doc-tool]") !== null,
          launcher: document.querySelector("[data-doc-tool-open]") !== null,
          empty: document.querySelector("[data-pro-new]") !== null,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.addEventListener("focusout", (event) => {
      if (on) events.push({ t: now(), type: "focusout", target: describe(event.target as Element), related: describe(event.relatedTarget as Element | null) });
    }, true);
    document.addEventListener("focusin", (event) => {
      if (on) events.push({ t: now(), type: "focusin", target: describe(event.target as Element), related: describe(event.relatedTarget as Element | null) });
    }, true);
    w.__focusFrames = {
      start: () => {
        frames = [];
        events = [];
        started = performance.now();
        on = true;
      },
      stop: () => {
        on = false;
        return { frames, events: events.slice(-60) };
      },
    };
  });
}

const startRecording = (page: Page): Promise<void> => page.evaluate(() => (window as ObserverWindow).__focusFrames!.start());
const stopRecording = (page: Page): Promise<{ frames: Frame[]; events: FocusEvent2[] }> =>
  page.evaluate(() => (window as ObserverWindow).__focusFrames!.stop());

type Analysis = {
  frames: number;
  scoped: number;
  bodyFrames: number;
  maxRun: number;
  lastActive: string;
  firstScoped: string;
  trail: string;
};

/** Cuenta los fotogramas con foco en <body> a partir del primero que cumple `from` (o desde el principio). */
function analyze(recording: { frames: Frame[]; events: FocusEvent2[] }, from?: (frame: Frame) => boolean): Analysis {
  const { frames } = recording;
  const start = from ? frames.findIndex(from) : 0;
  const scoped = start < 0 ? [] : frames.slice(start);
  let maxRun = 0;
  let run = 0;
  for (const frame of scoped) {
    run = frame.body ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }
  const trail = scoped
    .filter((frame, index) => frame.body || index === 0 || scoped[index - 1].active !== frame.active)
    .slice(0, 14)
    .map((frame) => `${frame.t}ms ${frame.active}`)
    .join(" → ");
  return {
    frames: frames.length,
    scoped: scoped.length,
    bodyFrames: scoped.filter((frame) => frame.body).length,
    maxRun,
    lastActive: frames.at(-1)?.active ?? "(sin fotogramas)",
    firstScoped: scoped[0]?.active ?? "(la condicion nunca se cumplio)",
    trail,
  };
}

const describeFailure = (flow: string, repetition: number, analysis: Analysis, recording: { events: FocusEvent2[] }): string =>
  `${flow} · repeticion ${repetition}: ${analysis.bodyFrames} fotogramas con el foco en <body> (maximo ${analysis.maxRun} seguidos) de ${analysis.scoped}; ` +
  `recorrido del foco: ${analysis.trail}; ultimos eventos: ${recording.events.slice(-6).map((event) => `${event.t}ms ${event.type} ${event.target} → ${event.related}`).join(" | ")}`;

/* ------------------------------------------------------------------ *
 * Ayudas de flujo
 * ------------------------------------------------------------------ */

const emptyStateReady = (page: Page) => page.locator("[data-pro-new]").first();
const openButton = (page: Page) => page.getByRole("button", { name: T.launcher.open(TOOL_TITLE), exact: true });
const toolHeading = (page: Page) => page.getByRole("heading", { level: 2, name: TOOL_TITLE, exact: true });

async function openDoc(page: Page, bytes: Buffer): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles({ name: DOC_NAME, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(DOC_NAME.replace(".", "\\.")) })).toBeVisible();
}

async function gotoEmpty(page: Page): Promise<void> {
  await page.goto("/pdf-pro");
  await expect(emptyStateReady(page)).toBeVisible();
}

const settleFrames = (page: Page, ms = 450): Promise<void> => page.waitForTimeout(ms);

/** Espera a que la hoja superior deje de moverse (la hoja entra con un muelle de ~1 s): solo entonces se confirma o cancela. */
async function waitDialogStill(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toBeVisible();
  let previous = "";
  let same = 0;
  await expect
    .poll(
      async () => {
        const signature = await dialog
          .evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(":") + `|${getComputedStyle(element).opacity}`;
          })
          .catch(() => "");
        same = signature !== "" && signature === previous ? same + 1 : 0;
        previous = signature;
        return same;
      },
      { intervals: [70], timeout: 10_000, message: "la hoja no llega a quedarse quieta" },
    )
    .toBeGreaterThanOrEqual(4);
}

const tally: string[] = [];
function record(flow: string, analyses: Analysis[]): void {
  const frames = analyses.reduce((sum, analysis) => sum + analysis.scoped, 0);
  const body = analyses.reduce((sum, analysis) => sum + analysis.bodyFrames, 0);
  const maxRun = Math.max(0, ...analyses.map((analysis) => analysis.maxRun));
  const line = `[focus-frames] ${flow}: ${analyses.length} repeticiones, ${frames} fotogramas observados tras la accion, ${body} con foco en <body>, maximo ${maxRun} seguidos`;
  tally.push(line);
  console.log(line);
}

/**
 * Espera `count` fotogramas REALES (no milisegundos): en el runner de CI cargado `requestAnimationFrame` se atrasa y en
 * 250 ms el bucle grabo 2 fotogramas, no los >5 que exigen las pruebas de sensibilidad del observador.
 */
const waitAnimationFrames = (page: Page, count: number): Promise<void> =>
  page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        let left = frames;
        const tick = () => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );

/* ------------------------------------------------------------------ *
 * Prueba de sensibilidad del observador
 * ------------------------------------------------------------------ */

test.describe("observador de foco por fotograma", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("es sensible: un control con foco que se retira del DOM deja fotogramas con foco en <body>", async ({ page }) => {
    await installObserver(page);
    await gotoEmpty(page);
    await page.evaluate(() => {
      const probe = document.createElement("button");
      probe.id = "frame-probe";
      probe.textContent = "probe";
      document.body.appendChild(probe);
      probe.focus();
    });
    await startRecording(page);
    await page.evaluate(() => document.getElementById("frame-probe")?.remove());
    await waitAnimationFrames(page, 14);
    const analysis = analyze(await stopRecording(page));
    expect(analysis.frames, "el bucle graba fotogramas").toBeGreaterThan(5);
    expect(analysis.bodyFrames, "el observador ve el foco en <body> tras retirar el control").toBeGreaterThan(5);
    expect(analysis.maxRun).toBeGreaterThan(5);
  });

  test("distingue un foco que se mueve de uno que se pierde: pasar el foco a otro control no deja ningun fotograma en <body>", async ({ page }) => {
    await installObserver(page);
    await gotoEmpty(page);
    await page.evaluate(() => {
      for (const id of ["frame-a", "frame-b"]) {
        const probe = document.createElement("button");
        probe.id = id;
        probe.textContent = id;
        document.body.appendChild(probe);
      }
      document.getElementById("frame-a")!.focus();
    });
    await startRecording(page);
    // Se mueve el foco al hermano y SOLO ENTONCES se retira el primero (la forma correcta de hacerlo).
    await page.evaluate(() => {
      document.getElementById("frame-b")!.focus();
      document.getElementById("frame-a")!.remove();
    });
    await waitAnimationFrames(page, 14);
    const analysis = analyze(await stopRecording(page));
    expect(analysis.frames).toBeGreaterThan(5);
    expect(analysis.bodyFrames).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Los flujos, x30 en escritorio y x15 en movil (barra inferior, hojas y toques)
 * ------------------------------------------------------------------ */

type Mode = { name: string; mobile: boolean; reps: number; extraReps: number; viewport: { width: number; height: number } };
const MODES: Mode[] = [
  { name: "escritorio 1280", mobile: false, reps: REPETITIONS, extraReps: 15, viewport: { width: 1280, height: 800 } },
  { name: "móvil 375 táctil", mobile: true, reps: 15, extraReps: 8, viewport: { width: 375, height: 812 } },
];

/** En movil la barra de la suite no tiene «Cerrar documento» ni «Guardar y exportar»: viven en «Más acciones». */
const moreButton = (page: Page) => page.getByRole("button", { name: S.shell.more, exact: true });

async function press(page: Page, mode: Mode, target: ReturnType<Page["locator"]>): Promise<void> {
  if (mode.mobile) await target.tap();
  else await target.click();
}

/** Boton «Cerrar documento»: escritorio, la barra; movil, el menu «Más acciones». */
async function requestClose(page: Page, mode: Mode): Promise<void> {
  if (!mode.mobile) {
    await press(page, mode, page.getByRole("button", { name: S.suite.close, exact: true }));
    return;
  }
  await press(page, mode, moreButton(page));
  await press(page, mode, page.getByRole("menuitem", { name: S.shell.closeItem }));
}

/** Deja la lista de herramientas de Inicio a la vista (movil: abre la hoja de Inicio de la barra inferior). */
async function showLauncher(page: Page, mode: Mode): Promise<void> {
  if (mode.mobile && (await openButton(page).count()) === 0) {
    await press(page, mode, page.locator('[data-dock="home"]'));
    await waitDialogStill(page);
  }
  await expect(openButton(page)).toBeVisible();
}

for (const mode of MODES) {
  test.describe(`foco fotograma a fotograma · ${mode.name} · x${mode.reps}`, () => {
    test.use({ viewport: mode.viewport, hasTouch: mode.mobile, isMobile: mode.mobile, deviceScaleFactor: mode.mobile ? 2 : 1 });
    test.setTimeout(600_000);

    test(`1 · abrir un documento: desde que aparece el titulo, el foco esta en el titulo y nunca en <body> (x${mode.reps})`, async ({ page }) => {
      const bytes = await makePdf({ pages: 3, label: "PRO" });
      await installObserver(page);
      await gotoEmpty(page);
      const analyses: Analysis[] = [];
      const failures: string[] = [];
      for (let repetition = 1; repetition <= mode.reps; repetition += 1) {
        await startRecording(page);
        await openDoc(page, bytes);
        await settleFrames(page);
        const recording = await stopRecording(page);
        const analysis = analyze(recording, (frame) => frame.title);
        analyses.push(analysis);
        if (analysis.bodyFrames > 0 || !analysis.firstScoped.startsWith("h1")) {
          failures.push(describeFailure(`abrir documento (primer fotograma con titulo: ${analysis.firstScoped})`, repetition, analysis, recording));
        }
        // Cierre SIN cambios: no pide confirmacion.
        await requestClose(page, mode);
        await expect(emptyStateReady(page)).toBeVisible();
      }
      record(`1 abrir documento · ${mode.name}`, analyses);
      expect(failures, failures.join("\n")).toEqual([]);
    });

    test(`2 · abrir una herramienta de Inicio: el foco pasa a su titulo sin tocar <body> (x${mode.reps})`, async ({ page }) => {
      const bytes = await makePdf({ pages: 3, label: "PRO" });
      await installObserver(page);
      await gotoEmpty(page);
      await openDoc(page, bytes);
      await showLauncher(page, mode);
      const analyses: Analysis[] = [];
      const failures: string[] = [];
      for (let repetition = 1; repetition <= mode.reps; repetition += 1) {
        await openButton(page).focus();
        await startRecording(page);
        await press(page, mode, openButton(page));
        await expect(toolHeading(page)).toBeFocused();
        await settleFrames(page, 300);
        const recording = await stopRecording(page);
        const analysis = analyze(recording);
        analyses.push(analysis);
        if (analysis.bodyFrames > 0 || !analysis.lastActive.startsWith("h2")) {
          failures.push(describeFailure(`abrir herramienta (foco final: ${analysis.lastActive})`, repetition, analysis, recording));
        }
        // Vuelta (sin observar): el siguiente ciclo parte de la lista de herramientas.
        await press(page, mode, page.getByRole("button", { name: T.launcher.back, exact: true }));
        await expect(openButton(page)).toBeFocused();
      }
      record(`2 abrir herramienta · ${mode.name}`, analyses);
      expect(failures, failures.join("\n")).toEqual([]);
    });

    test(`3 · «Volver a herramientas»: el foco va al boton de esa misma herramienta sin tocar <body> (x${mode.reps})`, async ({ page }) => {
      const bytes = await makePdf({ pages: 3, label: "PRO" });
      await installObserver(page);
      await gotoEmpty(page);
      await openDoc(page, bytes);
      await showLauncher(page, mode);
      const analyses: Analysis[] = [];
      const failures: string[] = [];
      for (let repetition = 1; repetition <= mode.reps; repetition += 1) {
        await press(page, mode, openButton(page));
        await expect(toolHeading(page)).toBeFocused();
        const back = page.getByRole("button", { name: T.launcher.back, exact: true });
        await back.focus();
        await startRecording(page);
        await press(page, mode, back);
        await expect(openButton(page)).toBeFocused();
        await settleFrames(page, 300);
        const recording = await stopRecording(page);
        const analysis = analyze(recording);
        analyses.push(analysis);
        if (analysis.bodyFrames > 0 || !analysis.lastActive.includes(T.launcher.open(TOOL_TITLE))) {
          failures.push(describeFailure(`volver (foco final: ${analysis.lastActive})`, repetition, analysis, recording));
        }
      }
      record(`3 volver a herramientas · ${mode.name}`, analyses);
      expect(failures, failures.join("\n")).toEqual([]);
    });

    test(`4 · «Cerrar documento» + confirmar: el foco pasa a la zona de carga sin tocar <body> (x${mode.reps})`, async ({ page }) => {
      const bytes = await makePdf({ pages: 3, label: "PRO" });
      await installObserver(page);
      await gotoEmpty(page);
      const analyses: Analysis[] = [];
      const failures: string[] = [];
      for (let repetition = 1; repetition <= mode.reps; repetition += 1) {
        await openDoc(page, bytes);
        // Un cambio real: asi cerrar pide confirmacion en una hoja.
        await showLauncher(page, mode);
        await press(page, mode, page.getByRole("button", { name: S.operations.rotateAll90, exact: true }));
        await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
        if (mode.mobile) {
          await page.keyboard.press("Escape");
          await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5000 });
        }
        await requestClose(page, mode);
        await waitDialogStill(page);
        const dialog = page.getByRole("dialog");
        await startRecording(page);
        await press(page, mode, dialog.getByRole("button", { name: S.suite.close, exact: true }));
        await expect(emptyStateReady(page)).toBeVisible();
        // La hoja tarda en irse (animacion de salida): se observa hasta que se haya ido del todo.
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5000 });
        await settleFrames(page, 300);
        const recording = await stopRecording(page);
        const analysis = analyze(recording, (frame) => !frame.suite);
        analyses.push(analysis);
        if (analysis.bodyFrames > 0 || !analysis.lastActive.includes(es.tool.dropButton)) {
          failures.push(describeFailure(`cerrar documento (foco final: ${analysis.lastActive})`, repetition, analysis, recording));
        }
        // Sin la restriccion de «desde que desaparece la suite»: ningun fotograma con foco en <body> desde el clic de confirmar.
        const sinceClick = analyze(recording);
        if (sinceClick.bodyFrames > 0) failures.push(describeFailure("cerrar documento (desde el clic en la hoja)", repetition, sinceClick, recording));
      }
      record(`4 cerrar documento · ${mode.name}`, analyses);
      expect(failures, failures.join("\n")).toEqual([]);
    });
  });

  test.describe(`foco fotograma a fotograma · ${mode.name} · cierre de hojas y menus`, () => {
    test.use({ viewport: mode.viewport, hasTouch: mode.mobile, isMobile: mode.mobile, deviceScaleFactor: mode.mobile ? 2 : 1 });
    test.setTimeout(300_000);

    test(`5 · cancelar la confirmacion de «Cerrar documento»: el foco vuelve a quien la abrio sin tocar <body> (x${mode.extraReps})`, async ({ page }) => {
      const bytes = await makePdf({ pages: 2, label: "PRO" });
      await installObserver(page);
      await gotoEmpty(page);
      await openDoc(page, bytes);
      await showLauncher(page, mode);
      await press(page, mode, page.getByRole("button", { name: S.operations.rotateAll90, exact: true }));
      await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
      if (mode.mobile) {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5000 });
      }
      const analyses: Analysis[] = [];
      const failures: string[] = [];
      // El foco vuelve al control que abrio la hoja: el boton de la barra (escritorio) o «Más acciones» (movil).
      const origin = mode.mobile ? S.shell.more : S.suite.close;
      for (let repetition = 1; repetition <= mode.extraReps; repetition += 1) {
        if (!mode.mobile) await page.getByRole("button", { name: S.suite.close, exact: true }).focus();
        await requestClose(page, mode);
        await waitDialogStill(page);
        await startRecording(page);
        await press(page, mode, page.getByRole("dialog").getByRole("button", { name: S.suite.cancel, exact: true }));
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5000 });
        await settleFrames(page, 300);
        const recording = await stopRecording(page);
        const analysis = analyze(recording);
        analyses.push(analysis);
        if (analysis.bodyFrames > 0 || !analysis.lastActive.includes(origin)) {
          failures.push(describeFailure(`cancelar cierre (foco final: ${analysis.lastActive})`, repetition, analysis, recording));
        }
      }
      record(`5 cancelar confirmacion · ${mode.name}`, analyses);
      expect(failures, failures.join("\n")).toEqual([]);
    });

    test(`6 · paleta de comandos (Ctrl+K, Escape): el foco vuelve a donde estaba sin tocar <body> (x${mode.extraReps})`, async ({ page }) => {
      const bytes = await makePdf({ pages: 2, label: "PRO" });
      await installObserver(page);
      await gotoEmpty(page);
      await openDoc(page, bytes);
      const analyses: Analysis[] = [];
      const failures: string[] = [];
      const origin = mode.mobile ? moreButton(page) : openButton(page);
      const originName = mode.mobile ? S.shell.more : T.launcher.open(TOOL_TITLE);
      for (let repetition = 1; repetition <= mode.extraReps; repetition += 1) {
        await origin.focus();
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("combobox")).toBeFocused();
        await waitDialogStill(page);
        await startRecording(page);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5000 });
        await settleFrames(page, 300);
        const recording = await stopRecording(page);
        const analysis = analyze(recording);
        analyses.push(analysis);
        if (analysis.bodyFrames > 0 || !analysis.lastActive.includes(originName)) {
          failures.push(describeFailure(`paleta (foco final: ${analysis.lastActive})`, repetition, analysis, recording));
        }
      }
      record(`6 paleta de comandos · ${mode.name}`, analyses);
      expect(failures, failures.join("\n")).toEqual([]);
    });

    test(`7 · hoja «Guardar como…» (menu + Escape): el foco vuelve al boton del menu sin tocar <body> (x${mode.extraReps})`, async ({ page }) => {
      const bytes = await makePdf({ pages: 2, label: "PRO" });
      await installObserver(page);
      await gotoEmpty(page);
      await openDoc(page, bytes);
      const analyses: Analysis[] = [];
      const failures: string[] = [];
      const triggerName = mode.mobile ? S.shell.more : S.save.menuLabel;
      const trigger = page.getByRole("button", { name: triggerName, exact: true });
      for (let repetition = 1; repetition <= mode.extraReps; repetition += 1) {
        await press(page, mode, trigger);
        await press(page, mode, page.getByRole("menuitem", { name: S.save.saveAs }));
        await waitDialogStill(page);
        await startRecording(page);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5000 });
        await settleFrames(page, 300);
        const recording = await stopRecording(page);
        const analysis = analyze(recording);
        analyses.push(analysis);
        if (analysis.bodyFrames > 0 || !analysis.lastActive.includes(triggerName)) {
          failures.push(describeFailure(`Guardar como (foco final: ${analysis.lastActive})`, repetition, analysis, recording));
        }
      }
      record(`7 hoja Guardar como · ${mode.name}`, analyses);
      expect(failures, failures.join("\n")).toEqual([]);
    });
  });
}
