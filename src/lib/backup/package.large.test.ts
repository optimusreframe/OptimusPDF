import { webcrypto } from "node:crypto";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { encryptWithPassword } from "@/lib/crypto/passwordBox";
import { sha256Hex } from "@/lib/crypto/sha256";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { DEFAULT_MODULE_REGISTRY } from "@/lib/backup/registry";
import { forgeZip } from "@/lib/backup/__fixtures__/zipForge";
import { PACKAGE_LIMITS, type ModuleRegistry, type PackageErrorCode } from "@/lib/backup/types";

/**
 * H1 (verificación independiente de «Respaldo y traslado»): un paquete CIFRADO de más de ~125 MB exportado por la propia
 * app no se podía reimportar, porque la capa externa (`payload.bin`) y la interna (los PDF inflados del zip interior)
 * gastaban el MISMO presupuesto de 250 MiB. Aquí se fija que (1) lo que la app exporta, cifrado o no, se vuelve a leer a
 * cualquier tamaño hasta el tope, (2) lo que no cabría se rechaza AL EXPORTAR (nunca se genera un archivo que luego no se
 * pueda abrir) y (3) los topes de seguridad de la importación siguen igual: nada de lo hostil se afloja.
 */

const MiB = 1024 * 1024;
const enc = new TextEncoder();
const json = (value: unknown) => enc.encode(JSON.stringify(value));

const BIG: ModuleRegistry = {
  ...DEFAULT_MODULE_REGISTRY,
  demo: { name: "demo", schemaVersion: 1, folders: ["documents"], maxFileBytes: 260 * MiB, maxJsonBytes: 1024 },
};

/** Un «PDF» casi incompresible (el caso real: un contrato escaneado): cabecera aleatoria y el resto a cero. */
function fakePdf(bytes: number, tag: number): Uint8Array {
  const data = new Uint8Array(bytes);
  webcrypto.getRandomValues(data.subarray(0, Math.min(65536, bytes)));
  data[0] = tag;
  return data;
}

async function codeOf(run: () => Promise<unknown>): Promise<PackageErrorCode | "no-error"> {
  try {
    await run();
    return "no-error";
  } catch (error) {
    return (error as { code?: PackageErrorCode }).code ?? ("otro" as never);
  }
}

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: "application/zip" });

describe("H1 — paquetes grandes: lo que la app exporta se puede volver a importar (cifrado o no)", () => {
  for (const total of [120, 126, 132, 140]) {
    for (const password of [undefined, "contrasena-larga-123"]) {
      it(`${total} MiB de PDF ${password ? "CIFRADO" : "sin cifrar"}: exporta, relee y todos los archivos salen \`ok\``, async () => {
        const files = [fakePdf((total / 2) * MiB, 1), fakePdf((total / 2) * MiB, 2)].map((data, index) => ({
          path: `documents/d${index}.pdf`,
          data,
          type: "application/pdf",
        }));
        const expected = await Promise.all(files.map((f) => sha256Hex(f.data)));
        const blob = await buildPackage({ registry: BIG, password, modules: [{ name: "demo", schemaVersion: 1, files }] });
        expect(blob.size).toBeLessThanOrEqual(PACKAGE_LIMITS.maxFileBytes);
        const read = await readPackage(blob, password, { registry: BIG });
        const got = [...read.modules[0].files.values()];
        expect(got.map((f) => f.status)).toEqual(["ok", "ok"]);
        expect(got.map((f) => f.sha256)).toEqual(expected);
        expect(read.encrypted).toBe(password !== undefined);
      }, 120_000);
    }
  }

  it("cerca del tope (240 MiB) y cifrado: sigue siendo importable", async () => {
    const files = [fakePdf(120 * MiB, 3), fakePdf(120 * MiB, 4)].map((data, index) => ({ path: `documents/d${index}.pdf`, data, type: "application/pdf" }));
    const blob = await buildPackage({ registry: BIG, password: "contrasena-larga-123", modules: [{ name: "demo", schemaVersion: 1, files }] });
    expect(blob.size).toBeLessThanOrEqual(PACKAGE_LIMITS.maxFileBytes);
    const read = await readPackage(blob, "contrasena-larga-123", { registry: BIG });
    expect([...read.modules[0].files.values()].map((f) => f.status)).toEqual(["ok", "ok"]);
  }, 180_000);
});

