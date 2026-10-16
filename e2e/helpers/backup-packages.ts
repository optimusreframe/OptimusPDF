import { buildPackage } from "../../src/lib/backup/package";
import { signaturesModuleFromEntries } from "../../src/lib/backup/modules/signatures";
import { makeImage, pngPixelBomb, pngWithChunk, pngWithCorruptIdat } from "../../src/lib/backup/__fixtures__/pngFactory";
import type { VaultEntry } from "../../src/app/sign-pdf/signVault";

/**
 * Paquetes de respaldo de PRUEBA con imagenes PNG REALES (zlib de verdad, CRC de cada chunk): los que se importan sin
 * reparos en la interfaz. Los paquetes «dorados» de `src/lib/backup/__fixtures__/packages/` llevan imagenes SINTETICAS
 * (cabecera valida + relleno): sirven para la prueba de formato de la libreria, pero la importacion de la interfaz las
 * rechaza a proposito (D5: una imagen que no se puede decodificar no entra), asi que aqui hay un equivalente real.
 */

const D = (day: number) => `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`;

export function entry(
  id: string,
  name: string,
  opts: { sig?: number | null; ini?: number | null; role?: string; day?: number } = {},
): VaultEntry {
  const { sig = 1, ini = null, role, day = 1 } = opts;
  return {
    id,
    schema: 1,
    signerName: name,
    signerKey: name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim(),
    ...(role ? { role } : {}),
    sourceDocument: "",
    createdAt: D(day),
    lastUsedAt: D(day + 1),
    signature: sig === null ? null : makeImage({ seed: sig, width: 120, height: 48, real: true }),
    initials: ini === null ? null : makeImage({ seed: ini, width: 48, height: 48, real: true }),
  };
}

export async function packageBuffer(entries: VaultEntry[], password?: string): Promise<Buffer> {
  const blob = await buildPackage({ modules: [signaturesModuleFromEntries(entries)], password });
  return Buffer.from(await blob.arrayBuffer());
}

/** El equivalente REAL del paquete dorado v1 (Ana con firma e iniciales y cargo, Luis solo firma, Marta solo iniciales). */
export function threeSignatures(password?: string): Promise<Buffer> {
  return packageBuffer(
    [
      entry("vault-real-ana", "Ana Pérez", { sig: 11, ini: 12, role: "Directora", day: 1 }),
      entry("vault-real-luis", "Luis Gómez", { sig: 13, ini: null, day: 2 }),
      entry("vault-real-marta", "Marta Ruiz", { sig: null, ini: 14, day: 3 }),
    ],
    password,
  );
}

/** Una entrada cuya firma es un PNG FORJADO (estructura o datos rotos); el IHDR manda en dimensiones y ratio. */
export function forgedEntry(id: string, name: string, forge: (png: Uint8Array) => Uint8Array): VaultEntry {
  const base = entry(id, name, { sig: 3 });
  const png = forge(base.signature!.png);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return { ...base, signature: { png, ratio: height / width, width, height } };
}

export const FORGERIES: Array<[string, (png: Uint8Array) => Uint8Array]> = [
  ["IDAT corrupto", (png) => pngWithCorruptIdat(png)],
  ["APNG (acTL)", (png) => pngWithChunk(png, "acTL", new Uint8Array(8))],
  ["tEXt de 100 KB", (png) => pngWithChunk(png, "tEXt", new Uint8Array(100_000).fill(65))],
  ["4096x4096 que descomprime a 64 MB", () => pngPixelBomb()],
];
