import { describe, expect, it } from "vitest";
import { DEFAULT_INITIALS_GAP, applyPageAdjust, initialsFieldId, initialsRects, repeatInitials, shiftRect } from "./templateRepeat";
import { parseVariant } from "./templateSchema";
import { INITIALS_BASE, R } from "./testing/templateSamples";
import { emptyVariant, type TemplateSignField, type Variant } from "./templateTypes";

const sign = (over: Partial<TemplateSignField>): TemplateSignField => ({ roleIndex: 0, pageIndex: 0, type: "signature", rect: R(0.2, 0.5, 0.25, 0.05), required: true, source: "manual", ...over });
const initialsOn = (variant: Variant, page: number) => variant.fields.filter((field) => field.type === "initials" && field.pageIndex === page).sort((a, b) => a.roleIndex - b.roleIndex);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

describe("initialsRects: la disposición del usuario (§12)", () => {
  it("1 firmante: ocupa la línea entera", () => {
    expect(initialsRects(INITIALS_BASE, 1)).toEqual([INITIALS_BASE]);
  });

  it("2 firmantes: una al lado de la otra, firmante 1 a la IZQUIERDA y 2 a la DERECHA, sobre la misma línea", () => {
    const [left, right] = initialsRects(INITIALS_BASE, 2);
    expect(left.x).toBeLessThan(right.x);
    expect(left.y).toBe(INITIALS_BASE.y);
    expect(right.y).toBe(INITIALS_BASE.y);
    expect(left.height).toBe(INITIALS_BASE.height);
    expect(right.height).toBe(INITIALS_BASE.height);
    expect(left.width).toBeCloseTo(right.width, 9);
    // Empiezan donde empieza la línea y terminan donde termina.
    expect(near(left.x, INITIALS_BASE.x)).toBe(true);
    expect(near(right.x + right.width, INITIALS_BASE.x + INITIALS_BASE.width)).toBe(true);
  });

  it("deja un hueco (margen) del 10 % del ancho entre las dos y no se solapan", () => {
    const [left, right] = initialsRects(INITIALS_BASE, 2);
    const gap = right.x - (left.x + left.width);
    expect(gap).toBeCloseTo(INITIALS_BASE.width * DEFAULT_INITIALS_GAP, 5);
    expect(gap).toBeGreaterThan(0);
    expect(left.width + right.width + gap).toBeCloseTo(INITIALS_BASE.width, 5);
  });

  it("hueco propio y límites del hueco", () => {
    const [left, right] = initialsRects(R(0.5, 0.8, 0.4, 0.04), 2, 0.25);
    expect(right.x - (left.x + left.width)).toBeCloseTo(0.1, 5);
    const [a, b] = initialsRects(R(0.5, 0.8, 0.4, 0.04), 2, 0);
    expect(near(a.x + a.width, b.x)).toBe(true);
    expect(() => initialsRects(INITIALS_BASE, 2, -0.1)).toThrow(RangeError);
    expect(() => initialsRects(INITIALS_BASE, 2, 0.51)).toThrow(RangeError);
    expect(() => initialsRects(INITIALS_BASE, 2, Number.NaN)).toThrow(RangeError);
  });

  it("con las medidas observadas en los contratos reales cada inicial queda entre 0,05-0,09 × 0,02-0,05", () => {
    // Línea de 0,13 × 0,03 (x≈0,79-0,92): cada mitad ≈ 0,06 × 0,03.
    const [left, right] = initialsRects(R(0.79, 0.82, 0.12, 0.03), 2);
    for (const rect of [left, right]) {
      expect(rect.width).toBeGreaterThanOrEqual(0.05);
      expect(rect.width).toBeLessThanOrEqual(0.09);
      expect(rect.height).toBeGreaterThanOrEqual(0.02);
      expect(rect.height).toBeLessThanOrEqual(0.05);
      expect(rect.x).toBeGreaterThanOrEqual(0.79);
      expect(rect.x + rect.width).toBeLessThanOrEqual(0.91 + 1e-9);
      expect(rect.y).toBeGreaterThanOrEqual(0.8);
      expect(rect.y + rect.height).toBeLessThanOrEqual(0.91);
    }
  });

  it("base inválida lanza", () => {
    for (const base of [R(-0.1, 0, 0.1, 0.1), R(0.95, 0, 0.1, 0.1), R(0, 0, 0, 0.1), R(0, 0, 0.1, -1), R(NaN, 0, 0.1, 0.1), R(0, 0.99, 0.1, 0.05)]) {
      expect(() => initialsRects(base, 1), JSON.stringify(base)).toThrow(RangeError);
    }
  });
});

