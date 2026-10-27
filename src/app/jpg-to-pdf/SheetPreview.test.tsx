import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SheetPreview, PREVIEW_SHEETS } from "@/app/jpg-to-pdf/SheetPreview";
import { STRINGS } from "@/app/jpg-to-pdf/strings";
import { readImageHeader } from "@/lib/image/prepareForPdf";
import type { ImageProbe } from "@/lib/image/estimatePdfSize";
import { layoutPhotoGrid } from "@/lib/pdf/photoGrid";
import { MARGINS, pageSizeInPoints } from "@/lib/pdf/imagesToPdf";

/**
 * Vista previa de hojas ANTES de generar. Lo que se dibuja ha de ser lo que saldra: misma composicion (`layoutPhotoGrid`),
 * con el eje Y de PDF (origen abajo) pasado al de pantalla (origen arriba): la foto 1 va ARRIBA, no abajo.
 */

function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
}
const probeOf = (width: number, height: number): ImageProbe => ({ size: 1_000_000, header: readImageHeader(jpegHeader(width, height)) });

const s = STRINGS.es;

function renderSheets(overrides: Partial<Parameters<typeof SheetPreview>[0]> = {}) {
  const count = overrides.count ?? 4;
  return render(
    <SheetPreview
      count={count}
      probes={Array.from({ length: count }, () => probeOf(4000, 3000))}
      thumbnails={Array.from({ length: count }, (_, index) => `blob:thumb-${index}`)}
      perPage={4}
      pageSize="a4"
      orientation="auto"
      margin="none"
      strings={s}
      {...overrides}
    />,
  );
}

const pct = (value: string): number => Number.parseFloat(value);

describe("SheetPreview", () => {
  it("no pinta nada con una foto por hoja ni sin fotos", () => {
    expect(renderSheets({ perPage: 1 }).container.firstChild).toBeNull();
    expect(renderSheets({ count: 0, probes: [], thumbnails: [] }).container.firstChild).toBeNull();
  });

  it("la foto 1 va ARRIBA y la ultima abajo: el eje Y de PDF (origen abajo) se invierte al de pantalla", () => {
    const { container } = renderSheets({ count: 4, perPage: 4 });
    const photo = (index: number) => container.querySelector<HTMLElement>(`[data-sheet-photo="${index}"]`) as HTMLElement;
    const top = (index: number) => pct(photo(index).style.top);
    // 2 columnas x 2 filas: fotos 0 y 1 en la fila de arriba, 2 y 3 en la de abajo.
    expect(top(0)).toBeLessThan(top(2));
    expect(top(1)).toBeLessThan(top(3));
    expect(top(0)).toBeCloseTo(top(1), 5);
    expect(pct(photo(0).style.left)).toBeLessThan(pct(photo(1).style.left));
    // Coincide con la composicion real del motor.
    const [sheet] = layoutPhotoGrid(
      Array.from({ length: 4 }, () => ({ width: 4000, height: 3000 })),
      { perPage: 4, pageSize: pageSizeInPoints("a4"), orientation: "auto", margin: MARGINS.none },
    );
    sheet.photos.forEach((placed) => {
      const expectedTop = ((sheet.pageHeight - placed.rect.y - placed.rect.height) / sheet.pageHeight) * 100;
      expect(pct(photo(placed.index).style.top)).toBeCloseTo(expectedTop, 3);
      expect(pct(photo(placed.index).style.left)).toBeCloseTo((placed.rect.x / sheet.pageWidth) * 100, 3);
      expect(pct(photo(placed.index).style.width)).toBeCloseTo((placed.rect.width / sheet.pageWidth) * 100, 3);
      expect(pct(photo(placed.index).style.height)).toBeCloseTo((placed.rect.height / sheet.pageHeight) * 100, 3);
    });
  });

  it("2 por hoja: una arriba y otra abajo", () => {
    const { container } = renderSheets({ count: 2, perPage: 2 });
    const first = container.querySelector<HTMLElement>('[data-sheet-photo="0"]') as HTMLElement;
    const second = container.querySelector<HTMLElement>('[data-sheet-photo="1"]') as HTMLElement;
    expect(pct(first.style.top)).toBeLessThan(pct(second.style.top));
    expect(pct(first.style.left)).toBeCloseTo(pct(second.style.left), 3);
  });

  it("la hoja tiene la proporcion de la pagina (A4 vertical, y horizontal con orientacion horizontal)", () => {
    const portrait = renderSheets({ count: 4 }).container.querySelector<HTMLElement>("[data-sheet]") as HTMLElement;
    expect(portrait.style.aspectRatio.replace(/\s/g, "")).toBe(`${pageSizeInPoints("a4").width}/${pageSizeInPoints("a4").height}`);
    const landscape = renderSheets({ count: 4, orientation: "landscape" }).container.querySelector<HTMLElement>("[data-sheet]") as HTMLElement;
    expect(landscape.style.aspectRatio.replace(/\s/g, "")).toBe(`${pageSizeInPoints("a4").height}/${pageSizeInPoints("a4").width}`);
  });

  it("describe cada hoja en texto y cuenta las hojas", () => {
    const { container } = renderSheets({ count: 4, perPage: 4 });
    expect(container.textContent).toContain("Hoja 1: fotos 1 a 4, 2 columnas × 2 filas");
    expect(container.querySelector("[data-sheet-total]")?.textContent).toBe("1 hoja en total");
  });

  it("solo dibuja las primeras hojas y dice cuantas hay en total", () => {
    const { container } = renderSheets({ count: 30, perPage: 4 });
    expect(container.querySelectorAll("[data-sheet]")).toHaveLength(PREVIEW_SHEETS);
    expect(container.querySelector("[data-sheet-total]")?.textContent).toBe(`8 hojas en total Se muestran las primeras ${PREVIEW_SHEETS}.`);
  });

  it("usa las miniaturas ya hechas y deja el hueco si aun no estan", () => {
    const { container } = renderSheets({ count: 4, thumbnails: ["blob:a", undefined, null, "blob:d"] });
    const sources = Array.from(container.querySelectorAll("img")).map((image) => image.getAttribute("src"));
    expect(sources).toEqual(["blob:a", "blob:d"]);
    expect(container.querySelectorAll("[data-sheet-photo]")).toHaveLength(4);
  });

  it("sin cabeceras leidas supone 4:3 y dibuja igual", () => {
    const { container } = renderSheets({ count: 2, perPage: 2, probes: null });
    expect(container.querySelectorAll("[data-sheet-photo]")).toHaveLength(2);
  });

  it("una foto vertical y una horizontal conservan su proporcion en la celda", () => {
    const { container } = renderSheets({ count: 2, perPage: 4, probes: [probeOf(3000, 4000), probeOf(4000, 3000)] });
    const page = pageSizeInPoints("a4");
    const rect = (index: number) => {
      const element = container.querySelector<HTMLElement>(`[data-sheet-photo="${index}"]`) as HTMLElement;
      return { w: (pct(element.style.width) / 100) * page.width, h: (pct(element.style.height) / 100) * page.height };
    };
    expect(rect(0).w / rect(0).h).toBeCloseTo(3 / 4, 2);
    expect(rect(1).w / rect(1).h).toBeCloseTo(4 / 3, 2);
  });
});
