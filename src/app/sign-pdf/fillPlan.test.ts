import { describe, expect, it } from "vitest";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { FormFieldInfo } from "@/lib/pdf/fillForm";
import {
  buildFillPlan,
  checkboxFieldsFrom,
  choiceSeedFrom,
  isBoundToForm,
  readOnlyIds,
  rectMoved,
  seedValuesFrom,
} from "@/app/sign-pdf/fillPlan";

const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };

function info(overrides: Partial<FormFieldInfo> & Pick<FormFieldInfo, "id" | "kind">): FormFieldInfo {
  return { name: overrides.id, pageIndex: 0, rect: RECT, readOnly: false, value: "", ...overrides };
}

function field(overrides: Partial<DetectedField> & Pick<DetectedField, "id">): DetectedField {
  return { pageIndex: 0, rect: RECT, source: "acroform", confidence: "high", label: overrides.id, ...overrides };
}

const plan = (args: Partial<Parameters<typeof buildFillPlan>[0]>) =>
  buildFillPlan({ textFields: [], textValues: {}, formFields: [], choiceValues: {}, language: "es", ...args });

describe("rectMoved", () => {
  it("el mismo rectangulo no se considera movido (con tolerancia de redondeo)", () => {
    expect(rectMoved(RECT, { ...RECT, x: RECT.x + 0.001 })).toBe(false);
  });
  it("mover o redimensionar mas que la tolerancia si", () => {
    expect(rectMoved(RECT, { ...RECT, x: RECT.x + 0.01 })).toBe(true);
    expect(rectMoved(RECT, { ...RECT, y: RECT.y - 0.01 })).toBe(true);
    expect(rectMoved(RECT, { ...RECT, width: RECT.width * 2 })).toBe(true);
    expect(rectMoved(RECT, { ...RECT, height: RECT.height * 2 })).toBe(true);
  });
});

describe("isBoundToForm", () => {
  const text = info({ id: "acro-1", kind: "text" });
  it("un campo del lienzo de origen AcroForm, en su sitio y de tipo texto, esta ligado al campo real", () => {
    expect(isBoundToForm(field({ id: "acro-1" }), text)).toBe(true);
  });
  it("sin campo real con ese id no hay ligadura", () => {
    expect(isBoundToForm(field({ id: "acro-1" }), undefined)).toBe(false);
  });
  it("un campo manual o sugerido nunca esta ligado, aunque comparta id", () => {
    expect(isBoundToForm(field({ id: "acro-1", source: "manual" }), text)).toBe(false);
    expect(isBoundToForm(field({ id: "acro-1", source: "heuristic-vector" }), text)).toBe(false);
  });
  it("si la persona movio el campo ya no es el widget: se dibuja", () => {
    expect(isBoundToForm(field({ id: "acro-1", rect: { ...RECT, x: 0.5 } }), text)).toBe(false);
  });
  it("texto, fecha e iniciales sobre un campo de texto real siguen ligados; casilla no", () => {
    expect(isBoundToForm(field({ id: "acro-1", type: "date" }), text)).toBe(true);
    expect(isBoundToForm(field({ id: "acro-1", type: "initials" }), text)).toBe(true);
    expect(isBoundToForm(field({ id: "acro-1", type: "checkbox" }), text)).toBe(false);
  });
  it("una casilla real solo se liga a un campo de tipo casilla", () => {
    const box = info({ id: "acro-cb-1", kind: "checkbox" });
    expect(isBoundToForm(field({ id: "acro-cb-1", type: "checkbox" }), box)).toBe(true);
    expect(isBoundToForm(field({ id: "acro-cb-1" }), box)).toBe(false);
  });
  it("radios, desplegables y listas nunca se ligan a un campo del lienzo", () => {
    expect(isBoundToForm(field({ id: "acro-ch-1" }), info({ id: "acro-ch-1", kind: "dropdown" }))).toBe(false);
  });
});

