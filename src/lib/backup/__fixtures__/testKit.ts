import JSZip from "jszip";
import { sha256Hex } from "@/lib/crypto/sha256";
import type { VaultEntry, VaultEntryInput } from "@/app/sign-pdf/signVault";
import { makeImage } from "@/lib/backup/__fixtures__/pngFactory";

/** Utilidades compartidas por las pruebas del respaldo (no las importa codigo de produccion). */

export function vaultInput(
  name: string,
  opts: {
    sig?: number | null;
    ini?: number | null;
    role?: string;
    sigBytes?: number;
    iniBytes?: number;
  } = {},
): VaultEntryInput {
  const { sig = 1, ini = 2, role } = opts;
  return {
    signerName: name,
    ...(role ? { role } : {}),
    sourceDocument: "contrato-secreto.pdf",
    // PNG REALES salvo que la prueba pida un tamaño exacto (`*Bytes`): asi lo que se exporta pasa tambien la guarda
    // estricta de la importacion (`readSignaturesBackup`).
    signature:
      sig === null
        ? null
        : makeImage({ seed: sig, totalBytes: opts.sigBytes, real: opts.sigBytes === undefined }),
    initials:
      ini === null
        ? null
        : makeImage({
            width: 20,
            height: 20,
            seed: ini,
            totalBytes: opts.iniBytes,
            real: opts.iniBytes === undefined,
          }),
  };
}

/** Entrada completa de baul para pruebas que no pasan por IndexedDB. */
export function vaultEntry(
  id: string,
  name: string,
  opts: { sig?: number | null; ini?: number | null; created?: string; used?: string } = {},
): VaultEntry {
  const input = vaultInput(name, opts);
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
    sourceDocument: "",
    createdAt: opts.created ?? "2026-10-01T10:00:00.000Z",
    lastUsedAt: opts.used ?? "2026-10-02T10:00:00.000Z",
    signature: input.signature,
    initials: input.initials,
  };
}

/** Abre un zip, deja que `change` lo modifique y lo vuelve a generar. */
export async function rewriteZip(
  blob: Blob,
  change: (zip: JSZip) => Promise<void> | void,
): Promise<Blob> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  await change(zip);
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

/** Cambia el contenido de un archivo del paquete y ARREGLA sha256/bytes del manifiesto (zip "legitimo" con contenido malo). */
export async function replaceFile(
  blob: Blob,
  path: string,
  data: Uint8Array,
): Promise<Blob> {
  return rewriteZip(blob, async (zip) => {
    zip.file(path, data);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    for (const file of manifest.files) {
      if (file.path === path) {
        file.sha256 = await sha256Hex(data);
        file.bytes = data.length;
      }
    }
    zip.file("manifest.json", JSON.stringify(manifest));
  });
}

export async function editManifest(
  blob: Blob,
  // Manifiesto "suelto": las pruebas lo rompen a proposito de mil maneras.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  change: (manifest: Record<string, any>) => void,
): Promise<Blob> {
  return rewriteZip(blob, async (zip) => {
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    change(manifest);
    zip.file("manifest.json", JSON.stringify(manifest));
  });
}

export function asFile(blob: Blob, name = "respaldo.optimuspdf.zip"): File {
  return new File([blob], name, { type: "application/zip" });
}

export async function timed<T>(run: () => Promise<T>, maxMs = 2000): Promise<T> {
  const start = performance.now();
  const value = await run();
  const elapsed = performance.now() - start;
  if (elapsed > maxMs) throw new Error(`tardo ${Math.round(elapsed)} ms (> ${maxMs})`);
  return value;
}
