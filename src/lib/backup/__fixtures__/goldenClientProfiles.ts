import { buildPackage } from "@/lib/backup/package";
import { clientProfilesModuleFromProfiles } from "@/lib/backup/modules/clientProfiles";
import type { ClientProfile } from "@/lib/autofill/types";

/**
 * Generador de los dorados del modulo «Perfiles de cliente» (`client-profiles-v1*.optimuspdf.zip`): tres perfiles con datos
 * SINTETICOS fijos (nombres, telefonos y polizas inventados; fechas e ids fijos; una clave que el registro actual no conoce y un
 * valor corregido a mano). Los dorados NO se regeneran: si una prueba falla, se rompio la compatibilidad de un formato publicado.
 * Para volver a generarlos a proposito (solo si se pierden):
 *   GEN_GOLDEN_CLIENT_PROFILES=1 npx vitest run src/lib/backup/goldenClientProfiles.generate.test.ts
 */

export const GOLDEN_PROFILES_PASSWORD = "dorada-2026";
export const GOLDEN_PROFILES_CREATED = "2026-10-15T12:00:00.000Z";

const at = (iso: string) => iso;
const v = (value: string, updatedAt: string, source: "extracted" | "typed" = "extracted") => ({ value, updatedAt, source });

export const GOLDEN_PROFILES: readonly ClientProfile[] = [
  {
    id: "cp-golden-0001",
    name: "Pérez Soto, María",
    updatedAt: at("2026-10-14T09:00:00.000Z"),
    values: {
      insuredName1: v("María Pérez Soto", "2026-10-14T09:00:00.000Z"),
      phone: v("(555) 010-0001", "2026-10-14T09:00:00.000Z"),
      email: v("maria.perez@ejemplo.test", "2026-10-14T09:00:00.000Z", "typed"),
      address: v("Calle Falsa 123, Ciudad Demo", "2026-10-14T09:00:00.000Z"),
      insurer: v("Aseguradora Demo S.A.", "2026-10-14T09:00:00.000Z"),
      policyNumber: v("POL-0001-DEMO", "2026-10-14T09:00:00.000Z"),
      claimNumber: v("CLM-2026-0042", "2026-10-14T09:00:00.000Z"),
      lossDate: v("2026-09-30", "2026-10-14T09:00:00.000Z"),
    },
  },
  {
    id: "cp-golden-0002",
    name: "Gómez, Luis",
    updatedAt: at("2026-10-14T10:00:00.000Z"),
    values: {
      insuredName1: v("Luis Gómez", "2026-10-14T10:00:00.000Z"),
      insuredName2: v("Ana Ruiz", "2026-10-14T10:00:00.000Z"),
      phone: v("555-010-0002", "2026-10-14T10:00:00.000Z"),
    },
  },
  {
    id: "cp-golden-0003",
    name: "Cliente con clave futura",
    updatedAt: at("2026-10-14T11:00:00.000Z"),
    values: {
      insuredName1: v("Cliente Demo", "2026-10-14T11:00:00.000Z"),
      "roof.material": v("teja demo", "2026-10-14T11:00:00.000Z", "typed"),
    },
  },
];

export async function buildGoldenClientProfiles(options: { password?: string } = {}): Promise<Blob> {
  return buildPackage({
    modules: [clientProfilesModuleFromProfiles(GOLDEN_PROFILES)],
    password: options.password,
    now: new Date(GOLDEN_PROFILES_CREATED),
    app: { version: "0.1.0", build: "golden" },
  });
}