describe("repeatInitials: páginas", () => {
  it("de la 0 a la última con 'all' (necesita pageCount)", () => {
    const out = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: "all", pageCount: 5 });
    expect(out.pages).toEqual([0, 1, 2, 3, 4]);
    expect(out.variant.fields.map((field) => field.pageIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: "all" })).toThrow(RangeError);
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: "all", pageCount: 0 })).toThrow(RangeError);
  });

  it("'all' es el valor por defecto de toPage", () => {
    expect(repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, pageCount: 3 }).pages).toEqual([0, 1, 2]);
  });

  it("rango fromPage..toPage incluido, y fromPage con 'all'", () => {
    expect(repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, fromPage: 1, toPage: 3 }).pages).toEqual([1, 2, 3]);
    expect(repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, fromPage: 2, toPage: "all", pageCount: 5 }).pages).toEqual([2, 3, 4]);
    expect(repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, fromPage: 2, toPage: 2 }).pages).toEqual([2]);
  });

  it("lista exacta de páginas (sin repetir, ordenada; ignora fromPage)", () => {
    const out = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, fromPage: 9, toPage: [4, 1, 4, 2] });
    expect(out.pages).toEqual([1, 2, 4]);
  });

  it("páginas que no existen (≥ pageCount) se omiten y se devuelven", () => {
    const out = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: [0, 1, 7, 9], pageCount: 3 });
    expect(out.pages).toEqual([0, 1]);
    expect(out.skippedPages).toEqual([7, 9]);
    const range = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, fromPage: 1, toPage: 6, pageCount: 4 });
    expect(range.pages).toEqual([1, 2, 3]);
    expect(range.skippedPages).toEqual([4, 5, 6]);
  });

  it("parámetros inválidos lanzan", () => {
    const base = INITIALS_BASE;
    expect(() => repeatInitials(emptyVariant(), { signers: 3 as never, base })).toThrow(RangeError);
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base, fromPage: -1, toPage: 2 })).toThrow(RangeError);
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base, fromPage: 1.5, toPage: 2 })).toThrow(RangeError);
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base, fromPage: 3, toPage: 2 })).toThrow(RangeError);
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base, toPage: [0, -1] })).toThrow(RangeError);
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base, toPage: [0.5] })).toThrow(RangeError);
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base, fromPage: 0, toPage: 9999 })).toThrow(RangeError);
  });
});

