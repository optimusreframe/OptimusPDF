import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Configuracion de Vitest en dos proyectos, porque conviven dos clases de
 * test con necesidades opuestas:
 *
 * - "engines": los motores de `src/lib/pdf/` son logica pura (generan y
 *   leen PDFs con `@cantoo/pdf-lib` directamente en Node). El entorno
 *   "node" basta y ademas alguno cuenta con que NO exista `window` de
 *   serie (ver la cabecera de `sign.test.ts`).
 * - "components": los componentes de `src/app/` necesitan DOM, asi que
 *   van en "jsdom" con Testing Library y con las pocas APIs de puntero y
 *   de layout que jsdom todavia no trae (ver `vitest.setup.dom.ts`).
 *
 * La separacion es por extension: `.test.ts` para motores, `.test.tsx`
 * para componentes. Solo se resuelve el alias `@/*` -> `src/*` para poder
 * importar igual que lo hace el resto del proyecto (ver `tsconfig.json`).
 */

const alias = { "@": path.resolve(__dirname, "./src") };

/**
 * Plazos de Vitest (por defecto 5 s por test y 10 s por hook).
 *
 * Medido en una maquina libre: el test mas lento de la suite tarda ~6 s
 * (los que esperan el aviso «Deshacer» de 6 s con temporizador real) y
 * hay una veintena entre 1 y 4 s (motores de zip/xlsx/docx con datos
 * grandes y flujos completos de firma). Con la maquina cargada, o con los
 * ~17 workers peleandose por CPU, esos mismos tests se estiran de 2 a 4
 * veces y rozaban los 5 s por defecto, dando fallos intermitentes de
 * «Test timed out» que no indican ningun defecto. El plazo solo decide
 * cuanto tarda en declararse colgado un test; no cambia ninguna asercion
 * ni alarga los tests que pasan. 30 s deja >4x de margen sobre el peor
 * caso medido.
 */
const TEST_TIMEOUT_MS = 30_000;
const HOOK_TIMEOUT_MS = 30_000;

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "engines",
          environment: "node",
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          include: ["src/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "components",
          environment: "jsdom",
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.dom.ts"],
        },
      },
    ],
  },
});
