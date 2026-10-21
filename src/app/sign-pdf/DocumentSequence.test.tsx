import { useCallback, useMemo, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DocumentCanvas, type CanvasSelection, type PlacementTool } from "@/app/sign-pdf/DocumentCanvas";
import {
  DocumentSequence,
  useCanvasSequence,
  type SequenceDoc,
  type SequenceTarget,
  type SoloPlacementPlan,
} from "@/app/sign-pdf/DocumentSequence";
import {
  EMPTY_DOC_STATE,
  docIdOf,
  docStateOf,
  type DocId,
  type DocState,
} from "@/app/sign-pdf/docSet";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { soloSlotsFrom } from "@/app/sign-pdf/soloSignature";
import { defaultSoloRect, refitSoloRect } from "@/app/sign-pdf/soloSignature";
import type { DetectedField } from "@/lib/pdf/detectFields";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";

/** Tamano y numero de paginas de cada PDF simulado: documentos DISTINTOS, como en una ronda real. */
const pdf = vi.hoisted(() => ({
  pages: {} as Record<string, { w: number; h: number }[]>,
  /** Documentos cuyo recuento se retiene hasta que la prueba lo libere. */
  hold: new Set<string>(),
  release: null as null | (() => void),
  open: 0,
  maxOpen: 0,
  rendered: [] as string[],
}));

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async (file: File) => {
      if (pdf.hold.has(file.name)) {
        await new Promise<void>((resolve) => {
          const previous = pdf.release;
          pdf.release = () => {
            previous?.();
            resolve();
          };
        });
      }
      const pages = pdf.pages[file.name] ?? [{ w: 600, h: 800 }];
      pdf.open += 1;
      pdf.maxOpen = Math.max(pdf.maxOpen, pdf.open);
      return {
        numPages: pages.length,
        getPage: async (number: number) => ({
          cleanup: () => {},
          getViewport: () => ({ width: pages[number - 1].w, height: pages[number - 1].h }),
          __name: `${file.name}#${number}`,
        }),
      };
    },
    renderPageToDataUrl: async (page: { __name: string }) => {
      pdf.rendered.push(page.__name);
      return `data:image/png;base64,${page.__name}`;
    },
    closePdfDocument: async () => {
      pdf.open -= 1;
    },
  };
});

const strings = SIGN_STRINGS.es;
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: 600,
      height: 800,
      top: 0,
      left: 0,
      right: 600,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

let seed = 40;
function pdfFile(name: string, pages: { w: number; h: number }[]): File {
  pdf.pages[name] = pages;
  seed += 7;
  return new File([new Uint8Array([seed, seed + 1, seed + 2])], name, {
    type: "application/pdf",
    lastModified: 1_700_000_000_000 + seed,
  });
}

const PORTRAIT = { w: 600, h: 800 };
const LANDSCAPE = { w: 800, h: 600 };

/** a.pdf: 2 paginas; b.pdf: 3; c.pdf: 1 apaisada (6 en total). */
function threeFiles(): File[] {
  return [
    pdfFile("a.pdf", [PORTRAIT, LANDSCAPE]),
    pdfFile("b.pdf", [PORTRAIT, PORTRAIT, PORTRAIT]),
    pdfFile("c.pdf", [{ w: 1000, h: 500 }]),
  ];
}

beforeEach(() => {
  pdf.pages = {};
  pdf.hold = new Set();
  pdf.release = null;
  pdf.open = 0;
  pdf.maxOpen = 0;
  pdf.rendered = [];
  window.localStorage.clear();
  __resetValueHistoryCacheForTests();
});

afterEach(() => {
  pdf.hold.clear();
  pdf.release?.();
});

/** Libera los documentos retenidos (y deja de retener los siguientes). */
function releaseHold() {
  pdf.hold.clear();
  act(() => pdf.release?.());
}

const field = (
  id: string,
  pageIndex: number,
  y: number,
  label: string,
  extra: Partial<DetectedField> = {},
): DetectedField => ({
  id,
  pageIndex,
  rect: { x: 0.1, y, width: 0.3, height: 0.05 },
  label,
  source: "acroform",
  confidence: "high",
  ...extra,
});

type HarnessProps = {
  files: File[];
  mode?: "single" | "multi";
  signaturePng?: string;
  ratio?: number;
  zoom?: boolean;
  textFields?: Record<string, DetectedField[]>;
  initialDocs?: Record<string, Partial<DocState>>;
  initialActive?: number;
  onSession?: (session: SignSession) => void;
};

/**
 * El anfitrion de `SignToolClient` en miniatura: sesion con el estado por
 * documento, `go` y `placeSolo` como los del anfitrion real, y el lienzo del
 * documento activo montado con `key={docId}` (se remonta al cambiar de
 * documento, como los flujos).
 */
function Harness({
  files,
  mode = "multi",
  signaturePng = "",
  ratio = 0,
  zoom = false,
  textFields = {},
  initialDocs = {},
  initialActive = 0,
  onSession,
}: HarnessProps) {
  const docs = useMemo<SequenceDoc[]>(
    () => files.map((file) => ({ id: docIdOf(file), name: file.name, file })),
    [files],
  );
  const [activeId, setActiveId] = useState<DocId>(docs[initialActive].id);
  const [states, setStates] = useState<Record<DocId, DocState>>(() => {
    const out: Record<DocId, DocState> = {};
    for (const doc of docs) {
      out[doc.id] = {
        ...EMPTY_DOC_STATE,
        textFields: textFields[doc.name] ?? [],
        ...(initialDocs[doc.name] ?? {}),
      };
    }
    return out;
  });
  const [selected, setSelected] = useState<CanvasSelection | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [tool, setTool] = useState<PlacementTool>("select");

  const session: SignSession = {
    ...DEFAULT_SESSION,
    mode,
    signaturePng,
    ratio,
    docs: states,
    docOrder: docs.map((doc) => doc.id),
    activeDocId: activeId,
  };
  onSession?.(session);

  const go = useCallback((target: SequenceTarget) => {
    setActiveId(target.docId);
    setStates((current) => ({
      ...current,
      [target.docId]: {
        ...docStateOf(current, target.docId),
        fieldPageIndex: target.pageIndex,
      },
    }));
    setSelected(target.textFieldId ? { kind: "text", id: target.textFieldId } : null);
    setEditing(target.textFieldId ?? null);
  }, []);

  const placeSolo = useCallback((plan: SoloPlacementPlan) => {
    setStates((current) => {
      const next = { ...current };
      for (const [id, placement] of Object.entries(plan)) {
        next[id] = { ...docStateOf(next, id), ...placement };
      }
      return next;
    });
  }, []);

  const onDetected = useCallback((docId: DocId, _file: File, fields: DetectedField[]) => {
    setStates((current) => {
      const doc = docStateOf(current, docId);
      if (doc.textFields.length > 0 || doc.textFieldsDetectedFor !== null) return current;
      return { ...current, [docId]: { ...doc, textFields: fields } };
    });
  }, []);

  const active = docs.find((doc) => doc.id === activeId)!;
  const state = docStateOf(states, activeId);
  const patch = (change: Partial<DocState>) =>
    setStates((current) => ({
      ...current,
      [activeId]: { ...docStateOf(current, activeId), ...change },
    }));

  return (
    <DocumentSequence
      enabled={docs.length > 1}
      docs={docs}
      activeId={activeId}
      session={session}
      go={go}
      placeSolo={placeSolo}
      onDetected={onDetected}
      strings={strings}
    >
      <Flow
        key={activeId}
        file={active.file}
        solo={mode === "single"}
        signaturePng={signaturePng}
        ratio={ratio}
        zoom={zoom}
        state={state}
        patch={patch}
        selected={selected}
        setSelected={setSelected}
        editing={editing}
        setEditing={setEditing}
        tool={tool}
        setTool={setTool}
      />
    </DocumentSequence>
  );
}

