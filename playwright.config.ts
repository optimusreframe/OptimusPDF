import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/** Puerto del servidor de pruebas (`PW_PORT=3197 npx playwright test ...`). Por defecto, el de siempre. */
const PORT = Number(process.env.PW_PORT ?? 3000);
const FAKE_CAMERA_Y4M = path.resolve(__dirname, "e2e/fixtures/fake-camera.y4m");

/**
 * Pruebas cruzadas OPCIONALES en WebKit (Safari) y Firefox. Por defecto NO existen (ni en local ni en CI): el
 * conjunto que corre hoy es exactamente el de Chromium. Se activan con `PW_BROWSERS` (lista separada por comas):
 *   all          -> webkit + webkit-mobile + webkit-ipad + firefox
 *   webkit       -> Desktop Safari (WebKit de Playwright)
 *   webkit-mobile-> iPhone 15 Pro (WebKit movil, tactil)
 *   webkit-ipad  -> iPad Pro 11 (WebKit tactil, 834 x 1194): el aparato del adjuster que firma contratos (Fase 0 «Firma agil»)
 *   firefox      -> Desktop Firefox
 * Cada proyecto cruzado corre solo los flujos principales (`CROSS_SPECS`); con `PW_CROSS_FULL=1` corre todos los
 * specs (menos scan-to-pdf, que necesita la camara falsa de Chromium). Detalle y comandos: `docs/COMPATIBILIDAD-NAVEGADORES.md`.
 */
const CROSS = (process.env.PW_BROWSERS ?? "")
  .split(",")
  .map((token) => token.trim().toLowerCase())
  .filter(Boolean);
const wantsCross = (name: "webkit" | "webkit-mobile" | "webkit-ipad" | "firefox") => CROSS.includes("all") || CROSS.includes(name);
const CROSS_SPECS =
  /(pdf-pro-(foundation|viewer|viewer-damaged|pages|tools|export|export-persistent|modes-edit|modes-sign|create|journeys|unload|history-memory|memory|shared-content-edit)|pages-migration|pages-warnings|merge-pdf|split-pdf|organize-pdf|remove-extract-pages|edit-existing-text|edit-pdf-flow|edit-quality|edit-palette-reach|sign-quality|sign-multi|signature-font|sign-edit-summary|sign-upload-backup|sign-backup-merge|sign-upload-a11y|backup-drafts-settings|settings-package|doc-fingerprint|my-documents|documents-backup|exif-orientation|compress[\w-]*|protect-unlock|ocr-pdf|convert-out|image-conversion|a11y-sweep|tool-errors|focus-own-headers)\.spec\.ts$/;
/** scan-to-pdf depende de `--use-fake-device-for-media-stream` (solo Chromium). */
const crossMatch = process.env.PW_CROSS_FULL ? /(?<!scan-to-pdf)\.spec\.ts$/ : CROSS_SPECS;
/**
 * `webkit-mobile` (iPhone 15 Pro: agente de usuario de iOS, 393 px, DPR 3, tactil) deja fuera los specs con bloques de
 * escritorio por diseno: rueda del raton (Playwright no la soporta en WebKit movil), arrastres con raton, la barra
 * flotante de escritorio y las medidas de escritorio. Sus bloques moviles (375 px, tactil) ya corren en `webkit`.
 */
const MOBILE_EXCLUDED = /(compress[\w-]*|edit-pdf-flow|pdf-pro-viewer|pdf-pro-pages|pdf-pro-modes-sign|pdf-pro-memory|tool-errors)\.spec\.ts$/;

/**
 * Specs de la Fase 0 «Firma agil» (`docs/PLAN-FIRMA-AGIL.md` §3, U0.1): reproducen la perdida de trabajo al firmar
 * (turno que se reinicia, BACK del navegador, Recientes -> Continuar); y de la Fase 1 (`sign-assignment`: tabla «¿Quien firma
 * que?», copias, orden de turnos y revision antes de descargar) y de la Fase 2 (`sign-templates*`: plantillas de documento,
 * aplicacion automatica y automapeo). Solo `webkit-ipad` los suma a `CROSS_SPECS`;
 * los demas proyectos cruzados no cambian. En Chromium corren porque `chromium` no filtra por archivo.
 */
const F0_SPECS = /(sign-ceremony-turns|sign-recovery|sign-record|sign-privacy|recent-continue|sign-draft-safety|sign-stale-signature|sign-assignment|sign-templates|sign-templates-a11y|sign-templates-no-loss|sign-templates-stale|sign-templates-no-loss-a11y|sign-templates-variants)\.spec\.ts$/;
/**
 * Las pruebas que hoy DEBEN fallar (defectos aun sin corregir) llevan `@f0-pendiente` en el titulo y se EXCLUYEN de
 * cualquier ejecucion por defecto (local y CI) para no dejar la suite en rojo. `PW_F0=1` las incluye:
 *   PW_F0=1 npx playwright test sign-ceremony-turns sign-recovery recent-continue
 * Cada unidad que corrige un defecto (U0.2 / U0.3 / U0.6) quita la etiqueta de las pruebas que ya pasan.
 */
const F0_PENDING = /@f0-pendiente/;

/**
 * Suite E2E de navegador real para las rutas que dependen de pdfjs-dist /
 * canvas y no pueden ejercitarse en el entorno Node de Vitest
 * (compress, redact, compare, y el render compartido de core.ts via
 * pdf-to-jpg). Por defecto (y en CI) solo Chromium: mantiene el coste de CI bajo
 * y es el motor que ya se usa para el resto de verificacion manual de este
 * proyecto. WebKit y Firefox son opcionales (ver `PW_BROWSERS` arriba).
 */
export default defineConfig({
  testDir: "./e2e/specs",
  outputDir: ".evidence/playwright",
  fullyParallel: false,
  grepInvert: process.env.PW_F0 === "1" ? undefined : F0_PENDING,
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
    // WebKit aplica `upgrade-insecure-requests` tambien a http://localhost (pagina en blanco): ver next.config.ts.
    env:
      wantsCross("webkit") || wantsCross("webkit-mobile") || wantsCross("webkit-ipad")
        ? { CSP_SKIP_UPGRADE_INSECURE: "1" }
        : undefined,
    // `PW_REUSE_SERVER=1` permite, incluso con CI=1, apuntar a una build de produccion ya levantada en PW_PORT.
    reuseExistingServer: !process.env.CI || !!process.env.PW_REUSE_SERVER,
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
    ...(wantsCross("webkit")
      ? [{ name: "webkit", use: { ...devices["Desktop Safari"] }, testMatch: crossMatch }]
      : []),
    ...(wantsCross("webkit-mobile")
      ? [{ name: "webkit-mobile", use: { ...devices["iPhone 15 Pro"] }, testMatch: crossMatch, testIgnore: MOBILE_EXCLUDED }]
      : []),
    ...(wantsCross("webkit-ipad")
      ? [{ name: "webkit-ipad", use: { ...devices["iPad Pro 11"] }, testMatch: [crossMatch, F0_SPECS], testIgnore: MOBILE_EXCLUDED }]
      : []),
    ...(wantsCross("firefox")
      ? [{ name: "firefox", use: { ...devices["Desktop Firefox"] }, testMatch: crossMatch }]
      : []),
  ],
});
