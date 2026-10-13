import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  StandardFonts,
} from "@cantoo/pdf-lib";
import { applyPageAssembly, type PageAssemblyWarning, type PageEntry } from "@/lib/pdf/pageAssembly";
import { extractPages, splitDocument } from "@/lib/pdf/pageAssemblyExport";
import { organizePdfWithReport } from "@/lib/pdf/organize";
import { removePdfPagesWithReport } from "@/lib/pdf/removePages";
import { splitPdf } from "@/lib/pdf/split";
import { scanFile } from "@/lib/pdf/testing/pageAssemblyLeakFixtures";
import { occurs, rawFileText } from "@/lib/pdf/testing/pdfStrings";
import { collectPresentWidgets, pruneAcroForm } from "@/lib/pdf/pageAssemblyStructure";

/**
 * D-B7-1 (Wave 9 · lote 2): al quitar paginas, un CAMPO de formulario cuyos widgets estaban TODOS en las paginas quitadas
 * no se queda en el archivo con su valor. El caso que se escapaba: el campo es un diccionario APARTE de su widget (el que
 * crea pdf-lib: el campo lleva `/T` y `/V` y `/Kids [widget]`) y algo que se conserva lo nombra — el orden de calculo
 * (`/AcroForm /CO`), la lista `/Fields` de un boton de reinicio, una segunda entrada de `/Fields`... —: el widget se iba, el
 * campo quedaba con `/Kids []` y su `/V`, y el aviso decia «se quito 1 campo» aunque el valor seguia dentro.
 *
 * Aqui se comprueba POR CADENAS, sobre el archivo tal cual y sobre cada flujo descomprimido (los objetos comprimidos en un
 * flujo de objetos incluidos, y buscando cada valor en las tres formas en que un PDF lo escribe: `(texto)`, `<FEFF...>`
 * UTF-16 y `<hex>` de un `Tj`), que el valor y el nombre de lo quitado ya no estan, que lo conservado conserva su valor y
 * SIGUE SIENDO EDITABLE (se reabre con `getForm()`), y que el aviso cuenta justo los campos que se fueron.
 */

type FieldSpec = {
  id: string;
  /** Nombre completo (`grupo.subgrupo.campo`). */
  name: string;
  value: string;
  /** Paginas (0-based) donde tiene widget. */
  pages: number[];
  /** Otros textos del campo o de su grupo que deben seguir su suerte (`/DV` del grupo). */
  extras?: string[];
};

const SPECS: FieldSpec[] = [
  { id: "A01", name: "CMP-A01", value: "VAL-A01", pages: [3] },
  { id: "A02", name: "CMP-A02", value: "VAL-A02", pages: [3] },
  { id: "A03", name: "CMP-A03", value: "VAL-A03", pages: [1, 3] },
  { id: "A04", name: "GRP-A04.SUB-A04.CMP-A04", value: "VAL-A04", pages: [3], extras: ["DVG-A04"] },
  { id: "A05", name: "CMP-A05", value: "VAL-A05", pages: [1, 3] },
  { id: "A06", name: "GRP-A06.CMP-A06", value: "VAL-A06", pages: [0] },
  { id: "A07", name: "GRP-A06.CMP-A07", value: "VAL-A07", pages: [3] },
  { id: "A08", name: "CMP-A08", value: "VAL-A08", pages: [3] },
  { id: "A09", name: "CMP-A09", value: "VAL-A09", pages: [3] },
  { id: "A10", name: "CMP-A10", value: "VAL-A10", pages: [0] },
  { id: "A11", name: "CMP-A11", value: "VAL-A11", pages: [4] },
  { id: "A12", name: "CMP-A12", value: "VAL-A12", pages: [0, 3] },
  { id: "A13", name: "BTN-A13", value: "", pages: [0] },
  { id: "A14", name: "CMP-A14", value: "VAL-A14", pages: [] },
  { id: "A15", name: "CMP-A15", value: "VAL-A15", pages: [1, 3] },
];

const PAGE_COUNT = 6;

const N = PDFName.of;
const spec = (id: string) => SPECS.find((item) => item.id === id)!;

/* ------------------------------------------------------------------ *
 * El documento: 6 paginas y 13 campos con todas las formas en que un campo se une a una pagina
 * ------------------------------------------------------------------ */