function Flow({
  file,
  solo,
  signaturePng,
  ratio,
  zoom,
  state,
  patch,
  selected,
  setSelected,
  editing,
  setEditing,
  tool,
  setTool,
}: {
  file: File;
  solo: boolean;
  signaturePng: string;
  ratio: number;
  zoom: boolean;
  state: DocState;
  patch: (change: Partial<DocState>) => void;
  selected: CanvasSelection | null;
  setSelected: (selection: CanvasSelection | null) => void;
  editing: string | null;
  setEditing: (id: string | null) => void;
  tool: PlacementTool;
  setTool: (tool: PlacementTool) => void;
}) {
  const sequence = useCanvasSequence();
  const [values, setValues] = useState(state.textValues);
  void values;
  return (
    <DocumentCanvas
      file={file}
      solo={
        solo
          ? { signaturePng, ratio, onCreateSignature: () => {} }
          : undefined
      }
      signers={[]}
      activeSignerId={null}
      onActiveSignerIdChange={() => {}}
      tool={tool}
      onToolChange={setTool}
      slots={solo ? soloSlotsFrom(state) : []}
      onSlotsChange={(slots) => {
        const last = slots[slots.length - 1];
        patch(last ? { rect: last.rect, pageIndex: last.pageIndex } : { rect: EMPTY_DOC_STATE.rect, pageIndex: 0 });
      }}
      textFields={state.textFields}
      onTextFieldsChange={(textFields) => patch({ textFields })}
      values={state.textValues}
      onValueChange={(id, value) => {
        setValues((current) => ({ ...current, [id]: value }));
        patch({ textValues: { ...state.textValues, [id]: value } });
      }}
      pageIndex={state.fieldPageIndex}
      onPageIndexChange={(fieldPageIndex) => patch({ fieldPageIndex })}
      selection={selected}
      onSelectionChange={setSelected}
      editingId={editing}
      onEditingIdChange={setEditing}
      strings={strings}
      keyboardNavEnabled
      undoDeleteEnabled
      pinchZoomEnabled={zoom}
      sequence={sequence}
    />
  );
}

const bar = () => document.querySelector<HTMLElement>("[data-sequence-bar]")!;
const nextButton = () => within(bar()).getByRole("button", { name: strings.nextPage });
const prevButton = () => within(bar()).getByRole("button", { name: strings.previousPage });
const pageText = () => within(bar()).getByText(/^Página \d+ de \d+$/).textContent;
const docLabel = () => bar().querySelector("[data-sequence-doc-label]")!.textContent;
const liveText = () => document.querySelector("[data-sequence-live]")!.textContent;
const thumbButtons = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-thumb]"));
const thumb = (doc: string, page: number) =>
  document.querySelector<HTMLElement>(`[data-thumb="${docIdOf(DOCS_BY_NAME[doc])}:${page}"]`)!;
let DOCS_BY_NAME: Record<string, File> = {};

function renderSequence(props: Partial<HarnessProps> = {}) {
  const files = props.files ?? threeFiles();
  DOCS_BY_NAME = Object.fromEntries(files.map((file) => [file.name, file]));
  return render(<Harness {...props} files={files} />);
}

async function ready() {
  await waitFor(() => expect(pageText()).toMatch(/de 6$/));
  await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
}

