/**
 * Punto de entrada del paquete de pruebas de «Mis documentos» (U2.5): lo que el spec empaqueta con Vite y mete en una
 * pagina real para crear plantillas con las funciones de `templates.ts` (como lo hara la unidad del editor) y leer la
 * biblioteca. Solo lo usan las pruebas E2E.
 */
export * from "../../src/lib/docLibrary/templates";
export * from "../../src/lib/docLibrary/store";
export { sampleDraft, signField, variantOf } from "../../src/lib/docLibrary/testing/templateSamples";
