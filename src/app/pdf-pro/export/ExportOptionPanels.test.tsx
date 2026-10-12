import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import {
  CsvPanel,
  ExcelPanel,
  ImagesPanel,
  JsonPanel,
  MarkdownPanel,
  PowerpointPanel,
  TextPanel,
  WordPanel,
  scopeProblem,
} from "@/app/pdf-pro/export/ExportOptionPanels";
import { defaultExportOptions } from "@/app/pdf-pro/export/exportDefaults";
import { PDF_TO_TEXT_STRINGS } from "@/app/pdf-to-text/strings";
import { PDF_TO_MARKDOWN_STRINGS } from "@/app/pdf-to-markdown/strings";

const E = PRO_STRINGS.es.export.images;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(() => cleanup());

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>);

describe("scopeProblem", () => {
  const options = (patch: Partial<ReturnType<typeof defaultExportOptions<"images">>>) => ({ ...defaultExportOptions("images"), ...patch });

  it("todas las paginas nunca tiene problema", () => {
    expect(scopeProblem("es", options({}), 10, [])).toBeNull();
  });

  it("rango vacio, invalido y valido", () => {
    expect(scopeProblem("es", options({ scope: "range", range: "" }), 10, [])).toBe(E.rangeEmpty);
    expect(scopeProblem("es", options({ scope: "range", range: "11" }), 10, [])).toBe(E.rangeInvalid(10));
    expect(scopeProblem("es", options({ scope: "range", range: "2-4" }), 10, [])).toBeNull();
  });

  it("seleccion vacia y con paginas", () => {
    expect(scopeProblem("es", options({ scope: "selected" }), 10, [])).toBe(E.selectionEmpty);
    expect(scopeProblem("es", options({ scope: "selected" }), 10, [3])).toBeNull();
  });

  it("los motivos salen en ingles con el idioma en", () => {
    expect(scopeProblem("en", options({ scope: "range", range: "" }), 10, [])).toBe(PRO_STRINGS.en.export.images.rangeEmpty);
  });
});

describe("ImagesPanel", () => {
  function mount(patch = {}, pageCount = 8, selected: number[] = []) {
    const setOptions = vi.fn();
    const options = { ...defaultExportOptions("images"), ...patch };
    wrap(<ImagesPanel language="es" options={options} setOptions={setOptions} pageCount={pageCount} selectedPages={selected} />);
    return setOptions;
  }

  it("JPG: muestra calidad y no la nota de PNG", () => {
    mount();
    expect(screen.getByRole("slider")).toBeTruthy();
    expect(screen.queryByText(E.pngHint)).toBeNull();
  });

  it("PNG: oculta la calidad (no aplica) y explica que pesa mas", () => {
    mount({ format: "png" });
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByText(E.pngHint)).toBeTruthy();
  });

  it("elegir PNG o una resolucion emite el parche", () => {
    const setOptions = mount();
    fireEvent.click(screen.getByRole("tab", { name: E.png }));
    expect(setOptions).toHaveBeenLastCalledWith({ format: "png" });
    fireEvent.click(screen.getByRole("tab", { name: E.dpi[3] }));
    expect(setOptions).toHaveBeenLastCalledWith({ scale: 3 });
    fireEvent.click(screen.getByRole("tab", { name: E.dpi[1] }));
    expect(setOptions).toHaveBeenLastCalledWith({ scale: 1 });
  });

  it("la calidad se emite normalizada 0..1", () => {
    const setOptions = mount();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "70" } });
    expect(setOptions).toHaveBeenLastCalledWith({ quality: 0.7 });
  });

  it("alcance: elegir rango muestra el campo con su ayuda y el total", () => {
    mount({ scope: "range", range: "" }, 8);
    expect(screen.getByLabelText(E.rangeLabel)).toBeTruthy();
    expect(screen.getByText(E.rangeHint(8))).toBeTruthy();
    expect(screen.getByText(E.rangeEmpty)).toBeTruthy();
  });

  it("escribir el rango emite el texto", () => {
    const setOptions = mount({ scope: "range", range: "" });
    fireEvent.change(screen.getByLabelText(E.rangeLabel), { target: { value: "1-3" } });
    expect(setOptions).toHaveBeenLastCalledWith({ range: "1-3" });
  });

  it("rango valido: resume cuantas imagenes saldran y que van en un ZIP", () => {
    mount({ scope: "range", range: "1-3" });
    expect(screen.getByText(E.summary(3, true))).toBeTruthy();
  });

  it("una sola pagina: «Una imagen.» sin ZIP", () => {
    mount({ scope: "range", range: "2" });
    expect(screen.getByText(E.summary(1, false))).toBeTruthy();
  });

  it("seleccionadas: dice cuantas hay (singular y plural) y, sin ninguna, el motivo", () => {
    mount({ scope: "selected" }, 8, [1]);
    expect(screen.getByText(E.selectedHint(1))).toBeTruthy();
    cleanup();
    mount({ scope: "selected" }, 8, [1, 2, 5]);
    expect(screen.getByText(E.selectedHint(3))).toBeTruthy();
    cleanup();
    mount({ scope: "selected" }, 8, []);
    expect(screen.getByText(E.selectionEmpty)).toBeTruthy();
  });
});

