import { describe, expect, it } from "vitest";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { MODE_STRINGS } from "@/app/pdf-pro/modes/modeStrings";
import { PAGE_NUMBERS_STRINGS } from "@/app/add-page-numbers/strings";
import { WATERMARK_STRINGS } from "@/app/add-watermark/strings";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { PDF_TO_CSV_STRINGS } from "@/app/pdf-to-csv/strings";
import { PDF_TO_EXCEL_STRINGS } from "@/app/pdf-to-excel/strings";
import { STRINGS as PDF_TO_JPG_STRINGS } from "@/app/pdf-to-jpg/strings";
import { PDF_TO_JSON_STRINGS } from "@/app/pdf-to-json/strings";
import { PDF_TO_MARKDOWN_STRINGS } from "@/app/pdf-to-markdown/strings";
import { STRINGS as PDF_TO_POWERPOINT_STRINGS } from "@/app/pdf-to-powerpoint/strings";
import { PDF_TO_TEXT_STRINGS } from "@/app/pdf-to-text/strings";
import { STRINGS as PDF_TO_WORD_STRINGS } from "@/app/pdf-to-word/strings";
import { STRINGS as WORD_TO_PDF_STRINGS } from "@/app/word-to-pdf/strings";
import { STRINGS as EXCEL_TO_PDF_STRINGS } from "@/app/excel-to-pdf/strings";
import { STRINGS as HTML_TO_PDF_STRINGS } from "@/app/html-to-pdf/strings";
import { STRINGS as JPG_TO_PDF_STRINGS } from "@/app/jpg-to-pdf/strings";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

/**
 * Recorre TODAS las claves de los dos idiomas de PDF Pro (y de las herramientas cuyos textos reutiliza) y comprueba
 * que ninguna se queda sin traducir ni se pinta rota: ni vacia, ni con aspecto de clave («suite.tabs.home»), ni con
 * «undefined», «NaN» o «[object Object]» al llamarla con argumentos de ejemplo.
 */

type Leaf = { path: string; value: unknown };

function leaves(value: unknown, prefix = ""): Leaf[] {
  if (typeof value === "function" || typeof value !== "object" || value === null) return [{ path: prefix, value }];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

const KEY_LIKE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+){2,}$/;
const BROKEN = /undefined|NaN|\[object|null\b/;

/** Argumentos de ejemplo para una funcion de texto segun cuantos pide (numeros y cadenas alternativos). */
function samples(arity: number): unknown[][] {
  const count = Math.max(arity, 1);
  return [
    Array.from({ length: count }, () => 3),
    Array.from({ length: count }, () => "Muestra.pdf"),
    // Mezcla frecuente: nombre + numero, numero + nombre.
    Array.from({ length: count }, (_, i) => (i % 2 === 0 ? "Muestra.pdf" : 2)),
    Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 2 : "Muestra.pdf")),
    // Listas de nombres («omittedBody(names, hidden)»).
    Array.from({ length: count }, (_, i) => (i === 0 ? ["a.pdf", "b.pdf"] : 2)),
  ];
}