describe("repeatInitials: campos generados", () => {
  it("1 firmante: un campo por página, rol 0, tipo initials, requerido, ids deterministas", () => {
    const out = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: "all", pageCount: 3 });
    expect(out.variant.fields).toHaveLength(3);
    for (const [page, field] of out.variant.fields.entries()) {
      expect(field).toMatchObject({ roleIndex: 0, pageIndex: page, type: "initials", required: true, source: "manual", id: initialsFieldId(page, 0) });
      expect(field.rect).toEqual(INITIALS_BASE);
    }
  });

  it("2 firmantes: en CADA página, rol 0 a la izquierda y rol 1 a la derecha", () => {
    const out = repeatInitials(emptyVariant(), { signers: 2, base: INITIALS_BASE, toPage: "all", pageCount: 8 });
    expect(out.variant.fields).toHaveLength(16);
    for (let page = 0; page < 8; page += 1) {
      const [first, second] = initialsOn(out.variant, page);
      expect(first.roleIndex).toBe(0);
      expect(second.roleIndex).toBe(1);
      expect(first.rect.x).toBeLessThan(second.rect.x);
      expect(first.rect.y).toBe(second.rect.y);
    }
  });

  it("el resultado es válido para el esquema (variante de 2 firmantes)", () => {
    const out = repeatInitials(emptyVariant(), { signers: 2, base: INITIALS_BASE, toPage: "all", pageCount: 30 });
    expect(parseVariant(out.variant, "2", 2)).not.toBeNull();
    expect(parseVariant(out.variant, "1", 2)).toBeNull(); // el rol 1 no existe en la variante de 1
    const one = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: "all", pageCount: 30 });
    expect(parseVariant(one.variant, "1", 2)).not.toBeNull();
  });

  it("required y source se pueden elegir", () => {
    const out = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: 0, required: false, source: "auto" });
    expect(out.variant.fields[0]).toMatchObject({ required: false, source: "auto" });
  });

  it("es idempotente: repetir dos veces no duplica", () => {
    const once = repeatInitials(emptyVariant(), { signers: 2, base: INITIALS_BASE, toPage: "all", pageCount: 4 });
    const twice = repeatInitials(once.variant, { signers: 2, base: INITIALS_BASE, toPage: "all", pageCount: 4 });
    expect(twice.variant).toEqual(once.variant);
  });

  it("no toca firmas, textos ni las iniciales de otras páginas", () => {
    const original: Variant = {
      fields: [sign({ pageIndex: 3 }), sign({ pageIndex: 7, type: "initials", rect: R(0.1, 0.1, 0.05, 0.03), id: "mine" })],
      textFields: [{ pageIndex: 0, rect: R(0.1, 0.1, 0.3, 0.02), type: "text", label: "Nombre", required: false, source: "manual" }],
    };
    const snapshot = structuredClone(original);
    const out = repeatInitials(original, { signers: 1, base: INITIALS_BASE, toPage: [0, 1] });
    expect(original).toEqual(snapshot); // la entrada no cambia
    expect(out.variant.textFields).toEqual(original.textFields);
    expect(out.variant.fields.find((field) => field.type === "signature")).toEqual(original.fields[0]);
    expect(out.variant.fields.find((field) => field.id === "mine")).toEqual(original.fields[1]);
    expect(out.variant.fields).toHaveLength(4);
  });

  it("sustituye las iniciales previas de esas páginas, solo de los firmantes que se colocan", () => {
    const start = repeatInitials(emptyVariant(), { signers: 2, base: R(0.5, 0.5, 0.2, 0.03), toPage: [1] }).variant;
    // Con 1 firmante solo se sustituye el rol 0; el rol 1 queda donde estaba.
    const out = repeatInitials(start, { signers: 1, base: INITIALS_BASE, toPage: [1] });
    const [role0, role1] = initialsOn(out.variant, 1);
    expect(role0.rect).toEqual(INITIALS_BASE);
    expect(role1.roleIndex).toBe(1);
    expect(role1.rect).toEqual(initialsOn(start, 1)[1].rect);
  });

  it("replaceExisting:false respeta las páginas que ya tienen iniciales", () => {
    const start = repeatInitials(emptyVariant(), { signers: 1, base: R(0.1, 0.1, 0.1, 0.03), toPage: [2] }).variant;
    const out = repeatInitials(start, { signers: 1, base: INITIALS_BASE, toPage: [1, 2, 3], replaceExisting: false });
    expect(out.keptPages).toEqual([2]);
    expect(out.pages).toEqual([1, 3]);
    expect(initialsOn(out.variant, 2)[0].rect).toEqual(R(0.1, 0.1, 0.1, 0.03));
    expect(initialsOn(out.variant, 1)[0].rect).toEqual(INITIALS_BASE);
  });

  it("deja los campos ordenados por página y rol", () => {
    const out = repeatInitials({ fields: [sign({ pageIndex: 5 })], textFields: [] }, { signers: 2, base: INITIALS_BASE, toPage: [4, 1] });
    expect(out.variant.fields.map((field) => [field.pageIndex, field.roleIndex])).toEqual([
      [1, 0],
      [1, 1],
      [4, 0],
      [4, 1],
      [5, 0],
    ]);
  });

  it("no deja pasar de 500 campos por variante", () => {
    const lots: Variant = { fields: [], textFields: Array.from({ length: 480 }, () => ({ pageIndex: 0, rect: R(0.1, 0.1, 0.1, 0.02), type: "text" as const, label: "", required: false, source: "manual" as const })) };
    expect(() => repeatInitials(lots, { signers: 2, base: INITIALS_BASE, toPage: "all", pageCount: 11 })).toThrow(RangeError);
    expect(repeatInitials(lots, { signers: 2, base: INITIALS_BASE, toPage: "all", pageCount: 10 }).variant.fields).toHaveLength(20);
  });
});

