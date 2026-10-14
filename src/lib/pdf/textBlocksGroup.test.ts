import { describe, expect, it } from "vitest";
import type { SourceFontInfo } from "@/lib/pdf/editTypes";
import {
  blocksInReadingOrder,
  collapseLetterSpacing,
  computeOrigHash,
  fnv1a,
  groupTextItems,
  normalizeRotation,
  unreadableRatio,
  type RawTextItem,
} from "@/lib/pdf/textBlocksGroup";

/**
 * Pruebas PURAS del agrupado: se construyen los fragmentos de pdf.js a
 * mano (sin pdf.js) para controlar la geometria al detalle. Las pruebas con
 * PDFs reales estan en `textBlocks.test.ts`.
 */

const FONT: SourceFontInfo = {
  pdfName: "Helvetica",
  family: "sans",
  bold: false,
  italic: false,
  subset: false,
  embedded: false,
  symbolic: false,
  type3: false,
};

/** Ancho aproximado de un texto de `str.length` caracteres a `size`. */
const w = (str: string, size: number) => str.length * size * 0.5;

function item(partial: Partial<RawTextItem> & { str: string }): RawTextItem {
  const size = partial.fontSize ?? 12;
  return {
    x: 72,
    y: 700,
    rotation: 0,
    width: w(partial.str, size),
    fontSize: size,
    ascent: 0.8,
    descent: -0.2,
    color: "#000000",
    font: FONT,
    invisible: false,
    vertical: false,
    ...partial,
  };
}

/** Un parrafo de lineas alineadas a la izquierda con interlineado 1.2. */
function paragraphItems(
  lines: string[],
  opts: { x?: number; top?: number; size?: number; leading?: number } = {},
): RawTextItem[] {
  const size = opts.size ?? 12;
  const leading = (opts.leading ?? 1.2) * size;
  return lines.map((str, i) =>
    item({
      str,
      x: opts.x ?? 72,
      y: (opts.top ?? 700) - i * leading,
      fontSize: size,
    }),
  );
}

const group = (items: RawTextItem[], pageBox = undefined as undefined | { x: number; y: number; width: number; height: number }) =>
  groupTextItems(items, { pageIndex: 0, pageBox });

describe("utilidades numericas", () => {
  it("fnv1a es determinista y de 8 caracteres hexadecimales", () => {
    expect(fnv1a("hola")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("hola")).toBe(fnv1a("hola"));
    expect(fnv1a("hola")).not.toBe(fnv1a("hole"));
  });

  it("computeOrigHash depende del texto y de la caja", () => {
    const box = { x: 10, y: 20, width: 30, height: 12 };
    const a = computeOrigHash("Texto", box);
    expect(computeOrigHash("Texto", box)).toBe(a);
    expect(computeOrigHash("Texto2", box)).not.toBe(a);
    expect(computeOrigHash("Texto", { ...box, x: 11 })).not.toBe(a);
    // Una variacion por debajo de 0.05 pt no cambia la huella.
    expect(computeOrigHash("Texto", { ...box, x: 10.01 })).toBe(a);
  });

  it("normalizeRotation ajusta a multiplos de 90 y conserva angulos libres", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(89.8)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(180.2)).toBe(180);
    expect(normalizeRotation(30.04)).toBe(30.04);
    expect(normalizeRotation(-30)).toBe(330);
    expect(normalizeRotation(360)).toBe(0);
  });

  it("collapseLetterSpacing recompone el texto con espaciado entre letras", () => {
    expect(collapseLetterSpacing("S p a c e d")).toBe("Spaced");
    expect(collapseLetterSpacing("H e l l o  W o r l d")).toBe("Hello World");
    // Texto normal: no se toca.
    expect(collapseLetterSpacing("Hola mundo")).toBe("Hola mundo");
    expect(collapseLetterSpacing("a b c")).toBe("a b c");
    expect(collapseLetterSpacing("I am a b c d e")).toBe("I am a b c d e");
  });

  it("unreadableRatio mide control, PUA y U+FFFD", () => {
    expect(unreadableRatio("Hola mundo")).toBe(0);
    expect(unreadableRatio("\u0001\u0002\u0003\u0004")).toBe(1);
    expect(unreadableRatio("ab�")).toBe(0.5);
    expect(unreadableRatio("   ")).toBe(0);
  });
});

