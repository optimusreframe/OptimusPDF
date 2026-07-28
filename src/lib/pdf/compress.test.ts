import { describe, expect, it } from "vitest";
import {
  COMPRESSION_LEVELS,
  COMPRESSION_PRESETS,
  DEFAULT_COMPRESS_OPTIONS,
  reductionPercent,
} from "@/lib/pdf/compress";

/**
 * LIMITACION DE ENTORNO (leer antes de tocar este archivo):
 *
 * `compressPdf` rasteriza cada pagina con pdf.js (`openPdfDocument` +
 * `renderPageToCanvas`, via `@/lib/pdf/core`) y la primera linea de la
 * funcion ya abre el documento con pdf.js. Este proyecto ejecuta Vitest
 * con `environment: "node"` (ver `vitest.config.ts`) y SIN `jsdom`/`canvas`
 * (paquete npm) instalados.
 *
 * Comprobado en este entorno con un probe dedicado: `openPdfDocument`
 * lanza `ReferenceError: DOMMatrix is not defined` al intentar abrir
 * incluso un PDF valido y sin cifrar, ANTES de llegar a rasterizar ninguna
 * pagina. `compressPdf` reempaqueta ese error como `PdfError("unknown",
 * "DOMMatrix is not defined")` via `toPdfError` — no hay ninguna llamada a
 * `compressPdf` (exito, ni error con codigo significativo como
 * "corrupt"/"empty") que se pueda ejecutar aqui, porque no existe una
 * ruta de validacion previa a la apertura de pdf.js (a diferencia de
 * `redact.ts`, que primero valida las cajas de censura).
 *
 * Por eso esta suite se limita a las funciones y datos puros exportados
 * que SI son verificables sin pdf.js/DOM: `reductionPercent` y la forma de
 * `COMPRESSION_PRESETS`/`COMPRESSION_LEVELS` (que los niveles de calidad
 * son valores realmente distintos y ordenados, tal como exige la
 * consigna "las opciones de calidad se respetan").
 *
 * La verificacion real de "el PDF de salida es valido y mas pequeno (o al
 * menos se reporta su tamano real)" exige ejecutar `compressPdf` de
 * extremo a extremo, lo que requiere `jsdom` + el paquete `canvas` (o un
 * shim equivalente) como devDependency — cambio que excede el alcance de
 * "solo anadir archivos de test" de esta tarea. Se reporta como
 * bloqueador en vez de simular la rasterizacion con mocks, que darian una
 * falsa sensacion de cobertura sin ejecutar el motor de verdad.
 */

describe("reductionPercent — src/lib/pdf/compress.ts", () => {
  it("calcula el porcentaje de reduccion cuando el resultado pesa menos", () => {
    expect(reductionPercent(1000, 250)).toBe(75);
  });

  it("da un porcentaje negativo cuando el resultado pesa MAS que el original", () => {
    expect(reductionPercent(1000, 1500)).toBe(-50);
  });

  it("da 0 cuando el tamano no cambia", () => {
    expect(reductionPercent(1000, 1000)).toBe(0);
  });

  it("da 0 si el tamano original es 0 (evita division por cero)", () => {
    expect(reductionPercent(0, 500)).toBe(0);
  });

  it("da 0 si el tamano original es negativo o no finito", () => {
    expect(reductionPercent(-10, 5)).toBe(0);
    expect(reductionPercent(Number.NaN, 5)).toBe(0);
    expect(reductionPercent(Number.POSITIVE_INFINITY, 5)).toBe(0);
  });

  it("redondea al entero mas cercano", () => {
    // (1000 - 667) / 1000 = 0.333 -> 33%
    expect(reductionPercent(1000, 667)).toBe(33);
  });
});

describe("COMPRESSION_PRESETS / COMPRESSION_LEVELS — src/lib/pdf/compress.ts", () => {
  it("expone exactamente los 3 niveles documentados, en orden de mas a menos agresivo", () => {
    expect(COMPRESSION_LEVELS).toEqual(["extreme", "recommended", "low"]);
  });

  it("cada nivel de COMPRESSION_LEVELS tiene un preset definido", () => {
    for (const level of COMPRESSION_LEVELS) {
      expect(COMPRESSION_PRESETS[level]).toBeDefined();
    }
  });

  it("'extreme' es estrictamente mas agresivo que 'recommended', y este que 'low' (escala y calidad crecientes)", () => {
    const { extreme, recommended, low } = COMPRESSION_PRESETS;

    expect(extreme.scale).toBeLessThan(recommended.scale);
    expect(recommended.scale).toBeLessThan(low.scale);

    expect(extreme.quality).toBeLessThan(recommended.quality);
    expect(recommended.quality).toBeLessThan(low.quality);
  });

  it("la calidad JPEG de cada preset esta en el rango valido (0, 1]", () => {
    for (const level of COMPRESSION_LEVELS) {
      const { quality } = COMPRESSION_PRESETS[level];
      expect(quality).toBeGreaterThan(0);
      expect(quality).toBeLessThanOrEqual(1);
    }
  });

  it("la escala de cada preset es positiva", () => {
    for (const level of COMPRESSION_LEVELS) {
      expect(COMPRESSION_PRESETS[level].scale).toBeGreaterThan(0);
    }
  });

  it("DEFAULT_COMPRESS_OPTIONS usa el nivel 'recommended'", () => {
    expect(DEFAULT_COMPRESS_OPTIONS).toEqual({ level: "recommended" });
  });
});
