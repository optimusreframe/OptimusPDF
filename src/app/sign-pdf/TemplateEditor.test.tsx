import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoMapResult } from "@/lib/pdf/autoMapTypes";
import type { SignatureField } from "@/lib/pdf/sign";
import type { DetectedField } from "@/lib/pdf/detectFields";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { emptyContent, type EditorContent } from "@/app/sign-pdf/templateEditorModel";
import type { DocumentCanvasProps } from "@/app/sign-pdf/DocumentCanvas";
import { TemplateEditor, type EditorOutcome } from "@/app/sign-pdf/TemplateEditor";

const mocks = vi.hoisted(() => ({
  autoMapFile: vi.fn(),
  save: vi.fn(),
  pageCount: 6,
  /** Si hay una promesa aqui, `loadPdf` espera a que se resuelva (para ver el editor antes de conocer las paginas). */
  gate: null as Promise<void> | null,
}));
vi.mock("@/lib/pdf/autoMapFile", () => ({ autoMapFile: mocks.autoMapFile }));
vi.mock("@/lib/pdf/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/pdf/core")>()), loadPdf: async () => {
    await mocks.gate;
    return { getPageCount: () => mocks.pageCount };
  } }));
vi.mock("@/app/sign-pdf/templateLibrary", () => ({ saveTemplateToLibrary: mocks.save }));

let canvas: DocumentCanvasProps;
/** El lienzo de verdad (pdf.js) tiene sus propias pruebas: aqui es un doble que deja hacer lo que haria la persona. */
vi.mock("@/app/sign-pdf/DocumentCanvas", () => {
  let signCounter = 0;
  return {
    nextFieldId: () => `fld-t${(signCounter += 1)}`,
    nextTextFieldId: () => `txt-t${(signCounter += 1)}`,
    DocumentCanvas: (props: DocumentCanvasProps) => {
      canvas = props;
      return (
        <div data-testid="canvas" data-signers={props.signers.map((s) => s.name).join("|")} data-page={props.pageIndex}>
          {props.signers.map((signer) => (
            <button key={signer.id} type="button" onClick={() => props.onActiveSignerIdChange(signer.id)}>
              {`firmante ${signer.name}`}
            </button>
          ))}
          <button type="button" onClick={() => props.onSlotsChange([...props.slots, { id: `fld-${props.slots.length}-${props.pageIndex}-i`, signerId: props.activeSignerId ?? props.signers[0].id, pageIndex: props.pageIndex, type: "initials", rect: { x: 0.74, y: 0.885, width: 0.13, height: 0.045 } }])}>
            colocar iniciales
          </button>
          <button type="button" onClick={() => props.onSlotsChange([...props.slots, { id: `fld-${props.slots.length}-${props.pageIndex}-s`, signerId: props.activeSignerId ?? props.signers[0].id, pageIndex: props.pageIndex, type: "signature", rect: { x: 0.1, y: 0.5, width: 0.3, height: 0.05 } }])}>
            colocar firma
          </button>
          <button type="button" onClick={() => props.onTextFieldsChange([...props.textFields, { id: "txt-new", pageIndex: props.pageIndex, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.03 }, source: "manual", confidence: "high", type: "date" }])}>
            colocar fecha
          </button>
          <button type="button" onClick={() => props.onSelectionChange({ kind: "text", id: "txt-new" })}>
            elegir fecha
          </button>
          <button type="button" onClick={() => props.onPageIndexChange(props.pageIndex + 1)}>
            pagina siguiente
          </button>
          <button type="button" onClick={() => props.onSlotsChange(props.slots.map((slot, index) => (index === 0 ? { ...slot, rect: { ...slot.rect, x: slot.rect.x - 0.02 } } : slot)))}>
            mover primero
          </button>
          <span data-testid="slots">{props.slots.map((s) => `${s.pageIndex}:${s.signerId}:${s.type}:${s.rect.x.toFixed(3)}`).join(",")}</span>
        </div>
      );
    },
  };
});

const strings = SIGN_STRINGS.es;
const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const FILE = new File(["%PDF-1.4"], "Contrato.pdf", { type: "application/pdf" });