/**
 *  A01 campo APARTE de su widget (pagina 4), en `/Fields` y en `/CO`.              (el caso del verificador)
 *  A02 igual, pero FUERA de `/Fields` (solo lo nombra `/CO`), con el valor en cadena literal.
 *  A03 campo fuera de `/Fields` con widgets en una pagina viva (2) y otra quitada (4).
 *  A04 jerarquia de tres niveles `GRP.SUB.CMP`, con `/DV` en el grupo, widget en la pagina 4.
 *  A05 campo con widgets en la pagina 2 (viva) y la 4 (quitada).
 *  A06/A07 hermanos bajo el grupo `GRP-A06`: uno en la pagina 1, otro en la 4.
 *  A08 campo y widget FUSIONADOS (un solo diccionario) en la pagina 4.
 *  A09 campo apartado, listado DOS veces en `/Fields` (una segunda entrada), widget en la pagina 4.
 *  A10 campo vivo y sencillo en la pagina 1.                    A11 campo en la pagina 5.
 *  A12 descuidado: su lista `/Kids` solo nombra el widget de la pagina 4; el de la pagina 1 solo dice `/Parent`.
 *  A13 boton fusionado (pagina 1) con una accion de reinicio que nombra los campos A01 y A10.
 *  A14 campo cuyo unico widget no esta en ninguna pagina (en `/Fields` y en `/CO`): al quitar paginas se va tambien.
 *  A15 fuera de `/Fields`, con dos widgets (paginas 2 y 4): el de la pagina 2 esta en `/Kids` pero NO dice `/Parent`.
 */
async function makeFormLeakPdf(options: { objectStreams: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: PAGE_COUNT }, (_, index) => {
    const page = doc.addPage([300, 400]);
    page.drawText(`PAGINA-F${index + 1}`, { x: 24, y: 340, size: 18, font });
    return page;
  });
  const form = doc.getForm();
  const fields = form.acroForm.dict.lookup(N("Fields"), PDFArray);
  let slot = 0;
  const rect = () => ({ x: 20, y: 20 + 26 * slot++, width: 200, height: 20 });
  const appendAnnot = (page: PDFPage, ref: PDFRef) => {
    const annots = page.node.Annots();
    if (annots) annots.push(ref);
    else page.node.set(N("Annots"), ctx.obj([ref]));
  };
  const dropFromFields = (ref: PDFRef) => {
    for (let index = fields.size() - 1; index >= 0; index -= 1) if (fields.get(index) === ref) fields.remove(index);
  };

  const refs = new Map<string, PDFRef>();
  /** Campo de texto apartado de su widget (el de pdf-lib). `literal`: valor como cadena literal, no UTF-16. */
  const add = (spec: FieldSpec, literal = false, widgetPages: readonly number[] = spec.pages) => {
    const field = form.createTextField(spec.name);
    if (literal) field.acroField.dict.set(N("V"), PDFString.of(spec.value));
    else field.setText(spec.value);
    for (const page of widgetPages) field.addToPage(pages[page], rect());
    refs.set(spec.id, field.ref);
    return field;
  };
  add(spec("A01"));
  add(spec("A02"), true);
  dropFromFields(refs.get("A02")!);
  add(spec("A03"), true);
  dropFromFields(refs.get("A03")!);
  const triple = add(spec("A04"));
  const sub = ctx.lookup(triple.acroField.dict.get(N("Parent")), PDFDict);
  const group = ctx.lookup(sub.get(N("Parent")), PDFDict);
  group.set(N("DV"), PDFString.of("DVG-A04"));
  add(spec("A05"));
  add(spec("A06"));
  add(spec("A07"), true);
  add(spec("A09"));
  fields.push(refs.get("A09")!);
  add(spec("A10"));
  add(spec("A11"));

  // A08: campo y widget en un solo diccionario.
  const merged = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Tx",
      T: PDFString.of(spec("A08").name),
      V: PDFString.of(spec("A08").value),
      Rect: [20, 300, 220, 320],
      F: 4,
      P: pages[3].ref,
    }),
  );
  appendAnnot(pages[3], merged);
  fields.push(merged);
  refs.set("A08", merged);

  // A12: el campo solo nombra el widget de la pagina 4; el de la pagina 1 apunta al campo con `/Parent`.
  const sloppy = add(spec("A12"), false, [3]);
  const liveWidget = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [20, 340, 220, 360], F: 4, P: pages[0].ref, Parent: sloppy.ref }),
  );
  appendAnnot(pages[0], liveWidget);

  // A13: boton con una accion de reinicio que nombra un campo muerto y uno vivo.
  const button = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Btn",
      Ff: 65536,
      T: PDFString.of(spec("A13").name),
      Rect: [240, 20, 290, 40],
      F: 4,
      P: pages[0].ref,
      A: { S: "ResetForm", Fields: [refs.get("A01")!, refs.get("A10")!] },
    }),
  );
  appendAnnot(pages[0], button);
  fields.push(button);

  // A14: el widget cuelga del campo pero no esta en `/Annots` de ninguna pagina.
  const orphan = add(spec("A14"));
  const orphanWidget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [20, 20, 120, 40], F: 4, Parent: orphan.ref }));
  orphan.acroField.addWidget(orphanWidget);

  // A15: fuera de `/Fields`; el widget de la pagina 2 esta en `/Kids` pero no dice quien es su campo.
  const loose = add(spec("A15"), false, [3]);
  dropFromFields(loose.ref);
  const looseWidget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [20, 360, 220, 380], F: 4, P: pages[1].ref }));
  appendAnnot(pages[1], looseWidget);
  loose.acroField.addWidget(looseWidget);

  // El orden de calculo nombra a (casi) todos los campos.
  const order = ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09", "A10", "A14", "A15"].map((id) => refs.get(id)!);
  form.acroForm.dict.set(N("CO"), ctx.obj(order));
  return new Uint8Array(await doc.save({ useObjectStreams: options.objectStreams, updateFieldAppearances: false }));
}

