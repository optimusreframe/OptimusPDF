import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeFingerprintWith } from "@/lib/docLibrary/fingerprintEngine";
import { __resetLibraryForTests } from "@/lib/docLibrary/store";
import { nodeEnv } from "@/lib/docLibrary/testing/nodeEnv";
import { resave } from "@/lib/docLibrary/testing/syntheticContracts";
import { findTemplateForFingerprint } from "@/lib/docLibrary/templatesStore";
import { autoMapBytes } from "@/lib/pdf/testing/autoMapHarness";
import { DEFAULT_SESSION } from "@/app/sign-pdf/signSession";
import { applyDetection, emptyContent, repeatInitialsIn, initialsPages } from "@/app/sign-pdf/templateEditorModel";
import { saveTemplateToLibrary } from "@/app/sign-pdf/templateLibrary";
import { planAutoMapApplication, planTemplateApplication, type Mint } from "@/app/sign-pdf/templateSession";
import { defaultRoles } from "@/app/sign-pdf/templateEditorModel";

/**
 * Plantillas contra los CONTRATOS REALES del usuario (local y OPCIONAL). Solo corre con
 * `OPTIMUS_REAL_CONTRACTS_DIR=<carpeta>` (se salta en CI y sin la variable):
 *
 *   OPTIMUS_REAL_CONTRACTS_DIR=/ruta npx vitest run src/app/sign-pdf/templates.real.test.ts
 *
 * 1. Con los contratos en blanco (los que NO acaban en `-signed.pdf`): el automapeo aplicado a Firmar deja como mucho 12
 *    campos por pagina (firmas, iniciales, fechas y textos juntos).
 * 2. Con el contrato «MOLD_TEST»: se configura una plantilla (lo que el automapeo coloca con seguridad + iniciales en todas
 *    las paginas), se guarda en una biblioteca de pruebas, se REEXPORTA el PDF (otros bytes) y se comprueba que se
 *    reconoce y que la plantilla se aplica.
 *
 * PRIVACIDAD: solo se miran posiciones y conteos y solo se imprimen NUMEROS. Nada de texto ni de imagenes sale de aqui; los
 * PDF no se copian a ningun sitio (la biblioteca es la IndexedDB falsa de la prueba, en memoria).
 */
const DIR = process.env.OPTIMUS_REAL_CONTRACTS_DIR;
const run = DIR && fs.existsSync(DIR) ? describe : describe.skip;
/** Informe opcional (`TEMPLATES_REAL_REPORT=<archivo>`): solo numeros. */
const REPORT = process.env.TEMPLATES_REAL_REPORT;
function report(text: string): void {
  console.log(text);
  if (REPORT) fs.appendFileSync(REPORT, `${text}\n`);
}

vi.mock("@/lib/docLibrary/fingerprint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docLibrary/fingerprint")>()),
  computeFingerprint: async (source: Uint8Array | Blob) => computeFingerprintWith(source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer()), nodeEnv()),
}));

let counter = 0;
const mint: Mint = { signerId: () => `sg-${(counter += 1)}`, fieldId: () => `fld-${(counter += 1)}`, textFieldId: () => `txt-${(counter += 1)}` };

function blankContracts(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".pdf") && !/-signed\.pdf$/i.test(name))
    .sort();
}

run("plantillas con los contratos reales (local, opcional)", () => {
  beforeEach(() => {
    __resetLibraryForTests();
    globalThis.indexedDB = new IDBFactory();
  });

  it("el automapeo aplicado a Firmar deja como mucho 12 campos por página en los 9 contratos", async () => {
    const dir = DIR as string;
    const files = blankContracts(dir);
    expect(files).toHaveLength(9);
    const rows: string[] = [];
    for (const [index, name] of files.entries()) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, name)));
      const result = await autoMapBytes(bytes, { signers: 2, locale: "en" });
      const plan = planAutoMapApplication({ result, count: 2, session: { ...DEFAULT_SESSION, docOrder: ["d"] }, docId: "d", roles: defaultRoles("en"), mint });
      const doc = plan.patch.docs?.d;
      const perPage = new Map<number, number>();
      for (const field of [...(doc?.fields ?? []), ...(doc?.textFields ?? [])]) perPage.set(field.pageIndex, (perPage.get(field.pageIndex) ?? 0) + 1);
      for (const item of plan.pending) if (item.pageIndex !== null) perPage.set(item.pageIndex, (perPage.get(item.pageIndex) ?? 0) + 1);
      const most = Math.max(0, ...perPage.values());
      rows.push(`doc${index + 1}: aplicados ${plan.record.placed ?? 0}, sugerencias ${plan.pending.length}, máx. por página ${most}`);
      expect(most, `documento ${index + 1}`).toBeLessThanOrEqual(12);
    }
    report(rows.join("\n"));
  }, 120_000);

  it("MOLD_TEST: se configura y guarda una plantilla y su reexportación se reconoce y se aplica", async () => {
    const dir = DIR as string;
    const name = blankContracts(dir).find((candidate) => /MOLD_TEST/i.test(candidate));
    expect(name, "hay un contrato MOLD_TEST en la carpeta").toBeTruthy();
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, name as string)));
    const auto = await autoMapBytes(bytes, { signers: 2, locale: "en" });
    const detected = applyDetection(emptyContent("Plantilla de prueba", "en"), "2", auto);
    let content = detected.content;
    const pagesWithInitials = initialsPages(content.variants["2"], 2);
    const fingerprint = await computeFingerprintWith(bytes, nodeEnv());
    // Como lo haria la persona: coloca la linea en la primera pagina que la lleva y la repite en todas.
    if (pagesWithInitials.length > 0) {
      const repeated = repeatInitialsIn(content, "2", { basePage: pagesWithInitials[0], pageCount: fingerprint.pageCount });
      if (!("error" in repeated)) content = repeated.content;
    }
    const saved = await saveTemplateToLibrary({ file: new File([bytes as BlobPart], "doc.pdf", { type: "application/pdf" }), content, documentId: null, template: null });
    if (!saved.ok) throw new Error(saved.reason);

    const again = await resave(bytes, { title: "exportado otra vez" });
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(false);
    const found = await findTemplateForFingerprint(await computeFingerprintWith(again, nodeEnv()));
    expect(found?.match.level === "exact" || found?.match.level === "match").toBe(true);
    const plan = planTemplateApplication({ template: found!.template, match: found!.match, count: 2, session: { ...DEFAULT_SESSION, docOrder: ["d"] }, docId: "d", pageCount: fingerprint.pageCount, mint });
    const applied = plan.patch.docs!.d.fields.length + plan.patch.docs!.d.textFields.length;
    const saves = content.variants["2"].fields.length + content.variants["2"].textFields.length;
    report(`MOLD_TEST: ${fingerprint.pageCount} páginas, guardados ${saves} campos, reconocido ${found?.match.level} (${found?.match.percent} %), aplicados ${applied}, a revisar ${plan.pending.length}`);
    expect(applied).toBe(saves);
    expect(plan.pending).toHaveLength(0);
  }, 120_000);
});
