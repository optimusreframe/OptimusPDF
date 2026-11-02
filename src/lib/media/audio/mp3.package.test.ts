import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Auditoria ESTATICA del paquete que empaqueta LAME. El Worker del codificador viaja como texto dentro de
 * `@mediabunny/mp3-encoder` (se crea desde un blob); esta prueba falla si una version futura:
 *  - cambia de version sin que lo notemos (package.json fija la exacta; se comprueba el lock y el paquete instalado);
 *  - mete en el Worker `eval`, `new Function`, `importScripts`, WebSocket, `sendBeacon` o importaciones dinamicas, que la CSP
 *    de produccion (`'wasm-unsafe-eval'`, sin `'unsafe-eval'`) no deja pasar o que sacarian datos del dispositivo;
 *  - saca el WASM del propio texto (hoy va dentro del Worker como cadena binaria que empieza por `\0asm`: no hay `fetch` de un
 *    archivo `.wasm` aparte).
 * La unica mencion a `fetch`/`XMLHttpRequest` es el cargador estandar de Emscripten, que solo se usa si el WASM NO va en linea.
 */

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version: string; license?: string }> };
const installed = JSON.parse(read("node_modules/@mediabunny/mp3-encoder/package.json")) as { version: string; license: string };
const bundle = read("node_modules/@mediabunny/mp3-encoder/dist/bundles/mediabunny-mp3-encoder.mjs");

/** Texto del Worker: la funcion `Worker2()` del paquete devuelve `inlineWorker('<codigo>')`. */
const workerSource = (() => {
  const start = bundle.indexOf("function Worker2()");
  const end = bundle.indexOf("\n}", start);
  return bundle.slice(start, end);
})();

describe("@mediabunny/mp3-encoder empaquetado", () => {
  it("version EXACTA fijada en package.json, igual que el lock y que el paquete instalado, con la licencia MPL-2.0", () => {
    const wanted = pkg.dependencies["@mediabunny/mp3-encoder"];
    expect(wanted).toMatch(/^\d+\.\d+\.\d+$/); // sin ^ ni ~
    expect(lock.packages["node_modules/@mediabunny/mp3-encoder"].version).toBe(wanted);
    expect(installed.version).toBe(wanted);
    expect(installed.license).toBe("MPL-2.0");
    // Compatible con la mediabunny que ya usa el convertidor de video.
    expect(lock.packages["node_modules/mediabunny"].version.split(".").slice(0, 2)).toEqual(wanted.split(".").slice(0, 2));
  });

  it("el paquete trae los textos de licencia de LAME (LGPL) y del propio codificador (MPL-2.0)", () => {
    expect(read("node_modules/@mediabunny/mp3-encoder/licenses/lame/COPYING")).toMatch(/GNU (LESSER|LIBRARY) GENERAL PUBLIC LICENSE/i);
    expect(read("node_modules/@mediabunny/mp3-encoder/LICENSE")).toMatch(/Mozilla Public License/);
    expect(read("node_modules/@mediabunny/mp3-encoder/README.md")).toMatch(/LAME 3\.100/);
  });

  it("el Worker lleva el WASM en linea (sin archivo .wasm aparte) y no usa eval, new Function, importScripts, WebSocket, sendBeacon ni import()", () => {
    expect(workerSource.length).toBeGreaterThan(100_000);
    expect(workerSource).toContain("0asm"); // cabecera del modulo WebAssembly dentro del propio texto
    expect(workerSource).not.toMatch(/["'`][^"'`\s]*\.wasm["'`]/); // ninguna ruta a un archivo .wasm
    for (const forbidden of ["eval(", "new Function", "importScripts", "WebSocket", "sendBeacon", "import(", "new Worker", "indexedDB", "localStorage", "document."]) {
      expect(workerSource.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("`fetch` y XMLHttpRequest aparecen UNA vez cada uno, y solo en el cargador estandar de Emscripten (same-origin)", () => {
    expect(workerSource.split("fetch(").length - 1).toBe(1);
    expect(workerSource.split("XMLHttpRequest").length - 1).toBe(1);
    expect(workerSource).toContain('fetch(A,{credentials:"same-origin"})');
  });
});