describe("DocumentSequence — numeracion global y etiqueta del documento", () => {
  it("muestra «Pagina 1 de 6» y la etiqueta «a.pdf · p. 1/2» con tres documentos de 2, 3 y 1 paginas", async () => {
    renderSequence();
    await ready();
    expect(pageText()).toBe("Página 1 de 6");
    expect(docLabel()).toBe("a.pdf · p. 1/2");
  });

  it("avanzar suma uno a la pagina global dentro del documento", async () => {
    renderSequence();
    await ready();
    fireEvent.click(nextButton());
    await waitFor(() => expect(pageText()).toBe("Página 2 de 6"));
    expect(docLabel()).toBe("a.pdf · p. 2/2");
  });

  it("al pasar de la ultima pagina de a.pdf se entra en b.pdf como pagina 3 de 6", async () => {
    renderSequence();
    await ready();
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    expect(pageText()).toBe("Página 3 de 6");
  });

  it("retroceder desde la primera pagina de b.pdf llega a la ULTIMA de a.pdf (pagina 2 de 6)", async () => {
    renderSequence({ initialActive: 1 });
    await waitFor(() => expect(pageText()).toBe("Página 3 de 6"));
    fireEvent.click(prevButton());
    await waitFor(() => expect(docLabel()).toBe("a.pdf · p. 2/2"));
    expect(pageText()).toBe("Página 2 de 6");
  });

  it("en la primera pagina del conjunto «anterior» esta desactivado; en la ultima, «siguiente»", async () => {
    renderSequence();
    await ready();
    expect((prevButton() as HTMLButtonElement).disabled).toBe(true);
    expect((nextButton() as HTMLButtonElement).disabled).toBe(false);
    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(nextButton());
      await waitFor(() => expect(pageText()).toBe(`Página ${i + 2} de 6`));
    }
    expect(docLabel()).toBe("c.pdf · p. 1/1");
    expect((nextButton() as HTMLButtonElement).disabled).toBe(true);
    expect((prevButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("mientras no se conoce el recuento de todos, la numeracion es la local y despues pasa a la global", async () => {
    pdf.hold = new Set(["b.pdf", "c.pdf"]);
    renderSequence();
    await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
    expect(pageText()).toBe("Página 1 de 2");
    releaseHold();
    await waitFor(() => expect(pageText()).toBe("Página 1 de 6"));
  });

  it("el lienzo no pinta su propio paginador: solo hay UN par de flechas de pagina", async () => {
    renderSequence();
    await ready();
    expect(screen.getAllByRole("button", { name: strings.nextPage })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: strings.previousPage })).toHaveLength(1);
  });

  it("la barra pegajosa es una sola y aloja el zoom del lienzo", async () => {
    renderSequence({ zoom: true });
    await ready();
    expect(document.querySelectorAll("[data-canvas-sticky]")).toHaveLength(1);
    const zoomGroup = screen.getByRole("group", { name: strings.zoomGroupLabel });
    expect(bar().contains(zoomGroup)).toBe(true);
  });

  it("el nombre largo se recorta por el final con puntos suspensivos pero «p. 2/3» no (queda fuera del tramo recortable)", async () => {
    const files = [
      pdfFile("contrato-de-arrendamiento-muy-largo.pdf", [PORTRAIT, PORTRAIT]),
      pdfFile("b.pdf", [PORTRAIT]),
    ];
    renderSequence({ files });
    await waitFor(() => expect(pageText()).toBe("Página 1 de 3"));
    const spans = bar().querySelectorAll("[data-sequence-doc-label] > span");
    // M5 · N9: el nombre se recorta por el FINAL (no por el medio) y el texto completo va en `title`.
    const name = spans[0].querySelector("[data-doc-label-name]")!;
    expect(name.className).toContain("text-ellipsis");
    expect(name.textContent).toBe("contrato-de-arrendamiento-muy-largo.pdf");
    expect(spans[0].querySelector("[data-doc-label-tail]")).toBeNull();
    expect(spans[0].getAttribute("title")).toBe(
      "contrato-de-arrendamiento-muy-largo.pdf · p. 1/2",
    );
    expect(spans[1].className).toContain("shrink-0");
    expect(spans[1].textContent).toBe(" · p. 1/2");
  });
});

describe("DocumentSequence — etiqueta del documento: el nombre completo y el titulo no pierden caracteres", () => {
  it("el nombre con espacios se conserva entero (sin cortarse en cabeza y cola) y el titulo lleva el texto completo", async () => {
    const files = [
      pdfFile("Contrato A.pdf", [PORTRAIT, PORTRAIT]),
      pdfFile("Contrato de arrendamiento B.pdf", [PORTRAIT]),
    ];
    renderSequence({ files });
    await waitFor(() => expect(pageText()).toBe("Página 1 de 3"));
    const label = bar().querySelector("[data-sequence-doc-label]")!;
    const name = label.querySelector("[data-doc-label-name]")!;
    expect(name.textContent).toBe("Contrato A.pdf");
    expect(name.className).not.toContain("truncate");
    expect(label.textContent).toBe("Contrato A.pdf · p. 1/2");
    expect(label.querySelector("[title]")!.getAttribute("title")).toBe("Contrato A.pdf · p. 1/2");
  });
});

describe("DocumentSequence — con un solo documento es el lienzo de siempre", () => {
  it("no pinta barra, region viva ni tira: el lienzo conserva su paginador y sus miniaturas", async () => {
    renderSequence({ files: [pdfFile("solo.pdf", [PORTRAIT, PORTRAIT])] });
    await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
    expect(document.querySelector("[data-sequence-bar]")).toBeNull();
    expect(document.querySelector("[data-sequence-live]")).toBeNull();
    expect(document.querySelector("[data-thumb]")).toBeNull();
    expect(document.querySelectorAll("[data-canvas-sticky]")).toHaveLength(1);
    expect(screen.getByText(strings.pageOf(1, 2))).toBeTruthy();
    // Miniaturas del propio lienzo.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: strings.goToPage(2) })).toBeTruthy(),
    );
  });

  it("el paginador del lienzo recorre las paginas y no cruza a ningun otro documento", async () => {
    renderSequence({ files: [pdfFile("solo.pdf", [PORTRAIT, PORTRAIT])] });
    await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: strings.nextPage }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.nextPage }));
    await waitFor(() => expect(screen.getByText(strings.pageOf(2, 2))).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: strings.nextPage }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("DocumentSequence — el foco no cae a <body> al cruzar de documento", () => {
  it("el boton «Pagina siguiente» es el MISMO nodo, sigue conectado y con el foco tras cruzar (el lienzo si se remonta)", async () => {
    renderSequence();
    await ready();
    fireEvent.click(nextButton());
    await waitFor(() => expect(pageText()).toBe("Página 2 de 6"));
    const button = nextButton();
    const canvasHost = document.querySelector('[data-canvas="host"]');
    act(() => button.focus());
    expect(document.activeElement).toBe(button);

    fireEvent.click(button); // cruza a b.pdf
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));

    expect(document.querySelector('[data-canvas="host"]')).not.toBe(canvasHost);
    expect(nextButton()).toBe(button);
    expect(button.isConnected).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("al llegar a la ultima pagina «siguiente» se desactiva con el foco puesto: el foco pasa a «anterior», no a <body>", async () => {
    renderSequence();
    await ready();
    const button = nextButton();
    act(() => button.focus());
    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(nextButton());
      await waitFor(() => expect(pageText()).toBe(`Página ${i + 2} de 6`));
    }
    expect((nextButton() as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(prevButton());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("y a la inversa: al volver a la primera pagina «anterior» se desactiva y el foco pasa a «siguiente»", async () => {
    renderSequence({ initialActive: 1 });
    await waitFor(() => expect(pageText()).toBe("Página 3 de 6"));
    act(() => prevButton().focus());
    fireEvent.click(prevButton());
    await waitFor(() => expect(pageText()).toBe("Página 2 de 6"));
    fireEvent.click(prevButton());
    await waitFor(() => expect(pageText()).toBe("Página 1 de 6"));
    expect((prevButton() as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(nextButton());
  });

  it("lo mismo hacia atras con «Pagina anterior»", async () => {
    renderSequence({ initialActive: 1 });
    await waitFor(() => expect(pageText()).toBe("Página 3 de 6"));
    const button = prevButton();
    act(() => button.focus());
    fireEvent.click(button);
    await waitFor(() => expect(docLabel()).toBe("a.pdf · p. 2/2"));
    expect(prevButton()).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  it("al activar una miniatura de OTRO documento el foco acaba en esa miniatura (la tira se repinta en el lienzo nuevo)", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    const target = thumb("b.pdf", 1);
    act(() => target.focus());
    fireEvent.click(target);
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 2/3"));
    await waitFor(() => expect(document.activeElement).toBe(thumb("b.pdf", 1)));
    expect(thumb("b.pdf", 1).getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("al activar una miniatura del MISMO documento el foco sigue en ella", async () => {
    renderSequence({ initialActive: 1 });
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    const target = thumb("b.pdf", 2);
    act(() => target.focus());
    fireEvent.click(target);
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 3/3"));
    expect(document.activeElement).toBe(thumb("b.pdf", 2));
  });
});

describe("DocumentSequence — tira de miniaturas de todos los documentos", () => {
  it("un grupo por documento con su nombre y paginas, y una miniatura por pagina", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    const groups = screen.getAllByRole("group", { name: /^\d\. [abc]\.pdf/ });
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "1. a.pdf (2 páginas)",
      "2. b.pdf (3 páginas)",
      "3. c.pdf (1 página)",
    ]);
    // Separadores: a partir del segundo, un borde a la izquierda.
    expect(groups[0].className).not.toContain("border-l");
    expect(groups[1].className).toContain("border-l");
    expect(groups[2].className).toContain("border-l");
  });

  it("el nombre accesible de cada miniatura dice pagina y documento; aria-current solo en la visible", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    expect(thumb("b.pdf", 1).getAttribute("aria-label")).toBe("Ir a la página 2 de b.pdf");
    const current = thumbButtons().filter((button) => button.getAttribute("aria-current") === "true");
    expect(current).toEqual([thumb("a.pdf", 0)]);
  });

  it("una sola miniatura entra en el orden de Tab (tabindex itinerante) y es la pagina visible", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    const stops = thumbButtons().filter((button) => button.tabIndex === 0);
    expect(stops).toEqual([thumb("a.pdf", 0)]);
  });

  it("las flechas recorren la tira y cruzan de un documento al siguiente sin activar nada", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    act(() => thumb("a.pdf", 1).focus());
    fireEvent.keyDown(thumb("a.pdf", 1), { key: "ArrowRight" });
    expect(document.activeElement).toBe(thumb("b.pdf", 0));
    // Solo mueve el foco: la pagina visible no cambia.
    expect(pageText()).toBe("Página 1 de 6");
    fireEvent.keyDown(thumb("b.pdf", 0), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(thumb("a.pdf", 1));
  });

  it("Inicio y Fin llevan a la primera y a la ultima miniatura del conjunto; en los extremos las flechas no dan la vuelta", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    act(() => thumb("a.pdf", 0).focus());
    fireEvent.keyDown(thumb("a.pdf", 0), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(thumb("a.pdf", 0));
    fireEvent.keyDown(thumb("a.pdf", 0), { key: "End" });
    expect(document.activeElement).toBe(thumb("c.pdf", 0));
    fireEvent.keyDown(thumb("c.pdf", 0), { key: "ArrowRight" });
    expect(document.activeElement).toBe(thumb("c.pdf", 0));
    fireEvent.keyDown(thumb("c.pdf", 0), { key: "Home" });
    expect(document.activeElement).toBe(thumb("a.pdf", 0));
  });

  it("al enfocar otra miniatura pasa a ser la unica con tabindex 0", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    act(() => thumb("b.pdf", 2).focus());
    const stops = thumbButtons().filter((button) => button.tabIndex === 0);
    expect(stops).toEqual([thumb("b.pdf", 2)]);
  });

  it("las miniaturas se rasterizan de una en una y solo las del activo y sus vecinos (los lejanos son huecos)", async () => {
    const many = [
      pdfFile("d1.pdf", [PORTRAIT, PORTRAIT]),
      pdfFile("d2.pdf", [PORTRAIT, PORTRAIT]),
      pdfFile("d3.pdf", [PORTRAIT, PORTRAIT]),
      pdfFile("d4.pdf", [PORTRAIT, PORTRAIT]),
      pdfFile("d5.pdf", [PORTRAIT, PORTRAIT]),
    ];
    renderSequence({ files: many });
    await waitFor(() => expect(pageText()).toBe("Página 1 de 10"));
    await waitFor(() => expect(thumb("d2.pdf", 1).querySelector("img")).toBeTruthy());
    expect(thumb("d1.pdf", 0).querySelector("img")).toBeTruthy();
    // d5 esta lejos: el hueco no lleva imagen.
    expect(thumb("d5.pdf", 0).querySelector("img")).toBeNull();
    expect(pdf.rendered.some((name) => name.startsWith("d5.pdf"))).toBe(false);
    // Solo se cuenta el trabajo de la cola: nunca hubo mas de un documento abierto por ella
    // (el lienzo abre el suyo para la vista previa, de ahi el margen de 2).
    expect(pdf.maxOpen).toBeLessThanOrEqual(2);
  });

  it("el contador de la miniatura suma los campos de cada pagina de cada documento", async () => {
    renderSequence({
      textFields: {
        "a.pdf": [field("t1", 1, 0.1, "Nombre")],
        "b.pdf": [field("t2", 0, 0.1, "Fecha"), field("t3", 0, 0.3, "Lugar")],
      },
    });
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    expect(thumb("a.pdf", 1).textContent).toContain("2 · 1");
    expect(thumb("b.pdf", 0).textContent).toContain("1 · 2");
    expect(thumb("c.pdf", 0).textContent).toBe("1");
  });
});

describe("DocumentSequence — anuncios", () => {
  it("al cruzar de documento anuncia «Documento 2 de 3: b.pdf, pagina 1 de 3»", async () => {
    renderSequence();
    await ready();
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await waitFor(() =>
      expect(liveText()).toBe(strings.sequenceLive(2, 3, "b.pdf", 1, 3)),
    );
    expect(liveText()).toBe("Documento 2 de 3: b.pdf, página 1 de 3");
  });

  it("al cambiar de pagina dentro del documento anuncia «Pagina 2 de 6» (la global)", async () => {
    renderSequence();
    await ready();
    fireEvent.click(nextButton());
    await waitFor(() => expect(liveText()).toBe("Página 2 de 6"));
  });

  it("la region viva esta montada desde el principio y vacia (un status que aparece con su texto no se anuncia)", async () => {
    renderSequence();
    const live = document.querySelector("[data-sequence-live]");
    expect(live?.getAttribute("role")).toBe("status");
    expect(live?.textContent).toBe("");
    await ready();
  });
});

describe("DocumentSequence — siguiente/anterior campo pendiente entre documentos", () => {
  const FIELDS = {
    "a.pdf": [field("a1", 0, 0.1, "Nombre")],
    "b.pdf": [field("b1", 1, 0.2, "Fecha"), field("b2", 2, 0.4, "Lugar")],
    "c.pdf": [field("c1", 0, 0.3, "Cargo")],
  };

  function openEditor(label: string) {
    const group = screen.getByRole("group", { name: new RegExp(`^${label}, `) });
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
  }

  it("Enter en el ultimo pendiente de un documento salta al PRIMERO del siguiente (cambia de documento y de pagina)", async () => {
    renderSequence({ textFields: FIELDS });
    await ready();
    openEditor("Nombre");
    const input = screen.getByRole("textbox", { name: "Nombre" });
    fireEvent.change(input, { target: { value: "Ana" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 2/3"));
    const next = await screen.findByRole("textbox", { name: "Fecha" });
    expect(document.activeElement).toBe(next);
    expect(pageText()).toBe("Página 4 de 6");
  });

  it("sigue encadenando: del ultimo de b.pdf pasa a c.pdf", async () => {
    renderSequence({ textFields: FIELDS, initialActive: 1 });
    await waitFor(() => expect(pageText()).toBe("Página 3 de 6"));
    // Se rellena el de la pagina 2 y se sigue al de la 3.
    fireEvent.click(thumb("b.pdf", 1));
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 2/3"));
    openEditor("Fecha");
    const fecha = screen.getByRole("textbox", { name: "Fecha" });
    fireEvent.change(fecha, { target: { value: "hoy" } });
    fireEvent.keyDown(fecha, { key: "Enter" });
    const lugar = await screen.findByRole("textbox", { name: "Lugar" });
    fireEvent.change(lugar, { target: { value: "Quito" } });
    fireEvent.keyDown(lugar, { key: "Enter" });
    await waitFor(() => expect(docLabel()).toBe("c.pdf · p. 1/1"));
    expect(await screen.findByRole("textbox", { name: "Cargo" })).toBeTruthy();
  });

  it("hacia delante NO da la vuelta al principio del propio documento si hay pendientes en el siguiente", async () => {
    // b.pdf: «Fecha» sigue vacio (antes del cursor) y «Lugar» es el ultimo; c.pdf tiene «Cargo».
    renderSequence({ textFields: FIELDS, initialActive: 1 });
    await waitFor(() => expect(pageText()).toBe("Página 3 de 6"));
    fireEvent.click(thumb("b.pdf", 2));
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 3/3"));
    openEditor("Lugar");
    const lugar = screen.getByRole("textbox", { name: "Lugar" });
    fireEvent.change(lugar, { target: { value: "Quito" } });
    fireEvent.keyDown(lugar, { key: "Enter" });
    await waitFor(() => expect(docLabel()).toBe("c.pdf · p. 1/1"));
    expect(await screen.findByRole("textbox", { name: "Cargo" })).toBeTruthy();
  });

  it("Mayus+Tab en el primer pendiente de b.pdf vuelve al ULTIMO pendiente del documento anterior", async () => {
    renderSequence({ textFields: FIELDS, initialActive: 1 });
    await waitFor(() => expect(pageText()).toBe("Página 3 de 6"));
    fireEvent.click(thumb("b.pdf", 1));
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 2/3"));
    openEditor("Fecha");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Fecha" }), {
      key: "Tab",
      shiftKey: true,
    });
    await waitFor(() => expect(docLabel()).toBe("a.pdf · p. 1/2"));
    expect(await screen.findByRole("textbox", { name: "Nombre" })).toBeTruthy();
  });

  it("si ningun otro documento tiene pendientes, Enter da la vuelta dentro del propio documento (como siempre)", async () => {
    renderSequence({
      textFields: {
        "a.pdf": [field("a1", 0, 0.1, "Nombre"), field("a2", 0, 0.3, "Cargo")],
        "b.pdf": [field("b1", 0, 0.2, "Fecha")],
      },
      initialDocs: { "b.pdf": { textValues: { b1: "listo" } } },
    });
    await ready();
    openEditor("Cargo");
    const input = screen.getByRole("textbox", { name: "Cargo" });
    fireEvent.change(input, { target: { value: "Gerente" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("textbox", { name: "Nombre" })).toBeTruthy();
    expect(docLabel()).toBe("a.pdf · p. 1/2");
  });

  it("si no queda ningun pendiente en ningun documento, Enter cierra el editor y el foco vuelve al propio campo", async () => {
    renderSequence({
      textFields: { "a.pdf": [field("a1", 0, 0.1, "Nombre")] },
    });
    await ready();
    openEditor("Nombre");
    const input = screen.getByRole("textbox", { name: "Nombre" });
    fireEvent.change(input, { target: { value: "Ana" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Nombre, /),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it("«Campo siguiente» de la paleta esta activo si el unico pendiente esta en OTRO documento, y salta hasta alli", async () => {
    renderSequence({
      textFields: { "b.pdf": [field("b1", 0, 0.2, "Fecha")] },
    });
    await ready();
    const next = screen.getByRole("button", { name: strings.nextField });
    expect(next.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(next);
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    expect(await screen.findByRole("textbox", { name: "Fecha" })).toBeTruthy();
  });

  it("«Campo siguiente» sin pendientes en ningun documento sigue desactivado", async () => {
    renderSequence();
    await ready();
    const next = screen.getByRole("button", { name: strings.nextField });
    expect(next.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("DocumentSequence — el zoom se reinicia al cruzar (el lienzo se remonta)", () => {
  it("con el zoom al 200 % en a.pdf, b.pdf empieza al 100 %", async () => {
    renderSequence({ zoom: true });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: strings.zoomIn }));
    fireEvent.click(screen.getByRole("button", { name: strings.zoomIn }));
    expect(screen.getByRole("button", { name: strings.resetZoomButton }).textContent).toBe("200 %");
    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: strings.resetZoomButton }).textContent).toBe(
        "100 %",
      ),
    );
  });
});

describe("DocumentSequence — deshacer al cruzar de documento", () => {
  it("el aviso «Deshacer» de un campo quitado pertenece a SU documento: al cruzar desaparece (el lienzo se remonta)", async () => {
    renderSequence({
      textFields: { "a.pdf": [field("a1", 0, 0.1, "Nombre")] },
    });
    await ready();
    const group = screen.getByRole("group", { name: /^Nombre, / });
    fireEvent.pointerDown(group, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(group, { pointerId: 1 });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Nombre" }), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("group", { name: /^Nombre, / })).toBeTruthy());
    act(() => screen.getByRole("group", { name: /^Nombre, / }).focus());
    fireEvent.keyDown(window, { key: "Delete" });
    expect(await screen.findByRole("button", { name: strings.undoRemoveTextField })).toBeTruthy();

    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    expect(screen.queryByRole("button", { name: strings.undoRemoveTextField })).toBeNull();
    // El campo quitado sigue quitado en su documento (no se repone solo).
    fireEvent.click(prevButton());
    await waitFor(() => expect(docLabel()).toBe("a.pdf · p. 2/2"));
    fireEvent.click(prevButton());
    await waitFor(() => expect(docLabel()).toBe("a.pdf · p. 1/2"));
    expect(screen.queryByRole("group", { name: /^Nombre, / })).toBeNull();
  });

  it("zoom y deshacer a la vez: tras cruzar, el zoom vuelve al 100 % y no queda ningun aviso", async () => {
    renderSequence({
      zoom: true,
      textFields: { "a.pdf": [field("a1", 0, 0.1, "Nombre")] },
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: strings.zoomIn }));
    expect(screen.getByRole("button", { name: strings.resetZoomButton }).textContent).toBe("150 %");
    act(() => screen.getByRole("group", { name: /^Nombre, / }).focus());
    fireEvent.pointerDown(screen.getByRole("group", { name: /^Nombre, / }), {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(screen.getByRole("group", { name: /^Nombre, / }), { pointerId: 1 });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Nombre" }), { key: "Escape" });
    fireEvent.keyDown(window, { key: "Delete" });
    await screen.findByRole("button", { name: strings.undoRemoveTextField });
    fireEvent.click(thumb("c.pdf", 0));
    await waitFor(() => expect(docLabel()).toBe("c.pdf · p. 1/1"));
    expect(screen.getByRole("button", { name: strings.resetZoomButton }).textContent).toBe("100 %");
    expect(screen.queryByRole("button", { name: strings.undoRemoveTextField })).toBeNull();
  });
});

describe("DocumentSequence — «Solo yo»: la firma en cada documento", () => {
  const soloProps = { mode: "single" as const, signaturePng: PNG, ratio: 0.25 };
  const PLACED = { x: 0.1, y: 0.1, width: 0.2, height: 0.05 };
  const slotBox = () =>
    document.querySelector<HTMLElement>('[data-element-kind="slot"][data-drag-mode="move"]')!;

  it("sin firma creada no hay panel de «Aplicar a todos los documentos»", async () => {
    renderSequence({ mode: "single" });
    await ready();
    expect(screen.queryByRole("button", { name: strings.soloApplyAll })).toBeNull();
  });

  it("en «Varios firmantes» tampoco hay panel de firma propia", async () => {
    renderSequence({ mode: "multi", signaturePng: PNG, ratio: 0.25 });
    await ready();
    expect(screen.queryByRole("button", { name: strings.soloApplyAll })).toBeNull();
  });

  it("el resumen cuenta los documentos con la firma colocada: el activo se autocoloca, los otros quedan pendientes", async () => {
    renderSequence(soloProps);
    await ready();
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(1, 3))).toBeTruthy());
  });

  it("la firma que se autocoloca al abrir un documento usa la proporcion de SU pagina (c.pdf apaisada), no la del marcador 3:4", async () => {
    let latest: SignSession = DEFAULT_SESSION;
    // La caja medida de jsdom es 600x800 (3:4) pase lo que pase: solo la pagina del PDF dice 2:1.
    renderSequence({ ...soloProps, initialActive: 2, onSession: (session) => (latest = session) });
    await waitFor(() => expect(screen.getByAltText(strings.documentTitle)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(1, 3))).toBeTruthy());
    const c = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["c.pdf"]));
    expect(c.rect).toEqual(defaultSoloRect(0.25, 1000 / 500));
    expect(c.rect).not.toEqual(defaultSoloRect(0.25, 600 / 800));
  });

  it("«Aplicar a todos» copia la posicion de la firma del documento activo y recalcula el alto con la pagina de CADA documento", async () => {
    let latest: SignSession = DEFAULT_SESSION;
    renderSequence({ ...soloProps, onSession: (session) => (latest = session) });
    await ready();
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(1, 3))).toBeTruthy());
    const a = () => docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["a.pdf"]));
    const reference = a().rect;
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(3, 3))).toBeTruthy());

    const b = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["b.pdf"]));
    const c = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["c.pdf"]));
    // a.pdf (la referencia) no cambia; b.pdf es vertical como la pagina 1 de a.pdf; c.pdf es apaisada 2:1.
    expect(a().rect).toEqual(reference);
    expect(b.rect).toEqual(refitSoloRect(reference, 0.25, 600 / 800));
    expect(c.rect).toEqual(refitSoloRect(reference, 0.25, 1000 / 500));
    expect(c.rect.x).toBe(reference.x);
    expect(c.rect.width).toBe(reference.width);
    expect(c.rect.height).toBeGreaterThan(b.rect.height);
    expect([b.pageIndex, c.pageIndex]).toEqual([0, 0]);
  });

  it("sin firma colocada en el activo (la quito) cada documento recibe la colocacion por defecto en SU pagina visible", async () => {
    let latest: SignSession = DEFAULT_SESSION;
    renderSequence({
      ...soloProps,
      initialDocs: { "b.pdf": { fieldPageIndex: 2 }, "c.pdf": { fieldPageIndex: 0 } },
      onSession: (session) => (latest = session),
    });
    await ready();
    await waitFor(() => expect(slotBox()).toBeTruthy());
    act(() => slotBox().focus());
    fireEvent.keyDown(slotBox(), { key: "Delete" });
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(0, 3))).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(3, 3))).toBeTruthy());
    const a = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["a.pdf"]));
    const b = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["b.pdf"]));
    const c = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["c.pdf"]));
    expect(a.rect).toEqual(defaultSoloRect(0.25, 600 / 800));
    expect(b.rect).toEqual(defaultSoloRect(0.25, 600 / 800));
    expect(c.rect).toEqual(defaultSoloRect(0.25, 1000 / 500));
    expect(b.pageIndex).toBe(2);
  });

  it("con la firma en una pagina que otro documento no tiene, se acota a la ULTIMA pagina de ese documento", async () => {
    let latest: SignSession = DEFAULT_SESSION;
    renderSequence({
      ...soloProps,
      initialActive: 1,
      initialDocs: {
        "b.pdf": { rect: { x: 0.5, y: 0.6, width: 0.3, height: 0.075 }, pageIndex: 2 },
      },
      onSession: (session) => (latest = session),
    });
    await waitFor(() => expect(pageText()).toBe("Página 3 de 6"));
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(3, 3))).toBeTruthy());

    const a = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["a.pdf"]));
    const b = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["b.pdf"]));
    const c = docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["c.pdf"]));
    expect(b.pageIndex).toBe(2);
    // a.pdf tiene 2 paginas y c.pdf 1: la pagina 3 se acota a la ultima de cada uno.
    expect(a.pageIndex).toBe(1);
    expect(c.pageIndex).toBe(0);
    // La pagina 2 de a.pdf es apaisada (800x600).
    expect(a.rect).toEqual(refitSoloRect(b.rect, 0.25, 800 / 600));
    expect(a.rect.x).toBe(0.5);
  });

  it("la region de estado esta siempre montada y anuncia «Firma colocada en 3 documentos.»", async () => {
    renderSequence(soloProps);
    await ready();
    const panel = document.querySelector<HTMLElement>("[data-sequence-solo]")!;
    const status = within(panel).getByRole("status");
    expect(status.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    await waitFor(() => expect(status.textContent).toContain(strings.soloApplyAllDone(3)));
  });

  it("«Deshacer» devuelve cada documento a como estaba (incluido sin colocar) y mueve el foco al boton de aplicar", async () => {
    let latest: SignSession = DEFAULT_SESSION;
    renderSequence({
      ...soloProps,
      initialDocs: { "c.pdf": { rect: PLACED, pageIndex: 0 } },
      onSession: (session) => (latest = session),
    });
    await ready();
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(2, 3))).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    const undo = await screen.findByRole("button", { name: strings.soloApplyAllUndo });
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(3, 3))).toBeTruthy());
    expect(docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["c.pdf"])).rect).not.toEqual(PLACED);

    fireEvent.click(undo);
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(2, 3))).toBeTruthy());
    expect(docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["c.pdf"])).rect).toEqual(PLACED);
    expect(docStateOf(latest.docs, docIdOf(DOCS_BY_NAME["b.pdf"])).rect.width).toBe(0);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: strings.soloApplyAll }));
    expect(screen.getByText(strings.soloApplyAllUndone)).toBeTruthy();
  });

  it("el aviso con «Deshacer» se retira solo a los 6 s y, si el foco estaba en el, pasa al boton de aplicar", async () => {
    renderSequence({ ...soloProps });
    await ready();
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(1, 3))).toBeTruthy());
    const realSetTimeout = window.setTimeout.bind(window);
    const sixSeconds: (() => void)[] = [];
    const spy = vi.spyOn(window, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      delay?: number,
    ) => {
      if (delay === 6000 && typeof handler === "function") {
        sixSeconds.push(handler as () => void);
        return 0;
      }
      return realSetTimeout(handler, delay);
    }) as typeof window.setTimeout);
    try {
      fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
      const undo = await screen.findByRole("button", { name: strings.soloApplyAllUndo });
      act(() => undo.focus());
      await waitFor(() => expect(sixSeconds.length).toBeGreaterThan(0));
      act(() => sixSeconds.forEach((run) => run()));
      expect(screen.queryByRole("button", { name: strings.soloApplyAllUndo })).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: strings.soloApplyAll }));
    } finally {
      spy.mockRestore();
    }
  });

  it("cada documento se ajusta por separado: mover la firma de b.pdf no toca la de a.pdf ni la de c.pdf", async () => {
    let latest: SignSession = DEFAULT_SESSION;
    renderSequence({ ...soloProps, onSession: (session) => (latest = session) });
    await ready();
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(1, 3))).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: strings.soloApplyAll }));
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(3, 3))).toBeTruthy());
    const rectOf = (name: string) => docStateOf(latest.docs, docIdOf(DOCS_BY_NAME[name])).rect;
    const before = { a: rectOf("a.pdf"), c: rectOf("c.pdf"), b: rectOf("b.pdf") };

    fireEvent.click(thumb("b.pdf", 0));
    await waitFor(() => expect(docLabel()).toBe("b.pdf · p. 1/3"));
    await waitFor(() => expect(slotBox()).toBeTruthy());
    fireEvent.pointerDown(slotBox(), { pointerId: 1, clientX: 300, clientY: 600 });
    fireEvent.pointerMove(slotBox(), { pointerId: 1, clientX: 240, clientY: 520 });
    fireEvent.pointerUp(slotBox(), { pointerId: 1 });

    expect(rectOf("b.pdf").x).toBeCloseTo(before.b.x - 60 / 600, 5);
    expect(rectOf("a.pdf")).toEqual(before.a);
    expect(rectOf("c.pdf")).toEqual(before.c);
  });

  it("la tira marca por documento «Colocada» o «Pendiente»", async () => {
    renderSequence({
      ...soloProps,
      initialDocs: { "b.pdf": { rect: PLACED, pageIndex: 0 } },
    });
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    const group = (name: string) =>
      document.querySelector<HTMLElement>(`[data-sequence-group="${docIdOf(DOCS_BY_NAME[name])}"]`)!;
    expect(within(group("b.pdf")).getByText(strings.docBadgePlaced)).toBeTruthy();
    await waitFor(() => expect(within(group("a.pdf")).getByText(strings.docBadgePlaced)).toBeTruthy());
    expect(within(group("c.pdf")).getByText(strings.docBadgePending)).toBeTruthy();
  });

  it("mientras lee las paginas el boton esta ocupado (aria-disabled, conserva el foco) y no admite dobles clics", async () => {
    renderSequence(soloProps);
    await ready();
    await waitFor(() => expect(screen.getByText(strings.soloAllSummary(1, 3))).toBeTruthy());
    pdf.hold = new Set(["c.pdf"]);
    const apply = screen.getByRole("button", { name: strings.soloApplyAll });
    fireEvent.click(apply);
    await waitFor(() => expect(apply.getAttribute("aria-busy")).toBe("true"));
    // No se desactiva de verdad (perderia el foco); un segundo clic no hace nada.
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    expect(apply.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(apply);
    releaseHold();
    await waitFor(() => expect(apply.getAttribute("aria-busy")).toBe("false"));
    expect(apply.getAttribute("aria-disabled")).toBe("false");
  });
});


