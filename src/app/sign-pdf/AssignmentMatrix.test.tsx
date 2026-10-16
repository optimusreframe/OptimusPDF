import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AssignmentMatrix, type AssignmentChange } from "@/app/sign-pdf/AssignmentMatrix";
import { groupsMatrix } from "@/app/sign-pdf/assignment";
import type { Issue } from "@/app/sign-pdf/assignmentValidation";
import type { SignMode, SignerBlock } from "@/app/sign-pdf/docSet";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider } from "@/lib/i18n";
import type { Signer } from "@/lib/pdf/sign";

/*
 * `AssignmentMatrix` (U1.2) con un anfitrion minimo que guarda lo que la tabla pide (bloques, modo y copias): alternar
 * celdas, atajos, copias con topes, «Deshacer» con su pila corta, confirmacion de trazos afectados, teclado, problemas y
 * estructura de tarjetas en pantalla estrecha.
 */

const es = SIGN_STRINGS.es;
const en = SIGN_STRINGS.en;
const asg = es.assignment;
const ANA: Signer = { id: "s1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "s2", name: "Luis", color: "#0f9d68" };
const DOCS = ["d1", "d2", "d3", "d4"].map((id, index) => ({ id, name: `${["Contrato", "Anexo", "Carta", "Autorización"][index]}.pdf` }));
const SIG = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.5 };

const blk = (id: string, signerId: string, appliesTo: string[], extra: Partial<SignerBlock> = {}): SignerBlock => ({
  id, signerId, appliesTo, signature: null, initials: null, stamps: {}, auto: false, ...extra,
});
const ALL = (signerId: string, id: string) => blk(id, signerId, ["d1", "d2", "d3", "d4"], { auto: true });

type Log = { change: AssignmentChange[]; announce: string[] };

