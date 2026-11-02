import { describe, expect, it } from "vitest";
import { VideoError, classifyVideoError } from "@/lib/media/video/errors";

describe("classifyVideoError", () => {
  it("deja pasar un VideoError tal cual", () => {
    const original = new VideoError("noVideoTrack");
    expect(classifyVideoError(original)).toBe(original);
  });

  it("formato desconocido o archivo truncado = no se puede leer", () => {
    const unknown = Object.assign(new Error("Input has an unsupported or unrecognizable format."), { name: "UnsupportedInputFormatError" });
    expect(classifyVideoError(unknown).code).toBe("unreadable");
    expect(classifyVideoError(new Error("Unexpected end of file")).code).toBe("unreadable");
  });

  it("cancelar (AbortError o el error de la libreria) = cancelled, nunca un fallo", () => {
    expect(classifyVideoError(new DOMException("aborted", "AbortError")).code).toBe("cancelled");
    expect(classifyVideoError(Object.assign(new Error("Conversion has been canceled."), { name: "ConversionCanceledError" })).code).toBe("cancelled");
  });

  it("sin memoria", () => {
    expect(classifyVideoError(new RangeError("Array buffer allocation failed")).code).toBe("outOfMemory");
    expect(classifyVideoError(new RangeError("Invalid typed array length: 4294967296")).code).toBe("outOfMemory");
  });

  it("el codificador rechaza la configuracion", () => {
    expect(classifyVideoError(new DOMException("Encoder configure failed", "NotSupportedError")).code).toBe("cannotEncode");
  });

  it("lo que no reconoce es un fallo generico, y nunca lanza", () => {
    expect(classifyVideoError(new Error("algo raro")).code).toBe("failed");
    expect(classifyVideoError(undefined).code).toBe("failed");
    expect(classifyVideoError("texto").code).toBe("failed");
  });
});
