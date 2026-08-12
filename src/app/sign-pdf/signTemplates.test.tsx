import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TEMPLATES,
  __resetSignTemplatesCacheForTests,
  clearAllTemplates,
  deleteTemplate,
  instantiateTemplate,
  listTemplates,
  saveTemplate,
  type SaveTemplateInput,
} from "@/app/sign-pdf/signTemplates";
import type { DetectedField } from "@/lib/pdf/detectFields";

/**
 * `.test.tsx` a proposito, mismo motivo que `valueHistory.test.tsx`: es
 * el unico entorno del repo con `window.localStorage` real.
 */

beforeEach(() => {
  window.localStorage.clear();
  __resetSignTemplatesCacheForTests();
});

const BASE_INPUT: SaveTemplateInput = {
  name: "Contrato estandar",
  pageCount: 3,
  signers: [
    { id: "sg-1", name: "Ana", color: "#0d4bff" },
    { id: "sg-2", name: "Roberto", color: "#ff0000" },
  ],
  fields: [
    {
      id: "fld-1",
      signerId: "sg-1",
      pageIndex: 0,
      type: "signature",
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
    },
    {
      id: "fld-2",
      signerId: "sg-2",
      pageIndex: 2,
      type: "initials",
      rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.05 },
    },
  ],
  textFields: [
    {
      id: "txt-1",
      pageIndex: 1,
      rect: { x: 0.2, y: 0.2, width: 0.3, height: 0.05 },
      label: "Nombre",
      source: "manual",
      confidence: "high",
    },
  ],
};

function deps(pageCount: number) {
  let signerCounter = 0;
  let fieldCounter = 0;
  let textFieldCounter = 0;
  return {
    pageCount,
    mintSignerId: () => `sg-new-${++signerCounter}`,
    mintFieldId: () => `fld-new-${++fieldCounter}`,
    mintTextFieldId: () => `txt-new-${++textFieldCounter}`,
  };
}

describe("saveTemplate / listTemplates — src/app/sign-pdf/signTemplates.ts", () => {
  it("guarda solo forma: sin ids, sin colores y SIN textValues", () => {
    saveTemplate(BASE_INPUT);
    const [template] = listTemplates();

    expect(template.signers).toEqual([{ name: "Ana" }, { name: "Roberto" }]);
    expect(template.fields).toEqual([
      { signerIndex: 0, pageIndex: 0, type: "signature", rect: BASE_INPUT.fields[0].rect },
      { signerIndex: 1, pageIndex: 2, type: "initials", rect: BASE_INPUT.fields[1].rect },
    ]);
    expect(template.textFields).toEqual([
      { pageIndex: 1, rect: BASE_INPUT.textFields[0].rect, label: "Nombre" },
    ]);
    // Ninguna clave del manifiesto lleva "value": la plantilla no puede
    // cargar lo que alguien escribio en un documento anterior.
    expect(JSON.stringify(template)).not.toContain("value");
  });

  it("guardar con el mismo nombre sobrescribe en vez de duplicar", () => {
    saveTemplate(BASE_INPUT);
    saveTemplate({ ...BASE_INPUT, pageCount: 5 });

    const templates = listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].sourcePageCount).toBe(5);
  });

  it(`al llegar a ${MAX_TEMPLATES} plantillas distintas, rechaza en vez de expulsar la mas vieja`, () => {
    for (let i = 0; i < MAX_TEMPLATES; i++) {
      const result = saveTemplate({ ...BASE_INPUT, name: `Plantilla ${i}` });
      expect(result).toBe("ok");
    }
    const result = saveTemplate({ ...BASE_INPUT, name: "Una de mas" });
    expect(result).toBe("limit");
    expect(listTemplates()).toHaveLength(MAX_TEMPLATES);
  });

  it("borrar una plantilla la saca de la lista", () => {
    saveTemplate(BASE_INPUT);
    const [template] = listTemplates();
    deleteTemplate(template.id);
    expect(listTemplates()).toHaveLength(0);
  });

  it("clearAllTemplates borra todas de una vez", () => {
    saveTemplate(BASE_INPUT);
    saveTemplate({ ...BASE_INPUT, name: "Otra" });
    clearAllTemplates();
    expect(listTemplates()).toHaveLength(0);
  });
});

