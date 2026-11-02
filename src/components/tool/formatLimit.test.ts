import { describe, expect, it } from "vitest";
import { formatLimit } from "./formatLimit";

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("formatLimit", () => {
  it("un tope es un numero redondo: sin «,0» ni «.0»", () => {
    expect(formatLimit(64 * MB, "es-ES")).toBe("64 MB");
    expect(formatLimit(32 * MB, "en-US")).toBe("32 MB");
    expect(formatLimit(100 * MB, "es-ES")).toBe("100 MB");
    expect(formatLimit(4 * GB, "es-ES")).toBe("4 GB");
    expect(formatLimit(1 * GB, "en-US")).toBe("1 GB");
  });

  it("conserva un decimal cuando lo hay y usa la coma o el punto del idioma", () => {
    expect(formatLimit(1.5 * GB, "es-ES")).toBe("1,5 GB");
    expect(formatLimit(1.5 * GB, "en-US")).toBe("1.5 GB");
  });

  it("el numero y la unidad van unidos por un espacio duro (no se parten en dos lineas)", () => {
    expect(formatLimit(500 * MB)).toContain(" ");
    expect(formatLimit(500 * MB)).not.toContain(" ");
  });

  it("entradas inutiles no revientan", () => {
    expect(formatLimit(0)).toBe("0 KB");
    expect(formatLimit(Number.NaN)).toBe("0 KB");
  });
});
