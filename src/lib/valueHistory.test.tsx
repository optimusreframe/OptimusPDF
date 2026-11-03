import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetValueHistoryCacheForTests,
  MAX_ENTRIES_PER_KEY,
  MAX_KEYS,
  MAX_PINNED_PER_KEY,
  VALUE_HISTORY_STORAGE_KEY,
  bestMatchForKey,
  clearValueHistory,
  countForKey,
  editValue,
  forgetValue,
  listRemembered,
  recordValue,
  setPinned,
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

  it("tope de 30 entradas por etiqueta (antes 5 por rótulo): expulsa la mas antigua", () => {
    expect(MAX_ENTRIES_PER_KEY).toBe(30);
    const values = Array.from({ length: MAX_ENTRIES_PER_KEY + 1 }, (_, index) => `v${index + 1}`);
    for (const value of values) {
      recordValue("nombre", value);
    }
    const kept = suggestValues("nombre", "", 100);
    expect(kept).toHaveLength(MAX_ENTRIES_PER_KEY);
    expect(kept[0]).toBe(`v${MAX_ENTRIES_PER_KEY + 1}`);
    expect(kept[kept.length - 1]).toBe("v2");
    expect(kept).not.toContain("v1");
  });

  it("un valor fijado no se expulsa por antiguedad al llegar al tope", () => {
    recordValue("nombre", "Valor fijado");
    expect(setPinned("nombre", "Valor fijado", true)).toBe(true);
    for (let index = 0; index < MAX_ENTRIES_PER_KEY + 5; index += 1) {
      recordValue("nombre", `otro ${index}`);
    }
    expect(countForKey("nombre")).toBe(MAX_ENTRIES_PER_KEY);
    expect(suggestValues("nombre", "", 100)[0]).toBe("Valor fijado");
  });

  it("solo se pueden fijar MAX_PINNED_PER_KEY valores por etiqueta", () => {
    for (let index = 0; index < MAX_PINNED_PER_KEY + 1; index += 1) recordValue("nombre", `fijable ${index}`);
    for (let index = 0; index < MAX_PINNED_PER_KEY; index += 1) {
      expect(setPinned("nombre", `fijable ${index}`, true)).toBe(true);
    }
    expect(setPinned("nombre", `fijable ${MAX_PINNED_PER_KEY}`, true)).toBe(false);
  });

  it("un rótulo conocido («nombre», «poliza») se guarda bajo su etiqueta; uno que no se reconoce, bajo si mismo", () => {
    recordValue("nombre", "Ana Perez");
    recordValue("poliza", "12345");
    recordValue("campo raro", "Algo suelto");
    const keys = listRemembered().map((group) => group.key);
    expect(keys).toEqual(expect.arrayContaining(["insuredName1", "policyNumber", "campo raro"]));
    expect(keys).not.toContain("nombre");
    expect(keys).not.toContain("poliza");
  });

  it("tope de MAX_KEYS etiquetas: al pasarse se expulsa la menos reciente, no la que se acaba de escribir", () => {
    for (let index = 0; index < MAX_KEYS + 1; index += 1) recordValue(`rotulo suelto ${index}`, `valor ${index}`);
    expect(listRemembered()).toHaveLength(MAX_KEYS);
    expect(bestMatchForKey(`rotulo suelto ${MAX_KEYS}`)).toBe(`valor ${MAX_KEYS}`);
    expect(bestMatchForKey("rotulo suelto 0")).toBeNull();
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

  it("un rótulo antiguo (sin etiqueta) completa con otras claves al escribir, solo si la propia no llega al limite", () => {
    recordValue("campo raro", "Ana Perez");
    recordValue("otro campo raro", "Anabel Ruiz");
    const suggestions = suggestValues("campo raro", "ana", 5);
    expect(suggestions[0]).toBe("Ana Perez");
    expect(suggestions).toContain("Anabel Ruiz");
    // Con el limite ya cubierto por la propia clave no se mezcla nada de fuera.
    expect(suggestValues("campo raro", "ana", 1)).toEqual(["Ana Perez"]);
    // Con el campo vacio solo se ofrece lo de la propia clave.
    expect(suggestValues("campo raro", "", 5)).toEqual(["Ana Perez"]);
  });

  it("una etiqueta nunca sugiere el dato de otra, ni con el campo vacio ni escribiendo", () => {
    recordValue("nombre", "Ana Perez");
    recordValue("direccion", "Calle Falsa 123");
    expect(suggestValues("nombre", "", 5)).toEqual(["Ana Perez"]);
    expect(suggestValues("nombre", "a", 5)).toEqual(["Ana Perez"]);
    expect(suggestValues("direccion", "a", 5)).toEqual(["Calle Falsa 123"]);
  });

  it("las que empiezan igual que lo escrito van antes que las que solo lo contienen; las fijadas, primero de cada grupo", () => {
    recordValue("direccion", "Avenida Sol 5");
    recordValue("direccion", "Calle Sol 1");
    recordValue("direccion", "Sol Naciente 9");
    recordValue("direccion", "Sol Poniente 2");
    setPinned("direccion", "Sol Naciente 9", true);
    expect(suggestValues("direccion", "sol", 10)).toEqual([
      "Sol Naciente 9",
      "Sol Poniente 2",
      "Calle Sol 1",
      "Avenida Sol 5",
    ]);
  });

  it("no distingue tildes ni mayusculas al filtrar", () => {
    recordValue("direccion", "Camino Real Ñandú");
    expect(suggestValues("direccion", "NANDU", 5)).toEqual(["Camino Real Ñandú"]);
  });

  it("clave sin ninguna entrada devuelve lista vacia", () => {
    expect(suggestValues("desconocida", "", 5)).toEqual([]);
  });
});

