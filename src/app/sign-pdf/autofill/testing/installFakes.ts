import { createFakeOcr, fakeEngine } from "@/app/sign-pdf/autofill/testing/fakeEngine";

/**
 * Punto de entrada que Playwright compila a un IIFE (`e2e/helpers/autofill-ui.ts`) y ejecuta con `addInitScript` ANTES de la
 * pagina: deja el motor falso en `globalThis.__optimusAutofillEngine` y el doble del modelo de lectura en
 * `globalThis.__optimusAutofillOcr`, que lee `autofillServices.ts`. No esta en el build de
 * produccion.
 */
globalThis.__optimusAutofillEngine = fakeEngine;
globalThis.__optimusAutofillOcr = createFakeOcr(globalThis.__autofillFakeConfig?.ocr);
