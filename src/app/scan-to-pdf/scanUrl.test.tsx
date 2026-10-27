import { describe, expect, it } from "vitest";
import { hasScanInUrl, hideScanFromUrl, isBaseEntry, isValidScanId, readScanFromSearch, showScanInUrl } from "@/app/scan-to-pdf/scanUrl";

describe("lectura de la direccion (entrada NO confiable)", () => {
  it("ids validos: minusculas, digitos y guiones", () => {
    for (const id of ["scan-m1abc-1x", "sc-lq3k9-1abc12", "0-9-0-9-0", "x".repeat(8), "x".repeat(64)]) expect(isValidScanId(id)).toBe(true);
  });

  it("rechaza todo lo demas: rutas, mayusculas, espacios, etiquetas, vacios, largos y no-texto", () => {
    for (const bad of ["", "a", "short-7", "-abcdefgh", "../../etc/passwd", "ABCDEFGHIJ", "a b c d e f", "<script>alert", "a/b/c/d/e/f", "a".repeat(65), "abcdefg.h", "áéíóúñáéíóúñ", "a;b;c;d;e;f", null, undefined, 3, {}]) {
      expect(isValidScanId(bad)).toBe(false);
    }
  });

  it("`?scan=` y `?resume=scan:` (Recientes) se leen igual", () => {
    expect(readScanFromSearch("?scan=scan-abc-1")).toEqual({ present: true, id: "scan-abc-1" });
    expect(readScanFromSearch("?resume=scan:scan-abc-1")).toEqual({ present: true, id: "scan-abc-1" });
    expect(readScanFromSearch("")).toEqual({ present: false, id: null });
    expect(readScanFromSearch("?otra=1")).toEqual({ present: false, id: null });
  });

  it("varios valores a la vez, o uno malo, no restauran nada pero SI estan presentes (hay que limpiarlos)", () => {
    expect(readScanFromSearch("?scan=aaaaaaaa&scan=bbbbbbbb")).toEqual({ present: true, id: null });
    expect(readScanFromSearch("?scan=aaaaaaaa&resume=scan:bbbbbbbb")).toEqual({ present: true, id: null });
    expect(readScanFromSearch("?scan=" + encodeURIComponent("../x"))).toEqual({ present: true, id: null });
    expect(readScanFromSearch("?resume=sign:abc")).toEqual({ present: false, id: null });
  });
});

describe("la sesion en el historial", () => {
  const start = () => window.history.replaceState(null, "", "/scan-to-pdf");

  it("showScanInUrl AÑADE una entrada (con la base detras) y es idempotente", () => {
    start();
    const before = window.history.length;
    expect(showScanInUrl("scan-0001")).toBe("pushed");
    expect(window.location.search).toBe("?scan=scan-0001");
    expect(window.history.length).toBe(before + 1);
    expect(showScanInUrl("scan-0001")).toBe("same");
    expect(window.history.length).toBe(before + 1);
    expect(hasScanInUrl()).toBe(true);
  });

  it("otra sesion reescribe la entrada, no apila otra", () => {
    start();
    showScanInUrl("scan-0001");
    const length = window.history.length;
    expect(showScanInUrl("scan-0002")).toBe("replaced");
    expect(window.location.search).toBe("?scan=scan-0002");
    expect(window.history.length).toBe(length);
  });

  it("llegar con `?scan=` pegado (recarga) crea la entrada base detras sin duplicar", () => {
    window.history.replaceState(null, "", "/scan-to-pdf?scan=scan-00009");
    const before = window.history.length;
    expect(showScanInUrl("scan-00009")).toBe("rebased");
    expect(window.history.length).toBe(before + 1);
    window.history.back();
  });

  it("hideScanFromUrl quita `scan` y `resume` sin tocar el resto ni añadir entradas; devuelve si habia algo", () => {
    window.history.replaceState(null, "", "/scan-to-pdf?x=1&scan=scan-00003&resume=scan:scan-00003#h");
    const length = window.history.length;
    expect(hideScanFromUrl()).toBe(true);
    expect(window.location.search).toBe("?x=1");
    expect(window.location.hash).toBe("#h");
    expect(window.history.length).toBe(length);
    expect(hideScanFromUrl()).toBe(false);
  });

  it("la entrada base se reconoce (para saltarla al terminar) y se conserva tras ocultar", () => {
    start();
    showScanInUrl("scan-0001");
    expect(isBaseEntry()).toBe(false);
    hideScanFromUrl();
    expect(showScanInUrl("scan-0001")).toBe("replaced");
  });
});
