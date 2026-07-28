import { describe, expect, it } from "vitest";
import { diffWords, tokenizeWords } from "@/lib/pdf/compare";

/**
 * `compare.ts` tiene dos capas: (1) `tokenizeWords`/`diffWords`, el motor
 * de diferencias palabra a palabra (LCS), que es logica pura sin
 * dependencias de plataforma; y (2) `extractPageTexts`/`comparePdfFiles`,
 * que envuelven esa logica con extraccion de texto via `openPdfDocument`
 * (pdf.js) de `core.ts`.
 *
 * LIMITACION DE ENTORNO (ver tambien `core.test.ts`): se probo por
 * experimentacion que `openPdfDocument` no funciona bajo
 * `environment: "node"` de Vitest tal y como esta configurado este
 * proyecto: pdf.js requiere `DOMMatrix` (inexistente en Node,
 * `ReferenceError: DOMMatrix is not defined`) y, aun poniendole un shim
 * minimo a `DOMMatrix`, el propio pdf.js advierte "Please use the
 * `legacy` build in Node.js environments" y despues falla al resolver
 * `PDF_WORKER_SRC` ("/pdf.worker.min.mjs", una ruta absoluta pensada
 * para servirse desde `public/` en el navegador) como si fuera un modulo
 * de Node instalable. Arreglar esto exigiria tocar `core.ts` (importar
 * el build "legacy" de pdfjs-dist, o inyectar un worker distinto segun
 * entorno) o anadir dependencias nuevas (`jsdom` + `canvas`) — ambas
 * fuera del alcance de esta tarea (solo tests, sin tocar fuente ni
 * anadir dependencias). Por eso `extractPageTexts` y `comparePdfFiles`
 * (las funciones que exponen el "detectar diferencias entre dos
 * versiones de un PDF" documentado) NO tienen test funcional end-to-end
 * en esta suite: se cubre en su lugar, de forma exhaustiva, el motor de
 * diff que sí es logica pura y sí es responsable de "detectar las
 * diferencias" una vez que hay texto extraido.
 */

describe("tokenizeWords — src/lib/pdf/compare.ts", () => {
  it("separa por espacios en blanco y descarta vacios", () => {
    expect(tokenizeWords("hola   mundo\tcruel\nmundo")).toEqual([
      "hola",
      "mundo",
      "cruel",
      "mundo",
    ]);
  });

  it("texto vacio -> lista vacia", () => {
    expect(tokenizeWords("")).toEqual([]);
    expect(tokenizeWords("   ")).toEqual([]);
  });
});

describe("diffWords — src/lib/pdf/compare.ts", () => {
  it("dos listas identicas: todo 'equal', sin anadidos ni eliminados", () => {
    const a = ["el", "veloz", "zorro", "marron"];
    const result = diffWords(a, [...a]);

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.coarse).toBe(false);
    expect(result.left).toEqual([{ op: "equal", text: a.join(" ") }]);
    expect(result.right).toEqual([{ op: "equal", text: a.join(" ") }]);
  });

  it("insercion pura al final: prefijo comun 'equal' + sufijo 'insert' en B", () => {
    const a = ["hola", "mundo"];
    const b = ["hola", "mundo", "cruel"];
    const result = diffWords(a, b);

    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.left).toEqual([{ op: "equal", text: "hola mundo" }]);
    expect(result.right).toEqual([
      { op: "equal", text: "hola mundo" },
      { op: "insert", text: "cruel" },
    ]);
  });

  it("eliminacion pura al final: sufijo 'delete' solo en A", () => {
    const a = ["hola", "mundo", "cruel"];
    const b = ["hola", "mundo"];
    const result = diffWords(a, b);

    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(result.left).toEqual([
      { op: "equal", text: "hola mundo" },
      { op: "delete", text: "cruel" },
    ]);
    expect(result.right).toEqual([{ op: "equal", text: "hola mundo" }]);
  });

  it("sustitucion en medio: detecta el bloque cambiado y conserva prefijo/sufijo comunes", () => {
    const a = ["uno", "dos", "tres", "cuatro"];
    const b = ["uno", "dos-bis", "tres", "cuatro"];
    const result = diffWords(a, b);

    expect(result.removed).toBe(1);
    expect(result.added).toBe(1);
    expect(result.left).toEqual([
      { op: "equal", text: "uno" },
      { op: "delete", text: "dos" },
      { op: "equal", text: "tres cuatro" },
    ]);
    expect(result.right).toEqual([
      { op: "equal", text: "uno" },
      { op: "insert", text: "dos-bis" },
      { op: "equal", text: "tres cuatro" },
    ]);
  });

  it("A vacio: todo 'insert' en B", () => {
    const result = diffWords([], ["hola", "mundo"]);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.left).toEqual([]);
    expect(result.right).toEqual([{ op: "insert", text: "hola mundo" }]);
  });

  it("B vacio: todo 'delete' en A", () => {
    const result = diffWords(["hola", "mundo"], []);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
    expect(result.left).toEqual([{ op: "delete", text: "hola mundo" }]);
    expect(result.right).toEqual([]);
  });

  it("ambos vacios: sin cambios", () => {
    const result = diffWords([], []);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.left).toEqual([]);
    expect(result.right).toEqual([]);
  });

  it("reordenar dos palabras se ve como eliminar+insertar (no como 'equal' reordenado)", () => {
    const result = diffWords(["rojo", "azul"], ["azul", "rojo"]);
    expect(result.added).toBeGreaterThan(0);
    expect(result.removed).toBeGreaterThan(0);
  });

  it("degrada a 'coarse' cuando el producto de tamanos supera el limite de celdas LCS", () => {
    // (n+1)*(m+1) > 4_000_000 fuerza la rama 'coarse' sin construir la tabla DP.
    const a = Array.from({ length: 2100 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 2100 }, (_, i) => `b${i}`);
    const result = diffWords(a, b);

    expect(result.coarse).toBe(true);
    expect(result.removed).toBe(a.length);
    expect(result.added).toBe(b.length);
  });

  it("no marca 'coarse' cuando el diff cabe dentro del limite de celdas", () => {
    const a = ["uno", "dos", "tres"];
    const b = ["uno", "dos-bis", "tres"];
    const result = diffWords(a, b);
    expect(result.coarse).toBe(false);
  });
});
