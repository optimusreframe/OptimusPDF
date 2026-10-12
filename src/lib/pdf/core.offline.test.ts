import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfError, toPdfError } from "@/lib/pdf/core";
import { createInputGuard } from "@/lib/pdf/inputGuard";

/**
 * «Sin conexion» (Wave 7 · U8): un componente que no se pudo descargar es `offline`, NO «archivo danado»; los
 * mensajes de jszip de un zip roto (docx, xlsx) si son `corrupt`.
 */

function setOnline(value: boolean) {
  vi.stubGlobal("navigator", { onLine: value });
}

afterEach(() => vi.unstubAllGlobals());

describe("toPdfError: fallos de carga de un componente", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://x/_next/static/chunks/abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Loading chunk 123 failed.",
    "Loading CSS chunk 4 failed",
    "Setting up fake worker failed: Failed to fetch",
  ])("«%s» es offline aunque el navegador diga que hay red", (message) => {
    setOnline(true);
    expect(toPdfError(new Error(message)).code).toBe("offline");
  });

  it("ChunkLoadError por nombre", () => {
    const error = new Error("fallo");
    error.name = "ChunkLoadError";
    expect(toPdfError(error).code).toBe("offline");
  });

  it("«Failed to fetch» generico: offline solo si el navegador no tiene red", () => {
    setOnline(false);
    expect(toPdfError(new TypeError("Failed to fetch")).code).toBe("offline");
    expect(toPdfError(new TypeError("NetworkError when attempting to fetch resource.")).code).toBe("offline");
    setOnline(true);
    expect(toPdfError(new TypeError("Failed to fetch")).code).toBe("unknown");
  });

  it("un PdfError ya tipado se respeta", () => {
    setOnline(false);
    expect(toPdfError(new PdfError("corrupt")).code).toBe("corrupt");
  });

  it("conserva el mensaje original para el diagnostico", () => {
    setOnline(true);
    expect(toPdfError(new Error("Loading chunk 7 failed.")).message).toContain("chunk 7");
  });

  it("sin `navigator` (servidor) no revienta", () => {
    vi.stubGlobal("navigator", undefined);
    expect(toPdfError(new TypeError("Failed to fetch")).code).toBe("unknown");
  });
});

describe("toPdfError: zip roto de un .docx/.xlsx es `corrupt`", () => {
  it.each(["Corrupted zip or bug: unexpected signature", "Can't find end of central directory : is this a zip file ?", "not a zip file"])(
    "«%s»",
    (message) => {
      setOnline(true);
      expect(toPdfError(new Error(message)).code).toBe("corrupt");
    },
  );
});

describe("inputGuard: un componente sin descargar no se confunde con un PDF danado", () => {
  const pdf = () => new File([new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF")], "a.pdf", { type: "application/pdf" });

  it("si pdf.js no se pudo cargar, el codigo es `offline`", async () => {
    setOnline(false);
    const guard = createInputGuard({
      open: async () => {
        throw new TypeError("Failed to fetch dynamically imported module: /_next/static/chunks/pdfjs.js");
      },
    });
    expect(await guard(pdf())).toEqual({ status: "unsupported", code: "offline" });
  });

  it("un fallo de lectura de verdad sigue siendo `corrupt`", async () => {
    setOnline(true);
    const guard = createInputGuard({
      open: async () => {
        throw new Error("Invalid PDF structure.");
      },
    });
    expect(await guard(pdf())).toEqual({ status: "problem", code: "corrupt" });
  });
});