describe("H1 — el límite de exportación es el de importación (se avisa ANTES, nunca se genera un archivo que no se pueda abrir)", () => {
  it("archivos que suman el tope exacto pero con el manifiesto superan lo que se aceptaría al importar: buildPackage lanza `tooLarge`", async () => {
    // El tope de 250 MiB cuenta también `manifest.json`: con los archivos justo en el tope, el paquete no se podría leer.
    const data = new Uint8Array(PACKAGE_LIMITS.maxUncompressedBytes);
    const files = [{ path: "documents/d0.pdf", data, type: "application/pdf" }];
    expect(await codeOf(() => buildPackage({ registry: BIG, modules: [{ name: "demo", schemaVersion: 1, files }] }))).toBe("tooLarge");
    expect(await codeOf(() => buildPackage({ registry: BIG, password: "contrasena-larga-123", modules: [{ name: "demo", schemaVersion: 1, files }] }))).toBe("tooLarge");
  }, 120_000);

  it("el tope de bytes del archivo exportado también se respeta (el cifrado añade cabecera y etiqueta)", async () => {
    // Todo lo que sale de buildPackage cabe en `maxFileBytes`: si no, se lanza `tooLarge` en vez de entregar el archivo.
    const data = new Uint8Array(PACKAGE_LIMITS.maxUncompressedBytes - 4 * 1024);
    const files = [{ path: "documents/d0.pdf", data, type: "application/pdf" }];
    for (const password of [undefined, "contrasena-larga-123"]) {
      let blob: Blob | null = null;
      const code = await codeOf(async () => {
        blob = await buildPackage({ registry: BIG, password, modules: [{ name: "demo", schemaVersion: 1, files }] });
      });
      if (code === "no-error") {
        expect((blob as unknown as Blob).size).toBeLessThanOrEqual(PACKAGE_LIMITS.maxFileBytes);
        const read = await readPackage(blob as unknown as Blob, password, { registry: BIG });
        expect([...read.modules[0].files.values()][0].status).toBe("ok");
      } else {
        expect(code).toBe("tooLarge");
      }
    }
  }, 240_000);
});

describe("H1 — los topes de seguridad de la importación NO se aflojan", () => {
  const sealed = async (innerZip: Uint8Array, password = "pw") => {
    const box = await encryptWithPassword(innerZip, password, { kind: "optimuspdf.package-encrypted", version: 1 });
    return forgeZip([
      { name: "envelope.json", data: box.header, method: 0 },
      { name: "payload.bin", data: box.payload, method: 0 },
    ]);
  };
  const manifestOf = (files: { path: string; bytes: number }[]) =>
    json({
      format: "optimuspdf.package",
      formatVersion: 1,
      createdAt: "2026-10-15T00:00:00.000Z",
      app: { version: "t", build: "t" },
      modules: { demo: { schemaVersion: 1 } },
      files: files.map((f) => ({ path: f.path, sha256: "0".repeat(64), bytes: f.bytes, type: "application/octet-stream" })),
    });

  it("cifrado «legítimo» con zip-bomb por ratio dentro: bomb", async () => {
    const zeros = new Uint8Array(20 * MiB);
    const inner = forgeZip([{ name: "manifest.json", data: manifestOf([]) }, { name: "documents/a.bin", data: zeros }]);
    expect(await codeOf(async () => readPackage(blobOf(await sealed(inner)), "pw", { registry: BIG }))).toBe("bomb");
  });

  it("cifrado con un directorio que declara más de 250 MiB descomprimidos: tooLarge", async () => {
    const inner = forgeZip([
      { name: "manifest.json", data: manifestOf([]) },
      { name: "documents/a.bin", data: new Uint8Array(10), declaredUncompressed: 251 * MiB, declaredCompressed: 3 * MiB },
    ]);
    expect(await codeOf(async () => readPackage(blobOf(await sealed(inner)), "pw", { registry: BIG }))).toBe("tooLarge");
  });

  it("cifrado con entradas que MIENTEN (declaran 40 KB e inflan 40 MB cada una): el presupuesto de la capa interna las corta -> bomb", async () => {
    const real = new Uint8Array(40 * 1000 * 1000);
    const { deflateRawSync } = await import("node:zlib");
    const rawPayload = new Uint8Array(deflateRawSync(real));
    const names = Array.from({ length: 60 }, (_, i) => `documents/x${i}.bin`);
    const inner = forgeZip([
      { name: "manifest.json", data: manifestOf(names.map((path) => ({ path, bytes: 40_000 }))) },
      ...names.map((name) => ({ name, data: real, rawPayload, crc: 0, declaredUncompressed: 40_000, declaredCompressed: rawPayload.length })),
    ]);
    const started = performance.now();
    expect(await codeOf(async () => readPackage(blobOf(await sealed(inner)), "pw", { registry: BIG }))).toBe("bomb");
    expect(performance.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it("el presupuesto de la capa EXTERNA sigue acotado: un payload.bin que miente al inflar se corta", async () => {
    // payload.bin declarado 50 KB pero que infla 40 MB: la lectura de la capa externa se corta y se rechaza.
    const real = new Uint8Array(40 * 1000 * 1000);
    const outer = forgeZip([
      { name: "envelope.json", data: json({ version: 1 }), method: 0 },
      { name: "payload.bin", data: real, crc: 0, declaredUncompressed: 50_000 },
    ]);
    const code = await codeOf(() => readPackage(blobOf(outer), "pw", { registry: BIG }));
    expect(["bomb", "badZip"]).toContain(code);
  });

  it("el archivo de más de 250 MiB se rechaza sin leerlo, cifrado o no", async () => {
    const huge = { size: PACKAGE_LIMITS.maxFileBytes + 1, arrayBuffer: async () => { throw new Error("no se debe leer"); } } as unknown as Blob;
    expect(await codeOf(() => readPackage(huge, "pw"))).toBe("tooLarge");
  });

  it("zip exterior sano con el interior de 2 entradas JSZip normales: sigue leyendo (control)", async () => {
    const inner = new JSZip();
    inner.file("manifest.json", manifestOf([]));
    const bytes = await inner.generateAsync({ type: "uint8array" });
    const read = await readPackage(blobOf(await sealed(bytes)), "pw", { registry: BIG });
    expect(read.encrypted).toBe(true);
  });
});
