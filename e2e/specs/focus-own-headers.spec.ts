import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { es } from "../../src/lib/locales/es";
import { importPhotos, installFakeCamera, installScanFakes, WEBKIT_LINUX_CAMERA_REASON, waitIdle, waitVideoReady, webkitLinuxCamera, widthCodedFiles } from "../helpers/scan-ui";

/**
 * Wave 6 · V-F: el foco NUNCA pasa por <body> —ni un fotograma— tras «Elegir otro archivo», «Quitar
 * archivo», «Quitar» y «Cancelar» (ni al aparecer el banner de error), en las cuatro herramientas con
 * cabecera propia y en las 12 con panel de `ToolShell`. Navegador real (pdf.js de verdad), headless.
 *
 * La sonda (`addInitScript`) muestrea `document.activeElement` en cada fotograma (rAF) y tras cada lote de
 * cambios del DOM (MutationObserver: el momento justo despues de que React desmonte el control enfocado,
 * antes de que el navegador pinte, tras las microtareas de la aplicacion). Entre el clic y el destino NO
 * puede haber ni una muestra con <body>.
 * Cada flujo se repite `FOCUS_REPS` veces (30 por defecto).
 */

const FAKE_CAMERA_Y4M = path.resolve(__dirname, "..", "fixtures", "fake-camera.y4m");