function Host({
  signers = [ANA],
  initial,
  copies: initialCopies = {},
  mode = "same",
  issues = [],
  strings = es,
  log,
  docs = DOCS,
}: {
  signers?: Signer[];
  initial: SignerBlock[];
  copies?: Record<string, number>;
  mode?: SignMode;
  issues?: Issue[];
  strings?: typeof es;
  log?: Log;
  docs?: { id: string; name: string }[];
}) {
  const [blocks, setBlocks] = useState(initial);
  const [signMode, setSignMode] = useState<SignMode>(mode);
  const [copies, setCopies] = useState(initialCopies);
  return (
    <LanguageProvider>
      <pre data-testid="state">{JSON.stringify({ mode: signMode, copies, groups: groupsMatrix(blocks, docs.map((d) => d.id), signers).cells })}</pre>
      <button type="button" onClick={() => setBlocks((b) => [...b])}>externo</button>
      <AssignmentMatrix
        signers={signers}
        docs={docs}
        blocks={blocks}
        signMode={signMode}
        copies={Object.fromEntries(docs.map((d) => [d.id, copies[d.id] ?? 1]))}
        issues={issues}
        strings={strings}
        onAnnounce={(text) => log?.announce.push(text)}
        onChange={(change) => {
          log?.change.push(change);
          setBlocks(change.blocks);
          setSignMode(change.signMode);
          if (change.copies) setCopies(change.copies);
        }}
      />
    </LanguageProvider>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}") as { mode: string; copies: Record<string, number>; groups: (string | null)[][] };
const col = (index = 0) => state().groups.map((row) => row[index]);
const cell = (signer: string, doc: string, group: string | null) =>
  screen.getByRole("button", { name: asg.cellLabel(signer, doc, group === null ? null : asg.group(group)) }) as HTMLButtonElement;
const newLog = (): Log => ({ change: [], announce: [] });

describe("AssignmentMatrix — celdas", () => {
  it("el caso del usuario: 4 documentos, un firmante, «Por grupos» da A A B B de UN toque", () => {
    const log = newLog();
    render(<Host initial={[ALL("s1", "b1")]} log={log} />);
    expect(col()).toEqual(["A", "A", "A", "A"]);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutGroups }));
    expect(col()).toEqual(["A", "A", "B", "B"]);
    expect(state().mode).toBe("same");
    expect(log.announce).toEqual([asg.shortcutApplied(asg.shortcutGroups)]);
  });

  it("o a mano: tocar la 3ª y la 4ª celdas (2 toques) da lo mismo", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    fireEvent.click(cell("Ana", "Carta", "A"));
    fireEvent.click(cell("Ana", "Autorización", "A"));
    expect(col()).toEqual(["A", "A", "B", "B"]);
  });

  it("cada celda tiene nombre accesible «<firmante> en <documento>: <firma>» y su letra visible", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    const chip = cell("Ana", "Anexo", "A");
    expect(chip.textContent).toBe("A");
    expect(chip.getAttribute("title")).toBe("Firma A");
    fireEvent.click(cell("Ana", "Anexo", "A"));
    fireEvent.click(cell("Ana", "Anexo", "B"));
    expect(cell("Ana", "Anexo", null).textContent).toBe("—");
    expect(cell("Ana", "Anexo", null).getAttribute("title")).toBe(asg.noSign);
  });

  it("dos firmantes: cada columna es independiente y la cabecera nombra a cada uno", () => {
    render(<Host signers={[ANA, LUIS]} initial={[ALL("s1", "b1"), ALL("s2", "b2")]} />);
    const grid = screen.getByRole("grid");
    expect(within(grid).getAllByRole("columnheader").map((node) => node.textContent)).toEqual([asg.docColumn, "Ana", "Luis", asg.copiesColumn]);
    fireEvent.click(cell("Luis", "Anexo", "A"));
    expect(col(0)).toEqual(["A", "A", "A", "A"]);
    expect(col(1)).toEqual(["A", "B", "A", "A"]);
  });

  it("un cambio de celda no toca las copias (el cambio no lleva `copies`) y uno de copias si", () => {
    const log = newLog();
    render(<Host initial={[ALL("s1", "b1")]} log={log} />);
    fireEvent.click(cell("Ana", "Carta", "A"));
    expect("copies" in log.change[0]).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Anexo") }));
    expect(log.change[1].copies).toMatchObject({ d2: 2 });
  });

  it("«Una firma por documento» y «Una firma para todos» deriva el modo; «Por grupos» se desactiva con un solo documento", () => {
    const { unmount } = render(<Host signers={[ANA, LUIS]} initial={[ALL("s1", "b1"), ALL("s2", "b2")]} />);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutPerDoc }));
    expect(state().mode).toBe("independent");
    expect(col(0)).toEqual(["A", "B", "C", "D"]);
    expect(col(1)).toEqual(["A", "B", "C", "D"]);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutAll }));
    expect(state().mode).toBe("same");
    unmount();
    render(<Host initial={[blk("b1", "s1", ["d1"], { auto: true })]} docs={DOCS.slice(0, 1)} />);
    expect((screen.getByRole("button", { name: asg.shortcutGroups }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("«no firma» deja el modo en «same» aunque sea una tabla de un grupo por documento con huecos", () => {
    render(<Host signers={[ANA, LUIS]} initial={[ALL("s1", "b1"), ALL("s2", "b2")]} />);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutPerDoc }));
    fireEvent.click(cell("Luis", "Autorización", "D"));
    expect(col(1)).toEqual(["A", "B", "C", null]);
    expect(state().mode).toBe("same");
  });

  it("sin firmantes no hay tabla: pide añadir al menos uno", () => {
    render(<Host signers={[]} initial={[]} />);
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getByText(asg.summaryNoSigners)).toBeTruthy();
  });
});