describe("editValue, valores largos y almacen anterior — src/lib/valueHistory.ts", () => {
  it("editValue corrige el texto conservando usos y fijado, y funde con uno igual que ya exista", () => {
    recordValue("nombre", "Ana Peres");
    recordValue("nombre", "Ana Peres");
    setPinned("nombre", "Ana Peres", true);
    recordValue("nombre", "Ana Perez");
    expect(editValue("nombre", "Ana Peres", "Ana Perez")).toBe(true);
    expect(countForKey("nombre")).toBe(1);
    expect(editValue("nombre", "No existe", "Otro valor")).toBe(false);
    const stored = JSON.parse(window.localStorage.getItem(VALUE_HISTORY_STORAGE_KEY) ?? "{}");
    expect(stored.entries.insuredName1[0]).toMatchObject({ value: "Ana Perez", uses: 3, pinned: true });
  });

  it("un valor de mas de 500 caracteres no se guarda", () => {
    recordValue("nombre", "x".repeat(501));
    expect(bestMatchForKey("nombre")).toBeNull();
    recordValue("nombre", "x".repeat(500));
    expect(bestMatchForKey("nombre")).toBe("x".repeat(500));
  });

  it("un almacen anterior (rótulos sueltos, sin uses/pinned) se lee: el rótulo conocido se funde en su etiqueta y el desconocido sigue sirviendo", () => {
    window.localStorage.setItem(
      VALUE_HISTORY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          nombre: [{ value: "Ana Perez", lastUsedAt: "2026-01-02T10:00:00.000Z" }],
          "policy number": [{ value: "POL-998", lastUsedAt: "2026-01-03T10:00:00.000Z" }],
          "campo raro": [{ value: "Dato suelto", lastUsedAt: "2026-01-01T10:00:00.000Z" }],
        },
      }),
    );
    __resetValueHistoryCacheForTests();
    expect(bestMatchForKey("insuredName1")).toBe("Ana Perez");
    expect(bestMatchForKey("policyNumber")).toBe("POL-998");
    expect(bestMatchForKey("campo raro")).toBe("Dato suelto");
    expect(bestMatchForKey("nombre")).toBe("Ana Perez");
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
