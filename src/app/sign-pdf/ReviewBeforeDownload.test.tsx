import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReviewBeforeDownload, type ReviewIssueView } from "@/app/sign-pdf/ReviewBeforeDownload";
import { captureForBlock, type BlockContext } from "@/app/sign-pdf/blockModel";
import { EMPTY_DOC_STATE, docIdOf, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/*
 * «Revisar antes de descargar» (U1.3): miniaturas de las paginas con marcas, contadores por documento, problemas
 * bloqueantes y avisos (con «Ir a corregirlo»), salto a una pagina y modo reducido (solo problemas).
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({ numPages: 4, getPage: async () => ({ cleanup: () => {} }) }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});

const es = SIGN_STRINGS.es;
const rv = es.review;
const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const SIG = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.5 };
const INI = { dataUrl: "data:image/png;base64,BBBB", ratio: 1 };
const RECT = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };

const FILE_1 = new File([new Uint8Array([1, 2, 3, 4])], "Contrato.pdf", { type: "application/pdf" });
const FILE_2 = new File([new Uint8Array([5, 6, 7, 8])], "Anexo.pdf", { type: "application/pdf" });
const D1 = docIdOf(FILE_1);
const D2 = docIdOf(FILE_2);
const DOCS = [{ id: D1, name: "Contrato.pdf" }, { id: D2, name: "Anexo.pdf" }];

const slot = (id: string, pageIndex: number, type: SignatureField["type"]): SignatureField => ({ id, signerId: ANA.id, pageIndex, type, rect: RECT });

function setup(opts: { initialsPages?: number[]; sign?: boolean; text?: boolean } = {}) {
  const { initialsPages = [0, 1, 2, 3], sign = true, text = false } = opts;
  const textField: DetectedField = { id: "t1", pageIndex: 1, rect: RECT, source: "acroform", confidence: "high" };
  const docStates: Record<string, DocState> = {
    [D1]: {
      ...EMPTY_DOC_STATE,
      fields: [...initialsPages.map((page) => slot(`i${page}`, page, "initials")), slot("s1", 3, "signature")],
      ...(text ? { textFields: [textField], textValues: { t1: "x" } } : {}),
    },
    [D2]: { ...EMPTY_DOC_STATE, fields: [slot("s2", 0, "signature")] },
  };
  const ctx: BlockContext = { signers: [ANA], docs: docStates, keys: { [D1]: "k1", [D2]: "k2" } };
  let blocks: SignerBlock[] = [
    { id: "b1", signerId: ANA.id, appliesTo: [D1, D2], signature: null, initials: null, stamps: {}, auto: true },
  ];
  if (sign) blocks = captureForBlock(blocks, "b1", { signature: SIG, initials: INI }, ctx);
  return { docStates, ctx, blocks };
}

const baseProps = () => {
  const { docStates, ctx, blocks } = setup();
  return { strings: es, signers: [ANA], docs: DOCS, docStates, blocks, ctx, files: [FILE_1, FILE_2], issues: [] as ReviewIssueView[], fileCount: 2 };
};

describe("ReviewBeforeDownload — pantalla completa", () => {
  it("una miniatura por pagina con marcas de cada documento, con su pagina y lo que lleva", async () => {
    const props = baseProps();
    render(<ReviewBeforeDownload {...props} onGoToPage={() => {}} />);
    expect(screen.getByRole("heading", { name: rv.title })).toBeTruthy();
    const contrato = screen.getByRole("heading", { name: /^Contrato/ }).closest("li") as HTMLElement;
    const tiles = within(contrato).getAllByRole("button");
    expect(tiles).toHaveLength(4);
    expect(tiles[3].getAttribute("aria-label")).toContain(rv.thumbGo("Contrato", 4));
    expect(tiles[3].getAttribute("aria-label")).toContain("firma, iniciales");
    expect(tiles[0].getAttribute("aria-label")).toContain("iniciales");
    expect(tiles[0].getAttribute("aria-label")).not.toContain("firma,");
    const anexo = screen.getByRole("heading", { name: /^Anexo/ }).closest("li") as HTMLElement;
    expect(within(anexo).getAllByRole("button")).toHaveLength(1);
    await waitFor(() => expect(contrato.querySelectorAll("img")).toHaveLength(4));
  });

  it("contadores por documento: «Iniciales: 4 de 4 · Firmas: 1 de 1»", async () => {
    render(<ReviewBeforeDownload {...baseProps()} />);
    const contrato = screen.getByRole("heading", { name: /^Contrato/ }).closest("li") as HTMLElement;
    expect(within(contrato).getByText(rv.counterInitials(4, 4))).toBeTruthy();
    expect(within(contrato).getByText(rv.counterSignatures(1, 1))).toBeTruthy();
    const anexo = screen.getByRole("heading", { name: /^Anexo/ }).closest("li") as HTMLElement;
    expect(within(anexo).queryByText(/Iniciales/)).toBeNull();
    expect(within(anexo).getByText(rv.counterSignatures(1, 1))).toBeTruthy();
  });

  it("el encabezado del documento cuenta paginas con marcas de las del documento cuando ya se conocen", async () => {
    render(<ReviewBeforeDownload {...baseProps()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: rv.docHeading("Contrato", 4, 4) })).toBeTruthy());
    expect(screen.getByRole("heading", { name: rv.docHeading("Anexo", 1, 4) })).toBeTruthy();
  });

  it("faltan iniciales en una pagina del cuerpo: «3 de 4» y un AVISO (no bloquea) con la pagina", async () => {
    const { docStates, ctx, blocks } = setup({ initialsPages: [0, 1, 3] });
    const onGoToPage = vi.fn();
    render(<ReviewBeforeDownload {...baseProps()} docStates={docStates} ctx={ctx} blocks={blocks} onGoToPage={onGoToPage} />);
    const warning = await screen.findByText(rv.initialsMissing("Contrato", "Ana", [3]));
    const row = warning.closest("li") as HTMLElement;
    expect(row.getAttribute("data-issue-severity")).toBe("warning");
    await waitFor(() => expect(screen.getByText(rv.counterInitials(3, 4))).toBeTruthy());
    expect(screen.getByText(rv.warningsTitle)).toBeTruthy();
    // Sin problemas bloqueantes dice que esta listo.
    expect(screen.queryByText(rv.blockedTitle)).toBeNull();
    expect(screen.getByText(`${rv.readyTitle}. ${rv.readyBody(2)}`)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: es.assignment.fixIt }));
    expect(onGoToPage).toHaveBeenCalledWith(D1, 2);
  });

  it("los problemas BLOQUEANTES van primero, con «Ir a corregirlo», y quitan el «todo listo»", () => {
    const fix = vi.fn();
    render(
      <ReviewBeforeDownload
        {...baseProps()}
        issues={[
          { key: "1", severity: "blocking", text: "Nadie firma Anexo.", onFix: fix },
          { key: "2", severity: "warning", text: "Aviso suelto." },
        ]}
      />,
    );
    const blocking = screen.getByText(rv.blockedTitle).closest("div") as HTMLElement;
    expect(within(blocking).getByText("Nadie firma Anexo.")).toBeTruthy();
    fireEvent.click(within(blocking).getByRole("button", { name: es.assignment.fixIt }));
    expect(fix).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Aviso suelto.")).toBeTruthy();
    // El aviso sin destino no ofrece boton.
    expect(screen.getAllByRole("button", { name: es.assignment.fixIt })).toHaveLength(1);
    expect(screen.queryByText(new RegExp(rv.readyTitle))).toBeNull();
  });

  it("tocar una miniatura salta a ESA pagina de ESE documento", () => {
    const onGoToPage = vi.fn();
    render(<ReviewBeforeDownload {...baseProps()} onGoToPage={onGoToPage} />);
    const anexo = screen.getByRole("heading", { name: /^Anexo/ }).closest("li") as HTMLElement;
    fireEvent.click(within(anexo).getAllByRole("button")[0]);
    expect(onGoToPage).toHaveBeenCalledWith(D2, 0);
    const contrato = screen.getByRole("heading", { name: /^Contrato/ }).closest("li") as HTMLElement;
    fireEvent.click(within(contrato).getAllByRole("button")[2]);
    expect(onGoToPage).toHaveBeenLastCalledWith(D1, 2);
  });

  it("sin `onGoToPage` las miniaturas no son botones (solo informan)", () => {
    render(<ReviewBeforeDownload {...baseProps()} />);
    const contrato = screen.getByRole("heading", { name: /^Contrato/ }).closest("li") as HTMLElement;
    expect(within(contrato).queryAllByRole("button")).toHaveLength(0);
    expect(within(contrato).getAllByRole("group")).toHaveLength(4);
  });

  it("marcas pendientes (sin firmar) se dibujan discontinuas y las hechas continuas; el estado tambien va en texto", () => {
    const signed = setup();
    const { container, rerender } = render(<ReviewBeforeDownload {...baseProps()} docStates={signed.docStates} ctx={signed.ctx} blocks={signed.blocks} />);
    expect(container.querySelectorAll("[data-mark][data-done]").length).toBe(6);
    const unsigned = setup({ sign: false });
    rerender(<ReviewBeforeDownload {...baseProps()} docStates={unsigned.docStates} ctx={unsigned.ctx} blocks={unsigned.blocks} />);
    expect(container.querySelectorAll("[data-mark][data-done]").length).toBe(0);
    expect(container.querySelectorAll("[data-mark]").length).toBe(6);
    expect(screen.getByText(rv.counterInitials(0, 4))).toBeTruthy();
    expect(screen.getAllByText(rv.counterSignatures(0, 1))).toHaveLength(2);
  });

  it("campos de texto: contador «Texto: 1 de 1» y la pagina del campo aparece", () => {
    const { docStates, ctx, blocks } = setup({ text: true });
    render(<ReviewBeforeDownload {...baseProps()} docStates={docStates} ctx={ctx} blocks={blocks} />);
    expect(screen.getByText(rv.counterText(1, 1))).toBeTruthy();
  });

  it("un documento sin nada que lleve dice «no lleva firmas, iniciales ni texto»", () => {
    const { ctx, blocks } = setup();
    const docStates = { [D1]: EMPTY_DOC_STATE, [D2]: EMPTY_DOC_STATE };
    render(<ReviewBeforeDownload {...baseProps()} docStates={docStates} ctx={{ ...ctx, docs: docStates }} blocks={blocks} />);
    expect(screen.getAllByText(rv.noMarks)).toHaveLength(2);
  });

  it("no es una region viva y en ingles sale entero", () => {
    const en = SIGN_STRINGS.en;
    const props = baseProps();
    render(<ReviewBeforeDownload {...props} strings={en} />);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: en.review.title })).toBeTruthy();
    expect(screen.getByText(en.review.counterInitials(4, 4))).toBeTruthy();
    expect(screen.getByText(`${en.review.readyTitle}. ${en.review.readyBody(2)}`)).toBeTruthy();
  });
});

describe("ReviewBeforeDownload — modo reducido (aun hay firmas por recoger)", () => {
  it("solo los problemas: sin titulo, sin miniaturas ni contadores", () => {
    const { container } = render(
      <ReviewBeforeDownload {...baseProps()} mode="issues" issues={[{ key: "1", severity: "blocking", text: "Falta algo.", onFix: () => {} }]} />,
    );
    expect(screen.getByText("Falta algo.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: rv.title })).toBeNull();
    expect(container.querySelectorAll("img, [data-mark]").length).toBe(0);
  });
  it("sin problemas no pinta nada", () => {
    const { container } = render(<ReviewBeforeDownload {...baseProps()} mode="issues" />);
    expect(container.innerHTML).toBe("");
  });
});