describe("AssignmentMatrix — teclado y estructura", () => {
  it("rejilla ARIA: un unico punto de tabulacion, flechas, Inicio/Fin y limites", () => {
    render(<Host signers={[ANA, LUIS]} initial={[ALL("s1", "b1"), ALL("s2", "b2")]} />);
    const grid = screen.getByRole("grid");
    expect(grid.getAttribute("aria-rowcount")).toBe("5");
    expect(grid.getAttribute("aria-colcount")).toBe("4");
    const tabbable = () => within(grid).getAllByRole("button").filter((node) => node.hasAttribute("data-cell") && node.tabIndex === 0);
    expect(tabbable()).toHaveLength(1);
    const start = cell("Ana", "Contrato", "A");
    start.focus();
    fireEvent.keyDown(start, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(start); // limite izquierdo
    fireEvent.keyDown(start, { key: "ArrowUp" });
    expect(document.activeElement).toBe(start); // limite superior
    fireEvent.keyDown(start, { key: "End" });
    expect(document.activeElement).toBe(cell("Luis", "Contrato", "A"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cell("Luis", "Contrato", "A")); // limite derecho
    for (let i = 0; i < 6; i += 1) fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cell("Luis", "Autorización", "A")); // limite inferior
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toBe(document.activeElement);
    // Otras teclas no se tocan (Tab, letras): no hay preventDefault.
    const other = fireEvent.keyDown(document.activeElement as HTMLElement, { key: "x" });
    expect(other).toBe(true);
    const arrow = fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(arrow).toBe(false);
  });

  it("filas = tarjetas en estrecho (`flex-col`), tabla desde `sm`; la cabecera solo con tabla; celdas y botones de 44 px", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    const row = cell("Ana", "Anexo", "A").closest('[role="row"]') as HTMLElement;
    expect(row.className).toMatch(/\bflex-col\b/);
    expect(row.className).toContain("sm:grid-cols-(--assignment-cols)");
    const header = screen.getAllByRole("row", { hidden: true })[0];
    expect(header.className).toContain("hidden");
    expect(header.className).toContain("sm:grid");
    expect(cell("Ana", "Anexo", "A").className).toContain("size-11");
    for (const name of [asg.copiesMore("Anexo"), asg.copiesLess("Anexo")]) {
      expect(screen.getByRole("button", { name }).className).toContain("size-11");
    }
    // El nombre del firmante acompaña a su celda en tarjetas.
    expect(within(row).getAllByText("Ana").length).toBeGreaterThan(0);
    // Nada fuerza ancho: los nombres largos parten.
    expect(row.querySelector('[role="rowheader"]')!.className).toContain("[overflow-wrap:anywhere]");
  });
});

describe("AssignmentMatrix — copias", () => {
  it("«+»/«−» por documento con sus limites (1..5) y el resumen cuenta los archivos", () => {
    const log = newLog();
    render(<Host initial={[ALL("s1", "b1")]} log={log} />);
    const less = () => screen.getByRole("button", { name: asg.copiesLess("Contrato") }) as HTMLButtonElement;
    expect(less().disabled).toBe(true);
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Contrato") }));
    expect(state().copies).toMatchObject({ d1: 5 });
    expect(screen.getByText(asg.summaryFiles(8))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Contrato") }));
    expect(log.announce.at(-1)).toBe(asg.copiesAtMax(5));
    expect(screen.getByText(asg.copiesAtMax(5))).toBeTruthy();
    expect(state().copies).toMatchObject({ d1: 5 });
    expect(less().disabled).toBe(false);
    fireEvent.click(less());
    expect(state().copies).toMatchObject({ d1: 4 });
    expect(screen.queryByText(asg.copiesAtMax(5))).toBeNull();
  });

  it("el caso del usuario completo: «Copias de todos» + dos veces la cuenta 4 documentos x 2 = 8 archivos", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutGroups }));
    fireEvent.click(screen.getByRole("button", { name: asg.allCopiesMore }));
    expect(state().copies).toEqual({ d1: 2, d2: 2, d3: 2, d4: 2 });
    expect(screen.getByText(asg.summaryFiles(8))).toBeTruthy();
    expect(col()).toEqual(["A", "A", "B", "B"]);
    // El numero de «Copias de todos» solo se ve cuando todos son iguales.
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Anexo") }));
    const group = screen.getByRole("group", { name: asg.allCopiesLabel });
    expect(group.textContent).toContain("·");
  });

  it("no se puede pasar de 50 archivos: 11 documentos x 5 no cabe y se dice", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, name: `Doc ${i + 1}.pdf` }));
    const log = newLog();
    render(
      <Host
        docs={eleven}
        initial={[blk("b1", "s1", eleven.map((d) => d.id), { auto: true })]}
        copies={Object.fromEntries(eleven.map((d) => [d.id, 4]))}
        log={log}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: asg.allCopiesMore }));
    expect(log.announce.at(-1)).toBe(asg.filesAtMax(50));
    expect(state().copies).toEqual(Object.fromEntries(eleven.map((d) => [d.id, 4])));
    // Uno suelto si cabe hasta llenar los 50: 44 + 6.
    for (let i = 0; i < 6; i += 1) fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Doc 1") }));
    expect(state().copies).toMatchObject({ e0: 5 });
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Doc 2") }));
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Doc 3") }));
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Doc 4") }));
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Doc 5") }));
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Doc 6") }));
    fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Doc 7") }));
    // 44 + 1 (Doc1->5) ... el total llega a 50 y el siguiente se frena con el aviso de archivos.
    expect(log.announce.filter((text) => text === asg.filesAtMax(50)).length).toBeGreaterThanOrEqual(2);
  });
});

