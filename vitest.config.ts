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

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "engines",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "components",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.dom.ts"],
        },
      },
    ],
  },
});
