import { DEFAULT_IMAGE_PRESET, isImagePresetId, type ImagePresetId } from "@/lib/image/prepareForPdf";

/**
 * La ultima «Calidad de imagen» elegida se recuerda en este dispositivo (`localStorage`). Es una preferencia de CADA
 * dispositivo (un iPad con poco espacio y un ordenador no tienen por que compartirla), asi que esta clasificada en
 * `settingsRegistry.ts` como clave que NO viaja en el paquete de ajustes. Cualquier fallo del almacenamiento (modo privado,
 * cuota, `localStorage` ausente) se ignora: se usa la calidad recomendada.
 */
export const IMAGE_QUALITY_STORAGE_KEY = "optimuspdf.imageQuality";

export function readStoredImagePreset(): ImagePresetId {
  try {
    const stored = globalThis.localStorage?.getItem(IMAGE_QUALITY_STORAGE_KEY);
    if (isImagePresetId(stored)) return stored;
  } catch {
    // Sin almacenamiento: la recomendada.
  }
  return DEFAULT_IMAGE_PRESET;
}

export function writeStoredImagePreset(preset: ImagePresetId): void {
  try {
    globalThis.localStorage?.setItem(IMAGE_QUALITY_STORAGE_KEY, preset);
  } catch {
    // No se pudo guardar: la eleccion solo vale para esta pantalla.
  }
}
