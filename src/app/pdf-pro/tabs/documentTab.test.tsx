import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { DocumentTab } from "@/app/pdf-pro/tabs/DocumentTab";
import { cropBoxes, infoOf, labelsOf, mountTab, pageTexts, rotations } from "@/app/pdf-pro/tabs/docTestUtils";
import { __resetPageInfoCacheForTests } from "@/app/pdf-pro/ops/pageInfo";
import { __resetCropOverlayForTests } from "@/app/pdf-pro/ops/cropOverlay";
import { WATERMARK_STRINGS } from "@/app/add-watermark/strings";
import { PAGE_NUMBERS_STRINGS } from "@/app/add-page-numbers/strings";

/**
 * Pestaña «Inicio» de PDF Pro (U5): cada herramienta de documento abierta de verdad, con motores reales.
 * La vista previa (pdf.js) se sustituye por una imagen fija: en jsdom no hay canvas.
 */

vi.mock("@/app/pdf-pro/ops/previewRender", () => ({
  renderPreviewDataUrl: vi.fn(async () => "data:image/png;base64,iVBORw0KGgo="),
}));

const S = PRO_STRINGS.es;
const T = S.docTools;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  // El foco de los paneles usa `useFocusTarget` (fase de layout): sus candidatos exigen una caja que jsdom no calcula.
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});

beforeEach(() => {
  __resetPageInfoCacheForTests();
  __resetCropOverlayForTests();
});

afterEach(() => cleanup());

async function openTool(title: string) {
  fireEvent.click(screen.getByRole("button", { name: T.launcher.open(title) }));
  await screen.findByRole("heading", { level: 2, name: title });
}

const applyButton = () => screen.getByRole("button", { name: T.runner.apply });

async function applyAndWait(doc: Parameters<typeof labelsOf>[0], expectedSteps: number) {
  fireEvent.click(applyButton());
  await waitFor(() => expect(labelsOf(doc)).toHaveLength(expectedSteps));
}

describe("lista de herramientas e Inicio", () => {
  it("lista las nueve herramientas de documento con nombre y descripcion", async () => {
    await mountTab(<DocumentTab />);
    for (const id of ["watermark", "page-numbers", "header-footer", "compress", "crop", "rotate", "metadata", "repair", "ocr"] as const) {
      expect(screen.getByRole("button", { name: T.launcher.open(T.tools[id].title) })).toBeTruthy();
      expect(screen.getByText(T.tools[id].description)).toBeTruthy();
    }
    // «Quitar protección» vive en la pestaña Proteger, no aqui.
    expect(screen.queryByRole("button", { name: T.launcher.open(T.tools.unlock.title) })).toBeNull();
  });

  it("OCR lleva la marca «Requiere conexión» ya en la lista", async () => {
    await mountTab(<DocumentTab />);
    const ocr = screen.getByRole("button", { name: T.launcher.open(T.tools.ocr.title) });
    expect(within(ocr).getByText(T.runner.networkBadge)).toBeTruthy();
    const watermark = screen.getByRole("button", { name: T.launcher.open(T.tools.watermark.title) });
    expect(within(watermark).queryByText(T.runner.networkBadge)).toBeNull();
  });

  it("el resumen muestra nombre, paginas, firmas, cifrado e historial", async () => {
    await mountTab(<DocumentTab />, { pages: 4, name: "contrato.pdf" });
    const summary = screen.getByRole("heading", { name: T.summary.title }).closest("section")!;
    expect(within(summary).getByText("contrato.pdf")).toBeTruthy();
    expect(within(summary).getByText("4 páginas")).toBeTruthy();
    expect(within(summary).getByText(T.summary.signaturesValue.none)).toBeTruthy();
    expect(within(summary).getByText(T.summary.plainValue)).toBeTruthy();
    expect(within(summary).getByText(T.summary.historyValue(0))).toBeTruthy();
  });

  it("el resumen avisa de las firmas activas y de la copia descifrada", async () => {
    await mountTab(<DocumentTab />, { signatures: "active", encrypted: true });
    const summary = screen.getByRole("heading", { name: T.summary.title }).closest("section")!;
    expect(within(summary).getByText(T.summary.signaturesValue.active)).toBeTruthy();
    expect(within(summary).getByText(T.summary.encryptedValue)).toBeTruthy();
  });

  it("el resumen lee titulo y autor del PDF", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    document.setTitle("Informe anual");
    document.setAuthor("Ana Pérez");
    const bytes = await document.save();
    await mountTab(<DocumentTab />, { bytes });
    await screen.findByText("Informe anual");
    expect(screen.getByText("Ana Pérez")).toBeTruthy();
  });

  it("mantiene las acciones rapidas de rotar y comprimir y el historial", async () => {
    await mountTab(<DocumentTab />);
    expect(screen.getByRole("button", { name: S.operations.rotateAll90 })).toBeTruthy();
    expect(screen.getByRole("button", { name: S.operations.compress })).toBeTruthy();
    expect(screen.getByRole("list", { name: S.suite.historyTitle })).toBeTruthy();
  });

  it("las acciones rapidas NO incluyen las herramientas con opciones", async () => {
    await mountTab(<DocumentTab />);
    expect(screen.queryByRole("button", { name: S.operations.watermark })).toBeNull();
    expect(screen.queryByRole("button", { name: S.operations.metadata })).toBeNull();
  });

  it("las herramientas sueltas se abren en otra pestaña del navegador", async () => {
    await mountTab(<DocumentTab />);
    const link = screen.getByRole("link", { name: /Unir PDF/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("href")).toBe("/merge-pdf");
  });
});

