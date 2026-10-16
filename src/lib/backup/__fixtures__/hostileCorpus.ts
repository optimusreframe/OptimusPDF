import { forgeZip } from "@/lib/backup/__fixtures__/zipForge";
import type { PackageErrorCode } from "@/lib/backup/types";

/**
 * Zips HOSTILES para las pruebas de la INTERFAZ de importar firmas (vitest y E2E): el mismo tipo de ataques que
 * `package.test.ts` prueba contra la libreria, en una lista con el codigo de rechazo esperado. Solo para pruebas.
 */

export type HostileCase = { name: string; bytes: Uint8Array; code: PackageErrorCode };

const enc = new TextEncoder();

export function hostileCorpus(): HostileCase[] {
  const manyEntries = (n: number) =>
    forgeZip(Array.from({ length: n }, (_, i) => ({ name: `signatures/f${i}.json`, data: enc.encode("{}") })));
  return [
    { name: "archivo vacio", bytes: new Uint8Array(), code: "badZip" },
    { name: "texto que no es un zip", bytes: enc.encode("hola, esto no es un zip, pero es largo largo largo"), code: "badZip" },
    {
      name: "ruido aleatorio",
      bytes: new Uint8Array(5000).map((_, i) => (i * 131 + 7) & 0xff),
      code: "badZip",
    },
    {
      name: "zip-bomb por ratio (20 MB de ceros en ~20 KB)",
      bytes: forgeZip([{ name: "manifest.json", data: new Uint8Array(20 * 1024 * 1024), crc: 0 }]),
      code: "bomb",
    },
    {
      name: "declara mas de 250 MB descomprimidos",
      bytes: forgeZip([
        { name: "a.bin", data: new Uint8Array(4), declaredUncompressed: 140_000_000, declaredCompressed: 1_400_000 },
        { name: "b.bin", data: new Uint8Array(4), declaredUncompressed: 140_000_000, declaredCompressed: 1_400_000 },
      ]),
      code: "tooLarge",
    },
    { name: "2 001 entradas", bytes: manyEntries(2001), code: "tooManyEntries" },
    {
      name: "el EOCD miente sobre el numero de entradas",
      bytes: forgeZip([{ name: "manifest.json", data: enc.encode("{}") }], { eocdEntries: 5000 }),
      code: "tooManyEntries",
    },
    {
      name: "ruta con ../",
      bytes: forgeZip([
        { name: "manifest.json", data: enc.encode("{}") },
        { name: "signatures/../../evil.png", data: enc.encode("x") },
      ]),
      code: "unsafePath",
    },
    {
      name: "ruta absoluta",
      bytes: forgeZip([
        { name: "manifest.json", data: enc.encode("{}") },
        { name: "/etc/passwd", data: enc.encode("x") },
      ]),
      code: "unsafePath",
    },
    {
      name: "nombres duplicados por mayusculas",
      bytes: forgeZip([
        { name: "manifest.json", data: enc.encode("{}") },
        { name: "signatures/a.json", data: enc.encode("{}") },
        { name: "signatures/A.JSON", data: enc.encode("{}") },
      ]),
      code: "duplicateEntry",
    },
  ];
}