describe("paneles de texto, Excel, CSV, Markdown, JSON y PowerPoint", () => {
  it("texto: las etiquetas son las de la herramienta suelta y cada casilla emite su parche", () => {
    const setOptions = vi.fn();
    wrap(<TextPanel language="es" options={defaultExportOptions("text")} setOptions={setOptions} pageCount={3} selectedPages={[]} />);
    const s = PDF_TO_TEXT_STRINGS.es;
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(s.ocrLabel.slice(0, 20)) }));
    expect(setOptions).toHaveBeenLastCalledWith({ ocrFallback: false });
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(s.pageSeparatorsLabel.slice(0, 20)) }));
    expect(setOptions).toHaveBeenLastCalledWith({ pageSeparators: true });
  });

  it("Word no tiene panel (la herramienta suelta tampoco tiene opciones)", () => {
    const { container } = render(<WordPanel />);
    expect(container.innerHTML).toBe("");
  });

  it("Excel: una casilla de encabezados repetidos", () => {
    const setOptions = vi.fn();
    wrap(<ExcelPanel language="es" options={defaultExportOptions("excel")} setOptions={setOptions} pageCount={3} selectedPages={[]} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(setOptions).toHaveBeenLastCalledWith({ stripRepeated: false });
  });

  it("CSV: formato CSV/JSON y encabezados", () => {
    const setOptions = vi.fn();
    wrap(<CsvPanel language="es" options={defaultExportOptions("csv")} setOptions={setOptions} pageCount={3} selectedPages={[]} />);
    fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
    expect(setOptions).toHaveBeenLastCalledWith({ format: "json" });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(setOptions).toHaveBeenLastCalledWith({ stripRepeated: false });
  });

  it("Markdown: cinco casillas y, con OCR, el idioma del reconocimiento", () => {
    const setOptions = vi.fn();
    wrap(<MarkdownPanel language="es" options={defaultExportOptions("markdown")} setOptions={setOptions} pageCount={3} selectedPages={[]} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    const s = PDF_TO_MARKDOWN_STRINGS.es;
    expect(screen.getByRole("tab", { name: s.ocrLanguageNames.eng })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: s.ocrLanguageNames.fra }));
    expect(setOptions).toHaveBeenLastCalledWith({ ocrLanguage: "fra" });
  });

  it("Markdown sin OCR oculta el selector de idioma", () => {
    wrap(
      <MarkdownPanel
        language="es"
        options={{ ...defaultExportOptions("markdown"), ocrFallback: false }}
        setOptions={vi.fn()}
        pageCount={3}
        selectedPages={[]}
      />,
    );
    expect(screen.queryByRole("tab", { name: PDF_TO_MARKDOWN_STRINGS.es.ocrLanguageNames.eng })).toBeNull();
  });

  it("JSON: solo la casilla de OCR", () => {
    const setOptions = vi.fn();
    wrap(<JsonPanel language="es" options={defaultExportOptions("json")} setOptions={setOptions} pageCount={3} selectedPages={[]} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(setOptions).toHaveBeenLastCalledWith({ ocrFallback: false });
  });

  it("PowerPoint: calidad, resolucion en DPI y el aviso de que no son diapositivas editables", () => {
    const setOptions = vi.fn();
    wrap(<PowerpointPanel language="es" options={defaultExportOptions("powerpoint")} setOptions={setOptions} pageCount={3} selectedPages={[]} />);
    fireEvent.click(screen.getByRole("tab", { name: E.dpi[3] }));
    expect(setOptions).toHaveBeenLastCalledWith({ scale: 3 });
    fireEvent.change(screen.getByRole("slider"), { target: { value: "60" } });
    expect(setOptions).toHaveBeenLastCalledWith({ quality: 0.6 });
    expect(screen.getByText(/editables|editable/i)).toBeTruthy();
  });

  it("en ingles los paneles hablan ingles", () => {
    wrap(<ImagesPanel language="en" options={{ ...defaultExportOptions("images"), scope: "range", range: "" }} setOptions={vi.fn()} pageCount={4} selectedPages={[]} />);
    expect(screen.getByLabelText(PRO_STRINGS.en.export.images.rangeLabel)).toBeTruthy();
    expect(screen.getByText(PRO_STRINGS.en.export.images.rangeEmpty)).toBeTruthy();
  });
});