describe("abrir y cerrar un panel", () => {
  it("el foco va al titulo del panel y «Volver» devuelve el foco a su boton", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: T.tools.watermark.title })));
    fireEvent.click(screen.getByRole("button", { name: T.launcher.back }));
    const opener = screen.getByRole("button", { name: T.launcher.open(T.tools.watermark.title) });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("el panel nombra su region con el titulo de la herramienta", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.crop.title);
    const region = document.querySelector("[data-doc-tool='crop']") as HTMLElement;
    expect(region.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { level: 2, name: T.tools.crop.title }).id);
  });
});

describe("marca de agua", () => {
  it("con el texto vacio «Aplicar» queda inactivo con el motivo a la vista", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.textLabel), { target: { value: "  " } });
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(WATERMARK_STRINGS.es.textRequired)).toBeTruthy();
    expect(applyButton().getAttribute("aria-describedby")).toBe(screen.getByText(WATERMARK_STRINGS.es.textRequired).id);
    fireEvent.click(applyButton());
    await act(async () => {});
    expect(labelsOf(doc)).toEqual(["Original"]);
  });

  it("aplicar crea UN snapshot con la etiqueta «Marca de agua “CONFIDENCIAL”» y estampa el texto", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    await applyAndWait(doc, 2);
    expect(labelsOf(doc)).toEqual(["Original", "Marca de agua “CONFIDENCIAL”"]);
    expect(doc.getState().document?.snapshots[1].source).toBe("operation");
    expect(doc.getState().document?.snapshots[1].opId).toBe("watermark");
    expect(doc.getState().document?.snapshots[1].pageCount).toBe(3);
    const texts = await pageTexts(doc.current()!);
    expect(texts.every((text) => text.includes("CONFIDENCIAL"))).toBe(true);
  });

  it("respeta el rango de paginas (solo la 2)", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.textLabel), { target: { value: "BORRADOR" } });
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.pagesFrom), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.pagesTo), { target: { value: "2" } });
    await applyAndWait(doc, 2);
    const texts = await pageTexts(doc.current()!);
    expect(texts.map((text) => text.includes("BORRADOR"))).toEqual([false, true, false]);
    expect(labelsOf(doc)[1]).toBe("Marca de agua “BORRADOR”");
  });

  it("un rango que empieza despues de la ultima pagina se explica", async () => {
    await mountTab(<DocumentTab />, { pages: 2 });
    await openTool(T.tools.watermark.title);
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.pagesFrom), { target: { value: "9" } });
    expect(screen.getByText(T.runner.rangeBeyond)).toBeTruthy();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("anuncia «Aplicado: …» en la region viva y se deshace con el historial global", async () => {
    const { doc, original } = await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    await applyAndWait(doc, 2);
    expect(doc.getState().announcement?.text).toBe(S.announce.applied("Marca de agua “CONFIDENCIAL”"));
    expect(doc.current()).not.toEqual(original);
    act(() => {
      doc.undo();
    });
    expect(doc.getState().canUndo).toBe(false);
    expect(doc.current()).toEqual(original);
  });

  it("muestra la vista previa del resultado en la pagina 1", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    const image = await screen.findByAltText(T.runner.previewAlt(1));
    expect(image.getAttribute("src")).toContain("data:image/png");
  });

  it("con un rango que no incluye la pagina 1 la vista previa lo dice", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    fireEvent.change(screen.getByLabelText(WATERMARK_STRINGS.es.pagesFrom), { target: { value: "2" } });
    expect(await screen.findByText(T.runner.previewOutOfRange)).toBeTruthy();
  });
});