describe("buildFillPlan: campos reales", () => {
  it("un campo de texto real con valor nuevo se ESCRIBE (no se dibuja)", () => {
    const result = plan({
      textFields: [field({ id: "acro-1" })],
      textValues: { "acro-1": "Ana" },
      formFields: [info({ id: "acro-1", kind: "text" })],
    });
    expect(result.writes).toEqual([{ id: "acro-1", value: "Ana" }]);
    expect(result.placements).toEqual([]);
    expect(result.fieldCount).toBe(1);
  });

  it("un campo sin cambios (mismo valor que el PDF) no se reescribe", () => {
    const result = plan({
      textFields: [field({ id: "acro-1" })],
      textValues: { "acro-1": "igual" },
      formFields: [info({ id: "acro-1", kind: "text", value: "igual" })],
    });
    expect(result.writes).toEqual([]);
    expect(result.fieldCount).toBe(0);
  });

  it("vaciar un campo que tenia valor es una escritura (valor vacio)", () => {
    const result = plan({
      textFields: [field({ id: "acro-1" })],
      textValues: { "acro-1": "" },
      formFields: [info({ id: "acro-1", kind: "text", value: "antes" })],
    });
    expect(result.writes).toEqual([{ id: "acro-1", value: "" }]);
  });

  it("un campo de solo lectura nunca se escribe", () => {
    const result = plan({
      textFields: [field({ id: "acro-1" })],
      textValues: { "acro-1": "x" },
      formFields: [info({ id: "acro-1", kind: "text", readOnly: true })],
    });
    expect(result.writes).toEqual([]);
    expect(result.placements).toEqual([]);
  });

  it("una casilla real marcada escribe 'true'; desmarcada una que estaba marcada escribe vacio", () => {
    const box = info({ id: "acro-cb-1", kind: "checkbox" });
    const checked = plan({
      textFields: [field({ id: "acro-cb-1", type: "checkbox" })],
      textValues: { "acro-cb-1": "true" },
      formFields: [box],
    });
    expect(checked.writes).toEqual([{ id: "acro-cb-1", value: "true" }]);
    const cleared = plan({
      textFields: [field({ id: "acro-cb-1", type: "checkbox" })],
      textValues: {},
      formFields: [{ ...box, value: "true" }],
    });
    expect(cleared.writes).toEqual([{ id: "acro-cb-1", value: "" }]);
  });

  it("una fecha en un campo real se escribe ya formateada en el idioma activo", () => {
    const state = {
      textFields: [field({ id: "acro-1", type: "date" })],
      textValues: { "acro-1": "2026-03-04" },
      formFields: [info({ id: "acro-1", kind: "text" })],
    };
    const es = plan({ ...state, language: "es" }).writes[0].value;
    const en = plan({ ...state, language: "en" }).writes[0].value;
    expect(es).toMatch(/2026/);
    expect(es).not.toBe("2026-03-04");
    expect(en).not.toBe(es);
  });

  it("radios, desplegables y listas: se escribe lo que cambio respecto del PDF", () => {
    const result = plan({
      formFields: [
        info({ id: "acro-ch-1", kind: "dropdown", value: "Chile", options: ["Chile", "Peru"] }),
        info({ id: "acro-ch-2", kind: "radio", value: "", options: ["M", "F"] }),
        info({ id: "acro-ch-3", kind: "list", value: "es", options: ["es", "en"] }),
      ],
      choiceValues: { "acro-ch-1": "Peru", "acro-ch-2": "F", "acro-ch-3": "es" },
    });
    expect(result.writes).toEqual([
      { id: "acro-ch-1", value: "Peru" },
      { id: "acro-ch-2", value: "F" },
    ]);
  });

  it("los de opciones de solo lectura no se escriben y un valor ausente no cuenta como cambio", () => {
    const result = plan({
      formFields: [
        info({ id: "acro-ch-1", kind: "dropdown", value: "a", readOnly: true, options: ["a", "b"] }),
        info({ id: "acro-ch-2", kind: "radio", value: "", options: ["M"] }),
      ],
      choiceValues: { "acro-ch-1": "b" },
    });
    expect(result.writes).toEqual([]);
  });
});