describe("AssignmentMatrix — «Deshacer cambio»", () => {
  it("deshace el ultimo cambio (celda), el anterior y asi hasta el limite de la pila (5)", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    const undo = () => screen.getByRole("button", { name: asg.undo }) as HTMLButtonElement;
    const hasUndo = () => screen.queryByRole("button", { name: asg.undo }) !== null;
    expect(hasUndo()).toBe(false);
    fireEvent.click(cell("Ana", "Carta", "A"));
    expect(hasUndo()).toBe(true);
    fireEvent.click(cell("Ana", "Autorización", "A"));
    expect(col()).toEqual(["A", "A", "B", "B"]);
    fireEvent.click(undo());
    expect(col()).toEqual(["A", "A", "B", "A"]);
    fireEvent.click(undo());
    expect(col()).toEqual(["A", "A", "A", "A"]);
    expect(hasUndo()).toBe(false);
  });

  it("recuerda solo los ultimos 5 cambios", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    for (let i = 0; i < 7; i += 1) fireEvent.click(screen.getByRole("button", { name: asg.copiesMore("Contrato") }));
    // Subidas de copias de Contrato: 2,3,4,5 y luego el tope (no cuenta). Son 4 cambios reales.
    expect(state().copies).toMatchObject({ d1: 5 });
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: asg.undo }));
    expect(state().copies).toMatchObject({ d1: 1 });
    expect(screen.queryByRole("button", { name: asg.undo })).toBeNull();
    // 6 cambios de celda: solo se deshacen 5.
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutPerDoc }));
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutAll }));
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutGroups }));
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutPerDoc }));
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutAll }));
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutGroups }));
    let undone = 0;
    while (screen.queryByRole("button", { name: asg.undo }) !== null && undone < 10) {
      fireEvent.click(screen.getByRole("button", { name: asg.undo }));
      undone += 1;
    }
    expect(undone).toBe(5);
  });

  it("deshacer devuelve tambien las copias y el modo exacto de antes", () => {
    const perDoc = (signerId: string) => DOCS.map((doc, index) => blk(`${signerId}-${index}`, signerId, [doc.id]));
    render(<Host signers={[ANA, LUIS]} initial={[...perDoc("s1"), ...perDoc("s2")]} mode="independent" />);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutAll }));
    expect(state().mode).toBe("same");
    fireEvent.click(screen.getByRole("button", { name: asg.undo }));
    expect(state().mode).toBe("independent");
    fireEvent.click(screen.getByRole("button", { name: asg.allCopiesMore }));
    expect(state().copies).toEqual({ d1: 2, d2: 2, d3: 2, d4: 2 });
    fireEvent.click(screen.getByRole("button", { name: asg.undo }));
    expect(state().copies).toEqual({ d1: 1, d2: 1, d3: 1, d4: 1 });
  });

  it("si los bloques cambian por fuera (otra parte de la pantalla), «Deshacer» ya no se ofrece: pisaria ese trabajo", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    fireEvent.click(cell("Ana", "Carta", "A"));
    expect(screen.queryByRole("button", { name: asg.undo })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "externo" }));
    expect(screen.queryByRole("button", { name: asg.undo })).toBeNull();
  });
});

