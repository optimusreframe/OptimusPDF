import { describe, expect, it } from "vitest";
import { downloadFileName, ensurePdfName, savePrompt } from "@/app/pdf-pro/save/proSave";
import type { ProSnapshot } from "@/app/pdf-pro/proTypes";

const snapshots = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `s${i}` }) as ProSnapshot);

describe("ensurePdfName", () => {
  it("añade .pdf si falta y respeta el que hay (sin distinguir mayusculas)", () => {
    expect(ensurePdfName("Contrato")).toBe("Contrato.pdf");
    expect(ensurePdfName("Contrato.pdf")).toBe("Contrato.pdf");
    expect(ensurePdfName("Contrato.PDF")).toBe("Contrato.pdf");
  });

  it("quita rutas y caracteres prohibidos", () => {
    expect(ensurePdfName("a/b\\c:d*e?f\"g<h>i|j")).toBe("a b c d e f g h i j.pdf");
  });

  it("recorta espacios y puntos iniciales", () => {
    expect(ensurePdfName("   informe   final  ")).toBe("informe final.pdf");
    expect(ensurePdfName("..oculto")).toBe("oculto.pdf");
  });

  it("un nombre vacio (o solo caracteres prohibidos) devuelve cadena vacia", () => {
    expect(ensurePdfName("")).toBe("");
    expect(ensurePdfName("   ")).toBe("");
    expect(ensurePdfName("///")).toBe("");
    expect(ensurePdfName(".pdf")).toBe("");
  });

  it("conserva acentos, enes y emoji", () => {
    expect(ensurePdfName("Año nuevo ñandú")).toBe("Año nuevo ñandú.pdf");
  });

  it("un nombre con varios puntos solo pierde el .pdf final", () => {
    expect(ensurePdfName("v1.2.final.pdf")).toBe("v1.2.final.pdf");
  });
});

describe("downloadFileName", () => {
  it("sin cambios ni historial conserva el nombre original", () => {
    expect(downloadFileName({ name: "informe.pdf", snapshots: snapshots(1) }, false)).toBe("informe.pdf");
  });

  it("con cambios sin guardar añade -pro", () => {
    expect(downloadFileName({ name: "informe.pdf", snapshots: snapshots(1) }, true)).toBe("informe-pro.pdf");
  });

  it("con historial (aunque se haya vuelto al original) tambien añade -pro", () => {
    expect(downloadFileName({ name: "informe.pdf", snapshots: snapshots(3) }, false)).toBe("informe-pro.pdf");
  });

  it("un nombre elegido en «Guardar como…» se respeta tal cual, con cambios o sin ellos", () => {
    expect(downloadFileName({ name: "Final.pdf", renamed: true, snapshots: snapshots(4) }, true)).toBe("Final.pdf");
    expect(downloadFileName({ name: "Final", renamed: true, snapshots: snapshots(1) }, false)).toBe("Final.pdf");
  });

  it("un nombre renombrado raro cae al nombre del documento", () => {
    expect(downloadFileName({ name: "///", renamed: true, snapshots: snapshots(1) }, false)).toBe("///");
  });

  it("el sufijo -pro respeta nombres sin extension", () => {
    expect(downloadFileName({ name: "informe", snapshots: snapshots(2) }, true)).toBe("informe-pro.pdf");
  });
});

describe("savePrompt", () => {
  it("sin firmas y sin cifrado no hay nada que confirmar", () => {
    expect(savePrompt({ signatures: "none", wasEncrypted: false }, true, false)).toBeNull();
  });

  it("firmas activas CON cambios: avisa antes de descargar", () => {
    expect(savePrompt({ signatures: "active", wasEncrypted: false }, true, false)).toEqual({ signatures: true, decrypted: false });
  });

  it("firmas activas SIN cambios: descargar el original intacto no las invalida", () => {
    expect(savePrompt({ signatures: "active", wasEncrypted: false }, false, false)).toBeNull();
  });

  it("firmas desconocidas no bloquean (solo el aviso del banner)", () => {
    expect(savePrompt({ signatures: "unknown", wasEncrypted: false }, true, false)).toBeNull();
  });

  it("copia descifrada: avisa la primera vez", () => {
    expect(savePrompt({ signatures: "none", wasEncrypted: true }, false, false)).toEqual({ signatures: false, decrypted: true });
  });

  it("copia descifrada ya avisada: no se repite", () => {
    expect(savePrompt({ signatures: "none", wasEncrypted: true }, true, true)).toBeNull();
  });

  it("firmas y copia descifrada a la vez: un solo aviso con las dos cosas", () => {
    expect(savePrompt({ signatures: "active", wasEncrypted: true }, true, false)).toEqual({ signatures: true, decrypted: true });
  });

  it("las firmas avisan aunque la copia descifrada ya se hubiera confirmado", () => {
    expect(savePrompt({ signatures: "active", wasEncrypted: true }, true, true)).toEqual({ signatures: true, decrypted: false });
  });
});
