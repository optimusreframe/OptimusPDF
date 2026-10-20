import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetSignPdfFeatureFlagsCacheForTests,
  SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
  useSignPdfFeatureFlags,
} from "@/app/sign-pdf/signFeatureFlags";
import { __resetValueHistoryCacheForTests, bestMatchForKey, recordValue } from "@/lib/valueHistory";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { applySettingsImport, planSettingsImport, settingsModuleFromValues } from "@/lib/backup/modules/settings";
import { asFile } from "@/lib/backup/__fixtures__/testKit";

/**
 * El modulo «Ajustes» sobre el `localStorage` REAL de jsdom (sin pasar `storage`): lo que escribe lo leen de verdad los
 * almacenes de la app (interruptores de Firmar con su version, historial de valores con su cache).
 */

beforeEach(() => {
  window.localStorage.clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetValueHistoryCacheForTests();
});

async function importValues(values: Parameters<typeof settingsModuleFromValues>[0], history?: Parameters<typeof settingsModuleFromValues>[1], decisions = { settings: "replace" as const, valueHistory: "replace" as const }) {
  const blob = await buildPackage({ modules: [settingsModuleFromValues(values, history)] });
  const plan = planSettingsImport(await readPackage(asFile(blob)));
  return applySettingsImport(plan, decisions);
}

describe("sobre localStorage de verdad", () => {
  it("un interruptor de Firmar activado a proposito (`completionCertificate: true`) se respeta tras recargar: se escribe la version", async () => {
    const result = await importValues({ "optimuspdf.signPdf.featureFlags": { completionCertificate: true, autoApplyTemplates: false } });
    expect(result).toMatchObject({ ok: true, written: 1, reloadRequired: true });
    expect(window.localStorage.getItem(SIGN_PDF_FEATURE_FLAGS_VERSION_KEY)).toBe("2");
    __resetSignPdfFeatureFlagsCacheForTests(); // «recargar»
    const { result: flags } = renderHook(() => useSignPdfFeatureFlags());
    expect(flags.current.completionCertificate).toBe(true);
    expect(flags.current.autoApplyTemplates).toBe(false);
    expect(flags.current.autoDetectFields).toBe(true); // lo que el paquete no trae queda por defecto
  });

  it("control: sin la clave de version, la migracion unica volveria a apagar el registro (la prueba de arriba es sensible)", () => {
    window.localStorage.setItem("optimuspdf.signPdf.featureFlags", JSON.stringify({ completionCertificate: true }));
    __resetSignPdfFeatureFlagsCacheForTests();
    const { result } = renderHook(() => useSignPdfFeatureFlags());
    expect(result.current.completionCertificate).toBe(false);
  });

  it("el historial de valores importado se ve en seguida (se avisa a su cache) y mantiene su formato", async () => {
    recordValue("nombre", "Valor local"); // llena la cache en memoria
    expect(bestMatchForKey("nombre")).toBe("Valor local");
    const result = await importValues({}, { nombre: [{ value: "Maria Lopez", lastUsedAt: "2026-10-01T10:00:00.000Z" }] });
    expect(result).toMatchObject({ ok: true, valueHistory: true });
    expect(JSON.parse(window.localStorage.getItem("optimuspdf.valueHistory") as string)).toEqual({
      version: 1,
      entries: { nombre: [{ value: "Maria Lopez", lastUsedAt: "2026-10-01T10:00:00.000Z" }] },
    });
    expect(bestMatchForKey("nombre")).toBe("Maria Lopez");
  });
});