describe("lineas y tramos", () => {
  it("una linea de varios fragmentos con huecos normales es un bloque", () => {
    const { visible } = group([
      item({ str: "Hello", x: 72, width: 30 }),
      item({ str: "World", x: 72 + 30 + 3.5, width: 30 }),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0].text).toBe("Hello World");
    expect(visible[0].box.x).toBeCloseTo(72, 3);
    expect(visible[0].box.width).toBeCloseTo(63.5, 3);
  });

  it("no inserta un espacio extra cuando un fragmento ya lo trae", () => {
    const { visible } = group([
      item({ str: "Hello ", x: 72, width: 33 }),
      item({ str: "World", x: 105, width: 30 }),
    ]);
    expect(visible[0].text).toBe("Hello World");
  });

  it("junta fragmentos pegados sin espacio (kerning partido)", () => {
    const { visible } = group([
      item({ str: "Wor", x: 72, width: 20 }),
      item({ str: "ld", x: 92.2, width: 10 }),
    ]);
    expect(visible[0].text).toBe("World");
  });

  it("parte la linea cuando el hueco es grande (columnas)", () => {
    const { visible } = group([
      item({ str: "Columna uno", x: 72, width: 66 }),
      item({ str: "Columna dos", x: 300, width: 66 }),
    ]);
    expect(visible).toHaveLength(2);
    expect(visible.map((b) => b.text)).toEqual(["Columna uno", "Columna dos"]);
  });

  it("el hueco justo por debajo del umbral NO parte la linea", () => {
    const { visible } = group([
      item({ str: "Uno", x: 72, width: 18 }),
      item({ str: "dos", x: 72 + 18 + 0.65 * 12, width: 18 }),
    ]);
    expect(visible).toHaveLength(1);
  });

  it("ignora fragmentos vacios y solo espacios", () => {
    const { visible } = group([
      item({ str: "", x: 72 }),
      item({ str: "   ", x: 100 }),
      item({ str: "Real", x: 72, width: 24 }),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0].text).toBe("Real");
  });

  it("descarta duplicados exactos (negrita falsa)", () => {
    const { visible } = group([
      item({ str: "Titulo", x: 72, width: 36 }),
      item({ str: "Titulo", x: 72.2, width: 36 }),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0].text).toBe("Titulo");
  });

  it("recompone texto con espaciado entre caracteres", () => {
    const { visible } = group([item({ str: "S p a c e d", x: 72, width: 60 })]);
    expect(visible[0].text).toBe("Spaced");
  });

  it("no mezcla lineas de tamano distinto aunque compartan linea base", () => {
    const { visible } = group([
      item({ str: "Grande", x: 72, fontSize: 24, width: 72 }),
      item({ str: "pequeno", x: 150, fontSize: 12, width: 42 }),
    ]);
    expect(visible).toHaveLength(2);
    expect(visible.map((b) => b.fontSize).sort()).toEqual([12, 24]);
  });

  it("tolera pequenas diferencias de linea base (<= 0.3 x tamano)", () => {
    const { visible } = group([
      item({ str: "Alfa", x: 72, y: 700, width: 24 }),
      item({ str: "beta", x: 100, y: 700.8, width: 24 }),
    ]);
    expect(visible).toHaveLength(1);
  });

  it("fragmentos no finitos o con tamano absurdo se descartan sin lanzar", () => {
    const { visible } = group([
      item({ str: "NaN", x: Number.NaN }),
      item({ str: "Cero", fontSize: 0 }),
      item({ str: "Infinito", y: Number.POSITIVE_INFINITY }),
      item({ str: "Bueno", x: 72 }),
    ]);
    expect(visible.map((b) => b.text)).toEqual(["Bueno"]);
  });
});

describe("parrafos", () => {
  it("une lineas consecutivas con el interlineado normal en un parrafo", () => {
    const { visible } = group(
      paragraphItems(["Primera linea del parrafo", "segunda linea del parrafo", "tercera linea"]),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0].lines).toHaveLength(3);
    expect(visible[0].text).toBe(
      "Primera linea del parrafo segunda linea del parrafo tercera linea",
    );
    expect(visible[0].lineHeight).toBeCloseTo(1.2, 2);
  });

  it("no une cuando el interlineado es de otro parrafo (hueco grande)", () => {
    const items = [
      ...paragraphItems(["Parrafo uno linea 1", "Parrafo uno linea 2"], { top: 700 }),
      ...paragraphItems(["Parrafo dos linea 1", "Parrafo dos linea 2"], { top: 700 - 14.4 - 14.4 - 12 }),
    ];
    const { visible } = group(items);
    expect(visible).toHaveLength(2);
    expect(visible.every((b) => b.lines.length === 2)).toBe(true);
  });

  it("no une lineas con tamano distinto (titulo + cuerpo)", () => {
    const { visible } = group([
      item({ str: "Titulo grande", y: 700, fontSize: 20, width: 130 }),
      item({ str: "Cuerpo normal", y: 674, fontSize: 12, width: 78 }),
    ]);
    expect(visible).toHaveLength(2);
  });

  it("no une lineas de fuente o color distintos", () => {
    const bold = { ...FONT, pdfName: "Helvetica-Bold", bold: true };
    const a = group([
      item({ str: "Linea normal", y: 700 }),
      item({ str: "Linea negrita", y: 685.6, font: bold }),
    ]);
    expect(a.visible).toHaveLength(2);
    const b = group([
      item({ str: "Linea negra", y: 700 }),
      item({ str: "Linea roja", y: 685.6, color: "#ff0000" }),
    ]);
    expect(b.visible).toHaveLength(2);
  });

  it("no une cuando el margen izquierdo no coincide", () => {
    const { visible } = group([
      item({ str: "Linea alineada", x: 72, y: 700 }),
      item({ str: "Linea desplazada", x: 140, y: 685.6 }),
    ]);
    expect(visible).toHaveLength(2);
  });

  it("acepta sangria de primera linea", () => {
    const { visible } = group([
      item({ str: "Linea con sangria", x: 90, y: 700 }),
      item({ str: "segunda linea normal", x: 72, y: 685.6 }),
      item({ str: "tercera linea normal", x: 72, y: 671.2 }),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0].lines).toHaveLength(3);
    expect(visible[0].align).toBe("left");
  });

  it("corta el parrafo cuando la ultima linea es mucho mas corta", () => {
    const items = [
      ...paragraphItems(["Esta linea es muy larga para ocupar casi todo el ancho", "otra linea larga que sigue ocupando todo el ancho", "corta"]),
      item({ str: "Nuevo parrafo que empieza justo debajo", x: 72, y: 700 - 3 * 14.4 }),
    ];
    const { visible } = group(items);
    expect(visible).toHaveLength(2);
    expect(visible[0].lines).toHaveLength(3);
  });

  it("no une marcadores de lista con la linea anterior", () => {
    const { visible } = group(
      paragraphItems(["Introduccion de la lista", "- primer elemento", "- segundo elemento"]),
    );
    expect(visible).toHaveLength(3);
  });

  it("rompe el interlineado inconsistente", () => {
    const { visible } = group([
      item({ str: "Linea uno del texto", y: 700 }),
      item({ str: "Linea dos del texto", y: 685.6 }),
      item({ str: "Linea tres del texto", y: 661 }),
    ]);
    expect(visible.map((b) => b.lines.length).sort()).toEqual([1, 2]);
  });

  it("une un guion de fin de linea con la palabra siguiente sin espacio", () => {
    const { visible } = group(
      paragraphItems(["Esta es una inter-", "nacionalizacion completa"]),
    );
    expect(visible[0].text).toBe("Esta es una inter-nacionalizacion completa");
  });
});

