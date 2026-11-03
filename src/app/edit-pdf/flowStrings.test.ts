import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EDIT_FLOW_STRINGS, type EditFlowStrings } from "@/app/edit-pdf/flowStrings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { es as esLocale } from "@/lib/locales/es";
import { en as enLocale } from "@/lib/locales/en";

/** i18n es/en en paridad y retirada del editor antiguo sin referencias colgantes (W5-U5). */

const es = EDIT_FLOW_STRINGS.es;
const en = EDIT_FLOW_STRINGS.en;
const keys = (value: object) => Object.keys(value).sort();

/** Llama a cada funcion de copy con argumentos tipicos y devuelve el texto. */
function render(strings: EditFlowStrings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(strings)) {
    out[key] = typeof value === "function" ? (value as (...args: unknown[]) => string)(3, "x") : (value as string);
  }
  return out;
}

describe("flowStrings es/en", () => {
  it("las dos lenguas tienen las mismas claves del mismo tipo", () => {
    expect(keys(es)).toEqual(keys(en));
    for (const key of keys(es)) {
      expect(typeof es[key as keyof EditFlowStrings], key).toBe(typeof en[key as keyof EditFlowStrings]);
    }
  });

  it("ningun texto esta vacio ni deja marcas sin sustituir", () => {
    for (const lang of [render(es), render(en)]) {
      for (const [key, text] of Object.entries(lang)) {
        expect(text.trim().length, key).toBeGreaterThan(0);
        expect(text, key).not.toMatch(/\{\w+\}|undefined|NaN/);
      }
    }
  });

  it("el ingles no es el espanol copiado (salvo cadenas identicas por naturaleza)", () => {
    const same = Object.entries(render(es)).filter(([key, text]) => render(en)[key] === text);
    expect(same.map(([key]) => key)).toEqual([]);
  });

  it("los plurales distinguen 1 de varios en las dos lenguas", () => {
    for (const lang of [es, en]) {
      expect(lang.summaryEditedTexts(1)).not.toBe(lang.summaryEditedTexts(2));
      expect(lang.draftsChanges(1)).not.toBe(lang.draftsChanges(2));
      expect(lang.noticeFont(1)).not.toBe(lang.noticeFont(2));
    }
    expect(es.summaryEditedTexts(1)).toBe("1 texto editado");
    expect(en.summaryEditedTexts(1)).toBe("1 text edited");
  });

  it("la advertencia de aplanar nombra lo irreversible y que antes se puede deshacer", () => {
    expect(es.flattenConfirmBody).toMatch(/imagen/);
    expect(es.flattenConfirmBody).toMatch(/no se puede deshacer/);
    expect(en.flattenConfirmBody).toMatch(/image/);
    expect(en.flattenConfirmBody).toMatch(/can't be undone/);
  });

  it("los textos del interruptor en Ajustes dicen la verdad: apagado solo desactiva el texto existente y al exportar se quita el original", () => {
    for (const locale of [esLocale, enLocale]) {
      const flags = locale.settings.editPdfFeatures;
      expect(flags.editExistingText.hint).not.toMatch(/como antes|as before/i);
      // La limpieza ya no es un interruptor: siempre esta activa al exportar.
      expect(Object.keys(flags)).toEqual(["editExistingText"]);
      // Nada de lo viejo: ni «cubre y dibuja encima» ni «puede seguir existiendo» ni «proximamente».
      expect(flags.editExistingText.hint).not.toMatch(
        /cubre el original|covers the original|puede seguir|may still|pr[oó]ximamente|coming soon/i,
      );
    }
    expect(esLocale.settings.editPdfFeatures.editExistingText.hint).toMatch(/añadir texto, imágenes y formas/);
    expect(enLocale.settings.editPdfFeatures.editExistingText.hint).toMatch(/add text, images and shapes/);
    expect(esLocale.settings.editPdfFeatures.editExistingText.hint).toMatch(
      /al exportar, el texto original se elimina del archivo.*si no se puede quitar, se avisa/,
    );
    expect(enLocale.settings.editPdfFeatures.editExistingText.hint).toMatch(
      /on export, the original text is removed from the file.*if it can't be removed, you're told/,
    );
  });

  it("la descripcion de la herramienta refleja lo que hace, sin prometer OCR ni limpieza", () => {
    const text = `${esLocale.tools["edit-pdf"].description} ${enLocale.tools["edit-pdf"].description}`;
    expect(esLocale.tools["edit-pdf"].description).toMatch(/texto que ya trae el PDF/);
    expect(enLocale.tools["edit-pdf"].description).toMatch(/text already in the PDF/);
    expect(text).not.toMatch(/OCR|limpi|clean/i);
  });
});

describe("retirada del editor antiguo", () => {
  const root = path.join(process.cwd(), "src");
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  const files = walk(root).filter((file) => !file.endsWith("flowStrings.test.ts"));

  it("EditCanvas.tsx ya no existe y nadie lo importa", () => {
    expect(fs.existsSync(path.join(root, "app/edit-pdf/EditCanvas.tsx"))).toBe(false);
    // La palabra entera: el componente retirado («EditCanvas», su import o su JSX). Un nombre local que solo la termina
    // (`registerEditCanvas` en `DocumentCanvas.tsx`, el modo «Editar campos» de Firmar) no es el editor antiguo.
    const retired = /\bEditCanvas\b/;
    expect(retired.test('import { EditCanvas } from "./EditCanvas";')).toBe(true);
    expect(retired.test("<EditCanvas pages={pages} />")).toBe(true);
    expect(retired.test("const registerEditCanvas = editHost?.registerCanvas;")).toBe(false);
    const offenders = files.filter((file) => retired.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no quedan los avisos fijos ni el panel lateral del editor antiguo", () => {
    const offenders = files
      .filter((file) => file.includes(`${path.sep}edit-pdf${path.sep}`))
      .filter((file) => /scopeWarning|fontWarning|LegacyEditToolClient|howItWorksTitle|EditToolOptions/.test(fs.readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("EditStrings solo conserva lo que usa el lienzo nuevo", () => {
    expect(keys(EDIT_STRINGS.es)).toEqual(["filenameSuffix", "inline", "nextPage", "pageOf", "previousPage", "progressMessage", "typeLabels"]);
    expect(keys(EDIT_STRINGS.en)).toEqual(keys(EDIT_STRINGS.es));
  });

  it("solo existe UNA implementacion del muestreo del fondo (editBackground)", () => {
    const definers = files.filter((file) => /export function sampleBackgroundColor\b/.test(fs.readFileSync(file, "utf8")));
    expect(definers.map((file) => path.relative(root, file))).toEqual(["lib/pdf/editBackground.ts"]);
  });

  it("la herramienta ya no usa el panel de opciones del shell (sin renderOptions)", () => {
    const tool = fs.readFileSync(path.join(root, "app/edit-pdf/EditInlineTool.tsx"), "utf8");
    expect(tool).not.toMatch(/renderOptions/);
    const client = fs.readFileSync(path.join(root, "app/edit-pdf/EditToolClient.tsx"), "utf8");
    expect(client).not.toMatch(/OptionControls|useEditPdfFeatureFlag/);
  });
});

describe("i18n sin cadenas muertas (W5-U5)", () => {
  const dead = [
    "noEditableBlocks",
    "moveHandle",
    "exitedEditing",
    "imageDrop",
    "lineStart",
    "lineEnd",
    "thumbsLoading",
    "pageNavShortcuts",
  ];
  it("las cadenas del lienzo que nadie usa ya no existen en es ni en en", () => {
    for (const lang of ["es", "en"] as const) {
      const inline = EDIT_STRINGS[lang].inline as unknown as Record<string, unknown>;
      for (const key of dead) expect(key in inline, `${lang}.inline.${key}`).toBe(false);
    }
    for (const lang of [EDIT_FLOW_STRINGS.es, EDIT_FLOW_STRINGS.en] as unknown as Record<string, unknown>[]) {
      expect("checkFailed" in lang).toBe(false);
      expect("draftsProtectedNone" in lang).toBe(false);
    }
  });

  it("las cadenas nuevas existen en las dos lenguas (atajos de las barras, pagina que no se dibuja, mezcla de estilos)", () => {
    for (const lang of ["es", "en"] as const) {
      const inline = EDIT_STRINGS[lang].inline;
      expect(inline.barShortcuts.length).toBeGreaterThan(10);
      expect(inline.pageFailed.length).toBeGreaterThan(10);
      expect(inline.mixedStyleNotice.length).toBeGreaterThan(10);
      expect(inline.blockHint).toMatch(lang === "es" ? /Alt/ : /Alt/);
    }
    expect(EDIT_FLOW_STRINGS.es.exportCancelled).not.toBe(EDIT_FLOW_STRINGS.en.exportCancelled);
    expect(EDIT_FLOW_STRINGS.es.noticeOverlap(2)).not.toBe(EDIT_FLOW_STRINGS.en.noticeOverlap(2));
  });
});
