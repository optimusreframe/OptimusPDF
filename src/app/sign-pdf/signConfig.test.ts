import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  exportSignConfig,
  importSignConfig,
  isSignConfigManifest,
  signConfigFilename,
  type SignConfigManifest,
} from "@/app/sign-pdf/signConfig";

const MINIMAL_PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>",
);

function pdfFile(name = "contrato.pdf"): File {
  return new File([MINIMAL_PDF_BYTES], name, { type: "application/pdf" });
}

const MANIFEST: Omit<SignConfigManifest, "version"> = {
  mode: "multi",
  signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
  fields: [
    {
      id: "fld-1",
      signerId: "sg-1",
      pageIndex: 0,
      type: "signature",
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
    },
  ],
  textFields: [
    {
      id: "txt-1",
      pageIndex: 0,
      rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "manual",
      confidence: "high",
    },
  ],
  textValues: { "txt-1": "Ana Perez" },
};

describe("exportSignConfig / importSignConfig — src/app/sign-pdf/signConfig.ts", () => {
  it("ida y vuelta conserva el manifiesto y los bytes del PDF", async () => {
    const original = pdfFile();
    const zip = await exportSignConfig(original, MANIFEST);
    const zipFile = new File([zip], "config.zip", {
      type: "application/zip",
    });

    const { file, manifest } = await importSignConfig(zipFile);

    expect(manifest).toEqual({ ...MANIFEST, version: 1 });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      MINIMAL_PDF_BYTES,
    );
  });

  it("rechaza un zip sin manifest.json", async () => {
    const zip = new JSZip();
    zip.file("documento.pdf", MINIMAL_PDF_BYTES);
    const blob = await zip.generateAsync({ type: "blob" });
    const zipFile = new File([blob], "config.zip");

    await expect(importSignConfig(zipFile)).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("rechaza una version de manifiesto desconocida", async () => {
    const zip = new JSZip();
    zip.file("documento.pdf", MINIMAL_PDF_BYTES);
    zip.file(
      "manifest.json",
      JSON.stringify({ ...MANIFEST, version: 99 }),
    );
    const blob = await zip.generateAsync({ type: "blob" });
    const zipFile = new File([blob], "config.zip");

    await expect(importSignConfig(zipFile)).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("rechaza un archivo que no es un zip valido", async () => {
    const notAZip = new File([new Uint8Array([1, 2, 3])], "config.zip");
    await expect(importSignConfig(notAZip)).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("rechaza si el PDF embebido no tiene la cabecera real de un PDF", async () => {
    const zip = new JSZip();
    zip.file("documento.pdf", new TextEncoder().encode("no soy un pdf"));
    zip.file("manifest.json", JSON.stringify({ ...MANIFEST, version: 1 }));
    const blob = await zip.generateAsync({ type: "blob" });
    const zipFile = new File([blob], "config.zip");

    await expect(importSignConfig(zipFile)).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("signConfigFilename sugiere .zip a partir del nombre original", () => {
    expect(signConfigFilename("contrato.pdf")).toBe("contrato-config.zip");
  });
});

describe("isSignConfigManifest — src/app/sign-pdf/signConfig.ts", () => {
  it("acepta un manifiesto valido", () => {
    expect(isSignConfigManifest({ ...MANIFEST, version: 1 })).toBe(true);
  });

  it("rechaza un rect fuera de rango", () => {
    const bad = {
      ...MANIFEST,
      version: 1,
      fields: [
        {
          ...MANIFEST.fields[0],
          rect: { x: 2, y: 0, width: 0.1, height: 0.1 },
        },
      ],
    };
    expect(isSignConfigManifest(bad)).toBe(false);
  });

  it("rechaza un pageIndex negativo", () => {
    const bad = {
      ...MANIFEST,
      version: 1,
      fields: [{ ...MANIFEST.fields[0], pageIndex: -1 }],
    };
    expect(isSignConfigManifest(bad)).toBe(false);
  });

  it("rechaza un tipo de campo de firma desconocido", () => {
    const bad = {
      ...MANIFEST,
      version: 1,
      fields: [{ ...MANIFEST.fields[0], type: "stamp" }],
    };
    expect(isSignConfigManifest(bad)).toBe(false);
  });

  it("rechaza textValues con un valor que no es string", () => {
    const bad = {
      ...MANIFEST,
      version: 1,
      textValues: { "txt-1": 123 },
    };
    expect(isSignConfigManifest(bad)).toBe(false);
  });
});