function check(label: string, tree: unknown, templates: RegExp[] = []): number {
  let checked = 0;
  for (const { path, value } of leaves(tree)) {
    const where = `${label}.${path}`;
    if (typeof value === "string") {
      checked += 1;
      expect(value.trim().length, `${where} vacia`).toBeGreaterThan(0);
      expect(KEY_LIKE.test(value), `${where} parece una clave sin traducir: «${value}»`).toBe(false);
      if (!templates.some((template) => template.test(path))) expect(value, `${where} con marcador sin sustituir`).not.toMatch(/\{\w+\}/);
    } else if (typeof value === "function") {
      checked += 1;
      const produced = samples(value.length).map((args) => {
        try {
          return String((value as (...a: unknown[]) => unknown)(...args));
        } catch {
          // Tipos cruzados (p. ej. una cadena donde iba una lista): esa combinacion no vale.
          return "undefined";
        }
      });
      // No se conocen los tipos de los argumentos: se prueban combinaciones de numeros y cadenas y basta con que UNA
      // (la que respeta la firma real) produzca un texto limpio; las demas pueden dar «NaN» por tipos cruzados.
      const clean = produced.filter((text) => !BROKEN.test(text));
      expect(clean.length, `${where} nunca produce un texto limpio: ${JSON.stringify(produced)}`).toBeGreaterThan(0);
      for (const text of clean) {
        expect(text.trim().length, `${where} devuelve vacio`).toBeGreaterThan(0);
        expect(KEY_LIKE.test(text), `${where} parece una clave: «${text}»`).toBe(false);
      }
    } else if (value === undefined || value === null) {
      throw new Error(`${where} no tiene valor`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      checked += 1;
    }
  }
  return checked;
}

function sameKeys(label: string, a: unknown, b: unknown) {
  const paths = (tree: unknown) => leaves(tree).map((leaf) => leaf.path).sort();
  expect(paths(b), `${label}: las claves en/es difieren`).toEqual(paths(a));
}

/**
 * Marcadores `{x}` sin sustituir: solo se vigilan en las secciones de la Wave 7 · U8 (exportar, guardar, crear, sesion),
 * cuyos textos NUNCA llevan plantillas. Las secciones anteriores guardan a proposito algunas (`{n}`, `{total}`,
 * `{size}`) que la interfaz sustituye al pintarlas.
 */
const TEMPLATE_PATHS = [/^(?!export\.|save\.|create\.|session\.)/];

describe("PRO_STRINGS: ninguna clave sin traducir, en los dos idiomas", () => {
  for (const language of ["es", "en"] as const) {
    it(`${language}: cada texto y cada funcion de texto es valido`, () => {
      const checked = check(`PRO_STRINGS.${language}`, PRO_STRINGS[language], TEMPLATE_PATHS);
      // La suite tiene cientos de claves: una cifra baja indicaria que el recorrido dejo de ver parte del arbol.
      expect(checked).toBeGreaterThan(600);
    });
  }

  it("las mismas claves en es y en, a cualquier profundidad", () => {
    sameKeys("PRO_STRINGS", PRO_STRINGS.es, PRO_STRINGS.en);
  });

  it("los dos idiomas tienen exactamente las mismas funciones de texto", () => {
    const fnPaths = (tree: unknown) =>
      leaves(tree)
        .filter((leaf) => typeof leaf.value === "function")
        .map((leaf) => `${leaf.path}/${(leaf.value as { length: number }).length}`)
        .sort();
    expect(fnPaths(PRO_STRINGS.en)).toEqual(fnPaths(PRO_STRINGS.es));
  });

  it("ningun texto se repite palabra por palabra entre idiomas salvo marcas y formatos", () => {
    const flat = (tree: unknown) => Object.fromEntries(leaves(tree).filter((leaf) => typeof leaf.value === "string").map((leaf) => [leaf.path, leaf.value as string]));
    const a = flat(PRO_STRINGS.es);
    const b = flat(PRO_STRINGS.en);
    // Los nombres de formato («PowerPoint (.pptx)») son iguales en los dos idiomas a proposito.
    const same = Object.keys(a).filter((path) => a[path] === b[path] && a[path].length > 14 && !/^export\.formats\.\w+\.title$/.test(path));
    expect(same, "textos largos iguales en es y en").toEqual([]);
  });
});

describe("textos de los modos y de las herramientas que reutiliza PDF Pro", () => {
  const sets: Array<[string, Record<"es" | "en", unknown>, RegExp[]?]> = [
    ["MODE_STRINGS", MODE_STRINGS as Record<"es" | "en", unknown>],
    ["PAGE_NUMBERS_STRINGS", PAGE_NUMBERS_STRINGS],
    ["WATERMARK_STRINGS", WATERMARK_STRINGS],
    ["PROTECT_STRINGS", PROTECT_STRINGS],
    ["PDF_TO_CSV_STRINGS", PDF_TO_CSV_STRINGS],
    ["PDF_TO_EXCEL_STRINGS", PDF_TO_EXCEL_STRINGS],
    ["PDF_TO_JPG_STRINGS", PDF_TO_JPG_STRINGS],
    ["PDF_TO_JSON_STRINGS", PDF_TO_JSON_STRINGS],
    ["PDF_TO_MARKDOWN_STRINGS", PDF_TO_MARKDOWN_STRINGS],
    ["PDF_TO_POWERPOINT_STRINGS", PDF_TO_POWERPOINT_STRINGS],
    ["PDF_TO_TEXT_STRINGS", PDF_TO_TEXT_STRINGS],
    ["PDF_TO_WORD_STRINGS", PDF_TO_WORD_STRINGS],
    ["WORD_TO_PDF_STRINGS", WORD_TO_PDF_STRINGS],
    ["EXCEL_TO_PDF_STRINGS", EXCEL_TO_PDF_STRINGS],
    ["HTML_TO_PDF_STRINGS", HTML_TO_PDF_STRINGS],
    ["JPG_TO_PDF_STRINGS", JPG_TO_PDF_STRINGS],
  ];
  for (const [label, set] of sets) {
    it(`${label}: mismas claves y sin claves rotas en es y en`, () => {
      sameKeys(label, set.es, set.en);
      for (const language of ["es", "en"] as const) {
        expect(check(`${label}.${language}`, set[language], [/./]), `${label}.${language}`).toBeGreaterThan(3);
      }
    });
  }
});

describe("diccionario global: PDF Pro en los dos idiomas", () => {
  it("nombre y descripcion de PDF Pro", () => {
    for (const dictionary of [es, en]) {
      expect(dictionary.tools["pdf-pro"].name.length).toBeGreaterThan(2);
      expect(dictionary.tools["pdf-pro"].description.length).toBeGreaterThan(20);
    }
    expect(es.tools["pdf-pro"].description).not.toBe(en.tools["pdf-pro"].description);
  });

  it("las claves de Ajustes de PDF Pro son iguales en es y en", () => {
    sameKeys("proFeatures", (es as unknown as { settings: { proFeatures: unknown } }).settings?.proFeatures ?? {}, (en as unknown as { settings: { proFeatures: unknown } }).settings?.proFeatures ?? {});
  });

  it("todos los nombres de herramienta existen y son distintos de su clave", () => {
    for (const dictionary of [es, en]) {
      for (const [slug, entry] of Object.entries(dictionary.tools)) {
        expect(entry.name.length, slug).toBeGreaterThan(1);
        expect(entry.name, slug).not.toBe(slug);
      }
    }
  });
});
