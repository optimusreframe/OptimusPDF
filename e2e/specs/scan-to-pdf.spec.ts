import { expect, test } from "@playwright/test";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, getPageOperatorCounts, getPageSize } from "../helpers/pdf-inspection";
import { renderPageToPixels } from "../helpers/pdf-render-inspection";

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
// de croma) mas la recompresion JPEG (calidad 0.92) que aplica
// captureFrame(). Los colores elegidos difieren en >150 por canal entre
// si, asi que este margen no puede confundir un cuadrante con otro.
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

    // "Ajustar": la pagina del PDF final hereda el tamano exacto del
    // fotograma capturado, sin letterboxing de A4/Carta -- simplifica la
    // conversion de coordenadas al verificar los cuadrantes despues.
    await page.getByRole("tab", { name: /ajustar|fit/i }).click();

    await page
      .getByRole("button", { name: /capturar página|capture page/i })
      .click();

    // Confirma que quedo EXACTAMENTE una captura en la tira antes de
    // generar el PDF (mismo espiritu que el chequeo de "1 zona" en
    // redact.spec.ts: un contador exacto, no una coincidencia laxa).
    await expect(page.getByAltText(/^(Captura 1|Capture 1)$/i)).toBeVisible();

    await page
      .getByRole("button", { name: /generar pdf|build pdf/i })
      .first()
      .click();

    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: /descargar|download/i }).first().click();
    });

    expect(await getPageCount(bytes)).toBe(1);

    const size = await getPageSize(bytes, 1);
    // "Ajustar" + sin margen: la pagina hereda el pixel size exacto del
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
