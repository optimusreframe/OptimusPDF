import { DEFAULT_SCAN_SETTINGS, type ScanMode, type ScanSettings } from "@/lib/scan/types";

/**
 * Preferencias del escaner que se recuerdan en ESTE dispositivo (captura automatica, rafaga y ultimo modo). Nunca contenido.
 * Cualquier fallo del almacenamiento (modo privado, cuota) se ignora: se usan los valores de fabrica.
 */
export const SCAN_PREFS_KEY = "optimuspdf.scan.prefs";

const MODES: ScanMode[] = ["document", "id-card", "receipt", "book", "whiteboard", "photo"];

export type ScanPrefs = Pick<ScanSettings, "mode" | "autoCapture" | "batch">;

export function readScanPrefs(): Partial<ScanPrefs> {
  try {
    const raw = globalThis.localStorage?.getItem(SCAN_PREFS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const value = parsed as Record<string, unknown>;
    const out: Partial<ScanPrefs> = {};
    if (typeof value.mode === "string" && (MODES as string[]).includes(value.mode)) out.mode = value.mode as ScanMode;
    if (typeof value.autoCapture === "boolean") out.autoCapture = value.autoCapture;
    if (typeof value.batch === "boolean") out.batch = value.batch;
    return out;
  } catch {
    return {};
  }
}

export function writeScanPrefs(settings: ScanSettings): void {
  try {
    const prefs: ScanPrefs = { mode: settings.mode, autoCapture: settings.autoCapture, batch: settings.batch };
    globalThis.localStorage?.setItem(SCAN_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Sin almacenamiento: vale solo para esta pantalla.
  }
}

export { DEFAULT_SCAN_SETTINGS };
