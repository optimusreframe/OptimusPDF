import { describe, expect, it } from "vitest";
import {
  NOTICE_ORDER,
  pageNoticeText,
  pageNotices,
  pageNoticesTitle,
} from "@/app/organize-pdf/pageNotices";
import type { PageAssemblyWarning, PageAssemblyWarningCode } from "@/lib/pdf/pageAssembly";

/** Todos los codigos que puede devolver el motor de paginas (si se anade uno, esta lista debe crecer). */
const ALL_CODES: PageAssemblyWarningCode[] = [
  "outlinesRemoved",
  "linksRemoved",
  "namedDestinationsRemoved",
  "pageLabelsRemoved",
  "structureRemoved",
  "structureIncomplete",
  "signaturesInvalidated",
  "formFieldsRemoved",
  "fieldsRenamed",
  "signatureFieldsRemoved",
  "signedSignaturesRemoved",
  "largeInsert",
];

const LANGUAGES = ["es", "en"] as const;

describe("avisos de las herramientas de paginas", () => {
  it("hay texto para cada codigo del motor (menos `largeInsert`, que no se cuenta) y un orden para cada uno", () => {
    expect([...NOTICE_ORDER].sort()).toEqual(ALL_CODES.filter((code) => code !== "largeInsert").sort());
    for (const language of LANGUAGES) {
      for (const code of ALL_CODES) {
        const text = pageNoticeText(language, { code, count: 3 });
        if (code === "largeInsert") expect(text).toBeNull();
        else expect(text).toBeTruthy();
      }
    }
  });

  it("ningun texto deja un marcador sin sustituir, una clave cruda o un undefined; todos acaban en punto", () => {
    for (const language of LANGUAGES) {
      for (const code of NOTICE_ORDER) {
        for (const count of [1, 2, 7, 120]) {
          const text = pageNoticeText(language, { code, count }) ?? "";
          expect(text, `${language}/${code}/${count}`).not.toMatch(/\{n\}|undefined|NaN|\[object/);
          expect(text).not.toContain(code);
          expect(text.endsWith(".")).toBe(true);
          expect(text.length).toBeGreaterThan(20);
        }
      }
    }
  });

  it("la cantidad aparece en los textos que la llevan y el singular no dice «1 xxxs»", () => {
    expect(pageNoticeText("es", { code: "outlinesRemoved", count: 12 })).toContain("12 marcadores");
    expect(pageNoticeText("es", { code: "outlinesRemoved", count: 1 })).toBe(
      "Se quitó 1 marcador que apuntaba a una página que ya no está.",
    );
    expect(pageNoticeText("en", { code: "linksRemoved", count: 5 })).toContain("5 internal links");
    expect(pageNoticeText("en", { code: "linksRemoved", count: 1 })).toContain("1 internal link that");
    expect(pageNoticeText("es", { code: "signaturesInvalidated", count: 2 })).toContain("Las 2 firmas digitales");
    expect(pageNoticeText("es", { code: "signaturesInvalidated", count: 1 })).toContain("La firma digital");
    expect(pageNoticeText("en", { code: "structureIncomplete", count: 4 })).toContain("4 pages");
    expect(pageNoticeText("es", { code: "structureIncomplete", count: 1 })).toContain("1 página no lleva");
  });

  it("dice las firmas con claridad: dejan de ser validas / no se copian", () => {
    expect(pageNoticeText("es", { code: "signaturesInvalidated", count: 1 })).toContain("deja de ser válida");
    expect(pageNoticeText("en", { code: "signaturesInvalidated", count: 3 })).toContain("no longer valid");
    expect(pageNoticeText("es", { code: "signatureFieldsRemoved", count: 2 })).toContain("No se copiaron 2 campos de firma");
    expect(pageNoticeText("en", { code: "signatureFieldsRemoved", count: 1 })).toContain("was not copied");
  });

  it("D7 · un campo de firma VACIO no habla de «firma digital» valida; una firma YA APLICADA si, y cada una dice lo que es", () => {
    for (const count of [1, 2]) {
      const emptyEs = pageNoticeText("es", { code: "signatureFieldsRemoved", count })!;
      const emptyEn = pageNoticeText("en", { code: "signatureFieldsRemoved", count })!;
      expect(emptyEs).toContain("vacío");
      expect(emptyEs).not.toMatch(/firma digital|válida/i);
      expect(emptyEn).toContain("empty signature field");
      expect(emptyEn).not.toMatch(/digital signature|valid/i);
      const signedEs = pageNoticeText("es", { code: "signedSignaturesRemoved", count })!;
      const signedEn = pageNoticeText("en", { code: "signedSignaturesRemoved", count })!;
      expect(signedEs).toContain("ya aplicada");
      expect(signedEs).toContain("una firma digital solo es válida en el documento en el que se firmó");
      expect(signedEn).toContain("already applied");
      expect(signedEn).toContain("a digital signature is only valid in the document it was signed in");
    }
    expect(pageNoticeText("es", { code: "signatureFieldsRemoved", count: 1 })).toContain("No se copió 1 campo de firma vacío");
    expect(pageNoticeText("es", { code: "signedSignaturesRemoved", count: 3 })).toContain("No se copiaron 3 firmas ya aplicadas");
  });

  it("D2 · el aviso de la numeracion de paginas es cierto tambien cuando el arbol del primero se queda y se pierde el del anadido", () => {
    expect(pageNoticeText("es", { code: "pageLabelsRemoved", count: 1 })).toContain("de un documento");
    expect(pageNoticeText("es", { code: "pageLabelsRemoved", count: 1 })).not.toMatch(/se quitó/);
    expect(pageNoticeText("en", { code: "pageLabelsRemoved", count: 1 })).toContain("of a document");
    expect(pageNoticeText("en", { code: "pageLabelsRemoved", count: 1 })).not.toMatch(/was removed/);
  });

  it("sin avisos no hay bloque; `largeInsert` solo tampoco", () => {
    for (const language of LANGUAGES) {
      expect(pageNotices(language, [])).toBeUndefined();
      expect(pageNotices(language, [{ code: "largeInsert", count: 600 }])).toBeUndefined();
      expect(pageNotices(language, [{ code: "linksRemoved", count: 0 }])).toBeUndefined();
    }
  });

  it("el bloque lleva titulo y un elemento por codigo, en orden de importancia, sumando repeticiones", () => {
    const warnings: PageAssemblyWarning[] = [
      { code: "fieldsRenamed", count: 2 },
      { code: "linksRemoved", count: 1 },
      { code: "signaturesInvalidated", count: 1 },
      { code: "linksRemoved", count: 2 },
      { code: "structureIncomplete", count: 3 },
    ];
    const notices = pageNotices("es", warnings);
    expect(notices?.title).toBe(pageNoticesTitle("es"));
    expect(notices?.items).toHaveLength(4);
    expect(notices?.items[0]).toContain("firma digital");
    expect(notices?.items[1]).toContain("3 páginas");
    expect(notices?.items[2]).toContain("3 enlaces internos");
    expect(notices?.items[3]).toContain("2 campos de formulario");
  });

  it("con todos los codigos a la vez salen en el orden de lectura: firmas, estructura, numeracion y despues lo menudo", () => {
    const shuffled = [...ALL_CODES].reverse().map((code) => ({ code, count: 2 }));
    const items = pageNotices("es", shuffled)?.items ?? [];
    const expected = [
      "firmas digitales",
      "firmas ya aplicadas",
      "campos de firma vacíos",
      "estructura de accesibilidad",
      "etiquetas de accesibilidad",
      "numeración de páginas",
      "marcadores",
      "enlaces internos",
      "destinos con nombre",
      "campos de formulario de páginas",
      "cambiaron de nombre",
    ];
    expect(items).toHaveLength(expected.length);
    expected.forEach((fragment, index) => expect(items[index], `posicion ${index}`).toContain(fragment));
    const english = pageNotices("en", shuffled)?.items ?? [];
    expect(english[0]).toContain("digital signatures");
    expect(english[1]).toContain("signatures that were already applied");
    expect(english[2]).toContain("empty signature fields");
    expect(english[10]).toContain("renamed");
  });

  it("espanol e ingles dan el mismo numero de elementos y titulos distintos", () => {
    const warnings = ALL_CODES.map((code) => ({ code, count: 2 }));
    const es = pageNotices("es", warnings);
    const en = pageNotices("en", warnings);
    expect(es?.items.length).toBe(en?.items.length);
    expect(es?.items.length).toBe(NOTICE_ORDER.length);
    expect(es?.title).not.toBe(en?.title);
    expect(new Set(es?.items).size).toBe(es?.items.length);
  });
});