describe("repeatInitials: ajuste fino por página", () => {
  it("la posición varía ligeramente por página (como las puso el usuario a mano)", () => {
    const out = repeatInitials(emptyVariant(), {
      signers: 2,
      base: INITIALS_BASE,
      toPage: "all",
      pageCount: 4,
      perPageAdjust: { 1: { dx: -0.01, dy: 0.005 }, 3: { dx: 0.0, dy: -0.01 } },
    });
    const page0 = initialsOn(out.variant, 0);
    const page1 = initialsOn(out.variant, 1);
    const page3 = initialsOn(out.variant, 3);
    expect(page1[0].rect.x).toBeCloseTo(page0[0].rect.x - 0.01, 6);
    expect(page1[1].rect.x).toBeCloseTo(page0[1].rect.x - 0.01, 6);
    expect(page1[0].rect.y).toBeCloseTo(page0[0].rect.y + 0.005, 6);
    expect(page3[0].rect.y).toBeCloseTo(page0[0].rect.y - 0.01, 6);
    expect(page3[0].rect.x).toBeCloseTo(page0[0].rect.x, 6);
    expect(initialsOn(out.variant, 2)[0].rect).toEqual(page0[0].rect); // sin ajuste
    // El hueco entre los dos firmantes se conserva al desplazar.
    const gap0 = page0[1].rect.x - (page0[0].rect.x + page0[0].rect.width);
    const gap1 = page1[1].rect.x - (page1[0].rect.x + page1[0].rect.width);
    expect(gap1).toBeCloseTo(gap0, 6);
  });

  it("un ajuste nunca saca el campo de la página (se queda pegado al borde, sin encoger)", () => {
    const out = repeatInitials(emptyVariant(), { signers: 1, base: R(0.88, 0.95, 0.1, 0.04), toPage: [0, 1, 2], perPageAdjust: { 0: { dx: 0.5, dy: 0.5 }, 1: { dx: -2, dy: -2 } } });
    const [p0, p1, p2] = [0, 1, 2].map((page) => initialsOn(out.variant, page)[0].rect);
    expect(p0.x + p0.width).toBeCloseTo(1, 6);
    expect(p0.y + p0.height).toBeCloseTo(1, 6);
    expect(p0.width).toBe(0.1);
    expect(p1.x).toBe(0);
    expect(p1.y).toBe(0);
    expect(p2).toEqual(R(0.88, 0.95, 0.1, 0.04));
    expect(parseVariant(out.variant, "1", 2)).not.toBeNull();
  });

  it("ajustes no finitos lanzan; ajustes de páginas ajenas se ignoran", () => {
    expect(() => repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: 0, perPageAdjust: { 0: { dx: Number.NaN, dy: 0 } } })).toThrow(RangeError);
    const out = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: 0, perPageAdjust: { 5: { dx: 0.1, dy: 0.1 } } });
    expect(out.variant.fields[0].rect).toEqual(INITIALS_BASE);
  });

  it("`__proto__`/'constructor' como página no cuentan como ajuste", () => {
    const hostile = JSON.parse('{"__proto__":{"dx":0.3,"dy":0.3}}') as Record<number, { dx: number; dy: number }>;
    const out = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, toPage: 0, perPageAdjust: hostile });
    expect(out.variant.fields[0].rect).toEqual(INITIALS_BASE);
  });

  it("el diseño devuelto recuerda base, rango, hueco y solo los ajustes de las páginas colocadas", () => {
    const out = repeatInitials(emptyVariant(), { signers: 2, base: INITIALS_BASE, fromPage: 1, toPage: 3, gap: 0.2, perPageAdjust: { 2: { dx: 0.01, dy: 0 }, 9: { dx: 1, dy: 1 }, 3: { dx: 0, dy: 0 } } });
    expect(out.layout).toEqual({ fromPage: 1, toPage: 3, base: INITIALS_BASE, gap: 0.2, adjust: [{ page: 2, dx: 0.01, dy: 0 }] });
    const all = repeatInitials(emptyVariant(), { signers: 1, base: INITIALS_BASE, pageCount: 2 });
    expect(all.layout).toEqual({ fromPage: 0, toPage: "all", base: INITIALS_BASE, adjust: [] });
  });
});

