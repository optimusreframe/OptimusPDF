import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  DEFAULT_SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  SIGN_PDF_FEATURE_FLAGS_VERSION,
  SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
  setSignPdfFeatureFlag,
  useSignPdfFeatureFlag,
  useSignPdfFeatureFlags,
  type SignPdfFeatureFlagState,
} from "@/app/sign-pdf/signFeatureFlags";

/**
 * F0-U0.5: la hoja «Registro de firmas» nace APAGADA. `writeFlags` guarda TODOS los interruptores, asi que quien toco
 * cualquier ajuste tiene `completionCertificate: true` grabado por haber sido el valor por defecto: cambiar el defecto
 * no basta, hay que migrar lo guardado UNA vez y respetar lo que la persona elija despues.
 */

const KEY = SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY;
const VERSION_KEY = SIGN_PDF_FEATURE_FLAGS_VERSION_KEY;

/** Lo que dejaba la version 1: TODOS los flags, con el certificado a `true`, y sin clave de version. */
function legacyFlags(overrides: Partial<SignPdfFeatureFlagState> = {}): Record<string, boolean> {
  const all: Record<string, boolean> = {};
  for (const flag of SIGN_PDF_FEATURE_FLAGS) all[flag] = true;
  delete all.signingRecordFile; // la version 1 no conocia este interruptor
  return { ...all, completionCertificate: true, ...overrides };
}

/** «Recargar la pagina»: el cache en memoria se pierde, localStorage se conserva. */
function reload() {
  __resetSignPdfFeatureFlagsCacheForTests();
}

function flagsNow(): SignPdfFeatureFlagState {
  return renderHook(() => useSignPdfFeatureFlags()).result.current;
}