describe("buildFillPlan: texto que se dibuja", () => {
  it("una sugerencia con valor y un campo manual se DIBUJAN (nada se escribe en el formulario)", () => {
    const result = plan({
      textFields: [
        field({ id: "sug-1", source: "heuristic-vector" }),
        field({ id: "man-1", source: "manual" }),
      ],
      textValues: { "sug-1": "Madrid", "man-1": "Nota" },
    });
    expect(result.writes).toEqual([]);
    expect(result.placements.map((placement) => placement.kind === "text" && placement.value)).toEqual(["Madrid", "Nota"]);
    expect(result.fieldCount).toBe(2);
  });

  it("una sugerencia sin valor no cuenta", () => {
    const result = plan({ textFields: [field({ id: "sug-1", source: "heuristic-vector" })], textValues: {} });
    expect(result.fieldCount).toBe(0);
  });

  it("un campo real que se movio de sitio se dibuja en su nueva posicion en vez de escribirse", () => {
    const moved = { ...RECT, x: 0.6 };
    const result = plan({
      textFields: [field({ id: "acro-1", rect: moved })],
      textValues: { "acro-1": "Movido" },
      formFields: [info({ id: "acro-1", kind: "text" })],
    });
    expect(result.writes).toEqual([]);
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]).toMatchObject({ kind: "text", value: "Movido", rect: moved });
  });

  it("una casilla manual se dibuja centrada como 'X'", () => {
    const result = plan({
      textFields: [field({ id: "man-1", source: "manual", type: "checkbox" })],
      textValues: { "man-1": "true" },
    });
    expect(result.placements[0]).toMatchObject({ kind: "text", value: "X", align: "center" });
  });

  it("mezcla: escrituras y dibujos suman en fieldCount", () => {
    const result = plan({
      textFields: [field({ id: "acro-1" }), field({ id: "man-1", source: "manual" })],
      textValues: { "acro-1": "A", "man-1": "B" },
      formFields: [info({ id: "acro-1", kind: "text" })],
    });
    expect(result.writes).toHaveLength(1);
    expect(result.placements).toHaveLength(1);
    expect(result.fieldCount).toBe(2);
  });
});

describe("buildFillPlan: avisos previos", () => {
  it("lista los caracteres que la apariencia estandar no puede pintar (campos escritos y dibujados)", () => {
    const result = plan({
      textFields: [field({ id: "acro-1" }), field({ id: "man-1", source: "manual" })],
      textValues: { "acro-1": "ok ✓", "man-1": "你好" },
      formFields: [info({ id: "acro-1", kind: "text" })],
    });
    expect(result.unsupported).toEqual(["✓", "你", "好"]);
  });

  it("acentos y enes no se avisan", () => {
    const result = plan({
      textFields: [field({ id: "acro-1" })],
      textValues: { "acro-1": "Ñandú José" },
      formFields: [info({ id: "acro-1", kind: "text" })],
    });
    expect(result.unsupported).toEqual([]);
  });

  it("cuenta los valores mas largos que el maximo del campo real", () => {
    const result = plan({
      textFields: [field({ id: "acro-1" }), field({ id: "acro-2" })],
      textValues: { "acro-1": "abcdefgh", "acro-2": "ab" },
      formFields: [
        info({ id: "acro-1", kind: "text", maxLength: 5 }),
        info({ id: "acro-2", kind: "text", maxLength: 5 }),
      ],
    });
    expect(result.truncated).toBe(1);
  });
});

describe("ayudas de siembra", () => {
  const fields: FormFieldInfo[] = [
    info({ id: "acro-1", kind: "text", value: "Ana" }),
    info({ id: "acro-2", kind: "text", value: "" }),
    info({ id: "acro-cb-1", kind: "checkbox", value: "true", name: "acepto" }),
    info({ id: "acro-cb-2", kind: "checkbox", value: "", readOnly: true }),
    info({ id: "acro-ch-1", kind: "dropdown", value: "Chile", options: ["Chile"] }),
    info({ id: "acro-ch-2", kind: "radio", value: "", options: ["M"], readOnly: true }),
  ];

  it("checkboxFieldsFrom crea un campo del lienzo por casilla editable (de tipo casilla, origen AcroForm)", () => {
    const created = checkboxFieldsFrom(fields);
    expect(created.map((item) => item.id)).toEqual(["acro-cb-1"]);
    expect(created[0]).toMatchObject({ type: "checkbox", source: "acroform", confidence: "high", label: "acepto" });
  });

  it("seedValuesFrom solo trae los valores no vacios de texto y casillas", () => {
    expect(seedValuesFrom(fields)).toEqual({ "acro-1": "Ana", "acro-cb-1": "true" });
  });

  it("choiceSeedFrom trae el valor inicial de desplegables, radios y listas (tambien vacios)", () => {
    expect(choiceSeedFrom(fields)).toEqual({ "acro-ch-1": "Chile", "acro-ch-2": "" });
  });

  it("readOnlyIds lista los campos de solo lectura", () => {
    expect([...readOnlyIds(fields)].sort()).toEqual(["acro-cb-2", "acro-ch-2"]);
  });
});