describe("applyPageAdjust", () => {
  const variant = (): Variant => ({
    fields: [
      sign({ pageIndex: 0, type: "initials", rect: R(0.79, 0.84, 0.05, 0.03), id: "a" }),
      sign({ pageIndex: 0, type: "initials", roleIndex: 1, rect: R(0.85, 0.84, 0.05, 0.03), id: "b" }),
      sign({ pageIndex: 1, type: "initials", rect: R(0.79, 0.84, 0.05, 0.03), id: "c" }),
      sign({ pageIndex: 1, type: "signature", rect: R(0.2, 0.5, 0.25, 0.05), id: "d" }),
    ],
    textFields: [],
  });

  it("mueve solo las iniciales de las páginas citadas (por defecto)", () => {
    const out = applyPageAdjust(variant(), { 0: { dx: 0.01, dy: -0.02 } });
    expect(out.fields[0].rect).toMatchObject({ x: 0.8, y: 0.82 });
    expect(out.fields[1].rect.x).toBeCloseTo(0.86, 6);
    expect(out.fields[2].rect).toEqual(variant().fields[2].rect);
    expect(out.fields[3].rect).toEqual(variant().fields[3].rect);
  });

  it("filtra por tipo y por rol", () => {
    const sig = applyPageAdjust(variant(), { 1: { dx: 0.1, dy: 0 } }, { type: "signature" });
    expect(sig.fields[3].rect.x).toBeCloseTo(0.3, 6);
    expect(sig.fields[2].rect.x).toBe(0.79);
    const role = applyPageAdjust(variant(), { 0: { dx: 0.02, dy: 0 } }, { roleIndex: 1 });
    expect(role.fields[0].rect.x).toBe(0.79);
    expect(role.fields[1].rect.x).toBeCloseTo(0.87, 6);
  });

  it("no modifica la entrada y respeta el borde de la página", () => {
    const input = variant();
    const snapshot = structuredClone(input);
    const out = applyPageAdjust(input, { 0: { dx: 5, dy: 5 } });
    expect(input).toEqual(snapshot);
    expect(out.fields[0].rect.x + out.fields[0].rect.width).toBeCloseTo(1, 6);
    expect(out.fields[0].rect.y + out.fields[0].rect.height).toBeCloseTo(1, 6);
    expect(() => applyPageAdjust(input, { 0: { dx: Number.POSITIVE_INFINITY, dy: 0 } })).toThrow(RangeError);
  });
});

describe("shiftRect", () => {
  it("desplaza y recorta al borde sin cambiar el tamaño", () => {
    expect(shiftRect(R(0.5, 0.5, 0.2, 0.1), 0.1, -0.1)).toEqual(R(0.6, 0.4, 0.2, 0.1));
    expect(shiftRect(R(0.5, 0.5, 0.2, 0.1), 1, 1)).toEqual(R(0.8, 0.9, 0.2, 0.1));
    expect(shiftRect(R(0.5, 0.5, 0.2, 0.1), -1, -1)).toEqual(R(0, 0, 0.2, 0.1));
  });
});
