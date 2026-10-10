import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import JSZip from "jszip";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import { ExportEditsNotice } from "@/app/sign-pdf/DocumentSessionParts";
import { exportSignConfigSet } from "@/app/sign-pdf/signConfig";
import { SIGN_TEMPLATES_STORAGE_KEY, saveTemplate, __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";

/**
 * «Exportar configuracion» y las plantillas NO llevan las ediciones del texto original (W6-A):
 * la configuracion es la disposicion (firmantes, huecos, campos), no el contenido. El panel lo
 * dice con un aviso (`role=status`, siempre montado) cuando el documento tiene ediciones.
 */

beforeEach(() => {
  window.localStorage.clear();
  __resetSignTemplatesCacheForTests();
});

describe("ExportEditsNotice", () => {
  it("sin ediciones la region viva esta montada pero vacia (oculta)", () => {
    render(<ExportEditsNotice hasEdits={false} strings={SIGN_STRINGS.es} />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    expect(region.className).toContain("sr-only");
  });

  it("con ediciones explica que no viajan en la configuracion y donde si se guardan (es/en)", () => {
    const { rerender } = render(<ExportEditsNotice hasEdits strings={SIGN_STRINGS.es} />);
    expect(screen.getByRole("status").textContent).toBe(SIGN_STRINGS.es.exportConfigEditsNote);
    expect(SIGN_STRINGS.es.exportConfigEditsNote).toMatch(/borrador/);
    expect(screen.getByRole("status").className).not.toContain("sr-only");
    rerender(<ExportEditsNotice hasEdits strings={SIGN_STRINGS.en} />);
    expect(screen.getByRole("status").textContent).toBe(SIGN_STRINGS.en.exportConfigEditsNote);
    expect(SIGN_STRINGS.en.exportConfigEditsNote).toMatch(/draft/);
  });

  it("el aviso aparece al llegar ediciones (la misma region, no una nueva)", () => {
    const { rerender } = render(<ExportEditsNotice hasEdits={false} strings={SIGN_STRINGS.es} />);
    const region = screen.getByRole("status");
    rerender(<ExportEditsNotice hasEdits strings={SIGN_STRINGS.es} />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).not.toBe("");
  });
});

describe("la configuracion exportada y las plantillas no incluyen ediciones", () => {
  it("el .zip de configuracion no contiene ninguna edicion de texto aunque el documento las tenga", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "doc.pdf", { type: "application/pdf" });
    const edits = [makeEdit({ id: "e1", blockId: "p0-b0", text: "TEXTO-EDITADO-SECRETO" })];
    const blob = await exportSignConfigSet(
      [{ id: "d1", file, fields: [], textFields: [], textValues: {}, textEdits: edits } as never],
      { mode: "multi", signMode: "same", signers: [], blocks: [] },
    );
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    for (const name of Object.keys(zip.files)) {
      const content = await zip.files[name].async("string");
      expect(content).not.toContain("TEXTO-EDITADO-SECRETO");
      expect(content).not.toContain("textEdits");
    }
  });

  it("una plantilla guardada no incluye ediciones", () => {
    const edits = [makeEdit({ id: "e1", blockId: "p0-b0", text: "TEXTO-EDITADO-SECRETO" })];
    const result = saveTemplate({
      name: "Mi plantilla",
      pageCount: 1,
      signers: [],
      fields: [],
      textFields: [],
      textEdits: edits,
    } as never);
    expect(result).toBe("ok");
    const raw = window.localStorage.getItem(SIGN_TEMPLATES_STORAGE_KEY) ?? "";
    expect(raw).toContain("Mi plantilla");
    expect(raw).not.toContain("TEXTO-EDITADO-SECRETO");
    expect(raw).not.toContain("textEdits");
  });
});
