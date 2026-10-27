import { expect, test } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts, getPageSize } from "../helpers/pdf-inspection";
import { renderPageToPixels } from "../helpers/pdf-render-inspection";
import { installScanFakes } from "../helpers/scan-ui";

/**
 * Corre solo en el proyecto "chromium-fake-camera" (ver playwright.config.ts),
 * que inyecta e2e/fixtures/fake-camera.y4m como dispositivo de video falso
 * via flags de Chromium. El fixture son 4 cuadrantes de color solido y
 * distinto -- eso permite comprobar, con muestreo de pixeles real sobre el
 * PDF final, que el fotograma exacto de la camara (y no uno en blanco o
 * corrupto) llego a la pagina, y que su orientacion no se altero.
 */
const CAMERA_WIDTH = 320;
const CAMERA_HEIGHT = 240;

// Mismos colores que e2e/fixtures/generate-fixtures.mjs (buildFakeCameraFrameRgba).
const EXPECTED_QUADRANTS = {
  topLeft: { r: 230, g: 25, b: 25 },
  topRight: { r: 25, g: 200, b: 60 },
  bottomLeft: { r: 30, g: 90, b: 230 },
  bottomRight: { r: 235, g: 210, b: 20 },
};

// Tolerancia generosa: absorbe la deriva de color de YUV420 (submuestreo
// de croma, mas la posible reinterpretacion de rango completo vs limitado
// al decodificar el I420 -- ver generate-fixtures.mjs) mas la
// recompresion JPEG (calidad 0.92) que aplica captureFrame(). Cada par de
// cuadrantes difiere en al menos un canal por mucho mas que el doble de
// esta tolerancia, asi que el margen no puede confundir uno con otro.
const COLOR_TOLERANCE = 40;

function expectColorClose(
  actual: { r: number; g: number; b: number },
  expected: { r: number; g: number; b: number },
) {
  expect(Math.abs(actual.r - expected.r)).toBeLessThan(COLOR_TOLERANCE);
  expect(Math.abs(actual.g - expected.g)).toBeLessThan(COLOR_TOLERANCE);
  expect(Math.abs(actual.b - expected.b)).toBeLessThan(COLOR_TOLERANCE);
}