describe("AssignmentMatrix — trazos ya recogidos: confirmacion", () => {
  const withStrokes = () => [
    blk("b1", "s1", ["d1", "d2"], { signature: SIG, stamps: { d1: "x", d2: "y" } }),
    blk("b2", "s1", ["d3", "d4"], { signature: SIG, stamps: { d3: "z", d4: "w" } }),
  ];

  it("«Una firma para todos» se lleva la firma B: pide confirmacion con «Esto borrará la firma B de Ana en 2 documentos»", async () => {
    const log = newLog();
    render(<Host initial={withStrokes()} log={log} />);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutAll }));
    const dialog = await screen.findByRole("dialog", { name: asg.confirmTitle });
    expect(within(dialog).getByText(asg.lostLine("Firma B", "Ana", 2, ["signature"]))).toBeTruthy();
    expect(within(dialog).getByText(asg.lostLine("Firma B", "Ana", 2, ["signature"])).textContent).toBe("Esto borrará la firma B de Ana en 2 documentos.");
    expect(within(dialog).getByText(asg.reconfirmLine("Firma A", "Ana", 2))).toBeTruthy();
    expect(log.change).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: asg.confirmContinue }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(col()).toEqual(["A", "A", "A", "A"]);
    expect(log.change).toHaveLength(1);
  });

  it("«Cancelar» y Escape no cambian nada y lo anuncian", async () => {
    const log = newLog();
    render(<Host initial={withStrokes()} log={log} />);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutAll }));
    const dialog = await screen.findByRole("dialog", { name: asg.confirmTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: asg.confirmCancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(col()).toEqual(["A", "A", "B", "B"]);
    expect(log.change).toHaveLength(0);
    expect(log.announce.at(-1)).toBe(asg.cancelled);

    fireEvent.click(screen.getByRole("button", { name: asg.shortcutAll }));
    await screen.findByRole("dialog", { name: asg.confirmTitle });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(col()).toEqual(["A", "A", "B", "B"]);
    expect(log.change).toHaveLength(0);
  });

  it("sacar un documento a un grupo NUEVO (el grupo solo encoge) no pide nada: encoger no avisa", () => {
    const log = newLog();
    render(<Host initial={[blk("b1", "s1", ["d1", "d2", "d3", "d4"], { signature: SIG, stamps: { d1: "a", d2: "b", d3: "c", d4: "d" } })]} log={log} />);
    fireEvent.click(cell("Ana", "Autorización", "A"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(log.change).toHaveLength(1);
    expect(col()).toEqual(["A", "A", "A", "B"]);
  });

  it("pasar un documento a un grupo que YA tiene firma lo amplia: pide re-confirmar (el firmante no vio ese documento)", async () => {
    render(<Host initial={withStrokes()} />);
    fireEvent.click(cell("Ana", "Anexo", "A")); // d2: A -> B (existente)
    const dialog = await screen.findByRole("dialog", { name: asg.confirmTitle });
    expect(within(dialog).getByText(asg.reconfirmLine("Firma B", "Ana", 1))).toBeTruthy();
  });

  it("si solo hay que re-confirmar (sin borrar) usa el boton primario, no el destructivo", async () => {
    render(<Host initial={[
      blk("b1", "s1", ["d1", "d2"], { signature: SIG, stamps: { d1: "x", d2: "y" } }),
      blk("b2", "s1", ["d3", "d4"]),
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: asg.shortcutAll }));
    const dialog = await screen.findByRole("dialog", { name: asg.confirmTitle });
    expect(within(dialog).queryByText(/Esto borrará/)).toBeNull();
    expect(within(dialog).getByText(asg.reconfirmLine("Firma A", "Ana", 2))).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: asg.confirmContinue }).className).toContain("bg-signal");
  });
});

