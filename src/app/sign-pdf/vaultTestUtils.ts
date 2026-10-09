/**
 * Ayudas SOLO para los tests del baul de firmas (no se importa desde
 * produccion): PNG minimos validos para `signVault.ts` y un canvas simulado,
 * porque jsdom ni dibuja ni decodifica imagenes.
 */
import {
  crc32,
  vaultImageToDataUrl,
  type VaultEntryInput,
  type VaultImage,
} from "@/app/sign-pdf/signVault";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/** PNG con IHDR correcto; `seed` hace distintos los bytes de dos del mismo tamaño. */
export function makePng(
  opts: { width?: number; height?: number; seed?: number } = {},
): Uint8Array {
  const { width = 40, height = 20, seed = 0 } = opts;
  const ihdr = new Uint8Array(25);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 13);
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4);
  view.setUint32(8, width);
  view.setUint32(12, height);
  ihdr.set([8, 6, 0, 0, 0], 16);
  // CRC valido del IHDR (la importacion lo exige).
  view.setUint32(21, crc32(ihdr.subarray(4, 21)));
  const filler = new Uint8Array(8).fill(seed & 0xff);
  const out = new Uint8Array(PNG_HEAD.length + ihdr.length + filler.length + PNG_END.length);
  out.set(PNG_HEAD, 0);
  out.set(ihdr, PNG_HEAD.length);
  out.set(filler, PNG_HEAD.length + ihdr.length);
  out.set(PNG_END, out.length - PNG_END.length);
  return out;
}

export function makeImage(
  opts: { width?: number; height?: number; seed?: number } = {},
): VaultImage {
  const { width = 40, height = 20 } = opts;
  return { png: makePng(opts), ratio: height / width, width, height };
}

export function pngDataUrl(
  opts: { width?: number; height?: number; seed?: number } = {},
): string {
  return vaultImageToDataUrl(makeImage(opts));
}

export function vaultInput(
  name = "Ana Pérez",
  overrides: Partial<VaultEntryInput> = {},
): VaultEntryInput {
  return {
    signerName: name,
    role: "Directora",
    sourceDocument: "contrato.pdf",
    signature: makeImage({ seed: 1 }),
    initials: makeImage({ width: 20, height: 20, seed: 2 }),
    ...overrides,
  };
}

/**
 * Sustituye `getContext` y `toDataURL` del canvas por versiones minimas que
 * bastan para que el compositor produzca un borrador en el modo «Escribir».
 * Devuelve la funcion que lo deja como estaba.
 */
export function installCanvasStubs(output = pngDataUrl({ seed: 9 })): () => void {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return {
      font: "",
      fillStyle: "",
      textBaseline: "",
      measureText: () => ({ width: 100 }),
      scale: () => {},
      fillText: () => {},
      clearRect: () => {},
      drawImage: () => {},
      setTransform: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4).fill(255),
      }),
    };
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
    return output;
  } as unknown as typeof HTMLCanvasElement.prototype.toDataURL;
  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
  };
}
