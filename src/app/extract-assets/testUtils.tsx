import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import type { ExtractedAsset } from "@/lib/pdf/extractAssets/types";

/** Ayudas SOLO de las pruebas de la interfaz de «Extraer elementos» (no se importa desde produccion). */

export function setLanguage(language: "es" | "en" = "es"): void {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
}

export function mount(node: ReactNode) {
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

/** Un elemento sintetico (sin miniatura: jsdom no decodifica imagenes). */
export function makeAsset(partial: Partial<ExtractedAsset> & { id: string }): ExtractedAsset {
  return {
    kind: "signature",
    confidence: 0.95,
    reasons: ["transparente"],
    source: "xobject",
    occurrences: [{ pageIndex: 2, rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.07 } }],
    pixel: { width: 420, height: 140, hasAlpha: true },
    formats: ["png"],
    bytesEstimate: 2048,
    thumb: null,
    ref: { engine: "image", objectId: partial.id, pageIndex: 2 },
    ...partial,
  };
}

/** Los mismos tipos y paginas que el escenario `mixed` del motor falso, en pequeno. */
export function sampleAssets(): ExtractedAsset[] {
  return [
    makeAsset({ id: "sig-a", kind: "signature", confidence: 0.93 }),
    makeAsset({ id: "sig-b", kind: "signature", confidence: 0.6, reasons: ["fondo casi blanco"], occurrences: [{ pageIndex: 3, rect: { x: 0.2, y: 0.7, width: 0.3, height: 0.07 } }], pixel: { width: 520, height: 180, hasAlpha: false }, formats: ["png", "jpg-original"] }),
    makeAsset({ id: "ini-a", kind: "initials", confidence: 0.8, occurrences: [{ pageIndex: 0, rect: { x: 0.8, y: 0.9, width: 0.1, height: 0.05 } }], pixel: { width: 160, height: 90, hasAlpha: true } }),
    makeAsset({ id: "logo-a", kind: "logo", confidence: 0.92, occurrences: [0, 1, 2, 3, 4, 5].map((pageIndex) => ({ pageIndex, rect: { x: 0.05, y: 0.03, width: 0.2, height: 0.05 } })), pixel: { width: 300, height: 100, hasAlpha: false } }),
    makeAsset({ id: "wm-a", kind: "watermark", confidence: 0.7, source: "text", pixel: null, formats: ["txt", "svg"], ref: { engine: "text", text: "CONFIDENCIAL" }, occurrences: [{ pageIndex: 0, rect: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 } }] }),
    makeAsset({ id: "img-a", kind: "image", confidence: 0.99, occurrences: [{ pageIndex: 4, rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 } }], pixel: { width: 800, height: 600, hasAlpha: false } }),
  ];
}
