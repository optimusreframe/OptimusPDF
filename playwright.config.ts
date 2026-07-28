import { defineConfig, devices } from "@playwright/test";

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
  workers: process.env.CI ? 1 : undefined,
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
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
