import { clearVault } from "@/app/sign-pdf/signVault";
import { __resetLibraryForTests, clearLibrary, putDocument } from "@/lib/docLibrary/store";
import { createTemplate } from "@/lib/docLibrary/templatesStore";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { sampleDraft } from "@/lib/docLibrary/testing/templateSamples";
import { sha256Hex } from "@/lib/crypto/sha256";
import { buildPackage } from "@/lib/backup/package";
import { signaturesModuleFromEntries } from "@/lib/backup/modules/signatures";
import { exportLibraryWithReport } from "@/lib/backup/modules/library";
import { exportDraftsDetailed } from "@/lib/backup/modules/drafts";
import { settingsModuleFromValues, type ValueHistoryEntries } from "@/lib/backup/modules/settings";
import { clearAllLocalDrafts, realPdf, seedEditDraft, seedProDraft, seedSignDocument, seedSignSession } from "@/lib/backup/__fixtures__/draftsKit";
import { vaultEntry } from "@/lib/backup/__fixtures__/testKit";
// Efecto lateral necesario: ajusta `instanceof Uint8Array` para los bytes que devuelve fake-indexeddb en jsdom.
import "@/lib/backup/__fixtures__/libraryKit";

/**
 * Generador DETERMINISTA de los dorados del «OptimusPDF Package» global (`package-all-v1*.optimuspdf.zip`, U4.8): los CUATRO
 * módulos (Firmas, Plantillas y documentos, Borradores, Ajustes) con datos sintéticos fijos (PDF reales de pdf-lib sin fechas,
 * PNG reales de semilla fija, fechas fijas, ids fijos). El contenido sale idéntico en cada ejecución; solo el cifrado del
 * dorado cifrado usa sal e IV aleatorios (como en cualquier cifrado). Los dorados NO se regeneran: si una prueba falla, se
 * rompió la compatibilidad de un formato publicado. Para volver a generarlos a propósito (solo si se pierden):
 *   GEN_GOLDEN_ALL=1 npx vitest run src/lib/backup/goldenAll.generate.test.tsx
 */

export const GOLDEN_ALL_PASSWORD = "dorada-2026";
export const GOLDEN_ALL_CREATED = "2026-10-15T12:00:00.000Z";
export const GOLDEN_ALL_SAVED = "2026-10-14T10:00:00.000Z";
export const GOLDEN_ALL_NOW = Date.parse(GOLDEN_ALL_CREATED);

/** Ajustes del dorado: diez, uno por cada ajuste de la lista blanca que tiene valor propio. */
export const GOLDEN_ALL_SETTINGS = {
  "optimuspdf.theme": "dark",
  "optimuspdf.language": "en",
  "optimuspdf.sidebarCollapsed": true,
  "optimuspdf.signPdf.featureFlags": { completionCertificate: true, autoApplyTemplates: false, autoDetectFields: false },
  "optimuspdf.sign.templateSigners": 2,
  "optimuspdf.editPdf.featureFlags": { editExistingText: false },
  "optimuspdf.pro.featureFlags": { proAutosave: true },
  "optimuspdf.pro.layout.v1": { thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true },
  "optimuspdf.sign-pdf.privacyNoticeSeen": true,
  "optimuspdf.edit-pdf.privacyNoticeSeen": true,
} as const;

export const GOLDEN_ALL_HISTORY: ValueHistoryEntries = {
  "nombre del asegurado": [{ value: "Ana Pérez", lastUsedAt: "2026-10-10T10:00:00.000Z" }],
  "numero de poliza": [{ value: "POL-0001", lastUsedAt: "2026-10-11T10:00:00.000Z" }],
};

/** Lo que llevan los dorados (la prueba de contenido compara contra esto). */
export const GOLDEN_ALL = {
  signatures: [
    { id: "pkgall-ana", name: "Ana Pérez", role: "Directora", sig: 41, ini: 42 },
    { id: "pkgall-luis", name: "Luis Gómez", role: undefined, sig: 43, ini: null },
    { id: "pkgall-marta", name: "Marta Ruiz", role: undefined, sig: null, ini: 44 },
  ],
  documents: [
    { id: "pkgall-doc-a", name: "Contrato global A", pages: 3, seed: 1, template: "pkgall-tpl-a" },
    { id: "pkgall-doc-b", name: "Contrato global B", pages: 2, seed: 2, template: "pkgall-tpl-b" },
    { id: "pkgall-doc-c", name: "Contrato global C", pages: 2, seed: 3, template: null },
  ],
  drafts: { signLabel: "Poliza global", editLabel: "Informe global", proLabel: "Pro global", proTag: "global" },
} as const;

const DOC_DATE = "2026-10-01T10:00:00.000Z";

/** Congela solo `Date` (los temporizadores y `fake-indexeddb` siguen reales) mientras corre `work`. */
async function withFixedDate<T>(iso: string, work: () => Promise<T>): Promise<T> {
  const { vi } = await import("vitest");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}

/** Los cuatro módulos con los datos sintéticos fijos. Deja los almacenes vacíos al terminar. */
export async function buildGoldenAll(options: { password?: string; withHistory: boolean }): Promise<Blob> {
  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();

  const signatures = signaturesModuleFromEntries(
    GOLDEN_ALL.signatures.map((row, index) => ({
      ...vaultEntry(row.id, row.name, {
        sig: row.sig,
        ini: row.ini,
        created: `2026-10-0${index + 1}T10:00:00.000Z`,
        used: `2026-10-0${index + 5}T10:00:00.000Z`,
      }),
      ...(row.role ? { role: row.role } : {}),
    })),
  );

  for (const row of GOLDEN_ALL.documents) {
    const bytes = await realPdf(row.name, row.pages);
    const fingerprint = { ...sampleFingerprint(row.pages, row.seed), exact: await sha256Hex(bytes) };
    await putDocument(
      {
        id: row.id,
        name: row.name,
        docType: "contrato de servicio",
        fileName: `${row.id}.pdf`,
        pageCount: fingerprint.pageCount,
        pageSizes: fingerprint.pageSizes,
        fingerprint,
        templateIds: [],
      },
      bytes,
      { now: () => new Date(DOC_DATE) },
    );
    if (row.template) {
      await createTemplate(sampleDraft(row.id, { name: `Plantilla ${row.name}` }), { newId: () => row.template as string, now: () => new Date(DOC_DATE) });
    }
  }
  const library = (await exportLibraryWithReport()).module;

  const drafts = await withFixedDate(GOLDEN_ALL_SAVED, async () => {
    await seedSignDocument({ label: GOLDEN_ALL.drafts.signLabel, strokes: true });
    await seedSignSession({ strokes: true, ceremony: true });
    await seedEditDraft({ label: GOLDEN_ALL.drafts.editLabel, withImage: true });
    await seedProDraft({ label: GOLDEN_ALL.drafts.proLabel, tag: GOLDEN_ALL.drafts.proTag });
    return (await exportDraftsDetailed({ now: GOLDEN_ALL_NOW })).module;
  });

  const settings = settingsModuleFromValues(GOLDEN_ALL_SETTINGS, options.withHistory ? GOLDEN_ALL_HISTORY : undefined);

  const blob = await withFixedDate(GOLDEN_ALL_CREATED, () =>
    buildPackage({
      modules: [signatures, library, drafts, settings],
      password: options.password,
      now: new Date(GOLDEN_ALL_CREATED),
      app: { version: "0.1.0", build: "golden" },
    }),
  );

  __resetLibraryForTests();
  await clearLibrary();
  await clearVault();
  await clearAllLocalDrafts();
  return blob;
}