// La camara falsa (la misma de scan-to-pdf.spec.ts) vale para todo el archivo: `launchOptions` no se puede fijar
// por bloque. Las demas herramientas no piden camara, asi que no les afecta.
// Cada motor tiene su camara de prueba: Chromium usa los argumentos de abajo, WebKit trae dispositivos simulados
// propios (basta darle el permiso) y Firefox, sus preferencias `media.navigator.*`. Playwright no admite el permiso
// «camera» en Firefox (lanza «Unknown permission»), asi que ahi se omite.
test.use({
  locale: "es-ES",
  viewport: { width: 1280, height: 800 },
  permissions: async ({ browserName }, provide) => {
    await provide(browserName === "firefox" ? [] : ["camera"]);
  },
  launchOptions: [
    async ({ browserName }, provide) => {
      if (browserName === "chromium") {
        await provide({
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-video-capture=${FAKE_CAMERA_Y4M}`,
          ],
        });
      } else if (browserName === "firefox") {
        await provide({ firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } });
      } else {
        await provide({});
      }
    },
    { scope: "worker" },
  ],
});
test.setTimeout(240_000);

const T = es.tool;
const REPS = Number(process.env.FOCUS_REPS ?? 30);

type Upload = { name: string; mimeType: string; buffer: Buffer };

async function good(name = "bueno.pdf", pages = 3): Promise<Upload> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    document.addPage([300, 400]).drawText(`Pagina ${index + 1}`, { x: 20, y: 200, size: 14, font });
  }
  return { name, mimeType: "application/pdf", buffer: Buffer.from(await document.save()) };
}

function bad(name = "basura.pdf"): Upload {
  const filler = Buffer.alloc(4000);
  for (let index = 0; index < filler.length; index += 1) filler[index] = (index * 131 + 17) & 0xff;
  return { name, mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.7\n"), filler]) };
}

async function encrypted(name = "cifrado.pdf"): Promise<Upload> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  document.encrypt({ userPassword: "secreta", ownerPassword: "owner", permissions: {} });
  return { name, mimeType: "application/pdf", buffer: Buffer.from(await document.save()) };
}

/** Sonda: cuenta las muestras con el foco en <body> (o en nada) mientras esta encendida. */
async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const probe = { on: false, bodyFrames: 0, samples: 0, log: [] as string[] };
    (window as unknown as { __probe: typeof probe }).__probe = probe;
    let detail = "";
    const sample = (origin: string) => {
      if (!probe.on) return;
      probe.samples += 1;
      const active = document.activeElement;
      if (!active || active === document.body) {
        probe.bodyFrames += 1;
        probe.log.push(`${origin}@${Math.round(performance.now())} ${origin === "focusout" ? detail : ""}`);
      }
    };
    const frame = () => {
      sample("frame");
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    // Tras cada lote de cambios del DOM (y de cada focusout), DESPUES de que corran las microtareas de la
    // aplicacion (dos turnos): un hueco que se cierra en la misma microtarea no llega a pintarse.
    const later = (origin: string) => queueMicrotask(() => queueMicrotask(() => sample(origin)));
    new MutationObserver(() => later("mutation")).observe(document, { childList: true, subtree: true, attributes: true });
    document.addEventListener(
      "focusout",
      (event) => {
        const target = event.target as HTMLElement;
        detail = `${target.tagName}[${(target.getAttribute?.("aria-label") ?? target.textContent ?? "").slice(0, 18)}]->${(event as FocusEvent).relatedTarget ? "rel" : "null"} hasFocus=${document.hasFocus()} connected=${target.isConnected}`;
        // Macrotarea: durante blur/focusout el navegador aun no ha movido el foco al destino (los eventos de
        // un cambio de foco se despachan en cadena y las microtareas se vacian entre ellos).
        setTimeout(() => sample("focusout"), 0);
      },
      true,
    );
  });
}

async function probeOn(page: Page) {
  await page.evaluate(() => {
    const probe = (window as unknown as { __probe: { on: boolean; bodyFrames: number; samples: number; log: string[] } }).__probe;
    probe.bodyFrames = 0;
    probe.samples = 0;
    probe.log = [];
    probe.on = true;
  });
}

async function probeOff(page: Page): Promise<{ bodyFrames: number; samples: number; log: string[] }> {
  // Dos fotogramas mas, para cazar un hueco tardio.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate(() => {
    const probe = (window as unknown as { __probe: { on: boolean; bodyFrames: number; samples: number; log: string[] } }).__probe;
    probe.on = false;
    return { bodyFrames: probe.bodyFrames, samples: probe.samples, log: probe.log };
  });
}

const activeIsBody = (page: Page) =>
  page.evaluate(() => !document.activeElement || document.activeElement === document.body);

/** El foco esta en un control de la pagina (no <body>) y sigue ahi 300 ms despues (cubre la mejora a «Procesar»). */
async function settleOnControl(page: Page) {
  await expect.poll(() => activeIsBody(page), { timeout: 8000 }).toBe(false);
  await page.waitForTimeout(300);
  expect(await activeIsBody(page)).toBe(false);
}

const banner = (page: Page) => page.locator("[data-error-banner]");
const pdfInput = (page: Page) => page.locator('input[type="file"][accept*="pdf"]').first();

async function expectNoBody(page: Page, what: string) {
  const result = await probeOff(page);
  expect(result.bodyFrames, `${what}: muestras con el foco en <body> (${result.log.join(",")}) de ${result.samples}`).toBe(0);
}

type ToolCase = {
  slug: string;
  /** Sube un archivo bueno/malo al primer hueco. */
  prepare?: (page: Page) => Promise<void>;
};

const OWN_HEADERS: ToolCase[] = [
  { slug: "pdf-to-pdfa" },
  { slug: "compare-pdf" },
  // «Extraer elementos»: cabecera propia con `useOwnToolFocus` (como compare-pdf), con su banner de error compartido.
  { slug: "extract-assets" },
  {
    slug: "pdf-summarizer",
    prepare: async (page) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "gpu", {
          configurable: true,
          value: { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) },
        });
      });
    },
  },
];

const SHELL_TOOLS = [
  "split-pdf",
  "remove-pages",
  "extract-pages",
  "rotate-pdf",
  "compress-pdf",
  "add-watermark",
  "add-page-numbers",
  "pdf-to-markdown",
  "crop-pdf",
  "organize-pdf",
  "redact-pdf",
  "pdf-to-jpg",
];

async function openTool(page: Page, tool: ToolCase) {
  await tool.prepare?.(page);
  await page.goto(`/${tool.slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // El selector solo existe cuando la herramienta ya es interactiva.
  await expect(pdfInput(page)).toBeAttached({ timeout: 30_000 });
}

test.describe("cabeceras propias · el foco nunca pasa por <body>", () => {
  for (const tool of OWN_HEADERS) {
    test(`${tool.slug}: banner, «Elegir otro archivo», «Quitar archivo» y «Quitar» ×${REPS}`, async ({ page }) => {
      await installProbe(page);
      const goodFile = await good();
      for (let rep = 0; rep < REPS; rep += 1) {
        await openTool(page, tool);
        if (tool.slug === "compare-pdf") await pdfInput(page).setInputFiles(await good("a.pdf"));

        // 1) El banner recibe el foco al aparecer.
        await pdfInput(page).setInputFiles(bad());
        await expect(banner(page)).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => banner(page).evaluate((element) => element.contains(document.activeElement)), { timeout: 8000 }).toBe(true);

        // 2) «Elegir otro archivo» con un PDF bueno: ni un fotograma en <body>.
        await probeOn(page);
        const chooser = page.waitForEvent("filechooser");
        await banner(page).getByRole("button", { name: T.chooseAnother }).click();
        (await chooser).setFiles(goodFile);
        await expect(banner(page)).toHaveCount(0);
        await settleOnControl(page);
        await expectNoBody(page, `${tool.slug} elegir otro`);

        // 3) «Quitar archivo» del banner (con un archivo malo otra vez).
        await page.goto(`/${tool.slug}`);
        await expect(pdfInput(page)).toBeAttached({ timeout: 30_000 });
        if (tool.slug === "compare-pdf") await pdfInput(page).setInputFiles(await good("a.pdf"));
        await pdfInput(page).setInputFiles(bad());
        await expect(banner(page)).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => banner(page).evaluate((element) => element.contains(document.activeElement)), { timeout: 8000 }).toBe(true);
        await probeOn(page);
        await banner(page).getByRole("button", { name: T.removeFile }).click();
        await expect(banner(page)).toHaveCount(0);
        await settleOnControl(page);
        await expectNoBody(page, `${tool.slug} quitar archivo`);

        // 4) «Quitar» de la lista con un archivo bueno.
        await page.goto(`/${tool.slug}`);
        await expect(pdfInput(page)).toBeAttached({ timeout: 30_000 });
        await pdfInput(page).setInputFiles(goodFile);
        await expect(page.getByRole("button", { name: T.remove, exact: true }).first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(250);
        // Se parte de un foco real (el del propio boton): tras subir el archivo nadie lo enfoca y el
        // <body> inicial no forma parte del flujo que se mide.
        await page.getByRole("button", { name: T.remove, exact: true }).first().focus();
        await probeOn(page);
        await page.getByRole("button", { name: T.remove, exact: true }).first().click();
        await settleOnControl(page);
        await expectNoBody(page, `${tool.slug} quitar de la lista`);
      }
    });
  }
});

test.describe("ToolShell · el foco nunca pasa por <body>", () => {
  for (const slug of SHELL_TOOLS) {
    test(`${slug}: «Elegir otro archivo», «Quitar archivo», «Quitar» y «Cancelar» ×${REPS}`, async ({ page }) => {
      await installProbe(page);
      const goodFile = await good();
      for (let rep = 0; rep < REPS; rep += 1) {
        await page.goto(`/${slug}`);
        await expect(pdfInput(page)).toBeAttached({ timeout: 30_000 });
        await pdfInput(page).setInputFiles(bad());
        await expect(banner(page)).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => banner(page).evaluate((element) => element.contains(document.activeElement)), { timeout: 8000 }).toBe(true);

        // «Elegir otro archivo».
        await probeOn(page);
        const chooser = page.waitForEvent("filechooser");
        await banner(page).getByRole("button", { name: T.chooseAnother }).click();
        (await chooser).setFiles(goodFile);
        await expect(banner(page)).toHaveCount(0);
        await settleOnControl(page);
        await expectNoBody(page, `${slug} elegir otro`);

        // «Quitar» de la lista (un archivo bueno, el unico).
        await page.waitForTimeout(250);
        // Se parte de un foco real (el del propio boton): tras subir el archivo nadie lo enfoca y el
        // <body> inicial no forma parte del flujo que se mide.
        await page.getByRole("button", { name: T.remove, exact: true }).first().focus();
        await probeOn(page);
        await page.getByRole("button", { name: T.remove, exact: true }).first().click();
        await settleOnControl(page);
        await expectNoBody(page, `${slug} quitar de la lista`);

        // «Quitar archivo» del banner.
        await pdfInput(page).setInputFiles(bad("otra-basura.pdf"));
        await expect(banner(page)).toBeVisible({ timeout: 30_000 });
        await expect.poll(() => banner(page).evaluate((element) => element.contains(document.activeElement)), { timeout: 8000 }).toBe(true);
        await probeOn(page);
        await banner(page).getByRole("button", { name: T.removeFile }).click();
        await settleOnControl(page);
        await expectNoBody(page, `${slug} quitar archivo`);

        // «Cancelar» en la hoja de contrasena.
        await pdfInput(page).setInputFiles(await encrypted());
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible({ timeout: 30_000 });
        await probeOn(page);
        await dialog.getByRole("button", { name: T.password.cancel }).click();
        await expect(dialog).toBeHidden();
        await settleOnControl(page);
        await expectNoBody(page, `${slug} cancelar contrasena`);
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * scan-to-pdf (V-G): flujo «Escaner» nuevo: camara a pantalla completa, revisar, editor y esquinas
 * ------------------------------------------------------------------ */

const S = {
  start: "Activar cámara",
  capture: "Capturar página",
  closeCamera: "Cerrar la cámara",
  remove: /^Borrar la página \d+$/,
  closeEditor: "Cerrar sin cambios",
};

test.describe("scan-to-pdf · el foco nunca pasa por <body>", () => {
  test.beforeEach(async ({ page }) => {
    // Motor y almacen falsos + camara de canvas (valen en los tres motores; la camara real no se usa aqui).
    await installScanFakes(page);
    await installFakeCamera(page);
  });

  const tiles = (page: Page) => page.locator("[data-page-grid] [data-page-id]");

  async function startCamera(page: Page) {
    await page.goto("/scan-to-pdf");
    await page.getByRole("button", { name: S.start }).click();
    await expect(page.getByRole("button", { name: S.capture })).toBeVisible({ timeout: 30_000 });
    await waitVideoReady(page);
  }

  test(`iniciar la camara, cerrarla, y borrar paginas desde Revisar ×${REPS}`, async ({ page, browserName }) => {
    test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
    await installProbe(page);
    for (let rep = 0; rep < REPS; rep += 1) {
      await page.goto("/scan-to-pdf");
      // Iniciar: el foco pasa de «Activar camara» al disparador de la capa de camara.
      await page.getByRole("button", { name: S.start }).focus();
      await probeOn(page);
      await page.getByRole("button", { name: S.start }).click();
      await expect(page.getByRole("button", { name: S.capture })).toBeFocused({ timeout: 30_000 });
      await expectNoBody(page, "scan iniciar camara");
      await waitVideoReady(page);

      // Dos paginas (sin captura automatica) y a revisar: el foco queda en el encabezado del paso.
      await page.locator('[data-camera-action="auto"]').click();
      await page.getByRole("button", { name: S.capture }).click();
      await page.getByRole("button", { name: S.capture }).click();
      await probeOn(page);
      await page.locator('[data-camera-action="done"]').click();
      await expect(tiles(page)).toHaveCount(2);
      await settleOnControl(page);
      await expectNoBody(page, "scan ir a revisar");
      await waitIdle(page);

      // Borrar la primera: el foco va a la que ocupa su sitio.
      await page.getByRole("button", { name: S.remove }).first().focus();
      await probeOn(page);
      await page.getByRole("button", { name: S.remove }).first().click();
      await settleOnControl(page);
      await expectNoBody(page, "scan borrar (hay mas)");
      expect(await tiles(page).count()).toBe(1);

      // Borrar la ultima: el foco va a «Camara» (no queda ninguna tarjeta).
      await page.getByRole("button", { name: S.remove }).first().focus();
      await probeOn(page);
      await page.getByRole("button", { name: S.remove }).first().click();
      await settleOnControl(page);
      await expectNoBody(page, "scan borrar (la ultima)");
    }
  });

  test(`cerrar la camara con Escape y con el boton ×${REPS}`, async ({ page, browserName }) => {
    test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
    await installProbe(page);
    for (let rep = 0; rep < REPS; rep += 1) {
      await startCamera(page);
      await probeOn(page);
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-camera-stage]")).toHaveCount(0);
      await settleOnControl(page);
      await expectNoBody(page, "scan cerrar camara (Escape)");
      await page.getByRole("button", { name: S.start }).click();
      await expect(page.getByRole("button", { name: S.capture })).toBeFocused({ timeout: 30_000 });
      await probeOn(page);
      await page.getByRole("button", { name: S.closeCamera }).click();
      await settleOnControl(page);
      await expectNoBody(page, "scan cerrar camara (boton)");
    }
  });

  test(`editor de pagina y editor de esquinas («Cerrar sin cambios») ×${REPS}`, async ({ page }) => {
    await installProbe(page);
    await page.goto("/scan-to-pdf");
    await importPhotos(page, widthCodedFiles(3));
    await expect(tiles(page)).toHaveCount(3);
    await waitIdle(page);
    for (let rep = 0; rep < REPS; rep += 1) {
      // Abrir el editor: el foco entra; Escape lo cierra y vuelve a la tarjeta.
      const main = tiles(page).nth(1).locator("[data-page-main]");
      await main.focus();
      await probeOn(page);
      await main.click();
      await expect(page.locator("[data-page-editor]")).toBeVisible();
      await expect(page.locator('[data-editor-action="done"]')).toBeFocused();
      await expectNoBody(page, "scan abrir editor");

      // Esquinas: el foco entra en «Cerrar sin cambios» y vuelve al boton «Recortar» del editor.
      await page.locator('[data-editor-action="crop"]').focus();
      await probeOn(page);
      await page.locator('[data-editor-action="crop"]').click();
      await expect(page.locator("[data-corner-editor]")).toBeVisible();
      await expect(page.getByRole("button", { name: S.closeEditor })).toBeFocused();
      await expectNoBody(page, "scan abrir esquinas");
      await probeOn(page);
      await page.getByRole("button", { name: S.closeEditor }).click();
      await expect(page.locator("[data-corner-editor]")).toHaveCount(0);
      await expect(page.locator('[data-editor-action="crop"]')).toBeFocused();
      await expectNoBody(page, "scan cerrar esquinas");

      await probeOn(page);
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-page-editor]")).toHaveCount(0);
      await expect(main).toBeFocused();
      await expectNoBody(page, "scan cerrar editor");
    }
  });

  test(`mover una pagina con el teclado ×${REPS}`, async ({ page }) => {
    await installProbe(page);
    await page.goto("/scan-to-pdf");
    await importPhotos(page, widthCodedFiles(3));
    await expect(tiles(page)).toHaveCount(3);
    await waitIdle(page);
    for (let rep = 0; rep < REPS; rep += 1) {
      const handle = tiles(page).first().locator("[data-drag-handle]");
      await handle.focus();
      await probeOn(page);
      await page.keyboard.press("ArrowRight");
      await settleOnControl(page);
      await expectNoBody(page, "scan mover pagina");
    }
  });

  test(`error de camara: el aviso recibe el foco ×${REPS}`, async ({ page }) => {
    await installProbe(page);
    await installFakeCamera(page, { denyWith: "NotAllowedError" });
    for (let rep = 0; rep < REPS; rep += 1) {
      await page.goto("/scan-to-pdf");
      await page.getByRole("button", { name: S.start }).focus();
      await probeOn(page);
      await page.getByRole("button", { name: S.start }).click();
      await expect(page.locator("[data-camera-error]")).toBeFocused({ timeout: 10_000 });
      await expectNoBody(page, "scan error de camara");
    }
  });
});
