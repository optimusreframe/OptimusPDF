import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { listDrafts, listSessionDrafts } from "@/app/sign-pdf/signDrafts";
import { __resetSignPdfFeatureFlagsCacheForTests, setSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { applyDraftsImport, defaultDraftDecisions, exportDraftsDetailed, planDraftsImport, summarizeDrafts } from "@/lib/backup/modules/drafts";
import { clearAllLocalDrafts, seedSignDocument, seedSignSession } from "@/lib/backup/__fixtures__/draftsKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";

/**
 * «Guardar tambien las firmas recogidas» (`signaturesInDraft`) con el ajuste REAL de la aplicacion (jsdom, `localStorage`
 * de verdad, sin ninguna sustitucion de `window`): el respaldo lo respeta al exportar, al resumir y al importar.
 */

beforeEach(async () => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  await clearAllLocalDrafts();
});

describe("con el ajuste real de Firmar", () => {
  it("apagado: no viajan los trazos, el resumen lo dice y al importar tampoco entran", async () => {
    await seedSignDocument({ strokes: true });
    await seedSignSession({ strokes: true, ceremony: true });
    expect((await summarizeDrafts())).toMatchObject({ ok: true, withSignatureStrokes: 2, includesSignatureStrokes: true, strokesHeldBack: false });

    setSignPdfFeatureFlag("signaturesInDraft", false);
    expect(window.localStorage.getItem("optimuspdf.signPdf.featureFlags")).toContain('"signaturesInDraft":false');
    expect((await summarizeDrafts())).toMatchObject({ ok: true, includesSignatureStrokes: false, strokesHeldBack: true });
    const { module, report } = await exportDraftsDetailed();
    expect(report).toMatchObject({ signDocuments: 1, signSessions: 1, includesStrokes: false });
    expect(module.files.some((f) => f.path.endsWith(".png"))).toBe(false);

    // el paquete SIN trazos y, aparte, uno CON trazos importado con el ajuste apagado
    setSignPdfFeatureFlag("signaturesInDraft", true);
    const withStrokes = await exportDraftsDetailed();
    expect(withStrokes.report.includesStrokes).toBe(true);
    const read = await readPackage(asFile(await buildPackage({ modules: [withStrokes.module] })));
    await clearAllLocalDrafts();
    setSignPdfFeatureFlag("signaturesInDraft", false);
    const plan = await planDraftsImport(read);
    expect(plan.keepStrokes).toBe(false);
    expect(plan.items.every((i) => i.strokesDropped)).toBe(true);
    expect(await applyDraftsImport(plan, defaultDraftDecisions(plan))).toMatchObject({ ok: true, written: 2, strokesDropped: 2 });
    expect((await listDrafts())[0].captures).toEqual({});
    expect((await listSessionDrafts())[0].signaturesOmitted).toBe(true);
  });

  it("encendido (por defecto): los trazos viajan y se conservan", async () => {
    await seedSignDocument({ strokes: true });
    const { report, module } = await exportDraftsDetailed();
    expect(report.includesStrokes).toBe(true);
    const read = await readPackage(asFile(await buildPackage({ modules: [module] })));
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read);
    expect(plan.keepStrokes).toBe(true);
    await applyDraftsImport(plan, defaultDraftDecisions(plan));
    expect(Object.keys((await listDrafts())[0].captures)).toEqual(["sg-1"]);
  });
});
