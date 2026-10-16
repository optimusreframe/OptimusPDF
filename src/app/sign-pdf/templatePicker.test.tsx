import { afterEach, describe, expect, it } from "vitest";
import { pickPdfFile } from "@/app/sign-pdf/templatePicker";

afterEach(() => {
  document.body.innerHTML = "";
});

const pdfInputs = () => document.body.querySelectorAll('input[type="file"]');

describe("elegir un PDF para configurar su plantilla", () => {
  it("crea el selector al tocar, devuelve el PDF elegido y lo quita de la página", async () => {
    const pending = pickPdfFile();
    const inputs = pdfInputs();
    expect(inputs).toHaveLength(1);
    const input = inputs[0] as HTMLInputElement;
    expect(input.accept).toContain("pdf");
    const file = new File(["%PDF"], "a.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(await pending).toBe(file);
    expect(pdfInputs()).toHaveLength(0);
  });

  it("cancelar devuelve null y también lo quita", async () => {
    const pending = pickPdfFile();
    (pdfInputs()[0] as HTMLInputElement).dispatchEvent(new Event("cancel"));
    expect(await pending).toBeNull();
    expect(pdfInputs()).toHaveLength(0);
  });
});
