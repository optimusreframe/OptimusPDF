import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFDict, StandardFonts } from "@cantoo/pdf-lib";
import { detectAcroFormFields } from "@/lib/pdf/detectFields";
import {
  collectFormEntries,
  isWinAnsiCodePoint,
  readFillForm,
  unsupportedCharacters,
  writeFillForm,
} from "@/lib/pdf/fillForm";
import {
  hasPoppler,
  type FormFixtureOptions,
  makeFormPdf,
  makePlainPdf,
  pdfjsFieldObjects,
  pdfjsPageText,
  popplerText,
} from "@/lib/pdf/testing/formFixtures";

const FULL: FormFixtureOptions = {
  textFields: ["nombre", "apellido"],
  multiline: true,
  checkbox: true,
  dropdown: true,
  radio: true,
  list: true,
  readOnlyText: true,
};

async function fieldNamed(bytes: Uint8Array, name: string) {
  const document = await PDFDocument.load(bytes);
  return document.getForm().getField(name);
}

describe("readFillForm", () => {
  it("lista todos los tipos de campo con su pagina, su rectangulo normalizado y su valor", async () => {
    const info = await readFillForm(new Blob([(await makeFormPdf(FULL)) as unknown as BlobPart]));
    expect(info.hasForm).toBe(true);
    const kinds = Object.fromEntries(info.fields.map((field) => [field.name, field.kind]));
    expect(kinds).toEqual({
      nombre: "text",
      apellido: "text",
      notas: "text",
      fijo: "text",
      acepto: "checkbox",
      pais: "dropdown",
      sexo: "radio",
      idiomas: "list",
    });
    for (const field of info.fields) {
      expect(field.pageIndex).toBe(0);
      expect(field.rect.x).toBeGreaterThanOrEqual(0);
      expect(field.rect.y).toBeGreaterThanOrEqual(0);
      expect(field.rect.x + field.rect.width).toBeLessThanOrEqual(1.001);
      expect(field.rect.y + field.rect.height).toBeLessThanOrEqual(1.001);
    }
  });

  it("un PDF sin formulario devuelve hasForm=false y ningun campo", async () => {
    const info = await readFillForm(new Blob([(await makePlainPdf(2)) as unknown as BlobPart]));
    expect(info).toEqual({ fields: [], hasForm: false });
  });

  it("los ids de texto son EXACTAMENTE los de la deteccion de Firmar (acro-N)", async () => {
    const bytes = await makeFormPdf({ ...FULL, textOnPage2: true, pages: 2 });
    const document = await PDFDocument.load(bytes);
    const detected = detectAcroFormFields(document).map((field) => [field.id, field.label]);
    const read = collectFormEntries(document)
      .filter((entry) => entry.kind === "text")
      .map((entry) => [entry.id, entry.name]);
    expect(read).toEqual(detected);
    expect(read[0][0]).toBe("acro-1");
  });

  it("casillas y opciones llevan ids propios y estables entre lecturas", async () => {
    const bytes = await makeFormPdf(FULL);
    const first = (await readFillForm(new Blob([bytes as unknown as BlobPart]))).fields.map((field) => field.id);
    const second = (await readFillForm(new Blob([bytes as unknown as BlobPart]))).fields.map((field) => field.id);
    expect(first).toEqual(second);
    expect(first).toContain("acro-cb-1");
    expect(first).toContain("acro-ch-1");
    expect(new Set(first).size).toBe(first.length);
  });

  it("lee las opciones de radios, desplegables y listas, y el estado inicial", async () => {
    const bytes = await makeFormPdf({ ...FULL, multiList: true, initialText: "Ana", checkboxChecked: true });
    const { fields } = await readFillForm(new Blob([bytes as unknown as BlobPart]));
    const by = Object.fromEntries(fields.map((field) => [field.name, field]));
    expect(by.nombre.value).toBe("Ana");
    expect(by.acepto.value).toBe("true");
    expect(by.pais.options).toEqual(["España", "México", "Chile"]);
    expect(by.sexo.options).toEqual(["M", "F"]);
    expect(by.idiomas.options).toEqual(["es", "en", "fr"]);
    expect(by.idiomas.multiSelect).toBe(true);
    expect(by.notas.multiline).toBe(true);
    expect(by.fijo.readOnly).toBe(true);
    expect(by.nombre.readOnly).toBe(false);
  });

  it("respeta la rotacion de la pagina al normalizar el rectangulo", async () => {
    const plain = (await readFillForm(new Blob([(await makeFormPdf({ textFields: ["a"] })) as unknown as BlobPart]))).fields[0];
    const rotated = (
      await readFillForm(new Blob([(await makeFormPdf({ textFields: ["a"], rotate: true })) as unknown as BlobPart]))
    ).fields[0];
    // Girada 90°: el ancho y el alto en pantalla se intercambian respecto de la pagina.
    expect(rotated.rect.width).toBeLessThan(plain.rect.width);
    expect(rotated.rect.height).toBeGreaterThan(plain.rect.height);
  });
});

