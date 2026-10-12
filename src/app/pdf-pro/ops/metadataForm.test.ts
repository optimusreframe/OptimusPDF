import { describe, expect, it } from "vitest";
import {
  EMPTY_METADATA_FORM,
  dateToInput,
  formFromInfo,
  hasPatch,
  inputToDate,
  patchFromForm,
} from "@/app/pdf-pro/ops/metadataForm";
import type { PdfMetadataInfo } from "@/lib/pdf/metadata";

const INFO: PdfMetadataInfo = {
  title: "Informe",
  author: "Ana",
  subject: "",
  keywords: "a, b",
  creator: "App",
  producer: "Motor",
  creationDate: new Date(2024, 2, 5, 10, 20, 30),
  modificationDate: null,
  hasXmp: false,
  customKeys: [],
};

describe("fechas del formulario", () => {
  it("dateToInput usa la hora local sin segundos y devuelve vacio para nulo o invalido", () => {
    expect(dateToInput(new Date(2024, 0, 2, 3, 4, 59))).toBe("2024-01-02T03:04");
    expect(dateToInput(null)).toBe("");
    expect(dateToInput(new Date("x"))).toBe("");
  });

  it("inputToDate es la inversa y rechaza lo que no es datetime-local", () => {
    const date = inputToDate("2024-03-05T10:20")!;
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]).toEqual([2024, 2, 5, 10, 20]);
    expect(inputToDate("")).toBeNull();
    expect(inputToDate("2024-03-05")).toBeNull();
    expect(inputToDate("basura")).toBeNull();
  });
});

describe("patchFromForm", () => {
  it("un formulario sin tocar no genera parche", () => {
    expect(patchFromForm(formFromInfo(INFO), INFO)).toEqual({});
    expect(hasPatch(patchFromForm(formFromInfo(INFO), INFO))).toBe(false);
  });

  it("solo incluye los campos de texto que cambiaron", () => {
    const form = { ...formFromInfo(INFO), title: "Nuevo", keywords: "a, b, c" };
    expect(patchFromForm(form, INFO)).toEqual({ title: "Nuevo", keywords: "a, b, c" });
  });

  it("vaciar un campo lo pide como cadena vacia (quitar)", () => {
    expect(patchFromForm({ ...formFromInfo(INFO), author: "" }, INFO)).toEqual({ author: "" });
  });

  it("una fecha intacta no entra (conserva sus segundos) y una cambiada si", () => {
    expect(patchFromForm(formFromInfo(INFO), INFO).creationDate).toBeUndefined();
    const changed = patchFromForm({ ...formFromInfo(INFO), creationDate: "2025-01-01T00:00" }, INFO).creationDate as Date;
    expect(changed.getFullYear()).toBe(2025);
  });

  it("borrar una fecha existente pide `null`; rellenar una vacia la crea", () => {
    expect(patchFromForm({ ...formFromInfo(INFO), creationDate: "" }, INFO).creationDate).toBeNull();
    const created = patchFromForm({ ...formFromInfo(INFO), modificationDate: "2026-10-12T12:00" }, INFO).modificationDate as Date;
    expect(created.getMonth()).toBe(9);
  });

  it("el formulario vacio sobre un documento vacio no genera parche", () => {
    const empty = { ...INFO, title: "", author: "", keywords: "", creator: "", producer: "", creationDate: null };
    expect(patchFromForm(EMPTY_METADATA_FORM, empty)).toEqual({});
  });
});