describe("columnas y tablas", () => {
  it("dos columnas de texto largo: un bloque por columna, nunca mezcladas", () => {
    const left = paragraphItems(
      ["Columna izquierda linea uno larga", "Columna izquierda linea dos larga", "Columna izquierda linea tres"],
      { x: 72 },
    );
    const right = paragraphItems(
      ["Columna derecha linea uno larga", "Columna derecha linea dos larga", "Columna derecha linea tres"],
      { x: 330 },
    );
    const { visible } = group([...left, ...right]);
    expect(visible).toHaveLength(2);
    for (const block of visible) {
      expect(block.lines).toHaveLength(3);
      expect(block.text).not.toContain("izquierda derecha");
    }
    const [first, second] = visible;
    expect(first.text).toContain("izquierda");
    expect(second.text).toContain("derecha");
  });

  it("tabla simple: cada celda es su propio bloque aunque las filas esten juntas", () => {
    const rows = ["Nombre", "Ana", "Luis"];
    const cols = [72, 200, 330];
    const items: RawTextItem[] = [];
    rows.forEach((label, r) =>
      cols.forEach((x, c) =>
        items.push(
          item({
            str: c === 0 ? label : c === 1 ? `${r * 7}` : `${r}.50`,
            x,
            y: 700 - r * 14.4,
          }),
        ),
      ),
    );
    const { visible } = group(items);
    expect(visible).toHaveLength(9);
    expect(visible.every((b) => b.lines.length === 1)).toBe(true);
  });

  it("orden de lectura: arriba a abajo y, en la misma banda, izquierda a derecha", () => {
    const { visible } = group([
      item({ str: "C", x: 72, y: 600 }),
      item({ str: "B", x: 330, y: 700 }),
      item({ str: "A", x: 72, y: 700 }),
    ]);
    expect(visible.map((b) => b.text)).toEqual(["A", "B", "C"]);
    expect(visible.map((b) => b.id)).toEqual(["p0-b0", "p0-b1", "p0-b2"]);
  });

  it("blocksInReadingOrder no muta la entrada y es estable", () => {
    const blocks = [
      { box: { x: 100, y: 500, width: 10, height: 10 }, fontSize: 10, n: 1 },
      { box: { x: 10, y: 500.5, width: 10, height: 10 }, fontSize: 10, n: 2 },
      { box: { x: 10, y: 700, width: 10, height: 10 }, fontSize: 10, n: 3 },
    ];
    const copy = [...blocks];
    const sorted = blocksInReadingOrder(blocks);
    expect(sorted.map((b) => b.n)).toEqual([3, 2, 1]);
    expect(blocks).toEqual(copy);
    expect(blocksInReadingOrder(sorted).map((b) => b.n)).toEqual([3, 2, 1]);
  });
});