describe("numerar paginas", () => {
  it("aplica «Página {n} de {p}» y crea un snapshot «Numerar páginas»", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools["page-numbers"].title);
    fireEvent.click(screen.getByRole("radio", { name: PAGE_NUMBERS_STRINGS.es.formatPageNofP }));
    await applyAndWait(doc, 2);
    expect(labelsOf(doc)[1]).toBe(T.labels.pageNumbers);
    const texts = await pageTexts(doc.current()!);
    expect(texts[0]).toContain("Página 1 de 3");
    expect(texts[2]).toContain("Página 3 de 3");
  });

  it("la vista del formato usa el total real del documento", async () => {
    await mountTab(<DocumentTab />, { pages: 7 });
    await openTool(T.tools["page-numbers"].title);
    fireEvent.click(screen.getByRole("radio", { name: PAGE_NUMBERS_STRINGS.es.formatPageNofP }));
    expect(screen.getByText("Página 1 de 7")).toBeTruthy();
  });
});

describe("encabezado, pie y Bates", () => {
  it("por defecto pone «Página n de p» al pie y se aplica", async () => {
    const { doc } = await mountTab(<DocumentTab />, { pages: 2 });
    await openTool(T.tools["header-footer"].title);
    await applyAndWait(doc, 2);
    expect(labelsOf(doc)[1]).toBe(T.labels.headerFooter);
    expect((await pageTexts(doc.current()!))[1]).toContain("Página 2 de 2");
  });

  it("sin ningun texto «Aplicar» explica el motivo", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools["header-footer"].title);
    fireEvent.change(screen.getByLabelText(`${T.headerFooter.footerTitle} · ${T.headerFooter.center}`), { target: { value: "" } });
    expect(screen.getByText(T.headerFooter.nothingToStamp)).toBeTruthy();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("encabezado con {nombre}, {fecha} y Bates se estampa y la etiqueta lo dice", async () => {
    const { doc } = await mountTab(<DocumentTab />, { name: "caso.pdf", pages: 2 });
    await openTool(T.tools["header-footer"].title);
    fireEvent.change(screen.getByLabelText(`${T.headerFooter.headerTitle} · ${T.headerFooter.left}`), { target: { value: "{nombre}" } });
    fireEvent.change(screen.getByLabelText(`${T.headerFooter.footerTitle} · ${T.headerFooter.right}`), { target: { value: "{bates}" } });
    fireEvent.click(screen.getByRole("switch", { name: T.headerFooter.batesToggle }));
    fireEvent.change(screen.getByLabelText(T.headerFooter.batesPrefix), { target: { value: "CASO-" } });
    await applyAndWait(doc, 2);
    expect(labelsOf(doc)[1]).toBe(T.labels.bates);
    const texts = await pageTexts(doc.current()!);
    expect(texts[0]).toContain("caso");
    expect(texts[0]).toContain("CASO-000001");
    expect(texts[1]).toContain("CASO-000002");
  });
});

