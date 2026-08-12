import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetValueHistoryCacheForTests,
  VALUE_HISTORY_STORAGE_KEY,
  bestMatchForKey,
  clearValueHistory,
  forgetValue,
  recordValue,
  suggestValues,
} from "@/lib/valueHistory";

/**
 * `valueHistory.ts` es logica pura de `src/lib/`, pero vive en el
 * proyecto "components" (`.test.tsx`, entorno jsdom) a proposito: es el
 * unico entorno del repo con un `window.localStorage` real, y este modulo
 * es justamente el que decide que se persiste ahi. El proyecto "engines"
 * (`.test.ts`) corre en Node sin DOM (ver `vitest.config.ts`).
 */

beforeEach(() => {
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
});

describe("recordValue / bestMatchForKey — src/lib/valueHistory.ts", () => {
  it("recuerda el valor mas reciente de una clave", () => {
    recordValue("nombre", "Ana Perez");
    expect(bestMatchForKey("nombre")).toBe("Ana Perez");
  });

  it("deduplica: reescribir el mismo valor lo mueve al frente sin duplicarlo", () => {
    recordValue("nombre", "Ana Perez");
    recordValue("nombre", "Luis Gomez");
    recordValue("nombre", "Ana Perez");
    expect(suggestValues("nombre", "", 10)).toEqual(["Ana Perez", "Luis Gomez"]);
  });

  it("LRU dentro de una clave: el mas reciente queda primero", () => {
    recordValue("nombre", "Uno");
    recordValue("nombre", "Dos");
    recordValue("nombre", "Tres");
    expect(suggestValues("nombre", "", 10)).toEqual(["Tres", "Dos", "Uno"]);
  });

  it("tope de 5 entradas por clave: expulsa la mas antigua", () => {
    for (const value of ["v1", "v2", "v3", "v4", "v5", "v6"]) {
      recordValue("nombre", value);
    }
    expect(suggestValues("nombre", "", 10)).toEqual([
      "v6",
      "v5",
      "v4",
      "v3",
      "v2",
    ]);
  });

  it("ignora valores vacios o de un solo caracter", () => {
    recordValue("nombre", "  ");
    recordValue("nombre", "a");
    expect(bestMatchForKey("nombre")).toBeNull();
  });

  it("sin ninguna entrada guardada devuelve null", () => {
    expect(bestMatchForKey("desconocida")).toBeNull();
  });

  it("persiste entre instancias del store (localStorage real)", () => {
    recordValue("nombre", "Ana Perez");
    __resetValueHistoryCacheForTests();
    expect(bestMatchForKey("nombre")).toBe("Ana Perez");
  });
});

describe("suggestValues — src/lib/valueHistory.ts", () => {
  it("filtra por coincidencia parcial, sin distinguir mayusculas", () => {
    recordValue("nombre", "Ana Perez");
    recordValue("nombre", "Luis Gomez");
    expect(suggestValues("nombre", "ana", 10)).toEqual(["Ana Perez"]);
  });

  it("no sugiere el valor exacto que ya esta escrito", () => {
    recordValue("nombre", "Ana Perez");
    expect(suggestValues("nombre", "Ana Perez", 10)).toEqual([]);
  });

  it("prioriza siempre la misma clave, incluso con mas resultados disponibles en otras", () => {
    recordValue("poliza", "12345");
    recordValue("nombre", "67890");
    expect(suggestValues("nombre", "", 1)).toEqual(["67890"]);
  });

  it("completa con otras claves solo si la propia no llega al limite", () => {
    recordValue("nombre", "Ana Perez");
    recordValue("direccion", "Calle Falsa 123");
    const suggestions = suggestValues("nombre", "", 5);
    expect(suggestions[0]).toBe("Ana Perez");
    expect(suggestions).toContain("Calle Falsa 123");
  });

  it("clave sin ninguna entrada devuelve lista vacia", () => {
    expect(suggestValues("desconocida", "", 5)).toEqual([]);
  });
});

describe("forgetValue — src/lib/valueHistory.ts", () => {
  it("quita solo el valor indicado, conserva el resto", () => {
    recordValue("nombre", "Ana Perez");
    recordValue("nombre", "Luis Gomez");
    forgetValue("nombre", "Ana Perez");
    expect(suggestValues("nombre", "", 10)).toEqual(["Luis Gomez"]);
  });

  it("al quitar la ultima entrada de una clave, deja de aparecer del todo", () => {
    recordValue("nombre", "Ana Perez");
    forgetValue("nombre", "Ana Perez");
    expect(bestMatchForKey("nombre")).toBeNull();
  });
});

describe("clearValueHistory — src/lib/valueHistory.ts", () => {
  it("borra todo lo guardado", () => {
    recordValue("nombre", "Ana Perez");
    recordValue("poliza", "12345");
    clearValueHistory();
    expect(bestMatchForKey("nombre")).toBeNull();
    expect(bestMatchForKey("poliza")).toBeNull();
    expect(window.localStorage.getItem(VALUE_HISTORY_STORAGE_KEY)).toBeNull();
  });
});

describe("resurreccion entre pestañas — src/lib/valueHistory.ts", () => {
  it("un evento 'storage' de otra pestaña invalida la cache de esta", () => {
    recordValue("nombre", "Ana Perez");
    expect(bestMatchForKey("nombre")).toBe("Ana Perez");

    // Otra pestaña borro el historial: escribe directo en localStorage
    // (sin pasar por este modulo) y dispara el evento que el navegador
    // manda a las DEMAS pestañas cuando `localStorage` cambia.
    window.localStorage.removeItem(VALUE_HISTORY_STORAGE_KEY);
    window.dispatchEvent(
      new StorageEvent("storage", { key: VALUE_HISTORY_STORAGE_KEY }),
    );

    expect(bestMatchForKey("nombre")).toBeNull();
  });
});