describe("superindices y subindices", () => {
  it("el superindice va como bloque aparte y corta la linea", () => {
    const { visible } = group([
      item({ str: "E = mc", x: 72, y: 700, width: 36 }),
      item({ str: "2", x: 108, y: 705, fontSize: 8, width: 4 }),
      item({ str: "es energia", x: 116, y: 700, width: 60 }),
    ]);
    expect(visible.map((b) => b.text)).toEqual(["E = mc", "2", "es energia"]);
    const script = visible.find((b) => b.text === "2");
    expect(script?.script).toBe("superscript");
    expect(visible.filter((b) => b.script)).toHaveLength(1);
  });

  it("detecta subindices", () => {
    const { visible } = group([
      item({ str: "H", x: 72, y: 700, width: 8 }),
      item({ str: "2", x: 80, y: 697.5, fontSize: 8, width: 4 }),
    ]);
    expect(visible.find((b) => b.text === "2")?.script).toBe("subscript");
  });

  it("admite el 83 % de Chrome para <sup>/<sub> si hay desplazamiento de linea base", () => {
    const { visible } = group([
      item({ str: "y agua H", x: 72, y: 700, fontSize: 10.5, width: 40 }),
      item({ str: "2", x: 112, y: 697.2, fontSize: 8.74, width: 4.9 }),
      item({ str: "O.", x: 117, y: 700, fontSize: 10.5, width: 10 }),
    ]);
    expect(visible.map((b) => b.text)).toEqual(["y agua H", "2", "O."]);
    expect(visible.find((b) => b.text === "2")?.script).toBe("subscript");
  });

  it("un texto pequeno en la misma linea base NO es indice", () => {
    const { visible } = group([
      item({ str: "Grande", x: 72, y: 700, fontSize: 20, width: 60 }),
      item({ str: "pequeno", x: 134, y: 700, fontSize: 10, width: 35 }),
    ]);
    expect(visible.some((b) => b.script)).toBe(false);
  });

  it("un texto pequeno lejos de cualquier texto mayor NO es indice", () => {
    const { visible } = group([
      item({ str: "Grande", x: 72, y: 700, fontSize: 20, width: 60 }),
      item({ str: "nota", x: 300, y: 706, fontSize: 8, width: 16 }),
    ]);
    expect(visible.some((b) => b.script)).toBe(false);
  });

  it("los indices de lineas distintas siguen siendo bloques aparte", () => {
    const { visible } = group([
      item({ str: "x", x: 72, y: 700, width: 6 }),
      item({ str: "1", x: 78, y: 705, fontSize: 8, width: 4 }),
      item({ str: "y", x: 72, y: 685.6, width: 6 }),
      item({ str: "2", x: 78, y: 690.6, fontSize: 8, width: 4 }),
    ]);
    expect(visible.filter((b) => b.script === "superscript")).toHaveLength(2);
    expect(visible.filter((b) => b.script).every((b) => b.lines.length === 1)).toBe(true);
  });
});

describe("indices dentro de un parrafo", () => {
  it("la linea con indice queda suelta y ninguna caja cubre a otra", () => {
    const items = [
      item({ str: "Primera linea del parrafo largo", x: 72, y: 700, width: 180 }),
      item({ str: "La segunda tiene nota", x: 72, y: 685.6, width: 120 }),
      item({ str: "1", x: 192, y: 690.6, fontSize: 8, width: 4 }),
      item({ str: "y sigue aqui", x: 200, y: 685.6, width: 70 }),
      item({ str: "Tercera linea del parrafo largo", x: 72, y: 671.2, width: 180 }),
    ];
    const { visible } = group(items);
    // Ningun par de cajas se solapa.
    for (let i = 0; i < visible.length; i += 1) {
      for (let j = i + 1; j < visible.length; j += 1) {
        const a = visible[i].box;
        const b = visible[j].box;
        const overlap =
          Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 0.01 &&
          Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 0.01;
        expect(overlap, `${visible[i].text} / ${visible[j].text}`).toBe(false);
      }
    }
    expect(visible.some((b) => b.script === "superscript")).toBe(true);
    expect(visible.some((b) => b.text === "y sigue aqui")).toBe(true);
  });

  it("un indice al final de la linea tampoco queda dentro de la caja de un parrafo", () => {
    const items = [
      item({ str: "Linea larga de arriba del parrafo", x: 72, y: 700, width: 200 }),
      item({ str: "Linea corta", x: 72, y: 685.6, width: 70 }),
      item({ str: "2", x: 143, y: 690.6, fontSize: 8, width: 4 }),
    ];
    const { visible } = group(items);
    const script = visible.find((b) => b.script)!;
    for (const block of visible.filter((b) => !b.script)) {
      const a = block.box;
      const b = script.box;
      const overlap =
        Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) + 0.01 &&
        Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y) + 0.01;
      expect(overlap).toBe(false);
    }
  });
});

