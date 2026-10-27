import { describe, expect, it } from "vitest";
import { buildNameSuggestion, credibleDocumentDate, fallbackName, findDates, isoDate, pickTitle, sanitizeFileName, tidyTitle } from "@/lib/scan/naming";
import type { OcrLine, OcrResult } from "@/lib/scan/ocr";

function line(text: string, y0: number, height: number, confidence = 90): OcrLine {
  let x = 10;
  const words = text.split(" ").map((w) => {
    const word = { text: w, confidence, bbox: { x0: x, y0, x1: x + w.length * height * 0.55, y1: y0 + height } };
    x += w.length * height * 0.55 + height * 0.3;
    return word;
  });
  return { text, confidence, bbox: { x0: 10, y0, x1: x, y1: y0 + height }, words };
}
const ocr = (lines: OcrLine[], height = 1000): OcrResult => ({ text: lines.map((l) => l.text).join("\n"), lines, width: 700, height });
const NOW = new Date(2026, 9, 26, 14, 32);

describe("nombre sugerido — src/lib/scan/naming.ts", () => {
  it("el titulo es la linea mas GRANDE del encabezado, no la primera ni la mas larga", () => {
    const result = ocr([line("AJUSTADORES DEL NORTE S.A.", 30, 22), line("Contrato de servicio", 90, 44), line("Fecha 12 de marzo de 2026", 170, 21), line("Texto del cuerpo del documento que sigue y sigue", 220, 21)]);
    expect(pickTitle(result)).toBe("Contrato de servicio");
  });

  it("a igual tamano gana la mas alta; una linea del pie (fuera del 45 % superior) no cuenta", () => {
    expect(pickTitle(ocr([line("Primera linea grande", 40, 30), line("Segunda linea grande", 100, 30)]))).toBe("Primera linea grande");
    expect(pickTitle(ocr([line("Cuerpo pequeno del texto", 40, 18), line("PIE ENORME DE PAGINA", 800, 60)]))).toBe("Cuerpo pequeno del texto");
    expect(pickTitle(ocr([line("Texto abajo del todo en grande", 700, 50)]))).toBeNull();
  });

  it("descarta lo que no puede ser titulo: numeros sueltos, lecturas dudosas, «Fecha: ...», lineas cortisimas", () => {
    const result = ocr([line("2026-0412 0044 7781", 20, 50), line("xq", 90, 60), line("Fecha: 12/03/2026", 140, 40), line("Titulo dudoso", 200, 80, 30), line("Informe de siniestro", 300, 36)]);
    expect(pickTitle(result)).toBe("Informe de siniestro");
    expect(pickTitle(ocr([]))).toBeNull();
  });

  it("tidyTitle: pasa MAYUSCULAS a frase, quita signos de los bordes, acorta en una palabra entera y respeta lo normal", () => {
    expect(tidyTitle("CONTRATO DE SERVICIO")).toBe("Contrato de servicio");
    expect(tidyTitle("  «Acta de inspección»: ")).toBe("Acta de inspección");
    expect(tidyTitle("Factura 2026-0412")).toBe("Factura 2026-0412");
    expect(tidyTitle("Service Agreement")).toBe("Service Agreement");
    const long = tidyTitle("Contrato de prestacion de servicios profesionales entre las partes abajo firmantes y otro mas");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith(" ")).toBe(false);
    expect(long.split(" ").every((w) => w.length > 0)).toBe(true);
  });

  it("sanitizeFileName quita lo que no vale en un archivo, acota a 80 y evita nombres reservados", () => {
    expect(sanitizeFileName('Informe: "Fase 1" / <final>?*|')).toBe("Informe Fase 1 final");
    expect(sanitizeFileName("  ..oculto  ")).toBe("oculto");
    expect(sanitizeFileName("CON")).toBe("CON_");
    expect(sanitizeFileName("a".repeat(200)).length).toBeLessThanOrEqual(80);
    expect(sanitizeFileName("palabra ".repeat(30)).endsWith(" ")).toBe(false);
    expect(sanitizeFileName("con\u0000control\u001f")).toBe("con control");
    expect(sanitizeFileName("///")).toBe("");
  });

  it("fechas: ISO, DD/MM/AAAA, «12 de marzo de 2026», «March 12, 2026»; las imposibles se descartan", () => {
    const iso = (text: string) => findDates(text).map((d) => isoDate(d.date));
    expect(iso("Emitido 2026-03-12.")).toEqual(["2026-03-12"]);
    expect(iso("Fecha 12/03/2026 y 1-2-2025")).toEqual(["2026-03-12", "2025-02-01"]);
    expect(iso("el 12 de marzo de 2026 y el 3 de septiembre del 2025")).toEqual(["2026-03-12", "2025-09-03"]);
    expect(iso("12 de setiembre de 2026")).toEqual(["2026-09-12"]);
    expect(iso("12 de diciembre de 2026")).toEqual(["2026-12-12"]);
    expect(iso("March 12, 2026")).toEqual(["2026-03-12"]);
    expect(iso("31/02/2026 y 2026-13-01 y 12/03/1850")).toEqual([]);
  });

  it("la fecha del documento solo vale si es creible: no futura y de los ultimos 2 anos; manda la que sigue a «Fecha»", () => {
    expect(isoDate(credibleDocumentDate("Fecha: 12 de marzo de 2026", NOW) as Date)).toBe("2026-03-12");
    expect(credibleDocumentDate("Fecha: 12 de marzo de 2020", NOW)).toBeNull();
    expect(credibleDocumentDate("Fecha: 12 de marzo de 2027", NOW)).toBeNull();
    expect(isoDate(credibleDocumentDate("Vence 01/04/2026. Fecha: 12/03/2026", NOW) as Date)).toBe("2026-03-12");
    expect(credibleDocumentDate("sin fechas", NOW)).toBeNull();
    // El dia siguiente se tolera (zonas horarias); dos dias despues no.
    expect(credibleDocumentDate("2026-10-27", NOW)).not.toBeNull();
    expect(credibleDocumentDate("2026-10-28", NOW)).toBeNull();
  });

  it("buildNameSuggestion: «Titulo · fecha» con OCR; sin titulo, «Escaneo AAAA-MM-DD HH.mm»; en ingles «Scan ...»", () => {
    const withTitle = buildNameSuggestion(ocr([line("CONTRATO DE SERVICIO", 60, 44), line("Fecha: 12 de marzo de 2026", 140, 21)]), "es", NOW);
    expect(withTitle).toMatchObject({ title: "Contrato de servicio", date: "2026-03-12", source: "ocr", name: "Contrato de servicio · 2026-03-12" });
    const dated = buildNameSuggestion(ocr([line("Informe de siniestro", 60, 44)]), "es", NOW);
    expect(dated.name).toBe("Informe de siniestro · 2026-10-26");
    const none = buildNameSuggestion(null, "es", NOW);
    expect(none).toMatchObject({ title: null, date: "2026-10-26", source: "date", name: "Escaneo 2026-10-26 14.32" });
    expect(buildNameSuggestion(ocr([]), "en", NOW).name).toBe("Scan 2026-10-26 14.32");
    expect(fallbackName(new Date(2026, 0, 5, 9, 7), "es")).toBe("Escaneo 2026-01-05 09.07");
  });

  it("un titulo con caracteres prohibidos sale saneado en el nombre", () => {
    const suggestion = buildNameSuggestion(ocr([line("Anexo A/B: Condiciones", 60, 44)]), "es", NOW);
    expect(suggestion.title).toBe("Anexo A/B: Condiciones");
    expect(suggestion.name).toBe("Anexo A B Condiciones · 2026-10-26");
  });
});
