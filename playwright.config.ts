import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/** Puerto del servidor de pruebas (`PW_PORT=3197 npx playwright test ...`). Por defecto, el de siempre. */
const PORT = Number(process.env.PW_PORT ?? 3000);
const FAKE_CAMERA_Y4M = path.resolve(__dirname, "e2e/fixtures/fake-camera.y4m");

/**
 * Suite E2E de navegador real para las rutas que dependen de pdfjs-dist /
 * canvas y no pueden ejercitarse en el entorno Node de Vitest
 * (compress, redact, compare, y el render compartido de core.ts via
 * pdf-to-jpg). Solo Chromium: mantiene el coste de CI bajo y es el motor
 * que ya se usa para el resto de verificacion manual de este proyecto.
 */
export default defineConfig({
  testDir: "./e2e/specs",
  outputDir: ".evidence/playwright",
  fullyParallel: false,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: ".evidence/playwright-report", open: "never" }]]
    : "list",
  use: {
    // "localhost", no "127.0.0.1": Next.js 16 bloquea por defecto los
    // recursos de dev (HMR, overlay de errores) que vienen de un origen
    // distinto al que el propio servidor considera local, y trata a
    // "127.0.0.1" como cross-origin frente a "localhost" -- confirmado en
    // los logs del webServer ("Blocked cross-origin request to Next.js
    // dev resource"). "localhost" es ademas el origen que ya se usa en el
    // resto de la verificacion manual de este proyecto.
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    // En CI se prueba la build de PRODUCCION (`next build` + `next start`): el
    // servidor de desarrollo pinta el indicador `nextjs-portal`, que
    // intercepta clics sobre el dock movil de PDF Pro y hacia fallar 7 de 75
    // pruebas Pro solo en CI. En local se mantiene `npm run dev` (rapido).
    command: process.env.CI
      ? `npm run build && npm run start -- -p ${PORT}`
      : `npm run dev -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 600_000 : 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // scan-to-pdf necesita flags de camara falsa que no queremos aplicar
      // a toda la suite: corre en su propio proyecto, ver mas abajo.
      testIgnore: /scan-to-pdf\.spec\.ts$/,
    },
    {
      name: "chromium-fake-camera",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["camera"],
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-video-capture=${FAKE_CAMERA_Y4M}`,
          ],
        },
      },
      testMatch: /scan-to-pdf\.spec\.ts$/,
    },
  ],
});