function fakeSaved(pages = 6) {
  return {
    ok: true as const,
    template: { id: "tpl-1", rev: 1 },
    document: { id: "doc-1" },
    createdDocument: true,
    pages,
    persistence: { granted: false, supported: true },
    fingerprint: { pageCount: pages },
  };
}

function setup(over: { initial?: EditorContent; variant?: "1" | "2"; template?: { id: string; rev: number } | null; documentId?: string | null } = {}) {
  const onClose = vi.fn<(outcome: EditorOutcome) => void>();
  const view = render(
    <TemplateEditor
      file={FILE}
      language="es"
      strings={strings}
      initial={over.initial ?? emptyContent("Contrato", "es")}
      initialVariant={over.variant ?? "2"}
      documentId={over.documentId ?? null}
      template={over.template ?? null}
      onClose={onClose}
    />,
  );
  return { onClose, ...view };
}
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const slots = () => screen.getByTestId("slots").textContent ?? "";
/** Espera a que el editor conozca las paginas del PDF (hasta entonces «Repetir» esta apagado). */
const ready = () => waitFor(() => expect((screen.getByRole("button", { name: "Repetir iniciales en todas las páginas" }) as HTMLButtonElement).disabled).toBe(false));
const live = () => document.querySelector("[data-template-live]")?.textContent ?? "";

beforeEach(() => {
  mocks.pageCount = 6;
  mocks.gate = null;
  mocks.autoMapFile.mockReset();
  mocks.save.mockReset().mockResolvedValue(fakeSaved());
});
afterEach(() => cleanup());