describe("instantiateTemplate — src/app/sign-pdf/signTemplates.ts", () => {
  it("acuña ids nuevos y nunca reutiliza los que tenia el documento de origen", () => {
    saveTemplate(BASE_INPUT);
    const [template] = listTemplates();

    const result = instantiateTemplate(template, deps(3));
    expect(result).not.toBeNull();
    const ids = [
      ...result!.signers.map((s) => s.id),
      ...result!.fields.map((f) => f.id),
      ...result!.textFields.map((f) => f.id),
    ];
    expect(ids).not.toContain("sg-1");
    expect(ids).not.toContain("fld-1");
    expect(ids).not.toContain("txt-1");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("un documento con menos paginas que el de origen descarta lo que no encaja y lo cuenta en 'dropped'", () => {
    saveTemplate(BASE_INPUT); // 2 huecos (paginas 0 y 2) + 1 campo de texto (pagina 1)
    const [template] = listTemplates();

    // Documento nuevo de solo 2 paginas: el hueco de la pagina 2 no encaja.
    const result = instantiateTemplate(template, deps(2));

    expect(result).not.toBeNull();
    expect(result!.fields).toHaveLength(1);
    expect(result!.fields[0].pageIndex).toBe(0);
    expect(result!.textFields).toHaveLength(1);
    expect(result!.dropped).toBe(1);
  });

  it("nunca recorta un campo a la ultima pagina disponible: lo descarta", () => {
    saveTemplate(BASE_INPUT);
    const [template] = listTemplates();

    const result = instantiateTemplate(template, deps(2));
    const pages = result!.fields.map((f) => f.pageIndex);
    expect(pages).not.toContain(2);
    expect(Math.max(...pages)).toBeLessThan(2);
  });

  it("si NINGUN campo encaja, no aplica nada (null) en vez de vaciar la plantilla sobre el documento", () => {
    saveTemplate(BASE_INPUT); // el campo mas temprano esta en la pagina 0... usar una plantilla toda en paginas altas
    // Construye una plantilla cuyo unico contenido cae fuera de un documento de 1 pagina.
    saveTemplate({
      ...BASE_INPUT,
      name: "Solo pagina alta",
      fields: [BASE_INPUT.fields[1]], // pageIndex 2
      textFields: [],
    });
    const template = listTemplates().find((t) => t.name === "Solo pagina alta")!;

    const result = instantiateTemplate(template, deps(1));
    expect(result).toBeNull();
  });

  it("los firmantes se recrean todos, incluso si sus huecos no sobreviven", () => {
    saveTemplate({
      ...BASE_INPUT,
      fields: [BASE_INPUT.fields[1]], // solo el hueco de Roberto (pagina 2)
      textFields: [BASE_INPUT.textFields[0]], // sobrevive, asi que result no es null
    });
    const template = listTemplates()[0];

    const result = instantiateTemplate(template, deps(1)); // pagina 2 no encaja, pero el campo de texto (pagina 1) tampoco
    // Aqui NADA encaja (fields cae por pagina 2, textFields cae por pagina 1 con pageCount=1) -> null.
    expect(result).toBeNull();
  });

  it("mapea signerIndex al id recien acuñado del firmante correcto", () => {
    saveTemplate(BASE_INPUT);
    const template = listTemplates()[0];

    const result = instantiateTemplate(template, deps(3))!;
    const robertoId = result.signers[1].id;
    const initialsField = result.fields.find((f) => f.type === "initials");
    expect(initialsField?.signerId).toBe(robertoId);
  });

  it("los campos de texto aplicados quedan como 'manual'/'high', igual que uno anadido a mano", () => {
    saveTemplate(BASE_INPUT);
    const template = listTemplates()[0];

    const result = instantiateTemplate(template, deps(3))!;
    const applied = result.textFields[0] as DetectedField;
    expect(applied.source).toBe("manual");
    expect(applied.confidence).toBe("high");
    expect(applied.label).toBe("Nombre");
  });

  it("el `type` de un campo de texto (casilla/fecha/inicial) sobrevive a guardar y aplicar (Recomendacion #5)", () => {
    saveTemplate({
      ...BASE_INPUT,
      textFields: [
        { ...BASE_INPUT.textFields[0], type: "checkbox" },
      ],
    });
    const template = listTemplates()[0];

    expect(template.textFields[0].type).toBe("checkbox");

    const result = instantiateTemplate(template, deps(3))!;
    expect(result.textFields[0].type).toBe("checkbox");
  });

  it("un campo de texto sin `type` (plantilla guardada antes de esta funcion) se sigue aplicando como texto libre", () => {
    saveTemplate(BASE_INPUT); // BASE_INPUT.textFields[0] no trae `type`
    const template = listTemplates()[0];

    expect(template.textFields[0].type).toBeUndefined();
    const result = instantiateTemplate(template, deps(3))!;
    expect(result.textFields[0].type).toBeUndefined();
  });
});
