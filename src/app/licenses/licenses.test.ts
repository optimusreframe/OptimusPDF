import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LAME, npmTarballUrl, npmVersionUrl, sourceTreeUrl } from "@/app/licenses/lame";
import { LICENSE_TEXT_URLS, SERVER_SIDE, USED_UNDER, licenseIds } from "@/app/licenses/licenseTexts";
import { PACKAGES } from "@/app/licenses/packages";
import { STRINGS } from "@/app/licenses/strings";

/**
 * Los datos de `/licenses` son COPIA de package.json y de los paquetes instalados: esta prueba los compara uno a uno, de modo
 * que subir una version, anadir o quitar una dependencia, o cambiar el empaquetado de LAME, rompe la prueba hasta actualizar
 * `packages.ts` / `lame.ts`. Nada se inventa: cada fila sale de `node_modules/<paquete>/package.json`.
 */

const root = process.cwd();
const readJson = <T>(relative: string): T => JSON.parse(readFileSync(path.join(root, relative), "utf8")) as T;
type PackageJson = { version: string; license: string | { type: string }; dependencies?: Record<string, string>; repository?: string | { url: string; directory?: string } };
const pkg = readJson<PackageJson>("package.json");
const lock = readJson<{ packages: Record<string, { version: string; resolved?: string }> }>("package-lock.json");
const runtime = Object.keys(pkg.dependencies ?? {});

const spdx = (license: PackageJson["license"]) => (typeof license === "string" ? license : license.type);

describe("packages.ts frente a package.json y node_modules", () => {
  it("lista EXACTAMENTE las dependencias de ejecucion de package.json (ni una de mas ni una de menos), sin repetir", () => {
    const listed = PACKAGES.map((entry) => entry.name);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...runtime].sort());
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b, "en")));
  });

  for (const name of runtime) {
    it(`${name}: version, licencia y repositorio coinciden con el paquete instalado`, () => {
      const entry = PACKAGES.find((candidate) => candidate.name === name);
      expect(entry, `falta ${name} en packages.ts`).toBeDefined();
      const installed = readJson<PackageJson>(`node_modules/${name}/package.json`);
      expect(entry?.version, `version de ${name}`).toBe(installed.version);
      expect(entry?.license, `licencia de ${name}`).toBe(spdx(installed.license));
      expect(entry?.repo).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/);
      // La version fijada en el lock es la instalada (lo que se empaqueta).
      expect(lock.packages[`node_modules/${name}`].version).toBe(installed.version);
    });
  }

  it("las dependencias de desarrollo (pruebas, tipos, compilador) NO aparecen como si se empaquetaran", () => {
    const dev = Object.keys((readJson<{ devDependencies: Record<string, string> }>("package.json")).devDependencies);
    for (const name of dev) expect(PACKAGES.some((entry) => entry.name === name), name).toBe(false);
  });

  it("obligatorias: mediabunny y su codificador (MPL-2.0, 1.65.0) y parse5 (MIT)", () => {
    const by = (name: string) => PACKAGES.find((entry) => entry.name === name);
    expect(by("mediabunny")).toMatchObject({ version: "1.65.0", license: "MPL-2.0" });
    expect(by("@mediabunny/mp3-encoder")).toMatchObject({ version: "1.65.0", license: "MPL-2.0" });
    expect(by("parse5")).toMatchObject({ license: "MIT" });
  });

  it("toda licencia que aparece tiene su enlace canonico (https), tambien las de las fuentes y decodificadores", () => {
    const expressions = [...PACKAGES.map((entry) => entry.license), ...STRINGS.es.assets.map((asset) => asset.license), ...STRINGS.en.assets.map((asset) => asset.license), "LGPL-2.0-or-later", "LGPL-2.1-or-later"];
    for (const expression of expressions) {
      for (const id of licenseIds(expression)) expect(LICENSE_TEXT_URLS[id], `${id} (${expression})`).toMatch(/^https:\/\//);
    }
    expect(licenseIds("(MIT OR GPL-3.0-or-later)")).toEqual(["MIT", "GPL-3.0-or-later"]);
    expect(licenseIds("BSD-2-Clause · BSD-3-Clause · MIT · Apache-2.0")).toEqual(["BSD-2-Clause", "BSD-3-Clause", "MIT", "Apache-2.0"]);
  });

  it("las licencias a eleccion (jszip: MIT o GPL) declaran bajo cual se usa, y es una de las ofrecidas", () => {
    for (const [name, used] of Object.entries(USED_UNDER)) {
      const entry = PACKAGES.find((candidate) => candidate.name === name);
      expect(entry, name).toBeDefined();
      expect(licenseIds(entry?.license ?? "")).toContain(used);
    }
    for (const entry of PACKAGES.filter((candidate) => /\bOR\b/.test(candidate.license))) expect(USED_UNDER[entry.name], `${entry.name} ofrece dos licencias`).toBeDefined();
  });

  it("solo lo que corre en el servidor lleva la etiqueta «En el servidor» (parse5) y existe en la lista", () => {
    expect([...SERVER_SIDE]).toEqual(["parse5"]);
    for (const name of SERVER_SIDE) expect(PACKAGES.some((entry) => entry.name === name)).toBe(true);
  });
});