describe("editor de plantillas", () => {
  it("el lienzo ve los dos roles como firmantes en la variante de 2 y solo el primero en la de 1", () => {
    setup();
    expect(screen.getByTestId("canvas").dataset.signers).toBe("Asegurado|Co-asegurado");
    fireEvent.click(screen.getByRole("tab", { name: "1 firmante" }));
    expect(screen.getByTestId("canvas").dataset.signers).toBe("Asegurado");
    expect(live()).toContain("Variante de 1 firmante");
  });

  it("repetir iniciales con 2 firmantes: una al lado de la otra, firmante 1 a la izquierda, en TODAS las páginas", async () => {
    setup();
    await ready();
    click("colocar iniciales");
    click("Repetir iniciales en todas las páginas");
    const text = slots();
    const entries = text.split(",");
    expect(entries).toHaveLength(12);
    for (let page = 0; page < 6; page += 1) {
      const left = entries.find((entry) => entry.startsWith(`${page}:signer1:initials`))!;
      const right = entries.find((entry) => entry.startsWith(`${page}:signer2:initials`))!;
      expect(Number(left.split(":")[3])).toBeLessThan(Number(right.split(":")[3]));
    }
    expect(live()).toContain("Iniciales repetidas en 6 páginas, una al lado de la otra");
  });

  it("repetir iniciales con 1 firmante: las iniciales ocupan la línea entera", async () => {
    setup({ variant: "1" });
    await ready();
    click("colocar iniciales");
    click("Repetir iniciales en todas las páginas");
    expect(slots().split(",")).toHaveLength(6);
    expect(slots().split(",").every((entry) => entry.includes(":signer1:initials:0.740"))).toBe(true);
    expect(live()).toContain("Iniciales repetidas en 6 páginas.");
  });

  it("«Repetir» espera a conocer las páginas del PDF (apagado hasta entonces)", async () => {
    let open: () => void = () => {};
    mocks.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    setup();
    const button = screen.getByRole("button", { name: "Repetir iniciales en todas las páginas" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Repetir en ese rango" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => open());
    await ready();
  });

  it("sin iniciales colocadas avisa y no hace nada", async () => {
    setup();
    await ready();
    click("Repetir iniciales en todas las páginas");
    expect(slots()).toBe("");
    expect(live()).toContain("Primero coloca las iniciales");
  });

  it("repetir en páginas N a M y rango no válido", async () => {
    setup();
    await ready();
    click("colocar iniciales");
    fireEvent.click(screen.getByText("Repetir solo en un rango de páginas"));
    fireEvent.change(screen.getByLabelText("Desde la página"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Hasta la página"), { target: { value: "4" } });
    click("Repetir en ese rango");
    // la página 1 (la colocada a mano) + 3 y 4, dos firmantes cada una
    expect(slots().split(",").map((e) => e.split(":")[0]).sort()).toEqual(["0", "2", "2", "3", "3"]);
    fireEvent.change(screen.getByLabelText("Hasta la página"), { target: { value: "2" } });
    click("Repetir en ese rango");
    expect(live()).toContain("El rango de páginas no es válido");
    fireEvent.change(screen.getByLabelText("Hasta la página"), { target: { value: "99" } });
    click("Repetir en ese rango");
    expect(live()).toContain("El rango de páginas no es válido");
  });

  it("«Igualar a la página anterior» solo se ofrece con iniciales en la anterior y las copia", () => {
    setup({ variant: "1" });
    const match = screen.getByRole("button", { name: "Igualar a la página anterior" });
    expect((match as HTMLButtonElement).disabled).toBe(true);
    click("colocar iniciales");
    click("mover primero");
    click("pagina siguiente");
    expect((screen.getByRole("button", { name: "Igualar a la página anterior" }) as HTMLButtonElement).disabled).toBe(false);
    click("Igualar a la página anterior");
    expect(slots()).toBe("0:signer1:initials:0.720,1:signer1:initials:0.720");
    expect(live()).toContain("Las iniciales de la página 2 quedaron como las de la anterior");
  });

  it("deshacer y rehacer: botones, teclado y un arrastre cuenta como UN paso", () => {
    setup({ variant: "1" });
    const undo = screen.getByRole("button", { name: "Deshacer" });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    click("colocar iniciales");
    click("colocar firma");
    expect(slots().split(",")).toHaveLength(2);
    click("Deshacer");
    expect(slots().split(",")).toHaveLength(1);
    click("Rehacer");
    expect(slots().split(",")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(slots().split(",")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(slots().split(",")).toHaveLength(2);
    // dos movimientos seguidos del mismo campo = un solo paso
    click("mover primero");
    click("mover primero");
    expect(slots()).toContain("0.700");
    click("Deshacer");
    expect(slots()).toContain("0.740");
  });

  it("las variantes se editan por separado y se puede copiar de una a otra", async () => {
    setup({ variant: "1" });
    await ready();
    click("colocar iniciales");
    click("Repetir iniciales en todas las páginas");
    fireEvent.click(screen.getByRole("tab", { name: "2 firmantes" }));
    expect(slots()).toBe("");
    click("Copiar de la variante de 1 firmante");
    const entries = slots().split(",");
    expect(entries).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /Copiar de la variante/ })).toBeNull();
    expect(live()).toContain("Copiado a la variante de 2 firmantes");
    fireEvent.click(screen.getByRole("tab", { name: "1 firmante" }));
    expect(slots().split(",")).toHaveLength(6);
  });

  it("los roles son editables y se ven en el lienzo", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Firmante 1"), { target: { value: "Propietario" } });
    expect(screen.getByTestId("canvas").dataset.signers).toBe("Propietario|Co-asegurado");
  });

  it("campo de texto: etiqueta, origen del dato y regla «hoy» de la fecha", () => {
    setup();
    click("colocar fecha");
    click("elegir fecha");
    const panel = document.querySelector("[data-text-field-panel]") as HTMLElement;
    expect(panel).not.toBeNull();
    const dateBox = within(panel).getByLabelText("Poner la fecha de hoy al firmar") as HTMLInputElement;
    expect(dateBox.checked).toBe(true);
    fireEvent.change(within(panel).getByLabelText("Etiqueta"), { target: { value: "Fecha de firma" } });
    fireEvent.change(within(panel).getByLabelText("Origen del dato"), { target: { value: "lossDate" } });
    expect((within(panel).getByLabelText("Origen del dato") as HTMLSelectElement).value).toBe("lossDate");
    fireEvent.click(dateBox);
    expect((within(panel).getByLabelText("Poner la fecha de hoy al firmar") as HTMLInputElement).checked).toBe(false);
    expect(canvas.textFields[0].label).toBe("Fecha de firma");
  });

  it("detectar campos: coloca los seguros con aviso para deshacer y deja las sugerencias aceptables una a una o todas", async () => {
    const result: AutoMapResult = {
      fields: [
        { id: "am-0-1", pageIndex: 0, rect: R(0.74, 0.885, 0.065, 0.045), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "r", source: "label" },
        { id: "am-0-2", pageIndex: 0, rect: R(0.81, 0.885, 0.065, 0.045), type: "initials", signerIndex: 1, confidence: 0.9, tier: "high", reason: "r", source: "label" },
        { id: "am-2-1", pageIndex: 2, rect: R(0.1, 0.5, 0.3, 0.05), type: "signature", signerIndex: 0, confidence: 0.5, tier: "review", reason: "r", source: "geometry" },
        { id: "am-3-1", pageIndex: 3, rect: R(0.1, 0.5, 0.3, 0.05), type: "signature", signerIndex: 1, confidence: 0.5, tier: "review", reason: "r", source: "geometry" },
      ],
      pages: [],
      confidenceSummary: { high: 2, review: 2, ignore: 0, byType: { signature: 2, initials: 2, date: 0, text: 0 }, meanHighConfidence: 0.9, maxPerPage: 2 },
      warnings: [],
    };
    mocks.autoMapFile.mockResolvedValue(result);
    setup();
    click("Detectar campos automáticamente");
    await waitFor(() => expect(screen.getByText("Sugerencias (2)", { selector: "h3" })).toBeTruthy());
    expect(mocks.autoMapFile).toHaveBeenCalledWith(FILE, expect.objectContaining({ signers: 2, locale: "es" }), expect.anything());
    expect(slots().split(",")).toHaveLength(2);
    expect(live()).toContain("Colocamos 2 campos con seguridad y hay 2 sugerencias por revisar");
    // Deshacer del aviso: quita lo colocado
    const notice = document.querySelector(".bg-elevated:not(p)") as HTMLElement;
    void notice;
    click("Aceptar: Firma de Asegurado, página 3");
    expect(slots().split(",")).toHaveLength(3);
    expect(screen.getByText("Sugerencias (1)", { selector: "h3" })).toBeTruthy();
    click("Aceptar todas");
    expect(slots().split(",")).toHaveLength(4);
    expect(screen.queryByText(/Sugerencias \(/, { selector: "h3" })).toBeNull();
  });

  it("detectar campos: si se llega al tope de campos por documento lo dice (las páginas del final pueden quedar sin iniciales)", async () => {
    mocks.autoMapFile.mockResolvedValue({
      fields: [{ id: "a", pageIndex: 0, rect: R(0.74, 0.885, 0.13, 0.045), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "r", source: "label" }],
      pages: [],
      confidenceSummary: { high: 1, review: 0, ignore: 0, byType: { signature: 0, initials: 1, date: 0, text: 0 }, meanHighConfidence: 0.9, maxPerPage: 1 },
      warnings: [{ code: "document-field-cap", message: "El documento tenía 120 propuestas; se conservan las 80 más fiables." }],
    } satisfies AutoMapResult);
    setup({ variant: "1" });
    click("Detectar campos automáticamente");
    await waitFor(() => expect(document.querySelector("[data-detect-capped]")).not.toBeNull());
    expect(document.querySelector("[data-detect-capped]")?.textContent).toContain("máximo de 80 campos por documento");
    expect(live()).toContain("máximo de 80 campos por documento");
  });

  it("detectar campos: sin tope no hay aviso de tope", async () => {
    mocks.autoMapFile.mockResolvedValue({
      fields: [{ id: "a", pageIndex: 0, rect: R(0.74, 0.885, 0.13, 0.045), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "r", source: "label" }],
      pages: [],
      confidenceSummary: { high: 1, review: 0, ignore: 0, byType: { signature: 0, initials: 1, date: 0, text: 0 }, meanHighConfidence: 0.9, maxPerPage: 1 },
      warnings: [{ code: "page-field-cap", pageIndex: 0, message: "x" }],
    } satisfies AutoMapResult);
    setup({ variant: "1" });
    click("Detectar campos automáticamente");
    await waitFor(() => expect(slots().split(",")).toHaveLength(1));
    expect(document.querySelector("[data-detect-capped]")).toBeNull();
  });

  it("detectar campos: el aviso ofrece Deshacer mientras sea el último cambio", async () => {
    mocks.autoMapFile.mockResolvedValue({
      fields: [{ id: "a", pageIndex: 0, rect: R(0.74, 0.885, 0.13, 0.045), type: "initials", signerIndex: 0, confidence: 0.9, tier: "high", reason: "r", source: "label" }],
      pages: [],
      confidenceSummary: { high: 1, review: 0, ignore: 0, byType: { signature: 0, initials: 1, date: 0, text: 0 }, meanHighConfidence: 0.9, maxPerPage: 1 },
      warnings: [],
    } satisfies AutoMapResult);
    setup({ variant: "1" });
    click("Detectar campos automáticamente");
    await waitFor(() => expect(slots().split(",")).toHaveLength(1));
    const undoButtons = screen.getAllByRole("button", { name: "Deshacer" });
    expect(undoButtons).toHaveLength(2);
    fireEvent.click(undoButtons[1]);
    expect(slots()).toBe("");
    expect(screen.getAllByRole("button", { name: "Deshacer" })).toHaveLength(1);
  });

  it("un fallo al detectar lo dice y deja colocar a mano", async () => {
    mocks.autoMapFile.mockRejectedValue(new Error("boom"));
    setup();
    click("Detectar campos automáticamente");
    await waitFor(() => expect(screen.getByText(/No se pudieron detectar campos/)).toBeTruthy());
    click("colocar iniciales");
    expect(slots().split(",")).toHaveLength(1);
  });
});

describe("guardar", () => {
  it("guarda la plantilla con los dos roles y las variantes, avisa «aplicada a N páginas» y pide el almacenamiento persistente", async () => {
    const { onClose } = setup();
    await ready();
    click("colocar iniciales");
    click("Repetir iniciales en todas las páginas");
    fireEvent.change(screen.getByLabelText("Nombre de la plantilla"), { target: { value: "Mold Test" } });
    click("Guardar plantilla");
    await waitFor(() => expect(document.querySelector("[data-template-saved]")).not.toBeNull());
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const input = mocks.save.mock.calls[0][0];
    expect(input.file).toBe(FILE);
    expect(input.documentId).toBeNull();
    expect(input.template).toBeNull();
    expect(input.content.name).toBe("Mold Test");
    expect(input.content.variants["2"].fields).toHaveLength(12);
    expect(input.content.variants["1"].fields).toHaveLength(0);
    expect(input.content.roles.map((r: { label: string }) => r.label)).toEqual(["Asegurado", "Co-asegurado"]);
    expect(input.content.layout).toMatchObject({ toPage: "all" });
    expect(document.querySelector("[data-template-saved]")?.textContent).toContain("Plantilla guardada · aplicada a 6 páginas");
    expect(live()).toContain("Plantilla guardada · aplicada a 6 páginas");
    expect(screen.getByText(/Almacenamiento persistente: no concedido/)).toBeTruthy();
    expect(screen.getByText(/Se guarda una copia de este PDF en este navegador; usa contratos en blanco, sin datos de clientes/)).toBeTruthy();
    // Guardar otra vez es una VERSION de la misma plantilla (misma identidad).
    click("Guardar cambios");
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1][0]).toMatchObject({ documentId: "doc-1", template: { id: "tpl-1", rev: 1 } });
    click("Firmar este documento");
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ sign: true, saved: expect.objectContaining({ ok: true }) }));
  });

  it("sin firmas ni iniciales no guarda; sin nombre tampoco", async () => {
    setup();
    click("Guardar plantilla");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(live()).toContain("Coloca al menos una firma o unas iniciales");
    click("colocar firma");
    fireEvent.change(screen.getByLabelText("Nombre de la plantilla"), { target: { value: "  " } });
    click("Guardar plantilla");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByText("Escribe un nombre para la plantilla.")).toBeTruthy();
  });

  it("un fallo del almacén se dice con su motivo y no se da por guardado", async () => {
    mocks.save.mockResolvedValue({ ok: false, reason: "quota" });
    setup();
    click("colocar firma");
    click("Guardar plantilla");
    await waitFor(() => expect(document.querySelector("[data-template-error]")).not.toBeNull());
    expect(document.querySelector("[data-template-error]")?.textContent).toContain("No hay espacio en este navegador");
    expect(document.querySelector("[data-template-saved]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Firmar este documento" })).toBeNull();
  });

  it("m5: si otra pestaña borró o cambió el documento (conflicto) se ofrece «Guardar como documento nuevo» y las ediciones no se pierden", async () => {
    mocks.save.mockResolvedValueOnce({ ok: false, reason: "conflict" });
    setup({ template: { id: "tpl-9", rev: 4 }, documentId: "doc-9" });
    click("colocar firma");
    expect(document.querySelector("[data-template-save-as-new]")).toBeNull();
    click("Guardar cambios");
    await waitFor(() => expect(document.querySelector("[data-template-error]")).not.toBeNull());
    // El mensaje dice qué pasó y que lo editado sigue ahí.
    expect(document.querySelector("[data-template-error]")?.textContent).toContain("Tus cambios siguen en pantalla");
    expect(slots().split(",")).toHaveLength(1);
    const asNew = screen.getByRole("button", { name: "Guardar como documento nuevo" });
    click("Guardar como documento nuevo");
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1][0]).toMatchObject({ documentId: null, template: null, asNewDocument: true });
    expect(mocks.save.mock.calls[1][0].content.variants["2"].fields).toHaveLength(1);
    await waitFor(() => expect(document.querySelector("[data-template-saved]")).not.toBeNull());
    expect(document.querySelector("[data-template-error]")).toBeNull();
    expect(asNew.isConnected).toBe(false);
    // A partir de aqui se edita el documento nuevo (version de SU plantilla).
    click("Guardar cambios");
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(3));
    expect(mocks.save.mock.calls[2][0]).toMatchObject({ documentId: "doc-1", template: { id: "tpl-1" } });
    expect(mocks.save.mock.calls[2][0].asNewDocument).toBeUndefined();
  });

  it("m5: otros fallos (cuota, etc.) no ofrecen «documento nuevo»", async () => {
    mocks.save.mockResolvedValue({ ok: false, reason: "quota" });
    setup({ template: { id: "tpl-9", rev: 4 }, documentId: "doc-9" });
    click("colocar firma");
    click("Guardar cambios");
    await waitFor(() => expect(document.querySelector("[data-template-error]")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Guardar como documento nuevo" })).toBeNull();
  });

  it("editar una plantilla existente guarda versión nueva", async () => {
    setup({ template: { id: "tpl-9", rev: 4 }, documentId: "doc-9" });
    click("colocar firma");
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeTruthy();
    click("Guardar cambios");
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ documentId: "doc-9", template: { id: "tpl-9", rev: 4 } });
  });

  it("cerrar con cambios pregunta; sin cambios cierra", async () => {
    const { onClose } = setup();
    click("Cerrar");
    expect(onClose).toHaveBeenCalledWith({ saved: null, sign: false });
    onClose.mockClear();
    click("colocar firma");
    click("Cerrar");
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText("¿Salir sin guardar?")).toBeTruthy();
    click("Salir sin guardar");
    expect(onClose).toHaveBeenCalledWith({ saved: null, sign: false });
  });

  it("en inglés", () => {
    render(<TemplateEditor file={FILE} language="en" strings={SIGN_STRINGS.en} initial={emptyContent("Contract", "en")} initialVariant="2" documentId={null} template={null} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "Set up template" })).toBeTruthy();
    expect(screen.getByText(/A copy of this PDF is stored in this browser/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Repeat initials on all pages" })).toBeTruthy();
    expect(screen.getByTestId("canvas").dataset.signers).toBe("Insured|Co-insured");
  });
});

void act;
void (null as unknown as SignatureField | DetectedField);
