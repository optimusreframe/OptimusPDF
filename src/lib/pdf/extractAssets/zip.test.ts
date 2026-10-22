import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { MAX_ZIP_ENTRIES, buildAssetsZip, sanitizeZipName } from "@/lib/pdf/extractAssets/zip";

/** ZIP de los elementos extraidos: nombres seguros y unicos, bytes intactos, topes y cancelacion. */

const png = (seed: number) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed, seed, seed])], { type: "image/png" });

async function open(blob: Blob) {
  return JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
}

describe("sanitizeZipName", () => {
  it("quita rutas, caracteres invalidos y puntos o espacios del borde", () => {
    expect(sanitizeZipName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeZipName("a\\b:c*d?e\"f<g>h|i.png")).toBe("a-b-c-d-e-f-g-h-i.png");
    expect(sanitizeZipName("  ..oculto.png  ")).toBe("oculto.png");
    expect(sanitizeZipName("nombre.")).toBe("nombre");
    expect(sanitizeZipName("con\u0000control\u001f.png")).toBe("con-control-.png");
  });
  it("un nombre vacio queda como «archivo»; un nombre normal no cambia", () => {
    expect(sanitizeZipName("")).toBe("archivo");
    expect(sanitizeZipName("///")).toBe("archivo");
    expect(sanitizeZipName("p03-firma-01.png")).toBe("p03-firma-01.png");
    expect(sanitizeZipName("p03-marca-de-agua-01.txt")).toBe("p03-marca-de-agua-01.txt");
  });
});

describe("buildAssetsZip", () => {
  it("empaqueta cada elemento con su nombre y sus bytes exactos", async () => {
    const { blob, names, bytes } = await buildAssetsZip([
      { name: "p03-firma-01.png", blob: png(1) },
      { name: "p01-marca-de-agua-01.txt", blob: new Blob(["CONFIDENCIAL"], { type: "text/plain" }) },
    ]);
    expect(blob.type).toBe("application/zip");
    expect(bytes).toBe(blob.size);
    expect(names).toEqual(["p03-firma-01.png", "p01-marca-de-agua-01.txt"]);
    const zip = await open(blob);
    expect(Object.keys(zip.files).sort()).toEqual(["p01-marca-de-agua-01.txt", "p03-firma-01.png"]);
    expect(Array.from(await zip.files["p03-firma-01.png"].async("uint8array"))).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 1, 1]);
    expect(await zip.files["p01-marca-de-agua-01.txt"].async("string")).toBe("CONFIDENCIAL");
  });

  it("desambigua nombres repetidos, tambien sin distinguir mayusculas ni forma Unicode (como Windows y macOS)", async () => {
    const { blob, names } = await buildAssetsZip([
      { name: "firma.png", blob: png(1) },
      { name: "FIRMA.png", blob: png(2) },
      { name: "firma.png", blob: png(3) },
      { name: "pérez.png", blob: png(4) },
      { name: "pérez.png", blob: png(5) },
    ]);
    expect(names).toEqual(["firma.png", "FIRMA (1).png", "firma (2).png", "pérez.png", "pérez (1).png"]);
    const zip = await open(blob);
    expect(Object.keys(zip.files)).toHaveLength(5);
    expect(Array.from(await zip.files["FIRMA (1).png"].async("uint8array")).at(-1)).toBe(2);
  });

  it("un nombre con ../ no sale de la raiz del ZIP", async () => {
    const { blob, names } = await buildAssetsZip([{ name: "../../evil.png", blob: png(1) }]);
    expect(names).toEqual(["evil.png"]);
    expect(Object.keys((await open(blob)).files)).toEqual(["evil.png"]);
  });

  it("comprime el texto y el SVG pero guarda PNG y JPG tal cual", async () => {
    const big = "A".repeat(5000);
    const { blob } = await buildAssetsZip([
      { name: "a.txt", blob: new Blob([big]) },
      { name: "b.svg", blob: new Blob([`<svg>${big}</svg>`]) },
      { name: "c.png", blob: new Blob([big]) },
      { name: "d.jpg", blob: new Blob([big]) },
    ]);
    const compressed = (await open(blob)).files as unknown as Record<string, { _data: { compressedSize: number; uncompressedSize: number } }>;
    expect(compressed["a.txt"]._data.compressedSize).toBeLessThan(200);
    expect(compressed["b.svg"]._data.compressedSize).toBeLessThan(200);
    expect(compressed["c.png"]._data.compressedSize).toBe(5000);
    expect(compressed["d.jpg"]._data.compressedSize).toBe(5000);
  });

  it("con la misma fecha produce los MISMOS bytes", async () => {
    const entries = [{ name: "a.png", blob: png(1) }, { name: "b.png", blob: png(2) }];
    const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 6));
    const one = await buildAssetsZip(entries, { date });
    const two = await buildAssetsZip(entries, { date });
    expect(Array.from(new Uint8Array(await one.blob.arrayBuffer()))).toEqual(Array.from(new Uint8Array(await two.blob.arrayBuffer())));
  });

  it("informa del progreso entrada a entrada", async () => {
    const seen: number[][] = [];
    await buildAssetsZip([{ name: "a.png", blob: png(1) }, { name: "b.png", blob: png(2) }, { name: "c.png", blob: png(3) }], { onProgress: (done, total) => seen.push([done, total]) });
    expect(seen).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it("sin entradas, con demasiadas o ya cancelado, falla con el codigo de siempre", async () => {
    await expect(buildAssetsZip([])).rejects.toMatchObject({ code: "empty" });
    const many = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => ({ name: `${index}.png`, blob: png(1) }));
    await expect(buildAssetsZip(many)).rejects.toMatchObject({ code: "tooLarge" });
    const controller = new AbortController();
    controller.abort();
    await expect(buildAssetsZip([{ name: "a.png", blob: png(1) }], { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("cancelar a mitad no genera el ZIP", async () => {
    const controller = new AbortController();
    const entries = [{ name: "a.png", blob: png(1) }, { name: "b.png", blob: png(2) }];
    await expect(
      buildAssetsZip(entries, { signal: controller.signal, onProgress: (done) => (done === 1 ? controller.abort() : undefined) }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