describe("texto justificado y estilos mezclados", () => {
  /** Palabras sueltas repartidas para llenar el ancho con huecos de ~0.55 em. */
  function justifiedLine(words: string[], y: number): RawTextItem[] {
    const size = 12;
    const gap = 0.55 * size;
    let x = 72;
    return words.map((word) => {
      const width = word.length * size * 0.5;
      const it = item({ str: word, x, y, width });
      x += width + gap;
      return it;
    });
  }

  it("un parrafo justificado con huecos grandes entre palabras sigue siendo uno", () => {
    const { visible } = group([
      ...justifiedLine(["Esta", "linea", "esta", "justificada", "a", "ambos"], 700),
      ...justifiedLine(["lados", "del", "ancho", "disponible", "de", "la"], 685.6),
      ...justifiedLine(["columna", "de", "texto", "principal", "del", "doc"], 671.2),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0].lines).toHaveLength(3);
    expect(visible[0].text.startsWith("Esta linea esta justificada")).toBe(true);
  });

  it("un tabulador (hueco > 0.7 em) parte la linea en dos bloques", () => {
    const { visible } = group([
      item({ str: "Concepto", x: 72, width: 48 }),
      item({ str: "Importe", x: 72 + 48 + 1.5 * 12, width: 42 }),
    ]);
    expect(visible).toHaveLength(2);
  });

  it("una palabra en negrita dentro de la linea no la parte ni cambia la fuente dominante", () => {
    const bold = { ...FONT, pdfName: "Helvetica-Bold", bold: true };
    const { visible } = group([
      item({ str: "Texto con una ", x: 72, width: 84 }),
      item({ str: "palabra", x: 156, width: 42, font: bold }),
      item({ str: " en negrita al medio", x: 198, width: 120 }),
      item({ str: "segunda linea normal del parrafo", x: 72, y: 685.6, width: 190 }),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0].lines).toHaveLength(2);
    expect(visible[0].font.bold).toBe(false);
    expect(visible[0].lines[0].text).toBe("Texto con una palabra en negrita al medio");
  });

  it("los espacios finales no ensanchan la caja de la linea", () => {
    const { visible } = group([item({ str: "Hola   ", x: 72, width: 42 })]);
    expect(visible[0].box.width).toBeLessThan(42 - 3);
  });

  it("dos lineas de color distinto no se funden aunque el resto coincida", () => {
    const { visible } = group([
      item({ str: "Aviso en rojo importante", y: 700, color: "#ff0000" }),
      item({ str: "Texto negro siguiente", y: 685.6 }),
    ]);
    expect(visible).toHaveLength(2);
  });
});