/* ------------------------------------------------------------------ *
 * Lo que se espera de un plan
 * ------------------------------------------------------------------ */

/** Sin quitar paginas no se toca nada (tampoco el campo que ya no estaba en ninguna pagina). */
const alive = (item: FieldSpec, keep: readonly number[]) =>
  keep.length === PAGE_COUNT || item.pages.some((page) => keep.includes(page));

/** Nombres parciales (`GRP-A04`, `SUB-A04`, `CMP-A04`) de un campo. */
const partials = (item: FieldSpec) => item.name.split(".");

function expectation(keep: readonly number[]) {
  const live = SPECS.filter((item) => alive(item, keep));
  const dead = SPECS.filter((item) => !alive(item, keep));
  const liveNames = new Set(live.flatMap(partials));
  const liveTexts = new Set(live.flatMap((item) => [item.value, ...(item.extras ?? [])]));
  return {
    live,
    dead,
    deadTexts: [
      ...dead.flatMap((item) => [item.value, ...(item.extras ?? [])]).filter((text) => text && !liveTexts.has(text)),
      ...dead.flatMap(partials).filter((name) => !liveNames.has(name)),
    ],
    liveTexts: [...liveTexts].filter(Boolean),
    liveNames: [...liveNames],
  };
}

const count = (warnings: readonly PageAssemblyWarning[], code: PageAssemblyWarning["code"]) =>
  warnings.filter((warning) => warning.code === code).reduce((total, warning) => total + warning.count, 0);

function fullName(context: PDFDocument["context"], dict: PDFDict): string {
  const names: string[] = [];
  const seen = new Set<PDFDict>();
  let current: PDFDict | undefined = dict;
  while (current && !seen.has(current)) {
    seen.add(current);
    const title = current.get(N("T"));
    if (title instanceof PDFString || title instanceof PDFHexString) names.unshift(title.decodeText());
    const parent = current.get(N("Parent"));
    current = parent ? (context.lookup(parent) as PDFDict | undefined) : undefined;
  }
  return names.join(".");
}

/** El diccionario del campo con ese nombre completo, buscado entre TODOS los objetos (esten o no en `/Fields`). */
function findField(loaded: PDFDocument, name: string): PDFDict | undefined {
  for (const [, object] of loaded.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.has(N("T")) && fullName(loaded.context, object) === name) return object;
  }
  return undefined;
}

/** Campos que NO cuelgan de `/Fields` (solo los nombra el orden de calculo): `getForm()` no los ve. */
const OUTSIDE_FIELDS = new Set(["A02", "A03", "A15"]);