describe("comprimir", () => {
  it("un PDF diminuto ya esta optimizado: no crea snapshot y lo explica", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.compress.title);
    fireEvent.click(applyButton());
    expect(await screen.findByText(S.warnings.unchanged)).toBeTruthy();
    expect(labelsOf(doc)).toEqual(["Original"]);
    // El resumen del resultado se muestra aun sin snapshot (pesos medidos, sin ahorro inventado).
    expect(screen.getByRole("heading", { name: "Última compresión" })).toBeTruthy();
  });

  it("muestra los niveles de compresion y «Aplanar documento escaneado»", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.compress.title);
    expect(screen.getByRole("radiogroup", { name: "Nivel de compresión" })).toBeTruthy();
    expect(screen.getByText("Aplanar documento escaneado")).toBeTruthy();
  });
});

describe("recortar", () => {
  it("con todos los margenes en 0 explica que falta un margen", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.crop.title);
    fireEvent.change(screen.getByRole("spinbutton", { name: `${T.crop.linked} (mm)` }), { target: { value: "0" } });
    expect(screen.getByText(T.crop.nothingToCrop)).toBeTruthy();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("«Igual en todas» recorta los cuatro lados lo mismo en todas las paginas", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.crop.title);
    fireEvent.change(screen.getByRole("spinbutton", { name: `${T.crop.linked} (mm)` }), { target: { value: "25.4" } });
    await applyAndWait(doc, 2);
    expect(labelsOf(doc)[1]).toBe(T.labels.crop);
    const boxes = await cropBoxes(doc.current()!);
    // 25,4 mm = 72 pt por lado sobre una pagina de 300 × 400.
    for (const box of boxes) {
      expect(box.x).toBeCloseTo(72, 3);
      expect(box.width).toBeCloseTo(300 - 144, 3);
      expect(box.height).toBeCloseTo(400 - 144, 3);
    }
  });

  it("por lado: margenes distintos y solo un rango de paginas", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.crop.title);
    fireEvent.click(screen.getByRole("switch", { name: T.crop.linked }));
    fireEvent.change(screen.getByRole("spinbutton", { name: `${T.crop.left} (mm)` }), { target: { value: "25.4" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: `${T.crop.top} (mm)` }), { target: { value: "0" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: `${T.crop.right} (mm)` }), { target: { value: "0" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: `${T.crop.bottom} (mm)` }), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("tab", { name: T.crop.scopeRange }));
    fireEvent.change(screen.getByLabelText(T.crop.from), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(T.crop.to), { target: { value: "2" } });
    await applyAndWait(doc, 2);
    const boxes = await cropBoxes(doc.current()!);
    expect(boxes[0].width).toBeCloseTo(300, 3);
    expect(boxes[1].x).toBeCloseTo(72, 3);
    expect(boxes[1].width).toBeCloseTo(228, 3);
    expect(boxes[2].width).toBeCloseTo(300, 3);
  });

  it("unos margenes que se comen la pagina se rechazan con su motivo", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.crop.title);
    fireEvent.change(screen.getByRole("spinbutton", { name: `${T.crop.linked} (mm)` }), { target: { value: "90" } });
    expect(await screen.findByText(T.crop.tooSmall)).toBeTruthy();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("indica las medidas de la pagina 1 en mm", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.crop.title);
    expect(await screen.findByText(T.crop.pageSize("105.8", "141.1"))).toBeTruthy();
  });
});

