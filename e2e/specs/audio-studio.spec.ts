import { expect, test, type Page } from "@playwright/test";
import { downloadFile } from "../helpers/downloads";
import {
  audioContext,
  describeViolations,
  frequencyOf,
  makeWav,
  measureOverflow,
  peakOf,
  readWav,
  runAxe,
  type Language,
  type Theme,
} from "../helpers/audio-flow";

/**
 * Audio Studio (OptimusTOOLS · W-AUDIO), en Chromium headless con codecs y Web Audio reales:
 *  - editar de verdad (quitar un tramo, fundido de salida, deshacer/rehacer, dividir, reordenar) y comprobar el WAV
 *    exportado muestra a muestra (duracion, tonos por tramo, fundido);
 *  - teclado (flechas, Mayus, Espacio, Esc) y reproduccion real; arrastre con el puntero;
 *  - privacidad: nada sale de la pagina y no se guarda ningun audio (ni IndexedDB, ni almacenamiento);
 *  - ES/EN, axe 0, sin desborde a 375/320 px ni con tipografia ancha, objetivos de 44 px.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(120_000);

const RATE = 22050;
const input = (page: Page) => page.locator('input[type="file"]').first();
const wave = (page: Page) => page.getByRole("slider", { name: /Forma de onda del audio|Audio waveform/ });
const summary = (page: Page) => page.getByTestId("wave-summary");
const click = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).click();
const setField = async (page: Page, label: string, value: string) => {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.blur();
};

const tone440 = () => ({ name: "voz.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1, sampleRate: RATE, channels: 1, frequency: 440 }) });
const tone880 = () => ({ name: "aviso.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.5, sampleRate: RATE, channels: 1, frequency: 880 }) });

async function open(page: Page) {
  // «networkidle»: el HTML sale del servidor antes de hidratar; un archivo antes de eso se perderia.
  await page.goto("/audio-studio", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Audio Studio" })).toBeVisible();
}

async function openWithClips(page: Page, ...files: Array<ReturnType<typeof tone440>>) {
  await open(page);
  await input(page).setInputFiles(files);
  await expect(wave(page)).toBeVisible({ timeout: 30_000 });
}

test.describe("Audio Studio · editar y exportar", () => {
  test("unir dos audios, quitar un tramo, fundido de salida, deshacer/rehacer y exportar a WAV: el archivo coincide muestra a muestra con lo editado", async ({ page }) => {
    await openWithClips(page, tone440(), tone880());
    await expect(summary(page)).toHaveText("Duración 0:01.50. Cursor en 0:00.00. Sin selección.");
    await expect(page.getByRole("listitem", { name: /^Clip \d de 2$/ })).toHaveCount(2);

    await setField(page, "Inicio (segundos)", "0.5");
    await setField(page, "Fin (segundos)", "1.25");
    await expect(summary(page)).toHaveText("Duración 0:01.50. Selección de 0:00.50 a 0:01.25 (0:00.75).");
    await click(page, "Quitar la selección");
    await expect(summary(page)).toHaveText("Duración 0:00.75. Cursor en 0:00.50. Sin selección.");
    await expect(page.getByTestId("studio-status")).toHaveText("Tramo quitado. Ahora dura 0:00.75.");

    await page.getByLabel("Duración (segundos)").fill("0.2");
    await click(page, "Fundido de salida");
    await expect(page.getByTestId("studio-status")).toHaveText("Fundido de salida aplicado.");
    await click(page, "Deshacer");
    await expect(page.getByTestId("studio-status")).toHaveText("Cambio deshecho.");
    await click(page, "Rehacer");
    await expect(page.getByTestId("studio-status")).toHaveText("Cambio rehecho.");

    await click(page, "Exportar audio");
    const result = page.getByTestId("export-result");
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result).toContainText("voz-editado.wav");
    await expect(result).toContainText("0:00.75");
    await expect(page.getByRole("button", { name: "Descargar" })).toBeFocused();
    const { bytes, filename } = await downloadFile(page, () => page.getByRole("button", { name: "Descargar" }).click());
    expect(filename).toBe("voz-editado.wav");

    const wav = readWav(bytes);
    expect(wav.sampleRate).toBe(RATE);
    expect(wav.channels).toBe(1);
    expect(wav.durationSec).toBeCloseTo(0.75, 3);
    const s = wav.samples[0];
    // 0 - 0,5 s: el primer audio (440 Hz); 0,5 - 0,75 s: el final del segundo (880 Hz), con el fundido de salida de 0,2 s.
    expect(frequencyOf(s, RATE, 1000, 10000)).toBeGreaterThan(432);
    expect(frequencyOf(s, RATE, 1000, 10000)).toBeLessThan(448);
    expect(frequencyOf(s, RATE, Math.round(0.5 * RATE) + 50, Math.round(0.55 * RATE))).toBeGreaterThan(850);
    expect(frequencyOf(s, RATE, Math.round(0.5 * RATE) + 50, Math.round(0.55 * RATE))).toBeLessThan(910);
    const fadeStart = Math.round(0.55 * RATE);
    const end = wav.frames;
    expect(peakOf(s, Math.round(0.5 * RATE) + 10, fadeStart - 10)).toBeGreaterThan(0.45); // sin fundido todavia
    expect(peakOf(s, end - 80, end)).toBeLessThan(0.03); // se apaga al final
    const middleOfFade = Math.round((fadeStart + end) / 2);
    expect(peakOf(s, middleOfFade - 40, middleOfFade + 40)).toBeGreaterThan(0.15);
    expect(peakOf(s, middleOfFade - 40, middleOfFade + 40)).toBeLessThan(0.35); // ~mitad de 0,5
  });

  test("dividir en el cursor, reordenar y quitar clips: el WAV sale en el orden nuevo", async ({ page }) => {
    await openWithClips(page, tone440(), tone880());
    await wave(page).focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowRight"); // 0,5 s
    await expect(summary(page)).toHaveText("Duración 0:01.50. Cursor en 0:00.50. Sin selección.");
    await click(page, "Dividir en el cursor");
    await expect(page.getByRole("listitem", { name: /^Clip \d de 3$/ })).toHaveCount(3);
    await expect(summary(page)).toHaveText("Duración 0:01.50. Cursor en 0:00.50. Sin selección.");
    // Dos botones de reordenar: el aviso (clip 3) pasa al principio.
    await click(page, "Subir el clip 3: aviso.wav");
    await click(page, "Subir el clip 2: aviso.wav");
    // La segunda mitad de voz (clip 3) se quita.
    await click(page, /^Quitar el clip 3: voz\.wav$/);
    await expect(page.getByRole("listitem", { name: /^Clip \d de 2$/ })).toHaveCount(2);
    await expect(summary(page)).toHaveText("Duración 0:01.00. Cursor en 0:00.00. Sin selección.");

    await click(page, "Exportar audio");
    await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 60_000 });
    const { bytes } = await downloadFile(page, () => page.getByRole("button", { name: "Descargar" }).click());
    const wav = readWav(bytes);
    expect(wav.durationSec).toBeCloseTo(1, 3);
    const s = wav.samples[0];
    expect(frequencyOf(s, RATE, 1000, Math.round(0.45 * RATE))).toBeGreaterThan(850); // primero: aviso 880 Hz (0,5 s)
    expect(frequencyOf(s, RATE, Math.round(0.55 * RATE), Math.round(0.95 * RATE))).toBeGreaterThan(432); // despues: voz 440 Hz
    expect(frequencyOf(s, RATE, Math.round(0.55 * RATE), Math.round(0.95 * RATE))).toBeLessThan(448);
  });

  test("volumen y normalizar: -6 dB baja el pico a la mitad y normalizar lo lleva a -1 dBFS", async ({ page }) => {
    await openWithClips(page, tone440());
    await page.getByRole("slider", { name: "Cambio de volumen" }).fill("-6");
    await click(page, "Aplicar volumen");
    await expect(page.getByTestId("studio-status")).toHaveText("Volumen cambiado -6 dB.");
    await click(page, "Exportar audio");
    await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 60_000 });
    const quiet = readWav((await downloadFile(page, () => page.getByRole("button", { name: "Descargar" }).click())).bytes);
    expect(peakOf(quiet.samples[0])).toBeGreaterThan(0.24);
    expect(peakOf(quiet.samples[0])).toBeLessThan(0.27);

    await click(page, "Normalizar");
    await expect(page.getByTestId("studio-status")).toHaveText("Volumen normalizado.");
    await expect(page.getByTestId("export-result")).toBeHidden();
    await click(page, "Exportar audio");
    await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 60_000 });
    const loud = readWav((await downloadFile(page, () => page.getByRole("button", { name: "Descargar" }).click())).bytes);
    expect(peakOf(loud.samples[0])).toBeGreaterThan(0.88);
    expect(peakOf(loud.samples[0])).toBeLessThan(0.9); // 10^(-1/20) = 0,891
  });

  test("exportar a Opus desde el estudio: Ogg Opus que el navegador decodifica con la duracion editada", async ({ page }) => {
    await openWithClips(page, tone440());
    await expect(page.getByText(/Comprobando qué formatos/)).toBeHidden({ timeout: 10_000 });
    const opus = page.locator('[role="radio"][data-format="opus"]');
    test.skip((await opus.getAttribute("aria-disabled")) === "true", "este navegador no crea Opus");
    await opus.click();
    await setField(page, "Fin (segundos)", "0.6");
    await click(page, "Recortar a la selección");
    await expect(summary(page)).toHaveText("Duración 0:00.60. Cursor en 0:00.00. Sin selección.");
    await click(page, "Exportar audio");
    await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 60_000 });
    const { bytes, filename } = await downloadFile(page, () => page.getByRole("button", { name: "Descargar" }).click());
    expect(filename).toBe("voz-editado.opus");
    expect(bytes.toString("ascii", 0, 4)).toBe("OggS");
    const decoded = await page.evaluate(async (base64) => {
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(data.buffer);
      return { duration: buffer.duration, rate: buffer.sampleRate };
    }, bytes.toString("base64"));
    expect(decoded.rate).toBe(48000);
    expect(decoded.duration).toBeGreaterThan(0.55);
    expect(decoded.duration).toBeLessThan(0.66);
  });
});

test.describe("Audio Studio · teclado, puntero y reproduccion", () => {
  test("solo con teclado: flechas, Mayus + flechas, Esc, Ctrl+Z y Espacio reproduce y pausa de verdad", async ({ page }) => {
    await openWithClips(page, tone440());
    await wave(page).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(summary(page)).toHaveText("Duración 0:01.00. Cursor en 0:00.20. Sin selección.");
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Shift+ArrowRight");
    await expect(summary(page)).toHaveText("Duración 0:01.00. Selección de 0:00.20 a 0:00.50 (0:00.30).");
    await expect(wave(page)).toHaveAttribute("aria-valuetext", "Duración 0:01.00. Selección de 0:00.20 a 0:00.50 (0:00.30).");
    await page.keyboard.press("Escape");
    await expect(summary(page)).toHaveText("Duración 0:01.00. Cursor en 0:00.50. Sin selección.");

    await page.keyboard.press("Home");
    await expect(summary(page)).toContainText("Cursor en 0:00.00");
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Pausa" })).toHaveAttribute("aria-pressed", "true");
    // El reloj avanza con el audio real.
    await expect.poll(async () => (await page.getByTestId("clock").textContent()) ?? "", { timeout: 5000 }).not.toMatch(/^Posición: 0:00\.00 \//);
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Reproducir" })).toBeVisible();
    await expect(summary(page)).not.toContainText("Cursor en 0:00.00");

    // Ctrl+Z desde la onda.
    await setField(page, "Inicio (segundos)", "0");
    await setField(page, "Fin (segundos)", "0.4");
    await click(page, "Recortar a la selección");
    await expect(summary(page)).toContainText("Duración 0:00.40");
    await wave(page).focus();
    await page.keyboard.press("Control+z");
    await expect(summary(page)).toContainText("Duración 0:01.00");
    await page.keyboard.press("Control+Shift+z");
    await expect(summary(page)).toContainText("Duración 0:00.40");
  });

  test("con el puntero: un clic coloca el cursor y un arrastre selecciona; no hay desplazamiento horizontal", async ({ page }) => {
    await openWithClips(page, tone440());
    const box = (await wave(page).boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    await expect(summary(page)).toContainText(/Cursor en 0:00\.(49|50|51)/);
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 6 });
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(summary(page)).toContainText(/Selección de 0:00\.(24|25|26) a 0:00\.(74|75|76)/);
    await expect(wave(page)).toBeFocused();
    await click(page, "Recortar a la selección");
    await expect(summary(page)).toContainText("Duración 0:00.50");
  });
});

test.describe("Audio Studio · privacidad", () => {
  test("nada sale de la pagina y ningun audio se guarda: ni peticiones externas o con cuerpo, ni IndexedDB, ni almacenamiento", async ({ page }) => {
    const foreign: string[] = [];
    const bodies: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:") return;
      if (url.hostname !== "localhost") foreign.push(request.url());
      if (request.postData()) bodies.push(`${request.method()} ${url.pathname}`);
    });
    await open(page);
    const before = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name).sort());
    await input(page).setInputFiles([tone440(), tone880()]);
    await expect(wave(page)).toBeVisible({ timeout: 30_000 });
    await setField(page, "Fin (segundos)", "0.5");
    await click(page, "Recortar a la selección");
    await click(page, "Exportar audio");
    await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 60_000 });
    const after = await page.evaluate(async () => ({
      databases: (await indexedDB.databases()).map((db) => db.name).sort(),
      local: Object.entries(localStorage).map(([key, value]) => [key, value.length] as const),
      // Next en desarrollo guarda su canal de depuracion en sessionStorage (`__next_*`): no es de la herramienta.
      session: Object.keys(sessionStorage).filter((key) => !key.startsWith("__next")),
      caches: await caches.keys(),
    }));
    expect(after.databases).toEqual(before);
    expect(after.local.every(([, length]) => length < 2000), `almacenamiento local: ${JSON.stringify(after.local)}`).toBe(true);
    expect(after.session).toEqual([]);
    expect(after.caches).toEqual([]);
    expect(foreign).toEqual([]);
    expect(bodies).toEqual([]);
  });
});

const MATRIX: Array<{ width: number; theme: Theme; language: Language; wide: boolean }> = [
  { width: 1280, theme: "dark", language: "es", wide: false },
  { width: 1280, theme: "light", language: "en", wide: false },
  { width: 375, theme: "dark", language: "es", wide: true },
  { width: 375, theme: "light", language: "en", wide: false },
  { width: 320, theme: "light", language: "es", wide: true },
  { width: 320, theme: "dark", language: "en", wide: true },
];

test.describe("Audio Studio · accesibilidad y maquetacion", () => {
  for (const cell of MATRIX) {
    test(`axe 0 y sin desborde: ${cell.width}px · ${cell.theme} · ${cell.language}${cell.wide ? " · tipografia ancha" : ""}`, async ({ browser }) => {
      const context = await audioContext(browser, { ...cell, touch: cell.width < 600 });
      const page = await context.newPage();
      try {
        await open(page);
        const empty = await runAxe(page);
        expect(empty, `vacio\n${describeViolations(empty)}`).toEqual([]);
        expect((await measureOverflow(page)).overflow, "vacio").toBeLessThanOrEqual(1);

        await input(page).setInputFiles([
          { name: "grabacion-de-la-reunion-con-un-nombre-muy-largo-para-probar-el-corte.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 1, sampleRate: RATE, channels: 1, frequency: 330 }) },
          { name: "aviso.wav", mimeType: "audio/wav", buffer: makeWav({ seconds: 0.5, sampleRate: RATE, channels: 1, frequency: 660 }) },
        ]);
        await expect(wave(page)).toBeVisible({ timeout: 30_000 });
        // Una seleccion, un clip dividido y un resultado exportado: todas las piezas del editor a la vista.
        await wave(page).focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.press("Shift+ArrowRight");
        await page.getByRole("button", { name: /^(Dividir en el cursor|Split at the cursor)$/ }).click();
        await page.getByRole("button", { name: /^(Exportar audio|Export audio)$/ }).click();
        await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 60_000 });

        const loaded = await runAxe(page);
        expect(loaded, `editor\n${describeViolations(loaded)}`).toEqual([]);
        const measured = await measureOverflow(page);
        expect(measured.overflow, `editor: ${JSON.stringify(measured.offenders)}`).toBeLessThanOrEqual(1);
        expect(measured.offenders).toEqual([]);

        if (cell.width < 600) {
          const small = await page.evaluate(() => {
            const bad: string[] = [];
            for (const element of document.querySelectorAll<HTMLElement>("main button, main [role=radio], main select, main input[type=text], main input[type=number]")) {
              const rect = element.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              if (rect.height < 43.5 || rect.width < 43.5) bad.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 30)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
            }
            return bad;
          });
          expect(small, "controles de menos de 44 px").toEqual([]);
          // La onda ocupa todo el ancho disponible (un solo editor, sin franjas con desplazamiento propio).
          const waveWidth = (await wave(page).boundingBox())!.width;
          expect(waveWidth).toBeGreaterThan(cell.width - 40);
        }
      } finally {
        await context.close();
      }
    });
  }

  test("en ingles, el editor y su resumen salen en ingles", async ({ browser }) => {
    const context = await audioContext(browser, { width: 1280, language: "en" });
    const page = await context.newPage();
    try {
      await openWithClips(page, tone440());
      await expect(summary(page)).toHaveText("Duration 0:01.00. Cursor at 0:00.00. No selection.");
      await expect(page.getByRole("button", { name: "Trim to selection" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Export audio" })).toBeVisible();
      await wave(page).focus();
      await page.keyboard.press("Shift+ArrowRight");
      await expect(summary(page)).toHaveText("Duration 0:01.00. Selection from 0:00.00 to 0:00.10 (0:00.10).");
    } finally {
      await context.close();
    }
  });
});