describe("regresiones de la verificacion (pura)", () => {
  /** Lineas de un parrafo con anchos dados (en pt) y el mismo margen izquierdo. */
  const widths = (list: number[], dv: number, texts?: string[]) =>
    list.map((width, i) =>
      item({
        str: texts?.[i] ?? "x".repeat(Math.round(width / 6)),
        x: 72,
        y: 700 - i * dv,
        width,
      }),
    );

  it("interlineado doble (2x) con lineas que llenan la columna: un parrafo", () => {
    const { visible } = group(widths([300, 298, 300, 290, 120], 24));
    expect(visible).toHaveLength(1);
    expect(visible[0].lines).toHaveLength(5);
  });

  it("interlineado doble NO funde parrafos separados por un hueco mayor", () => {
    const first = widths([300, 298, 150], 24);
    const second = widths([300, 296, 140], 24).map((it) => ({ ...it, y: it.y - 3 * 24 - 24 }));
    const { visible } = group([...first, ...second]);
    expect(visible).toHaveLength(2);
  });

  it("penultima linea corta por una palabra larga: la ultima linea sigue en el parrafo", () => {
    // 6 pt por letra. La 3a linea mide 60 pt y deja 240 libres, pero la
    // palabra inicial de la 4a mide 270: no cabia, asi que el texto envolvia.
    const lines = ["x".repeat(50), "y".repeat(49), "z".repeat(10), `${"w".repeat(45)} ab`];
    const { visible } = group(
      lines.map((str, i) => item({ str, x: 72, y: 700 - i * 14.4, width: str.length * 6 })),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0].lines).toHaveLength(4);
  });

  it("linea corta seguida de una palabra que SI cabia: el parrafo acabo", () => {
    const { visible } = group(
      widths([300, 296, 120, 200], 14.4, [
        "x".repeat(50),
        "y".repeat(49),
        "z".repeat(20),
        "Nuevo parrafo que empieza",
      ]),
    );
    expect(visible).toHaveLength(2);
  });

  it("vinetas vectoriales (markers) abren un bloque por elemento", () => {
    const items = ["Uno", "Dos", "Tres"].map((str, i) =>
      item({ str, x: 90, y: 700 - i * 14.4, width: 20 }),
    );
    const markers = items.map((it) => ({ x: 80, y: it.y + 1.5, width: 4, height: 4 }));
    expect(group(items).visible).toHaveLength(1);
    const { visible } = groupTextItems(items, { pageIndex: 0, markers });
    expect(visible.map((b) => b.text)).toEqual(["Uno", "Dos", "Tres"]);
    // La vineta (x 80-84) queda fuera de la caja del bloque.
    expect(visible.every((b) => b.box.x >= 89.9)).toBe(true);
  });

  it("formas grandes o alargadas (subrayados, recuadros) no son vinetas", () => {
    const items = paragraphItems(["Linea uno del parrafo", "linea dos del parrafo"]);
    const markers = [
      { x: 60, y: 700, width: 30, height: 1 },
      { x: 40, y: 690, width: 20, height: 20 },
    ];
    const { visible } = groupTextItems(items, { pageIndex: 0, markers });
    expect(visible).toHaveLength(1);
  });

  it("marca suelta + texto en la misma linea: la marca se absorbe", () => {
    const { visible } = group([
      item({ str: "\u2022", x: 72, y: 700, width: 6 }),
      item({ str: "Elemento uno", x: 100, y: 700, width: 70 }),
      item({ str: "\u2022", x: 72, y: 685.6, width: 6 }),
      item({ str: "Elemento dos", x: 100, y: 685.6, width: 70 }),
    ]);
    expect(visible.map((b) => b.text)).toEqual(["Elemento uno", "Elemento dos"]);
  });

  it("negrita falsa con desfase de 0.3 pt a 14 pt se deduplica; 3 pt no", () => {
    const base = item({ str: "Duplicate bold", x: 40, y: 300, fontSize: 14, width: 80 });
    expect(group([base, { ...base, x: 40.3 }]).visible[0].text).toBe("Duplicate bold");
    expect(group([base, { ...base, x: 43 }]).visible[0].text).toBe("Duplicate boldDuplicate bold");
  });

  /**
   * Wave 10 · C-A2: una pasada se descarta como duplicado si cae a <= 0,03 em de CUALQUIER pasada anterior (la
   * conservada o una ya descartada). Antes solo contaba la conservada: la 3.ª de una negrita de 3-4 pasadas a 0,3 pt
   * (cuerpo 15) caia a 0,6 pt de la 1.ª, sobrevivia y el bloque salia duplicado.
   */
  describe("negrita falsa de 3-4 pasadas finas (cuerpo 15, 0,3 pt)", () => {
    const base = item({ str: "Hola mundo", x: 40, y: 300, fontSize: 15, width: 80 });
    const pass = (k: number, step = 0.3, dy = 0) => ({ ...base, x: 40 + k * step, y: 300 + k * dy });

    it("cada pasada se encadena con la anterior: 3 y 4 pasadas a 0,3 pt dan UN bloque «Hola mundo»", () => {
      expect(group([pass(0), pass(1), pass(2)]).visible.map((b) => b.text)).toEqual(["Hola mundo"]);
      expect(group([pass(0), pass(1), pass(2), pass(3)]).visible.map((b) => b.text)).toEqual(["Hola mundo"]);
    });

    it("tambien en diagonal y con cualquier orden de llegada", () => {
      const diagonal = [0, 1, 2, 3].map((k) => pass(k, 0.25, 0.25));
      expect(group(diagonal).visible.map((b) => b.text)).toEqual(["Hola mundo"]);
      expect(group([...diagonal].reverse()).visible.map((b) => b.text)).toEqual(["Hola mundo"]);
    });

    it("una pasada a MAS de 0,03 em de todas las anteriores (0,5 pt a 15) se conserva: es otra copia, no un duplicado", () => {
      expect(group([pass(0, 0.5), pass(1, 0.5), pass(2, 0.5)]).visible[0].text).toBe("Hola mundoHola mundoHola mundo");
    });

    it("el encadenado no cruza tamanos distintos ni textos distintos ni otra altura: cada uno sigue siendo su propio texto", () => {
      const texts = (items: RawTextItem[]) => group(items).visible.map((b) => b.text).sort();
      // La 3.ª pasada a 16 pt (otro cuerpo) NO es copia de las de 15: queda como un bloque aparte.
      expect(texts([pass(0), pass(1), { ...pass(2), fontSize: 16 }])).toEqual(["Hola mundo", "Hola mundo"]);
      // Con otro texto («mundi») tampoco: las dos «Hola mundo» se dedupan entre si y «Hola mundi» sigue en pie.
      expect(texts([pass(0), pass(1), { ...pass(2), str: "Hola mundi" }]).join("|")).toContain("Hola mundi");
      // A otra altura (15 pt mas abajo) es otra LINEA (el bloque trae las dos), no un duplicado.
      expect(texts([pass(0), pass(1), { ...pass(2), y: 285 }])).toEqual(["Hola mundo Hola mundo"]);
    });
  });

  it("fragmentos de una misma instruccion con huecos grandes forman una linea", () => {
    const words = ["Palabras", "muy", "separadas"];
    let x = 72;
    const items = words.map((str) => {
      const it = item({ str, x, width: str.length * 6, runId: 7 });
      x += str.length * 6 + 20;
      return it;
    });
    expect(group(items).visible.map((b) => b.text)).toEqual(["Palabras muy separadas"]);
    // Sin runId comun (instrucciones distintas) y huecos desiguales: se parten.
    const split = group(items.map((it, i) => ({ ...it, runId: i, x: it.x + i * i * 3 })));
    expect(split.visible.length).toBeGreaterThan(1);
  });

  it("mixedStyle solo aparece cuando hay mezcla de color o de fuente", () => {
    const bold = { ...FONT, pdfName: "Helvetica-Bold", bold: true };
    const mixed = group([
      item({ str: "Hola ", x: 72, width: 30 }),
      item({ str: "mundo", x: 102, width: 30, color: "#ff0000" }),
    ]).visible[0];
    expect(mixed.mixedStyle).toBe(true);
    expect(group([item({ str: "Hola ", x: 72, width: 30 }), item({ str: "mundo", x: 102, width: 30, font: bold })]).visible[0].mixedStyle).toBe(true);
    expect(group([item({ str: "Hola mundo" })]).visible[0]).not.toHaveProperty("mixedStyle");
    expect(
      group([item({ str: "Hola", x: 72, width: 24 }), item({ str: "mundo", x: 100, width: 30, font: { ...FONT, pdfName: "ABCDEF+Helvetica" } })]).visible[0],
    ).not.toHaveProperty("mixedStyle");
    expect(group([item({ str: "Hola mundo", mixed: true })]).visible[0].mixedStyle).toBe(true);
  });

  it("alineacion: una linea sola contra margenes de la pagina", () => {
    const pageBox = { x: 0, y: 0, width: 600, height: 800 };
    const body = paragraphItems(["Cuerpo uno largo del texto", "cuerpo dos largo del texto"], { top: 600 }).concat(
      paragraphItems(["Otro cuerpo uno largo", "otro cuerpo dos largo"], { top: 400 }),
    );
    const right = item({ str: "Derecha", x: 528 - 42, y: 300, width: 42 });
    const { visible } = groupTextItems([...body, right], { pageIndex: 0, pageBox });
    expect(visible.find((b) => b.text === "Derecha")?.align).toBe("right");
    const left = item({ str: "Izquierda", x: 72, y: 300, width: 54 });
    expect(groupTextItems([...body, left], { pageIndex: 0, pageBox }).visible.find((b) => b.text === "Izquierda")?.align).toBe("left");
  });

  it("control de caracteres: espacios convertidos en U+0003 => no-unicode", () => {
    const { visible } = group([item({ str: "/RUHP\u0003LSVXP\u0003GRORU\u0003VLW" })]);
    expect(visible[0].readOnlyReason).toBe("no-unicode");
  });
});