describe("writeFillForm: /V y apariencias", () => {
  it("escribe el texto en /V y pdf.js lo lee como valor del campo (con acentos)", async () => {
    const bytes = await makeFormPdf(FULL);
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [
      { id: "acro-1", value: "Ñandú José" },
      { id: "acro-2", value: "Pérez" },
    ]);
    expect(result.written).toEqual(["acro-1", "acro-2"]);
    const objects = await pdfjsFieldObjects(result.bytes);
    expect(objects.nombre[0].value).toBe("Ñandú José");
    expect(objects.apellido[0].value).toBe("Pérez");
    // Sigue siendo un campo: el formulario no se aplano.
    expect(result.flattened).toBe(false);
    expect((await fieldNamed(result.bytes, "nombre")).constructor.name).toBe("PDFTextField");
  });

  it("genera la apariencia del widget: el texto se ve en la pagina (pdf.js y poppler)", async () => {
    const bytes = await makeFormPdf(FULL);
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [
      { id: "acro-1", value: "Texto visible" },
    ]);
    const field = await fieldNamed(result.bytes, "nombre");
    const widget = (field as unknown as { acroField: { getWidgets(): { dict: PDFDict }[] } }).acroField.getWidgets()[0];
    const ap = widget.dict.lookup(PDFName.of("AP"));
    expect(ap).toBeInstanceOf(PDFDict);
    if (hasPoppler()) expect(popplerText(result.bytes)).toContain("Texto visible");
    expect(await pdfjsPageText(result.bytes)).toContain("Hoja 1 del formulario");
  });

  it.skipIf(!hasPoppler())("poppler lee los valores de texto, de la casilla y de las opciones elegidas", async () => {
    const bytes = await makeFormPdf(FULL);
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [
      { id: "acro-1", value: "Marta" },
      { id: "acro-cb-1", value: "true" },
      { id: "acro-ch-1", value: "México" },
    ]);
    const text = popplerText(result.bytes);
    expect(text).toContain("Marta");
    expect(text).toContain("México");
  });

  it("casilla: marca y desmarca (/V y /AS) y pdf.js la ve marcada", async () => {
    const bytes = await makeFormPdf({ checkbox: true, textFields: [] });
    const checked = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-cb-1", value: "true" }]);
    const box = (await fieldNamed(checked.bytes, "acepto")) as unknown as { isChecked(): boolean };
    expect(box.isChecked()).toBe(true);
    const objects = await pdfjsFieldObjects(checked.bytes);
    expect(objects.acepto[0].type).toBe("checkbox");
    expect(objects.acepto[0].value).not.toBe("Off");
    const unchecked = await writeFillForm(new Blob([checked.bytes as unknown as BlobPart]), [
      { id: "acro-cb-1", value: "" },
    ]);
    expect(((await fieldNamed(unchecked.bytes, "acepto")) as unknown as { isChecked(): boolean }).isChecked()).toBe(false);
  });

  it("radio: elige una opcion y la lee pdf.js; una opcion inexistente se salta como invalida", async () => {
    const bytes = await makeFormPdf({ radio: true, textFields: [] });
    const ok = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-ch-1", value: "F" }]);
    expect(((await fieldNamed(ok.bytes, "sexo")) as unknown as { getSelected(): string }).getSelected()).toBe("F");
    const objects = await pdfjsFieldObjects(ok.bytes);
    expect(objects.sexo.some((field) => field.value === "F")).toBe(true);
    const bad = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-ch-1", value: "X" }]);
    expect(bad.written).toEqual([]);
    expect(bad.skipped).toEqual([{ id: "acro-ch-1", reason: "invalid" }]);
  });

  it("desplegable: selecciona una opcion (/V) y una opcion que no existe se salta", async () => {
    const bytes = await makeFormPdf({ dropdown: true, textFields: [] });
    const ok = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-ch-1", value: "Chile" }]);
    expect((await pdfjsFieldObjects(ok.bytes)).pais[0].value).toBe("Chile");
    const bad = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-ch-1", value: "Peru" }]);
    expect(bad.skipped[0].reason).toBe("invalid");
  });

  it("lista de opciones con seleccion multiple: escribe varias", async () => {
    const bytes = await makeFormPdf({ list: true, multiList: true, textFields: [] });
    const ok = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [
      { id: "acro-ch-1", value: "es\nfr" },
    ]);
    expect(((await fieldNamed(ok.bytes, "idiomas")) as unknown as { getSelected(): string[] }).getSelected()).toEqual([
      "es",
      "fr",
    ]);
  });

  it("un campo sin cambios conserva su apariencia original byte a byte", async () => {
    const bytes = await makeFormPdf({ textFields: ["a", "b"], initialText: "fijo" });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-2", value: "nuevo" }]);
    const before = await PDFDocument.load(bytes);
    const after = await PDFDocument.load(result.bytes);
    const apOf = (document: PDFDocument, name: string) => {
      const field = document.getForm().getField(name) as unknown as { acroField: { getWidgets(): { dict: PDFDict }[] } };
      const ap = field.acroField.getWidgets()[0].dict.lookup(PDFName.of("AP")) as PDFDict;
      return String(ap.get(PDFName.of("N")));
    };
    expect(apOf(after, "a")).toBe(apOf(before, "a"));
    expect(apOf(after, "b")).not.toBe(apOf(before, "b"));
  });

  it("vaciar un campo con valor inicial lo deja vacio", async () => {
    const bytes = await makeFormPdf({ textFields: ["a"], initialText: "algo" });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-1", value: "" }]);
    expect(((await fieldNamed(result.bytes, "a")) as unknown as { getText(): string | undefined }).getText() ?? "").toBe("");
  });

  it("un texto mas largo que el maximo del campo se recorta y se informa", async () => {
    const bytes = await makeFormPdf({ textFields: ["a"], maxLengthText: 5 });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-1", value: "abcdefghij" }]);
    expect(result.truncated).toEqual(["acro-1"]);
    expect((await pdfjsFieldObjects(result.bytes)).a[0].value).toBe("abcde");
  });

  it("los campos de solo lectura y los ids inexistentes se saltan sin romper el resto", async () => {
    const bytes = await makeFormPdf({ ...FULL });
    const readOnly = (await readFillForm(new Blob([bytes as unknown as BlobPart]))).fields.find((field) => field.name === "fijo")!;
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [
      { id: readOnly.id, value: "cambiado" },
      { id: "acro-999", value: "x" },
      { id: "acro-1", value: "Si" },
    ]);
    expect(result.skipped).toEqual([
      { id: readOnly.id, reason: "readOnly" },
      { id: "acro-999", reason: "missing" },
    ]);
    expect(result.written).toEqual(["acro-1"]);
    const objects = await pdfjsFieldObjects(result.bytes);
    expect(objects.fijo[0].value).toBe("VALOR FIJO");
    expect(objects.nombre[0].value).toBe("Si");
  });

  it("avisa de los caracteres que la apariencia (Helvetica) no puede pintar, pero /V los conserva", async () => {
    const bytes = await makeFormPdf({ textFields: ["a"] });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-1", value: "OK ✓ 你" }]);
    expect(result.unsupportedChars).toEqual(["✓", "你"]);
    expect((await pdfjsFieldObjects(result.bytes)).a[0].value).toBe("OK ✓ 你");
  });

  it("unsupportedCharacters: acentos y enes si; saltos de linea no cuentan", () => {
    expect(unsupportedCharacters(["Ñandú años\nlínea", "tab\t"])).toEqual([]);
    expect(unsupportedCharacters(["Łódź"])).toEqual(["Ł", "ź"]);
    expect(unsupportedCharacters(["€ “comillas” — guion …"])).toEqual([]);
  });

  it("la tabla WinAnsi propia coincide con el juego de caracteres real de Helvetica en pdf-lib", async () => {
    const scratch = await PDFDocument.create();
    const font = await scratch.embedFont(StandardFonts.Helvetica);
    const real = new Set(font.getCharacterSet());
    for (let code = 0x20; code <= 0x2122; code += 1) {
      if (code >= 0x7f && code <= 0x9f) continue;
      expect(isWinAnsiCodePoint(code), `U+${code.toString(16)}`).toBe(real.has(code));
    }
  });

  it("campo multilinea: conserva los saltos de linea", async () => {
    const bytes = await makeFormPdf({ multiline: true, textFields: [] });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [
      { id: "acro-1", value: "uno\ndos\ntres" },
    ]);
    expect((await pdfjsFieldObjects(result.bytes)).notas[0].value).toBe("uno\ndos\ntres");
  });

  it("escribe en campos de la segunda pagina", async () => {
    const bytes = await makeFormPdf({ pages: 2, textOnPage2: true, textFields: ["p1"] });
    const info = await readFillForm(new Blob([bytes as unknown as BlobPart]));
    const second = info.fields.find((field) => field.name === "pagina2")!;
    expect(second.pageIndex).toBe(1);
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: second.id, value: "pagina dos" }]);
    expect((await pdfjsFieldObjects(result.bytes)).pagina2[0].value).toBe("pagina dos");
  });

  it("sin escrituras ni aplanado devuelve un PDF equivalente (mismo numero de paginas y campos)", async () => {
    const bytes = await makeFormPdf(FULL);
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), []);
    const after = await PDFDocument.load(result.bytes);
    expect(after.getPageCount()).toBe(1);
    expect(after.getForm().getFields()).toHaveLength(8);
  });
});

