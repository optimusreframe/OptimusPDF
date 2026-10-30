import { buildPackage } from "@/lib/backup/package";
import { exportScanSessionsDetailed } from "@/lib/backup/modules/scanSessions";
import { bytesBlob, resetScanStore, scanPage, scanSession, seedScanSession } from "@/lib/backup/__fixtures__/scanKit";
import { makeRealPng } from "@/lib/backup/__fixtures__/pngFactory";

/**
 * Generador de los dorados del modulo «Escaneos en curso» (`scan-sessions-v1*.optimuspdf.zip`): dos sesiones con datos
 * sinteticos fijos (fotos JPEG y PNG sinteticas, fechas e ids fijos; NUNCA fotos de clientes). Los dorados NO se regeneran: si
 * una prueba falla, se rompio la compatibilidad de un formato publicado. Para volver a generarlos a proposito (solo si se
 * pierden):
 *   GEN_GOLDEN_SCAN=1 npx vitest run src/lib/backup/goldenScan.generate.test.ts
 * Los SHA-256 de las fotos que fija `goldenPackages.scanSessions.test.ts` salen de los archivos ya publicados.
 */

export const GOLDEN_SCAN_PASSWORD = "dorada-2026";
export const GOLDEN_SCAN_CREATED = "2026-10-15T12:00:00.000Z";
/** Hora a la que se «guardaron» las sesiones al generar el dorado: los escaneos caducan a los 14 dias, asi que las pruebas la usan como reloj. */
export const GOLDEN_SCAN_NOW = Date.parse(GOLDEN_SCAN_CREATED);

export const GOLDEN_SCAN_IDS = { contract: "sc-golden-0001", receipt: "sc-golden-0002" } as const;

export async function buildGoldenScan(options: { password?: string } = {}): Promise<Blob> {
  await resetScanStore();
  const contract = scanSession(
    [
      scanPage(1, {
        id: "pg-golden-1",
        createdAt: "2026-10-14T09:00:00.000Z",
        filter: "bw",
        rotation: 90,
        adjust: { brightness: 0.25, contrast: -0.5 },
        flags: { blurry: true },
        ocrText: "Texto reconocido de la primera pagina\nsegunda linea",
        resolvedFilter: "bw",
        jpegSample: { side: 256, bytesPerPixel: 0.4, qualityRatio: { "0.8": 0.7 } },
      }),
      scanPage(2, {
        id: "pg-golden-2",
        createdAt: "2026-10-14T09:01:00.000Z",
        original: bytesBlob(makeRealPng({ width: 24, height: 30, seed: 7 }), "image/png"),
        originalWidth: 24,
        originalHeight: 30,
        corners: null,
        mode: "id-card",
        source: "library",
      }),
      scanPage(3, { id: "pg-golden-3", createdAt: "2026-10-14T09:02:00.000Z", flags: { noDocument: true } }),
    ],
    {
      id: GOLDEN_SCAN_IDS.contract,
      name: "Contrato de servicio (dorado)",
      createdAt: "2026-10-14T09:00:00.000Z",
      updatedAt: "2026-10-14T09:05:00.000Z",
      nameSuggested: { title: "Contrato de servicio", date: "2026-10-14", source: "ocr", name: "Contrato de servicio · 2026-10-14" },
      settings: { mode: "id-card", autoCapture: false, batch: false, defaultFilter: "grayscale", searchable: true },
    },
  );
  const receipt = scanSession([scanPage(9, { id: "pg-golden-9", createdAt: "2026-10-14T10:00:00.000Z", mode: "receipt" })], {
    id: GOLDEN_SCAN_IDS.receipt,
    name: "Recibo (dorado)",
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:01:00.000Z",
  });
  await seedScanSession(contract);
  await seedScanSession(receipt);
  const { module } = await exportScanSessionsDetailed({ now: GOLDEN_SCAN_NOW });
  return buildPackage({ modules: [module], password: options.password, now: new Date(GOLDEN_SCAN_CREATED), app: { version: "0.1.0", build: "golden" } });
}