function stored(): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
  window.localStorage.clear();
  reload();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("signFeatureFlags — valores por defecto", () => {
  it("el registro de firmas (pagina final) y el registro .json aparte nacen APAGADOS; el resto sigue encendido", () => {
    expect(DEFAULT_SIGN_PDF_FEATURE_FLAGS.completionCertificate).toBe(false);
    expect(DEFAULT_SIGN_PDF_FEATURE_FLAGS.signingRecordFile).toBe(false);
    for (const flag of SIGN_PDF_FEATURE_FLAGS) {
      if (flag === "completionCertificate" || flag === "signingRecordFile") continue;
      expect(DEFAULT_SIGN_PDF_FEATURE_FLAGS[flag], flag).toBe(true);
    }
  });

  it("«Guardar las firmas recogidas en el borrador» (U0.4) nace ENCENDIDO, esta en la lista de Ajustes y se puede apagar", () => {
    expect(SIGN_PDF_FEATURE_FLAGS).toContain("signaturesInDraft");
    expect(DEFAULT_SIGN_PDF_FEATURE_FLAGS.signaturesInDraft).toBe(true);
    expect(flagsNow().signaturesInDraft).toBe(true);
    setSignPdfFeatureFlag("signaturesInDraft", false);
    reload();
    expect(flagsNow().signaturesInDraft).toBe(false);
  });

  it("sin datos guardados (usuario nuevo) la pagina de registro y el .json estan apagados", () => {
    const flags = flagsNow();
    expect(flags.completionCertificate).toBe(false);
    expect(flags.signingRecordFile).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe("signFeatureFlags — migracion unica a la version 2", () => {
  it("usuario con ajustes ANTIGUOS (`completionCertificate: true` grabado, sin version): pasa a `false`", () => {
    window.localStorage.setItem(KEY, JSON.stringify(legacyFlags()));
    expect(window.localStorage.getItem(VERSION_KEY)).toBeNull();

    const flags = flagsNow();
    expect(flags.completionCertificate).toBe(false);
    // Se persiste con la version actual: la migracion no se repite.
    expect(stored()?.completionCertificate).toBe(false);
    expect(window.localStorage.getItem(VERSION_KEY)).toBe(String(SIGN_PDF_FEATURE_FLAGS_VERSION));
  });

  it("la migracion SOLO toca el certificado: el resto de ajustes que la persona cambio se conserva", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify(legacyFlags({ keyboardNav: false, pinchZoom: false, multiDocument: false })),
    );
    const flags = flagsNow();
    expect(flags.completionCertificate).toBe(false);
    expect(flags.keyboardNav).toBe(false);
    expect(flags.pinchZoom).toBe(false);
    expect(flags.multiDocument).toBe(false);
    expect(flags.undoDelete).toBe(true);
    expect(flags.signingRecordFile).toBe(false);
  });

  it("ajustes antiguos con la clave de version anterior (1) tambien migran", () => {
    window.localStorage.setItem(KEY, JSON.stringify(legacyFlags()));
    window.localStorage.setItem(VERSION_KEY, "1");
    expect(flagsNow().completionCertificate).toBe(false);
    expect(window.localStorage.getItem(VERSION_KEY)).toBe("2");
  });

  it("una clave de version corrupta se trata como antigua (migra) y no rompe", () => {
    window.localStorage.setItem(KEY, JSON.stringify(legacyFlags()));
    window.localStorage.setItem(VERSION_KEY, "no-es-un-numero");
    expect(flagsNow().completionCertificate).toBe(false);
  });

  it("tras migrar, si la persona LO ACTIVA se respeta tras recargar (la migracion no se repite)", () => {
    window.localStorage.setItem(KEY, JSON.stringify(legacyFlags()));
    expect(flagsNow().completionCertificate).toBe(false);

    act(() => setSignPdfFeatureFlag("completionCertificate", true));
    expect(stored()?.completionCertificate).toBe(true);
    expect(window.localStorage.getItem(VERSION_KEY)).toBe("2");

    reload();
    expect(flagsNow().completionCertificate).toBe(true);
    // Y otra recarga mas: sigue respetandose.
    reload();
    expect(flagsNow().completionCertificate).toBe(true);
  });

  it("usuario nuevo que activa el registro: se respeta tras recargar (la version se graba junto al primer cambio)", () => {
    act(() => setSignPdfFeatureFlag("completionCertificate", true));
    expect(window.localStorage.getItem(VERSION_KEY)).toBe("2");
    reload();
    expect(flagsNow().completionCertificate).toBe(true);
  });

  it("usuario nuevo que cambia OTRO ajuste: el registro sigue apagado tras recargar", () => {
    act(() => setSignPdfFeatureFlag("pinchZoom", false));
    reload();
    const flags = flagsNow();
    expect(flags.pinchZoom).toBe(false);
    expect(flags.completionCertificate).toBe(false);
  });

  it("con la version actual ya grabada y el certificado a `true`, NO se toca (eleccion de la persona)", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ ...legacyFlags(), completionCertificate: true }));
    window.localStorage.setItem(VERSION_KEY, String(SIGN_PDF_FEATURE_FLAGS_VERSION));
    expect(flagsNow().completionCertificate).toBe(true);
  });

  it("ajustes antiguos que ya tenian el certificado apagado: se quedan apagados y se anota la version", () => {
    window.localStorage.setItem(KEY, JSON.stringify(legacyFlags({ completionCertificate: false })));
    expect(flagsNow().completionCertificate).toBe(false);
    expect(window.localStorage.getItem(VERSION_KEY)).toBe("2");
  });

  it("ajustes antiguos sin la clave `completionCertificate` (aun mas viejos): apagado", () => {
    const old = legacyFlags();
    delete old.completionCertificate;
    window.localStorage.setItem(KEY, JSON.stringify(old));
    expect(flagsNow().completionCertificate).toBe(false);
  });

  it("el hook de UN flag lee el valor migrado", () => {
    window.localStorage.setItem(KEY, JSON.stringify(legacyFlags()));
    const { result } = renderHook(() => useSignPdfFeatureFlag("completionCertificate"));
    expect(result.current).toBe(false);
  });

  it("JSON corrupto o valor que no es un objeto: defaults (apagado) sin lanzar", () => {
    window.localStorage.setItem(KEY, "{no es json");
    expect(flagsNow().completionCertificate).toBe(false);
    reload();
    window.localStorage.setItem(KEY, "42");
    expect(flagsNow().completionCertificate).toBe(false);
  });

  it("si el navegador no deja escribir, el flag queda apagado en memoria y no se lanza nada", () => {
    window.localStorage.setItem(KEY, JSON.stringify(legacyFlags()));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(flagsNow().completionCertificate).toBe(false);
  });
});

describe("signFeatureFlags — registro .json aparte", () => {
  it("se puede activar y se respeta tras recargar", () => {
    act(() => setSignPdfFeatureFlag("signingRecordFile", true));
    reload();
    expect(flagsNow().signingRecordFile).toBe(true);
  });

  it("la migracion del certificado NO apaga un registro .json que la persona ya hubiera activado en la version 2", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ ...legacyFlags(), signingRecordFile: true }));
    const flags = flagsNow();
    expect(flags.completionCertificate).toBe(false);
    expect(flags.signingRecordFile).toBe(true);
  });
});