/** Lo que el archivo debe cumplir tras quitar paginas: nada de lo muerto, todo lo vivo, editable, y el aviso exacto. */
async function expectFormOutcome(
  bytes: Uint8Array,
  warnings: readonly PageAssemblyWarning[],
  keep: readonly number[],
  label: string,
): Promise<void> {
  const want = expectation(keep);
  const raw = rawFileText(bytes);
  const scan = (await scanFile(bytes)).text;
  for (const text of want.deadTexts) {
    expect(occurs(raw, text), `${label}: «${text}» sigue en los bytes o en un flujo descomprimido`).toBe(false);
    expect(occurs(scan, text), `${label}: «${text}» sigue en un objeto del archivo`).toBe(false);
  }
  // Control positivo: la misma busqueda SI encuentra lo que se conserva (si no, esta prueba no demostraria nada).
  for (const text of [...want.liveTexts, ...want.liveNames]) {
    expect(occurs(raw, text), `${label}: «${text}» (vivo) no se encuentra: la busqueda no sirve`).toBe(true);
  }

  const loaded = await PDFDocument.load(bytes, { updateMetadata: false });
  expect(loaded.getPageCount()).toBe(keep.length);
  const form = loaded.getForm();
  const listed = want.live.filter((item) => !OUTSIDE_FIELDS.has(item.id)).map((item) => item.name).sort();
  expect([...new Set(form.getFields().map((field) => field.getName()))].sort(), `${label}: campos del formulario`).toEqual(listed);

  // Ningun campo con nombre queda con la lista de hijos vacia (salvo el descuidado, que se conserva tal cual lo traia).
  for (const [, object] of loaded.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || !object.has(N("T"))) continue;
    const kids = object.get(N("Kids"));
    const name = fullName(loaded.context, object);
    if (name === spec("A12").name) continue;
    expect(kids instanceof PDFArray && kids.size() === 0, `${label}: «${name}» quedo con /Kids []`).toBe(false);
  }

  // El orden de calculo solo nombra campos que se quedan.
  const calc = form.acroForm.dict.get(N("CO"));
  const calcNames: string[] = [];
  if (calc instanceof PDFArray) {
    for (let index = 0; index < calc.size(); index += 1) {
      const dict = loaded.context.lookup(calc.get(index));
      expect(dict, `${label}: /CO nombra un objeto que ya no existe`).toBeInstanceOf(PDFDict);
      calcNames.push(fullName(loaded.context, dict as PDFDict));
    }
  }
  const inOrder = want.live.filter((item) => !["A11", "A12", "A13"].includes(item.id)).map((item) => item.name);
  expect(calcNames.sort(), `${label}: /CO`).toEqual(inOrder.sort());

  // El boton de reinicio solo nombra campos que se quedan.
  if (want.live.some((item) => item.id === "A13")) {
    const buttonDict = findField(loaded, spec("A13").name)!;
    const reset = loaded.context.lookup((loaded.context.lookup(buttonDict.get(N("A"))) as PDFDict).get(N("Fields"))) as PDFArray;
    const targets: string[] = [];
    for (let index = 0; index < reset.size(); index += 1) {
      targets.push(fullName(loaded.context, loaded.context.lookup(reset.get(index)) as PDFDict));
    }
    const expectedTargets = ["A01", "A10"].filter((id) => alive(spec(id), keep)).map((id) => spec(id).name);
    expect(targets.sort(), `${label}: /Fields del boton de reinicio`).toEqual(expectedTargets.sort());
  }

  // Lo conservado conserva su valor y sus widgets son los de las paginas que quedan.
  for (const item of want.live) {
    if (item.id === "A13") continue;
    const dict = findField(loaded, item.name)!;
    expect(dict, `${label}: ${item.name} no esta`).toBeInstanceOf(PDFDict);
    const stored = dict.get(N("V"));
    expect(stored instanceof PDFString || stored instanceof PDFHexString ? stored.decodeText() : undefined, `${label}: valor de ${item.name}`).toBe(item.value);
    if (item.id === "A12" || item.id === "A08" || item.id === "A14") continue;
    const kids = loaded.context.lookup(dict.get(N("Kids"))) as PDFArray;
    const wanted = item.pages.filter((page) => keep.includes(page));
    expect(kids.size(), `${label}: widgets de ${item.name}`).toBe(wanted.length);
    for (let index = 0; index < kids.size(); index += 1) {
      const widget = loaded.context.lookup(kids.get(index)) as PDFDict;
      const owner = loaded.getPages().findIndex((page) => page.ref === widget.get(N("P")));
      expect(owner, `${label}: el widget de ${item.name} apunta a una pagina que se quedo`).toBeGreaterThanOrEqual(0);
    }
  }

  // Sigue siendo EDITABLE: con la API de formularios se lee, se cambia, se guarda y se vuelve a leer.
  for (const item of want.live) {
    if (item.id === "A13" || OUTSIDE_FIELDS.has(item.id)) continue;
    expect(form.getTextField(item.name).getText(), `${label}: getText de ${item.name}`).toBe(item.value);
  }
  const editable = want.live.find((item) => item.id === "A05") ?? want.live.find((item) => item.id === "A10") ?? want.live.find((item) => !OUTSIDE_FIELDS.has(item.id) && item.id !== "A13");
  if (editable) {
    form.getTextField(editable.name).setText("EDITADO-DESPUES");
    const resaved = await loaded.save();
    const again = await PDFDocument.load(resaved);
    expect(again.getForm().getTextField(editable.name).getText()).toBe("EDITADO-DESPUES");
  }

  expect(count(warnings, "formFieldsRemoved"), `${label}: aviso «campos quitados»`).toBe(want.dead.length);
}