describe("textos (ES/EN)", () => {
  for (const language of ["es", "en"] as const) {
    it(`${language}: cada paquete tiene su para-que-se-usa y no sobran explicaciones de paquetes que ya no estan`, () => {
      const purposes = STRINGS[language].purposes;
      expect(Object.keys(purposes).sort()).toEqual(PACKAGES.map((entry) => entry.name).sort());
      for (const [name, text] of Object.entries(purposes)) expect(text.trim().length, name).toBeGreaterThan(15);
    });
  }

  it("ES y EN tienen la misma estructura (mismo numero de parrafos y de fuentes incluidas)", () => {
    expect(STRINGS.en.mp3.compliance).toHaveLength(STRINGS.es.mp3.compliance.length);
    expect(STRINGS.en.mp3.replace).toHaveLength(STRINGS.es.mp3.replace.length);
    expect(STRINGS.en.assets.map((asset) => asset.license)).toEqual(STRINGS.es.assets.map((asset) => asset.license));
  });
});

describe("LAME y los enlaces a su codigo (lame.ts)", () => {
  const readme = readFileSync(path.join(root, "node_modules/@mediabunny/mp3-encoder/README.md"), "utf8");
  const bundle = readFileSync(path.join(root, "node_modules/@mediabunny/mp3-encoder/dist/bundles/mediabunny-mp3-encoder.mjs"), "utf8");

  it("version de LAME, hash del tar.gz, hash del WASM y version de Emscripten coinciden con el README del paquete instalado", () => {
    expect(readme).toContain(`LAME ${LAME.version}`);
    expect(readme).toContain(`lame-${LAME.version}.tar.gz`);
    expect(readme).toContain(LAME.tarballSha256);
    expect(readme).toContain(LAME.wasmSha256);
    expect(readme).toContain(`Emscripten ${LAME.emscripten}`);
    expect(readme).toMatch(/LGPL v2 or later/);
    expect(LAME.notice).toBe("MP3 encoding by LAME");
    expect(`${LAME.noticeLead}${LAME.noticeLink}`).toBe(LAME.notice);
    expect(LAME.site).toBe("https://lame.sourceforge.io/");
  });

  it("el binario WebAssembly que viaja DENTRO del paquete tiene el SHA-256 que declara el README (se decodifica del propio Worker)", () => {
    const start = bundle.indexOf("function Worker2()");
    const block = bundle.slice(start, bundle.indexOf("\n}", start));
    const literal = block.slice(block.indexOf("inlineWorker(") + "inlineWorker(".length, block.lastIndexOf(")"));
    const worker = new Function(`return ${literal}`)() as string;
    const marker = "function VA(){return mA(`";
    const at = worker.indexOf(marker);
    expect(at, "no se encontro la cadena binaria del WASM (¿cambio el empaquetado?)").toBeGreaterThan(0);
    const from = at + marker.length - 1;
    let end = from + 1;
    while (end < worker.length && worker[end] !== "`") end += worker[end] === "\\" ? 2 : 1;
    const text = new Function(`return ${worker.slice(from, end + 1)}`)() as string;
    // Descodificacion que usa el propio paquete: cada caracter es un byte con los bits invertidos en el segundo octeto.
    const bytes = Uint8Array.from({ length: text.length }, (_, i) => {
      const code = text.charCodeAt(i);
      return (~code >> 8) & code;
    });
    expect(Buffer.from(bytes.subarray(0, 4)).toString("hex")).toBe("0061736d"); // «\0asm»
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(LAME.wasmSha256);
  });

  it("las URL de codigo fuente y de paquete llevan la version EXACTA y el tarball es el que fija el lock", () => {
    for (const name of ["mediabunny", "@mediabunny/mp3-encoder"]) {
      const version = PACKAGES.find((entry) => entry.name === name)?.version ?? "";
      expect(version).toBe("1.65.0");
      expect(npmVersionUrl(name, version)).toBe(`https://www.npmjs.com/package/${name}/v/1.65.0`);
      expect(npmTarballUrl(name, version)).toBe(lock.packages[`node_modules/${name}`].resolved);
    }
    expect(sourceTreeUrl("1.65.0")).toBe("https://github.com/Vanilagy/mediabunny/tree/v1.65.0");
    expect(sourceTreeUrl("1.65.0", "packages/mp3-encoder")).toBe("https://github.com/Vanilagy/mediabunny/tree/v1.65.0/packages/mp3-encoder");
  });

  it("los textos de licencia que se entregan con el paquete son los que la pagina dice (MPL-2.0 y LGPL v2)", () => {
    const base = "node_modules/@mediabunny/mp3-encoder";
    expect(readFileSync(path.join(root, `${base}/LICENSE`), "utf8")).toMatch(/Mozilla Public License Version 2\.0/);
    expect(readFileSync(path.join(root, `${base}/licenses/lame/COPYING`), "utf8")).toMatch(/GNU LIBRARY GENERAL PUBLIC LICENSE\s+Version 2/);
    expect(readFileSync(path.join(root, "node_modules/mediabunny/LICENSE"), "utf8")).toMatch(/Mozilla Public License Version 2\.0/);
  });
});