describe("alineacion", () => {
  it("izquierda: margenes izquierdos iguales", () => {
    const { visible } = group(paragraphItems(["linea larga uno aqui", "corta dos", "intermedia tres"]));
    expect(visible[0].align).toBe("left");
  });

  it("centrado: centros iguales, margenes distintos", () => {
    const widths = [120, 80, 100];
    const items = widths.map((width, i) =>
      item({ str: "x".repeat(width / 6), x: 300 - width / 2, y: 700 - i * 14.4, width }),
    );
    const { visible } = group(items);
    expect(visible).toHaveLength(1);
    expect(visible[0].align).toBe("center");
  });

  it("derecha: margenes derechos iguales", () => {
    const widths = [120, 80, 100];
    const items = widths.map((width, i) =>
      item({ str: "x".repeat(width / 6), x: 500 - width, y: 700 - i * 14.4, width }),
    );
    const { visible } = group(items);
    expect(visible).toHaveLength(1);
    expect(visible[0].align).toBe("right");
  });

  it("una linea centrada en la pagina se marca como centrada", () => {
    const pageBox = { x: 0, y: 0, width: 612, height: 792 };
    const width = 200;
    const { visible } = group(
      [item({ str: "Titulo centrado en la pagina", x: 306 - width / 2, width })],
      pageBox,
    );
    expect(visible[0].align).toBe("center");
  });

  it("una linea sola cerca del margen izquierdo es izquierda", () => {
    const pageBox = { x: 0, y: 0, width: 612, height: 792 };
    const { visible } = group([item({ str: "Texto", x: 72, width: 200 })], pageBox);
    expect(visible[0].align).toBe("left");
  });
});