const existing = (sourceIndex: number): PageEntry => ({ kind: "existing", sourceIndex, rotation: 0 });
function toFile(bytes: Uint8Array, name = "doc.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}
async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

const PLANS: Record<string, number[]> = {
  "quitar la pagina 4": [0, 1, 2, 4, 5],
  "dejar solo la pagina 1": [0],
  "dejar las paginas 5 y 2 (en ese orden)": [4, 1],
  "dejar solo la pagina quitada de antes": [3],
};

describe.each([
  { label: "con flujos de objetos", objectStreams: true },
  { label: "sin flujos de objetos", objectStreams: false },
])("D-B7-1 · campo de una pagina quitada ($label)", ({ objectStreams }) => {
  it("el documento de prueba trae lo que se dice: el campo apartado, el /CO y los valores buscables", async () => {
    const source = await makeFormLeakPdf({ objectStreams });
    const raw = rawFileText(source);
    for (const item of SPECS) {
      for (const text of [item.value, ...(item.extras ?? []), ...partials(item)].filter(Boolean)) {
        expect(occurs(raw, text), `${item.id}: «${text}» no esta en el origen`).toBe(true);
      }
    }
    const loaded = await PDFDocument.load(source);
    expect(new Set(loaded.getForm().getFields().map((field) => field.getName())).size).toBe(SPECS.length - OUTSIDE_FIELDS.size);
    const co = loaded.getForm().acroForm.dict.get(N("CO")) as PDFArray;
    expect(co.size()).toBe(12);
    if (objectStreams) expect(Buffer.from(source).toString("latin1")).toContain("/ObjStm");
    else expect(Buffer.from(source).toString("latin1")).not.toContain("/ObjStm");
  });

  for (const [plan, keep] of Object.entries(PLANS)) {
    it(`Quitar / Organizar (motor): ${plan}`, async () => {
      const source = await makeFormLeakPdf({ objectStreams });
      const result = await applyPageAssembly(source, keep.map(existing));
      await expectFormOutcome(result.bytes, result.warnings, keep, plan);
    });
  }

  it("sin quitar nada (plan identidad) todos los campos se quedan y no se avisa de campos quitados", async () => {
    const source = await makeFormLeakPdf({ objectStreams });
    const keep = [0, 1, 2, 3, 4, 5];
    const result = await applyPageAssembly(source, keep.map(existing));
    await expectFormOutcome(result.bytes, result.warnings, keep, "identidad");
    expect(count(result.warnings, "formFieldsRemoved")).toBe(0);
  });

  it("Quitar paginas (herramienta): la pagina 4", async () => {
    const source = await makeFormLeakPdf({ objectStreams });
    const result = await removePdfPagesWithReport(toFile(source), { remove: [4] });
    await expectFormOutcome(await bytesOf(result.blob), result.warnings, PLANS["quitar la pagina 4"], "quitar");
  });

  it("Extraer (herramienta): las paginas 1, 2, 3, 5 y 6 y, por separado, solo la 1", async () => {
    const source = await makeFormLeakPdf({ objectStreams });
    const most = await extractPages(source, [0, 1, 2, 4, 5]);
    await expectFormOutcome(most.bytes, most.warnings, [0, 1, 2, 4, 5], "extraer varias");
    const one = await extractPages(source, [0]);
    await expectFormOutcome(one.bytes, one.warnings, [0], "extraer una");
  });

  it("Dividir juntando los rangos (1-3 y 5-6 en un solo archivo)", async () => {
    const source = await makeFormLeakPdf({ objectStreams });
    const result = await splitPdf(
      toFile(source),
      { mode: "ranges", ranges: [{ from: 1, to: 3 }, { from: 5, to: 6 }], merge: true },
      "doc",
    );
    expect(result.kind).toBe("pdf");
    await expectFormOutcome(await bytesOf(result.blob), result.warnings, [0, 1, 2, 4, 5], "dividir y juntar");
  });

  it("Organizar eliminando la pagina 4 y girando otra", async () => {
    const source = await makeFormLeakPdf({ objectStreams });
    const result = await organizePdfWithReport(toFile(source), [
      { kind: "existing", page: 1, rotation: 0 },
      { kind: "existing", page: 2, rotation: 90 },
      { kind: "existing", page: 3, rotation: 0 },
      { kind: "existing", page: 5, rotation: 0 },
      { kind: "existing", page: 6, rotation: 0 },
    ]);
    await expectFormOutcome(await bytesOf(result.blob), result.warnings, PLANS["quitar la pagina 4"], "organizar");
  });

  it("Dividir en partes separadas: ninguna parte lleva lo que solo estaba en una pagina que no entra en ninguna", async () => {
    const source = await makeFormLeakPdf({ objectStreams });
    const outcome = await splitDocument(source, [[0, 1], [2, 4, 5]], "doc");
    expect(outcome.kind).toBe("zip");
    const zip = await JSZip.loadAsync(outcome.bytes);
    const keep = [0, 1, 2, 4, 5];
    const want = expectation(keep);
    for (const name of Object.keys(zip.files)) {
      const text = rawFileText(await zip.file(name)!.async("uint8array"));
      for (const dead of want.deadTexts) expect(occurs(text, dead), `${name}: «${dead}»`).toBe(false);
    }
  });
});

describe("D-B7-1 · pruneAcroForm por si solo (sin el barrido final del motor)", () => {
  it("deja /Fields sin campos vacios ni repetidos, cuenta los campos y devuelve lo quitado", async () => {
    const source = await makeFormLeakPdf({ objectStreams: true });
    const loaded = await PDFDocument.load(source, { updateMetadata: false });
    const leaves = loaded.getPages().map((page) => page.node);
    const keep = [0, 1, 2, 4, 5];
    const result = pruneAcroForm(
      loaded.context,
      loaded.catalog,
      collectPresentWidgets(loaded.context, keep.map((index) => leaves[index])),
      [leaves[3]],
    );
    const want = expectation(keep);
    expect(result.removed).toBe(want.dead.length);

    const listed = loaded.getForm().acroForm.dict.lookup(N("Fields"), PDFArray);
    const seen = new Set<PDFRef>();
    for (let index = 0; index < listed.size(); index += 1) {
      const ref = listed.get(index) as PDFRef;
      expect(seen.has(ref), "un campo listado dos veces").toBe(false);
      seen.add(ref);
      const dict = loaded.context.lookup(ref) as PDFDict;
      const kids = dict.get(N("Kids"));
      if (fullName(loaded.context, dict) !== spec("A12").name) {
        expect(kids instanceof PDFArray && kids.size() === 0, `${fullName(loaded.context, dict)} en /Fields con /Kids []`).toBe(false);
      }
    }
    // Lo quitado vuelve en `deadNodes`: los campos muertos, y ninguno de los vivos.
    const returned = new Set(
      result.deadNodes
        .map((ref) => loaded.context.lookup(ref) as PDFDict)
        .filter((dict) => dict.has(N("T")))
        .map((dict) => fullName(loaded.context, dict)),
    );
    for (const item of want.dead) expect(returned.has(item.name), `${item.name} no vuelve en deadNodes`).toBe(true);
    for (const item of want.live) expect(returned.has(item.name), `${item.name} (vivo) vuelve en deadNodes`).toBe(false);
    for (const group of ["GRP-A04", "GRP-A04.SUB-A04"]) expect(returned.has(group), `${group} (grupo vacio) no vuelve`).toBe(true);
    expect(returned.has("GRP-A06"), "el grupo con un hijo vivo no debe volver").toBe(false);
  });

  it("sin hojas quitadas y con todos los widgets presentes no quita nada", async () => {
    const source = await makeFormLeakPdf({ objectStreams: false });
    const loaded = await PDFDocument.load(source, { updateMetadata: false });
    const leaves = loaded.getPages().map((page) => page.node);
    const result = pruneAcroForm(loaded.context, loaded.catalog, collectPresentWidgets(loaded.context, leaves));
    // El unico campo que se va es el que nunca tuvo un widget en una pagina (A14).
    expect(result.removed).toBe(1);
    expect(result.deadNodes.length).toBeGreaterThan(0);
  });
});
