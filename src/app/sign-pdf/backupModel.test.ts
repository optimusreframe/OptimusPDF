import { describe, expect, it } from "vitest";
import { decisionOptions, describeApplyFailure, exportErrorKey } from "@/app/sign-pdf/backupModel";

describe("decisionOptions", () => {
  it("nuevo: importar u omitir; distinto: reemplazar, conservar ambos u omitir", () => {
    expect(decisionOptions("new")).toEqual(["import", "omit"]);
    expect(decisionOptions("different")).toEqual(["replace", "keepBoth", "omit"]);
  });
  it("idéntico e invalido no ofrecen nada (se omiten)", () => {
    expect(decisionOptions("identical")).toEqual([]);
    expect(decisionOptions("invalid")).toEqual([]);
  });
});

describe("describeApplyFailure / exportErrorKey", () => {
  it("cada fallo al aplicar tiene su mensaje; blocked cuenta como invalido", () => {
    expect(describeApplyFailure("limit")).toBe("limit");
    expect(describeApplyFailure("unavailable")).toBe("unavailable");
    expect(describeApplyFailure("invalid")).toBe("invalid");
    expect(describeApplyFailure("blocked")).toBe("invalid");
  });
  it("cada fallo al exportar tiene su mensaje", () => {
    expect(exportErrorKey("empty")).toBe("exportEmpty");
    expect(exportErrorKey("encryptionUnavailable")).toBe("encryptionUnavailable");
    expect(exportErrorKey("unavailable")).toBe("exportUnavailable");
    expect(exportErrorKey("tooLarge")).toBe("exportTooLarge");
    expect(exportErrorKey("failed")).toBe("exportFailed");
  });
});