describe("rotar", () => {
  it("todas las paginas 90° por defecto, con etiqueta descriptiva", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.rotate.title);
    await applyAndWait(doc, 2);
    expect(labelsOf(doc)[1]).toBe("Rotar 90° (todas las páginas)");
    expect(await rotations(doc.current()!)).toEqual([90, 90, 90]);
  });

  it("un rango con solo las paginas pares", async () => {
    const { doc } = await mountTab(<DocumentTab />, { pages: 4 });
    await openTool(T.tools.rotate.title);
    fireEvent.click(screen.getByRole("tab", { name: T.rotate.scopeRange }));
    fireEvent.click(screen.getByRole("radio", { name: T.rotate.parityEven }));
    fireEvent.click(screen.getByRole("tab", { name: "180°" }));
    await applyAndWait(doc, 2);
    expect(await rotations(doc.current()!)).toEqual([0, 180, 0, 180]);
    expect(labelsOf(doc)[1]).toBe("Rotar 180° (páginas 1–4)");
  });

  it("un rango impar sobre una sola pagina par no selecciona nada y se explica", async () => {
    await mountTab(<DocumentTab />, { pages: 4 });
    await openTool(T.tools.rotate.title);
    fireEvent.click(screen.getByRole("tab", { name: T.rotate.scopeRange }));
    fireEvent.change(screen.getByLabelText(T.rotate.from), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(T.rotate.to), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("radio", { name: T.rotate.parityOdd }));
    expect(screen.getByText(T.rotate.nothingSelected)).toBeTruthy();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("metadatos", () => {
  it("lee los datos actuales y aplicar cambia solo lo editado", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    document.setTitle("Viejo");
    document.setAuthor("Autor previo");
    const bytes = await document.save();
    const { doc } = await mountTab(<DocumentTab />, { bytes });
    await openTool(T.tools.metadata.title);
    const title = (await screen.findByLabelText(T.metadata.fieldTitle)) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe("Viejo"));
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(T.metadata.nothingChanged)).toBeTruthy();
    fireEvent.change(title, { target: { value: "Contrato 2026" } });
    await applyAndWait(doc, 2);
    expect(labelsOf(doc)[1]).toBe(T.labels.metadataSet);
    const info = await infoOf(doc.current()!);
    expect(info.Title).toBe("Contrato 2026");
    expect(info.Author).toBe("Autor previo");
  });

  it("«Eliminar todos» deja el documento sin metadatos", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    document.setTitle("Secreto");
    document.setAuthor("Persona");
    const bytes = await document.save();
    const { doc } = await mountTab(<DocumentTab />, { bytes });
    await openTool(T.tools.metadata.title);
    await screen.findByLabelText(T.metadata.fieldTitle);
    fireEvent.click(screen.getByRole("tab", { name: T.metadata.modeStrip }));
    await applyAndWait(doc, 2);
    expect(labelsOf(doc)[1]).toBe(T.labels.metadataStrip);
    const info = await infoOf(doc.current()!);
    expect("Title" in info).toBe(false);
    expect("Author" in info).toBe(false);
  });

  it("en un PDF sin metadatos «Eliminar todos» explica que no hay nada", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const document = await PDFDocument.create();
    document.addPage([200, 200]);
    document.context.trailerInfo.Info = undefined;
    const bytes = await document.save({ updateFieldAppearances: false });
    await mountTab(<DocumentTab />, { bytes });
    await openTool(T.tools.metadata.title);
    await screen.findByLabelText(T.metadata.fieldTitle);
    fireEvent.click(screen.getByRole("tab", { name: T.metadata.modeStrip }));
    expect(screen.getAllByText(T.metadata.stripNothing).length).toBeGreaterThan(0);
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("reparar y OCR", () => {
  it("un PDF sano no se puede reparar: motivo a la vista", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.repair.title);
    expect(screen.getAllByText(T.repair.nothingToRepair).length).toBeGreaterThan(0);
    expect(screen.getByText(T.repair.healthy)).toBeTruthy();
    expect(applyButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("OCR avisa de que requiere conexion antes de aplicar", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.ocr.title);
    const notice = document.querySelector("[data-needs-network]") as HTMLElement;
    expect(within(notice).getByText(T.runner.networkBadge)).toBeTruthy();
    expect(within(notice).getByText(T.runner.networkBody)).toBeTruthy();
  });
});