describe("writeFillForm: aplanado", () => {
  it("aplana: los campos desaparecen y el texto queda como contenido de la pagina", async () => {
    const bytes = await makeFormPdf({ textFields: ["a", "b"], checkbox: true });
    const result = await writeFillForm(
      new Blob([bytes as unknown as BlobPart]),
      [
        { id: "acro-1", value: "Aplanado" },
        { id: "acro-cb-1", value: "true" },
      ],
      { flatten: true },
    );
    expect(result.flattened).toBe(true);
    const after = await PDFDocument.load(result.bytes);
    expect(after.getForm().getFields()).toHaveLength(0);
    expect(await pdfjsPageText(result.bytes)).toContain("Aplanado");
    if (hasPoppler()) expect(popplerText(result.bytes)).toContain("Aplanado");
  });

  it("sin formulario, aplanar no hace nada", async () => {
    const result = await writeFillForm(new Blob([(await makePlainPdf(1)) as unknown as BlobPart]), [], { flatten: true });
    expect(result.flattened).toBe(false);
  });
});

describe("writeFillForm: errores", () => {
  it("un archivo que no es PDF lanza un error tipado", async () => {
    await expect(
      writeFillForm(new Blob([new Uint8Array([1, 2, 3])]), [{ id: "acro-1", value: "x" }]),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });
});

describe("fillForm: casos limite del formulario", () => {
  it("una pagina girada 90° se rellena igual y conserva su rotacion", async () => {
    const bytes = await makeFormPdf({ textFields: ["a"], rotate: true });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-1", value: "Girado" }]);
    const document = await PDFDocument.load(result.bytes);
    expect(document.getPage(0).getRotation().angle).toBe(90);
    expect((await pdfjsFieldObjects(result.bytes)).a[0].value).toBe("Girado");
  });

  it("un campo con dos widgets (mismo nombre en dos paginas) da dos ids de texto y un valor compartido", async () => {
    const document = await PDFDocument.create();
    const first = document.addPage([300, 300]);
    const second = document.addPage([300, 300]);
    const field = document.getForm().createTextField("repetido");
    field.addToPage(first, { x: 20, y: 200, width: 150, height: 24 });
    field.addToPage(second, { x: 20, y: 200, width: 150, height: 24 });
    const bytes = await document.save();
    const info = await readFillForm(new Blob([bytes as unknown as BlobPart]));
    expect(info.fields.map((item) => [item.id, item.name, item.pageIndex])).toEqual([
      ["acro-1", "repetido", 0],
      ["acro-2", "repetido", 1],
    ]);
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-2", value: "Compartido" }]);
    expect((await pdfjsFieldObjects(result.bytes)).repetido.map((widget) => widget.value)).toEqual(["Compartido", "Compartido"]);
  });

  it("una casilla con dos widgets da dos ids de casilla consecutivos", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 300]);
    const box = document.getForm().createCheckBox("doble");
    box.addToPage(page, { x: 20, y: 200, width: 16, height: 16 });
    box.addToPage(page, { x: 120, y: 200, width: 16, height: 16 });
    const info = await readFillForm(new Blob([(await document.save()) as unknown as BlobPart]));
    expect(info.fields.map((item) => item.id)).toEqual(["acro-cb-1", "acro-cb-2"]);
  });

  it("un PDF cifrado con contrasena no se puede leer ni escribir: error tipado 'encrypted'", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    document.encrypt({ userPassword: "x", ownerPassword: "x" });
    const bytes = await document.save();
    await expect(readFillForm(new Blob([bytes as unknown as BlobPart]))).rejects.toMatchObject({ code: "encrypted" });
    await expect(writeFillForm(new Blob([bytes as unknown as BlobPart]), [])).rejects.toMatchObject({ code: "encrypted" });
  });

  it("los botones no se listan como rellenables (solo texto, casillas, radios y listas)", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 300]);
    const form = document.getForm();
    form.createTextField("texto").addToPage(page, { x: 20, y: 200, width: 100, height: 20 });
    form.createButton("enviar").addToPage("Enviar", page, { x: 20, y: 100, width: 80, height: 24 });
    const info = await readFillForm(new Blob([(await document.save()) as unknown as BlobPart]));
    expect(info.fields.map((item) => item.kind)).toEqual(["text"]);
  });

  it("aplanar con desplegable y radio elegidos deja el valor como contenido de la pagina", async () => {
    const bytes = await makeFormPdf({ textFields: [], dropdown: true, radio: true });
    const result = await writeFillForm(
      new Blob([bytes as unknown as BlobPart]),
      [
        { id: "acro-ch-1", value: "México" },
        { id: "acro-ch-2", value: "F" },
      ],
      { flatten: true },
    );
    expect((await PDFDocument.load(result.bytes)).getForm().getFields()).toHaveLength(0);
    if (hasPoppler()) expect(popplerText(result.bytes)).toContain("México");
  });

  it("un desplegable editable admite un texto que no esta en la lista; uno cerrado lo rechaza", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 300]);
    const closed = document.getForm().createDropdown("cerrado");
    closed.addOptions(["a", "b"]);
    closed.addToPage(page, { x: 20, y: 200, width: 100, height: 20 });
    const open = document.getForm().createDropdown("abierto");
    open.addOptions(["a", "b"]);
    open.enableEditing();
    open.addToPage(page, { x: 20, y: 150, width: 100, height: 20 });
    const bytes = await document.save();
    const info = await readFillForm(new Blob([bytes as unknown as BlobPart]));
    const byName = Object.fromEntries(info.fields.map((item) => [item.name, item]));
    expect(byName.abierto.editable).toBe(true);
    expect(byName.cerrado.editable).toBeUndefined();
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [
      { id: byName.abierto.id, value: "libre" },
      { id: byName.cerrado.id, value: "libre" },
    ]);
    expect(result.written).toEqual([byName.abierto.id]);
    expect(result.skipped).toEqual([{ id: byName.cerrado.id, reason: "invalid" }]);
  });

  it("el maximo de caracteres cuenta puntos de codigo (un emoji es uno), no unidades UTF-16", async () => {
    const bytes = await makeFormPdf({ textFields: ["a"], maxLengthText: 3 });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-1", value: "a😀b😀c" }]);
    expect(result.truncated).toEqual(["acro-1"]);
  });

  it("euro, comillas curvas y guion largo se pintan (estan en WinAnsi) y poppler los lee", async () => {
    const bytes = await makeFormPdf({ textFields: ["a"] });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-1", value: "10 € “ok” — fin" }]);
    expect(result.unsupportedChars).toEqual([]);
    if (hasPoppler()) expect(popplerText(result.bytes)).toContain("10 €");
  });

  it("escribir no cambia el numero de paginas ni el texto de la pagina", async () => {
    const bytes = await makeFormPdf({ pages: 3, textFields: ["a"] });
    const result = await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-1", value: "x" }]);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(3);
    expect(await pdfjsPageText(result.bytes, 3)).toContain("Hoja 3 del formulario");
  });

  it("el progreso llega a 1", async () => {
    const seen: number[] = [];
    const bytes = await makeFormPdf({ textFields: ["a"] });
    await writeFillForm(new Blob([bytes as unknown as BlobPart]), [{ id: "acro-1", value: "x" }], {}, (value) => seen.push(value));
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});
