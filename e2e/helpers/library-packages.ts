import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { computeFingerprintWith } from "../../src/lib/docLibrary/fingerprintEngine";
import { nodeEnv } from "../../src/lib/docLibrary/testing/nodeEnv";
import { makeContractPdf } from "../../src/lib/docLibrary/testing/syntheticContracts";
import { sampleDraft, signField, variantOf } from "../../src/lib/docLibrary/testing/templateSamples";
import { __resetLibraryForTests, putDocument } from "../../src/lib/docLibrary/store";
import { createTemplate } from "../../src/lib/docLibrary/templatesStore";
import type { Fingerprint } from "../../src/lib/docLibrary/types";
import { buildPackage } from "../../src/lib/backup/package";
import { exportLibraryWithReport } from "../../src/lib/backup/modules/library";
import type { PackageFileInput, PackageModuleInput } from "../../src/lib/backup/types";

/**
 * Paquetes de «Plantillas y documentos» de PRUEBA para el E2E, armados en Node con contratos SINTÉTICOS reales (PDF de
 * pdf-lib con su huella de pdf.js): los que la interfaz importa sin reparos. Solo los usan las pruebas.
 */

export type SyntheticContract = { id: string; name: string; seed: number; pages: number; buffer: Buffer; fingerprint: Fingerprint };

export async function syntheticContract(id: string, name: string, seed: number, pages: number): Promise<SyntheticContract> {
  const bytes = await makeContractPdf({ seed, pages });
  const fingerprint = await computeFingerprintWith(bytes, nodeEnv());
  return { id, name, seed, pages, buffer: Buffer.from(bytes), fingerprint };
}

export type PackageSpec = {
  docs: SyntheticContract[];
  /** Plantillas: `ready` (1 y 2 firmantes) o `single` (1 firmante) por id de documento. */
  templates?: Record<string, "ready" | "single">;
  password?: string;
  /** Retoca el módulo antes de empaquetarlo (zips hostiles específicos del módulo). */
  mutate?: (mod: PackageModuleInput) => void;
};

/** Un paquete válido con esos contratos y plantillas; los ids de plantilla son `tpl-<id del documento>`. */
export async function libraryPackage(spec: PackageSpec): Promise<Buffer> {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
  let day = 0;
  for (const doc of spec.docs) {
    day += 1;
    const at = `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`;
    await putDocument(
      { id: doc.id, name: doc.name, docType: "contrato de servicio", fileName: `${doc.id}.pdf`, pageCount: doc.fingerprint.pageCount, pageSizes: doc.fingerprint.pageSizes, fingerprint: doc.fingerprint, templateIds: [], createdAt: at },
      new Uint8Array(doc.buffer),
      { updatedAt: at, now: () => new Date(at) },
    );
  }
  for (const [documentId, kind] of Object.entries(spec.templates ?? {})) {
    const draft =
      kind === "ready"
        ? sampleDraft(documentId, { name: `Plantilla ${documentId}` })
        : sampleDraft(documentId, { name: `Plantilla ${documentId}`, variants: { "1": variantOf([signField()]), "2": variantOf([]) } });
    await createTemplate(draft, { newId: () => `tpl-${documentId}`, now: () => new Date("2026-10-20T10:00:00.000Z") });
  }
  const { module: mod } = await exportLibraryWithReport();
  spec.mutate?.(mod);
  const blob = await buildPackage({ modules: [mod], password: spec.password });
  __resetLibraryForTests();
  return Buffer.from(await blob.arrayBuffer());
}

export const fileByPath = (mod: PackageModuleInput, path: string): PackageFileInput => {
  const file = mod.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`sin ${path}`);
  return file;
};