describe("AssignmentMatrix — resumen y problemas", () => {
  it("el resumen del ejemplo del plan: «Ana firma 4 documentos con 2 firmas: A (…) y B (…)». «Se descargarán 8 archivos.»", () => {
    render(
      <Host
        signers={[ANA, LUIS]}
        initial={[blk("b1", "s1", ["d1", "d2"]), blk("b2", "s1", ["d3", "d4"]), blk("b3", "s2", ["d1", "d2"])]}
        copies={{ d1: 2, d2: 2, d3: 2, d4: 2 }}
      />,
    );
    expect(screen.getByText("Ana firma 4 documentos con 2 firmas: A (Contrato, Anexo) y B (Carta, Autorización).")).toBeTruthy();
    expect(screen.getByText("Luis firma 2 documentos con 1 firma.")).toBeTruthy();
    expect(screen.getByText("Se descargarán 8 archivos.")).toBeTruthy();
  });

  it("nadie firma un documento: lo dice", () => {
    render(<Host initial={[blk("b1", "s1", ["d1", "d2"])]} />);
    expect(screen.getByText(asg.summaryNobody(["Carta", "Autorización"]))).toBeTruthy();
    expect(screen.getByText("Nadie firma: Carta y Autorización.")).toBeTruthy();
  });

  it("los problemas de la validacion salen con su frase y «Ir a corregirlo» lleva el foco a la celda", () => {
    const issues: Issue[] = [
      { kind: "slotWithoutSigner", severity: "blocking", messageKey: "assignment.issue.slotWithoutSigner", signerId: "s1", docId: "d3", params: {} },
      { kind: "tooManyFiles", severity: "blocking", messageKey: "assignment.issue.tooManyFiles", params: { count: 55, max: 50 } },
    ];
    render(<Host initial={[blk("b1", "s1", ["d1", "d2"])]} issues={issues} copies={{ d1: 2, d2: 2, d3: 2, d4: 2 }} />);
    expect(screen.getByText(asg.issueTitleBlocking)).toBeTruthy();
    const slotRow = screen.getByText(/hueco de firma en Carta/).closest("li") as HTMLElement;
    fireEvent.click(within(slotRow).getByRole("button", { name: asg.fixIt }));
    expect(document.activeElement).toBe(cell("Ana", "Carta", null));
    const filesRow = screen.getByText(/55 archivos/).closest("li") as HTMLElement;
    fireEvent.click(within(filesRow).getByRole("button", { name: asg.fixIt }));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(asg.allCopiesLess);
  });

  it("«Ir a corregirlo» del tope de archivos enfoca el primer boton ACTIVO de «Copias de todos» (el «−» esta apagado con 1 copia)", () => {
    const issues: Issue[] = [
      { kind: "tooManyFiles", severity: "blocking", messageKey: "assignment.issue.tooManyFiles", params: { count: 55, max: 50 } },
    ];
    render(<Host initial={[blk("b1", "s1", ["d1", "d2"])]} issues={issues} />);
    fireEvent.click(screen.getByRole("button", { name: asg.fixIt }));
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(asg.allCopiesMore);
  });

  it("sin problemas no hay lista de avisos", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    expect(screen.queryByText(asg.issueTitleBlocking)).toBeNull();
  });

  it("no crea regiones vivas propias (el anuncio va por `onAnnounce`)", () => {
    render(<Host initial={[ALL("s1", "b1")]} />);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("en ingles", () => {
    render(<Host initial={[ALL("s1", "b1")]} strings={en} />);
    expect(screen.getByRole("heading", { name: en.assignment.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.assignment.shortcutGroups })).toBeTruthy();
    expect(screen.getByText("Ana signs 4 documents with 1 signature.")).toBeTruthy();
    expect(screen.getByText("4 files will be downloaded.")).toBeTruthy();
  });
});