test.describe("scan-to-pdf", () => {
  // Motor y almacen FALSOS (con `SCAN_REAL=1` no se inyectan: el mismo spec corre contra el motor real, integracion).
  test.beforeEach(async ({ page }) => {
    await installScanFakes(page);
  });

  test("captura un fotograma real de la camara (falsa) y genera un PDF con el frame correcto, sin rotarlo", async ({
    page,
  }) => {
    await page.goto("/scan-to-pdf");

    await page
      .getByRole("button", { name: /activar cámara|turn camera on/i })
      .click();

    // El host <video> confirma que llegaron datos reales del dispositivo
    // falso -- no basta con que el elemento exista, tiene que tener
    // dimensiones y un fotograma disponible.
    const video = page.locator("video");
    await expect(video).toBeVisible();
    await expect
      .poll(async () =>
        video.evaluate(
          (el: HTMLVideoElement) =>
            el.videoWidth > 0 && el.videoHeight > 0 && el.readyState >= 2,
        ),
      )
      .toBe(true);

    // Ningun error de camara (permiso denegado, dispositivo no encontrado...).
    // Se apunta al texto exacto del banner de error de esta herramienta, no
    // a role="alert" en general: el overlay de dev tools de Next.js expone
    // su propia region alert/live permanente, ajena a este flujo.
    await expect(
      page.getByText(/la cámara no está disponible|the camera is not available/i),
    ).toHaveCount(0);

    // Captura MANUAL con un solo disparo: sin captura automatica, que dispararia sola mientras el
    // fotograma de prueba esta quieto.
    await page.locator('[data-camera-action="auto"]').click();
    await page
      .getByRole("button", { name: /capturar página|capture page/i })
      .click();
    await expect(page.locator("[data-camera-count]")).toHaveText(/^1 (página|page)$/);

    // A revisar: EXACTAMENTE una pagina en la cuadricula (un contador exacto, no una coincidencia laxa).
    await page.getByRole("button", { name: /revisar \(1\)|review \(1\)/i }).click();
    await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(1);
    await expect(page.locator("[data-tile-processing]")).toHaveCount(0, { timeout: 30_000 });

    // Escenario fijado a «SIN recorte de perspectiva»: este spec protege el camino crudo (el fotograma llega al PDF con los
    // colores exactos de la camara y sin girar). Con el motor real el fotograma de prueba no tiene documento y entra entero;
    // con el motor falso el recorte es un 4 % por lado (se tiene en cuenta abajo). «Toda la foto» fija las esquinas completas.
    await page.locator('[data-page-grid] [data-page-main]').first().click();
    await page.locator('[data-editor-action="crop"]').click();
    await page.getByRole("button", { name: /toda la foto|whole photo/i }).click();
    await page.getByRole("button", { name: /aplicar recorte|apply crop/i }).click();
    // Filtro «Color»: el «Auto» de un documento de texto lo pasaria a grises y aqui se comprueban los colores del fotograma.
    await page.locator('[data-filter="color"]').click();
    await page.locator('[data-editor-action="done"]').click();
    await expect(page.locator("[data-tile-processing]")).toHaveCount(0, { timeout: 30_000 });

    await page.getByRole("button", { name: /guardar pdf|save pdf/i }).click();
    // «Ajustar»: la pagina del PDF final hereda el tamano exacto del
    // fotograma capturado, sin letterboxing de A4/Carta -- simplifica la
    // conversion de coordenadas al verificar los cuadrantes despues.
    await page.getByRole("tab", { name: /ajustar|fit/i }).click();
    await page.locator('[data-save-action="create"]').click();

    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: /descargar|download/i }).first().click();
    });

    expect(await getPageCount(bytes)).toBe(1);

    const size = await getPageSize(bytes, 1);
    // «Ajustar» + sin margen: la pagina hereda el pixel size exacto del
    // fotograma (320x240, la resolucion del dispositivo de camara falso).
    // Si el motor rotara la imagen por error, ancho y alto saldrian
    // intercambiados y esta asercion fallaria.
    expect(size.width).toBeCloseTo(CAMERA_WIDTH, 0);
    expect(size.height).toBeCloseTo(CAMERA_HEIGHT, 0);

    // La pagina es la foto entera incrustada como imagen, no texto.
    const ops = await getPageOperatorCounts(bytes, 1);
    expect(ops.textPaintOps).toBe(0);
    expect(ops.imagePaintOps).toBeGreaterThan(0);

    // Muestreo de pixeles reales en los 4 cuadrantes: prueba que el
    // fotograma que llego al PDF es el de la camara falsa (y no una
    // pagina en blanco, corrupta o con canales de color mezclados), y que
    // la orientacion de cada cuadrante coincide con el fixture original.
    const rendered = await renderPageToPixels(bytes, 1, 2);
    const quarterW = rendered.width / 4;
    const quarterH = rendered.height / 4;
    const sampleSize = Math.round(Math.min(quarterW, quarterH));

    const topLeft = rendered.averageColor(0, 0, sampleSize, sampleSize);
    const topRight = rendered.averageColor(
      rendered.width - sampleSize,
      0,
      sampleSize,
      sampleSize,
    );
    const bottomLeft = rendered.averageColor(
      0,
      rendered.height - sampleSize,
      sampleSize,
      sampleSize,
    );
    const bottomRight = rendered.averageColor(
      rendered.width - sampleSize,
      rendered.height - sampleSize,
      sampleSize,
      sampleSize,
    );

    expectColorClose(topLeft, EXPECTED_QUADRANTS.topLeft);
    expectColorClose(topRight, EXPECTED_QUADRANTS.topRight);
    expectColorClose(bottomLeft, EXPECTED_QUADRANTS.bottomLeft);
    expectColorClose(bottomRight, EXPECTED_QUADRANTS.bottomRight);
  });
});