describe("rotacion y geometria", () => {
  it("texto a 90 grados: caja envolvente y rectangulo orientado", () => {
    // Texto que sube por x = 100: origen (100, 200), largo 60, tamano 10.
    const { visible } = group([
      item({ str: "Vertical90", x: 100, y: 200, rotation: 90, width: 60, fontSize: 10 }),
    ]);
    const block = visible[0];
    expect(block.rotation).toBe(90);
    // Perpendicular al texto (hacia la izquierda de la direccion de avance).
    expect(block.box.x).toBeCloseTo(100 - 0.8 * 10, 2);
    expect(block.box.width).toBeCloseTo(10, 2);
    expect(block.box.y).toBeCloseTo(200, 2);
    expect(block.box.height).toBeCloseTo(60, 2);
    expect(block.orientedBox?.width).toBeCloseTo(60, 2);
    expect(block.orientedBox?.height).toBeCloseTo(10, 2);
  });

  it("agrupa lineas rotadas en un parrafo a 90 grados", () => {
    const items = [0, 1, 2].map((i) =>
      item({
        str: `Linea rotada ${i} larga`,
        x: 300 + i * 14.4,
        y: 100,
        rotation: 90,
        width: 120,
      }),
    );
    // A 90 grados "arriba" del texto es -x: las lineas siguientes van a la derecha de la 1a? No: a la IZQUIERDA.
    const { visible } = group(items.map((it, i) => ({ ...it, x: 300 - i * 14.4 })));
    expect(visible).toHaveLength(1);
    expect(visible[0].lines).toHaveLength(3);
    expect(visible[0].rotation).toBe(90);
  });

  it("rotaciones distintas no se mezclan", () => {
    const { visible } = group([
      item({ str: "Horizontal", x: 72, y: 700 }),
      item({ str: "Girado", x: 72, y: 686, rotation: 30 }),
    ]);
    expect(visible).toHaveLength(2);
    expect(visible.map((b) => b.rotation).sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it("texto girado 30 grados: la caja envolvente contiene su rectangulo orientado", () => {
    const { visible } = group([
      item({ str: "Inclinado", x: 200, y: 100, rotation: 30, width: 50, fontSize: 14 }),
    ]);
    const block = visible[0];
    const o = block.orientedBox!;
    expect(o.width).toBeCloseTo(50, 2);
    expect(o.height).toBeCloseTo(14, 2);
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    expect(block.box.width).toBeCloseTo(50 * cos + 14 * sin, 2);
    expect(block.box.height).toBeCloseTo(50 * sin + 14 * cos, 2);
    expect(block.lines[0].origin?.x).toBeCloseTo(200, 2);
    expect(block.lines[0].length).toBeCloseTo(50, 2);
  });
});

describe("solo lectura e invisibles", () => {
  it("separa la capa invisible del resto", () => {
    const { visible, hidden } = group([
      item({ str: "Visible", x: 72, y: 700 }),
      item({ str: "Oculto OCR", x: 72, y: 600, invisible: true }),
    ]);
    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(1);
    expect(hidden[0].editable).toBe(false);
    expect(hidden[0].readOnlyReason).toBe("invisible");
    expect(hidden[0].id).toBe("p0-b1");
  });

  it("type3 => solo lectura", () => {
    const { visible } = group([
      item({ str: "Texto", font: { ...FONT, type3: true } }),
    ]);
    expect(visible[0].editable).toBe(false);
    expect(visible[0].readOnlyReason).toBe("type3");
  });

  it("vertical => solo lectura, un bloque por fragmento", () => {
    const { visible } = group([
      item({ str: "縦書き", vertical: true, x: 500, y: 700 }),
      item({ str: "縦書き2", vertical: true, x: 480, y: 700 }),
    ]);
    expect(visible).toHaveLength(2);
    expect(visible.every((b) => b.readOnlyReason === "vertical")).toBe(true);
  });

  it("caracteres de control / PUA => no-unicode", () => {
    const { visible } = group([item({ str: "\u0001\u0002\u0003ab" })]);
    expect(visible[0].editable).toBe(false);
    expect(visible[0].readOnlyReason).toBe("no-unicode");
  });

  it("un unico simbolo PUA en una frase larga NO la bloquea", () => {
    const { visible } = group([
      item({ str: "Una frase normal con un vinetas  suelta" }),
    ]);
    expect(visible[0].editable).toBe(true);
  });

  it("fuente simbolica => solo lectura", () => {
    const { visible } = group([
      item({ str: "abc", font: { ...FONT, pdfName: "ZapfDingbats", symbolic: true } }),
    ]);
    expect(visible[0].readOnlyReason).toBe("symbolic");
  });

  it("prioridad: type3 gana a no-unicode", () => {
    const { visible } = group([
      item({ str: "\u0001\u0002\u0003", font: { ...FONT, type3: true } }),
    ]);
    expect(visible[0].readOnlyReason).toBe("type3");
  });

  it("entrada vacia => resultado vacio", () => {
    expect(group([])).toEqual({ visible: [], hidden: [] });
  });
});

describe("identificadores y huella", () => {
  it("ids p<pagina>-b<indice> y huella estable entre ejecuciones", () => {
    const items = paragraphItems(["Uno", "Dos"], { top: 700 }).concat(
      item({ str: "Aparte", x: 300, y: 300 }),
    );
    const a = groupTextItems(items, { pageIndex: 3 });
    const b = groupTextItems(items, { pageIndex: 3 });
    expect(a.visible.map((x) => x.id)).toEqual(["p3-b0", "p3-b1"]);
    expect(a.visible.map((x) => x.origHash)).toEqual(b.visible.map((x) => x.origHash));
    expect(new Set(a.visible.map((x) => x.origHash)).size).toBe(2);
    expect(a.visible.every((x) => x.pageIndex === 3)).toBe(true);
  });

  it("el color y la fuente del bloque son los dominantes", () => {
    const bold = { ...FONT, pdfName: "Helvetica-Bold", bold: true };
    const { visible } = group([
      item({ str: "Palabra larga normal", x: 72, width: 100, color: "#000000" }),
      item({ str: "roja", x: 175, width: 20, color: "#ff0000", font: bold }),
    ]);
    expect(visible).toHaveLength(1);
    expect(visible[0].color).toBe("#000000");
    expect(visible[0].font.bold).toBe(false);
  });
});