describe("DocumentSequence — miniaturas perezosas con IntersectionObserver", () => {
  type Entry = { target: Element; isIntersecting: boolean };
  class FakeObserver {
    static live: FakeObserver[] = [];
    observed = new Set<Element>();
    constructor(
      private callback: (entries: Entry[]) => void,
      readonly options: { root?: Element | null; rootMargin?: string },
    ) {
      FakeObserver.live.push(this);
    }
    observe(element: Element) {
      this.observed.add(element);
    }
    unobserve(element: Element) {
      this.observed.delete(element);
    }
    disconnect() {
      this.observed.clear();
      FakeObserver.live = FakeObserver.live.filter((observer) => observer !== this);
    }
    /** La tira tiene a la vista estas miniaturas (y deja de tener las demas). */
    show(keys: string[]) {
      this.callback(
        [...this.observed].map((target) => ({
          target,
          isIntersecting: keys.includes((target as HTMLElement).dataset.thumb ?? ""),
        })),
      );
    }
  }
  const observer = () => FakeObserver.live[FakeObserver.live.length - 1];
  const withImage = () => thumbButtons().filter((button) => button.querySelector("img"));

  beforeEach(() => {
    FakeObserver.live = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("observa la propia tira con un margen a los lados y no hace ninguna miniatura hasta saber cuales se ven", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    expect(observer().options.rootMargin).toBe("0px 240px");
    expect(observer().options.root).toBe(document.querySelector("[data-thumb-scroller]"));
    expect(observer().observed.size).toBe(6);
    expect(withImage()).toHaveLength(0);
    // Solo la vista previa de la pagina abierta (la del lienzo): ninguna miniatura.
    expect(pdf.rendered).toEqual(["a.pdf#1"]);
  });

  it("solo se rasterizan las miniaturas que entran en la vista, aunque sean de un documento lejano", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    const keys = [thumb("c.pdf", 0), thumb("b.pdf", 2)].map((el) => el.dataset.thumb!);
    act(() => observer().show(keys));
    await waitFor(() => expect(withImage()).toHaveLength(2));
    expect(withImage()).toEqual([thumb("b.pdf", 2), thumb("c.pdf", 0)]);
    expect(pdf.rendered.filter((name) => name === "a.pdf#1")).toHaveLength(1); // la vista previa, no una miniatura
    expect(pdf.rendered).toEqual(expect.arrayContaining(["b.pdf#3", "c.pdf#1"]));
    expect(pdf.rendered.filter((name) => name.startsWith("b.pdf#1") || name === "b.pdf#2")).toEqual([]);
  });

  it("las que aun no llegaron muestran un marcador con icono, no un hueco vacio", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    const placeholder = thumb("a.pdf", 1).querySelector("[data-thumb-placeholder]");
    expect(placeholder).toBeTruthy();
    expect(placeholder!.querySelector("svg")).toBeTruthy();
    expect(placeholder!.getAttribute("aria-hidden")).toBe("true");
    // El numero de pagina sigue visible y el boton conserva su nombre accesible.
    expect(thumb("a.pdf", 1).textContent).toBe("2");
    expect(thumb("a.pdf", 1).getAttribute("aria-label")).toBe("Ir a la página 2 de a.pdf");
  });

  it("al desplazar la tira hasta el final, las del final se cargan y las del principio se pueden soltar (nada queda en blanco permanente)", async () => {
    const many = Array.from({ length: 4 }, (_, i) =>
      pdfFile(`m${i + 1}.pdf`, Array.from({ length: 30 }, () => PORTRAIT)),
    );
    renderSequence({ files: many });
    await waitFor(() => expect(pageText()).toBe("Página 1 de 120"));
    await waitFor(() => expect(thumbButtons()).toHaveLength(120));
    const last = thumbButtons().slice(-12).map((el) => el.dataset.thumb!);
    act(() => observer().show(last));
    await waitFor(() => expect(withImage()).toHaveLength(12));
    for (const key of last) {
      expect(document.querySelector(`[data-thumb="${key}"] img`)).toBeTruthy();
    }
  });

  it("al llegar miniaturas la tira NO vuelve a centrar la pagina activa (el desplazamiento de la persona se respeta)", async () => {
    renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    const scroller = document.querySelector<HTMLElement>("[data-thumb-scroller]")!;
    let writes = 0;
    Object.defineProperty(scroller, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set: () => {
        writes += 1;
      },
    });
    act(() => observer().show([thumb("c.pdf", 0).dataset.thumb!]));
    await waitFor(() => expect(withImage()).toHaveLength(1));
    act(() => observer().show([thumb("b.pdf", 1).dataset.thumb!, thumb("b.pdf", 0).dataset.thumb!]));
    await waitFor(() => expect(withImage()).toHaveLength(3));
    expect(writes).toBe(0);
  });

  it("al desmontar la tira se desconecta el observador (sin fugas)", async () => {
    const view = renderSequence();
    await ready();
    await waitFor(() => expect(thumbButtons()).toHaveLength(6));
    expect(FakeObserver.live.length).toBeGreaterThan(0);
    view.unmount();
    expect(FakeObserver.live).toHaveLength(0);
  });
});