describe("firmas digitales", () => {
  it("con firmas activas cada panel avisa de que aplicar las invalida", async () => {
    await mountTab(<DocumentTab />, { signatures: "active" });
    await openTool(T.tools.watermark.title);
    expect(document.querySelector("[data-signature-warning]")?.textContent).toContain(S.warnings.signaturesInvalidated);
  });

  it("sin firmas no hay aviso", async () => {
    await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    expect(document.querySelector("[data-signature-warning]")).toBeNull();
  });
});

describe("varias operaciones sobre el mismo documento", () => {
  it("se acumulan en el historial y se deshacen paso a paso", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.watermark.title);
    await applyAndWait(doc, 2);
    fireEvent.click(screen.getByRole("button", { name: T.launcher.back }));
    await openTool(T.tools["page-numbers"].title);
    await applyAndWait(doc, 3);
    fireEvent.click(screen.getByRole("button", { name: T.launcher.back }));
    await openTool(T.tools.rotate.title);
    await applyAndWait(doc, 4);
    expect(labelsOf(doc)).toEqual(["Original", "Marca de agua “CONFIDENCIAL”", T.labels.pageNumbers, "Rotar 90° (todas las páginas)"]);

    const texts = await pageTexts(doc.current()!);
    expect(texts[0]).toContain("CONFIDENCIAL");
    expect(texts[0]).toContain("1");
    expect(await rotations(doc.current()!)).toEqual([90, 90, 90]);

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(labelsOf(doc)).toHaveLength(3);
    expect(await rotations(doc.current()!)).toEqual([0, 0, 0]);
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect((await pageTexts(doc.current()!))[0]).toContain("CONFIDENCIAL");
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect((await pageTexts(doc.current()!))[0]).not.toContain("CONFIDENCIAL");
    expect(labelsOf(doc)).toEqual(["Original"]);
  });

  it("aplicar dos veces lo mismo crea dos pasos (cada uno deshacible)", async () => {
    const { doc } = await mountTab(<DocumentTab />);
    await openTool(T.tools.rotate.title);
    await applyAndWait(doc, 2);
    await applyAndWait(doc, 3);
    expect(await rotations(doc.current()!)).toEqual([180, 180, 180]);
  });
});

describe("cropOverlay y reloj", () => {
  it("el recorte publica la seleccion para el visor", async () => {
    const overlay = await import("@/app/pdf-pro/ops/cropOverlay");
    await mountTab(<DocumentTab />);
    await openTool(T.tools.crop.title);
    await waitFor(() => expect(overlay.getCropOverlay()).not.toBeNull());
    const rect = overlay.getCropOverlay()!.rect;
    expect(rect.x).toBeCloseTo(10 / 105.833, 3);
    cleanup();
    expect(overlay.getCropOverlay()).toBeNull();
  });

  it("el visor puede pedir una seleccion y el panel la convierte en margenes", async () => {
    const overlay = await import("@/app/pdf-pro/ops/cropOverlay");
    await mountTab(<DocumentTab />);
    await openTool(T.tools.crop.title);
    await waitFor(() => expect(overlay.getCropOverlay()).not.toBeNull());
    act(() => overlay.requestCropRect({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }));
    const left = (await screen.findByRole("spinbutton", { name: `${T.crop.left} (mm)` })) as HTMLInputElement;
    expect(Number(left.value)).toBeCloseTo(10.6, 1);
    const top = screen.getByRole("spinbutton", { name: `${T.crop.top} (mm)` }) as HTMLInputElement;
    expect(Number(top.value)).toBeCloseTo(28.2, 1);
  });
});
