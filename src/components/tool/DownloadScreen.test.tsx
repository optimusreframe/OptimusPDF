import { useEffect } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { DownloadScreen } from "@/components/tool/DownloadScreen";
import type { BatchReport } from "@/lib/pdf/batchReport";
import {
  LANGUAGE_STORAGE_KEY,
  LanguageProvider,
  useI18n,
  type Language,
} from "@/lib/i18n";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

afterEach(cleanup);

/** Fija el idioma activo (el estado de i18n vive en el modulo, no en el arbol). */
function UseLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => {
    setLanguage(language);
  }, [language, setLanguage]);
  return null;
}

function renderScreen(
  report?: BatchReport,
  language: Language = "es",
  extra: { summary?: string; notices?: { title: string; items: string[] } } = {},
) {
  return render(
    <LanguageProvider>
      <UseLanguage language={language} />
      <DownloadScreen
        slug="sign-pdf"
        filename="Firmados - 2 documentos.zip"
        size={2048}
        onDownload={vi.fn()}
        onStartOver={vi.fn()}
        report={report}
        {...extra}
      />
    </LanguageProvider>,
  );
}

const PARTIAL: BatchReport = {
  ok: [
    { id: "a", name: "Contrato A.pdf", filename: "Ana - Contrato A-firmado.pdf" },
    { id: "c", name: "Anexo.pdf", filename: "Ana - Anexo-firmado.pdf" },
  ],
  failed: [{ id: "b", name: "Contrato B.pdf", code: "corrupt" }],
};

describe("DownloadScreen — informe de fallos parciales", () => {
  it("sin `report`: no hay aviso ni descripcion en el boton Descargar (cero cambio visible)", () => {
    renderScreen(undefined);
    expect(screen.queryByTestId("partial-failure-report")).toBeNull();
    const button = screen.getByRole("button", { name: "Descargar" });
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByText(/documentos firmados/)).toBeNull();
  });

  it("con `report` sin fallos: tampoco se pinta nada", () => {
    renderScreen({ ok: PARTIAL.ok, failed: [] });
    expect(screen.queryByTestId("partial-failure-report")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Descargar" }).hasAttribute("aria-describedby"),
    ).toBe(false);
  });

  it("con fallos: role=status con «N de M firmados» y la lista «nombre (motivo)»", () => {
    renderScreen(PARTIAL);
    const status = screen.getByTestId("partial-failure-report");
    expect(status.getAttribute("role")).toBe("status");
    expect(within(status).getByText("2 de 3 documentos firmados")).toBeTruthy();
    expect(within(status).getByText("No se pudo firmar:")).toBeTruthy();
    const items = within(status).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe(
      "Contrato B.pdf (El archivo parece dañado y no se puede leer.)",
    );
  });

  it("lista varios fallos, cada uno con su motivo", () => {
    renderScreen({
      ok: [PARTIAL.ok[0]],
      failed: [
        { id: "b", name: "B.pdf", code: "encrypted" },
        { id: "c", name: "C.pdf", code: "tooLarge" },
      ],
    });
    const status = screen.getByTestId("partial-failure-report");
    expect(within(status).getByText("1 de 3 documentos firmados")).toBeTruthy();
    const items = within(status).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toMatch(/^B\.pdf \(El PDF está protegido/);
    expect(items[1].textContent).toMatch(/^C\.pdf \(El archivo supera/);
  });

  it("el boton Descargar queda descrito por el aviso (aria-describedby apunta a su id)", () => {
    renderScreen(PARTIAL);
    const status = screen.getByTestId("partial-failure-report");
    const button = screen.getByRole("button", { name: "Descargar" });
    expect(status.id).not.toBe("");
    expect(button.getAttribute("aria-describedby")).toBe(status.id);
  });

  it("en ingles", () => {
    renderScreen(PARTIAL, "en");
    const status = screen.getByTestId("partial-failure-report");
    expect(within(status).getByText("2 of 3 documents signed")).toBeTruthy();
    expect(within(status).getByText("Could not sign:")).toBeTruthy();
    expect(within(status).getAllByRole("listitem")[0].textContent).toMatch(
      /^Contrato B\.pdf \(/,
    );
  });
});

describe("DownloadScreen — resumen y avisos (B1)", () => {
  const NOTICES = {
    title: "Sobre el texto editado",
    items: ["Página 1, «Total»: el original sigue bajo la edición.", "Para quitarlo del todo, aplana la página."],
  };

  /** Texto que un lector de pantalla leeria de los elementos a los que apunta `aria-describedby`. */
  function described(button: HTMLElement): string {
    return (button.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  }

  it("el boton Descargar se describe por el resumen, el titulo de los avisos y CADA aviso, una sola vez (nunca por el grupo ni por la lista que los contienen)", () => {
    renderScreen(undefined, "es", { summary: "1 texto editado: no se pudo quitar el original.", notices: NOTICES });
    const button = screen.getByRole("button", { name: "Descargar" });
    const group = document.querySelector<HTMLElement>("[data-download-notices]")!;
    const list = group.querySelector("ul")!;
    const ids = (button.getAttribute("aria-describedby") ?? "").split(/\s+/);
    // Chromium describe un elemento referenciado con TODO su contenido: el grupo o la lista duplicarian lo que ya dicen sus partes.
    expect(ids).not.toContain(group.id);
    expect(ids).not.toContain(list.id);
    const titleId = group.getAttribute("aria-labelledby")!;
    expect(ids).toContain(titleId);
    const listItems = Array.from(list.querySelectorAll("li"));
    for (const li of listItems) expect(ids).toContain(li.id);
    expect(ids).toHaveLength(1 + 1 + NOTICES.items.length);
    // Ningun elemento referenciado contiene a otro referenciado: la descripcion no repite nada.
    const elements = ids.map((id) => document.getElementById(id)!);
    for (const outer of elements) {
      for (const inner of elements) {
        if (outer !== inner) expect(outer.contains(inner), `${outer.id} contiene a ${inner.id}`).toBe(false);
      }
    }
    const text = described(button);
    expect(text).toContain("1 texto editado: no se pudo quitar el original.");
    expect(text).toContain("Sobre el texto editado");
    for (const item of NOTICES.items) expect(text).toContain(item);
    // Cada texto sale UNA vez en la descripcion.
    const occurrences = (needle: string) => text.split(needle).length - 1;
    for (const piece of ["1 texto editado: no se pudo quitar el original.", "Sobre el texto editado", ...NOTICES.items]) {
      expect(occurrences(piece), piece).toBe(1);
    }
    // Cada referencia existe: ninguna descripcion cuelga de un id inexistente.
    for (const id of ids) expect(document.getElementById(id), id).not.toBeNull();
  });

  it("solo resumen: lo describe y no hay grupo de avisos", () => {
    renderScreen(undefined, "es", { summary: "2 textos editados: el original se eliminó del archivo." });
    const button = screen.getByRole("button", { name: "Descargar" });
    expect(described(button)).toBe("2 textos editados: el original se eliminó del archivo.");
    expect(document.querySelector("[data-download-notices]")).toBeNull();
  });

  it("ni el resumen ni los avisos son una region viva (los lee la descripcion del boton)", () => {
    renderScreen(undefined, "es", { summary: "x", notices: NOTICES });
    for (const element of [document.querySelector("[data-download-summary]")!, document.querySelector("[data-download-notices]")!]) {
      expect(element.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
    }
  });

  it("el grupo de avisos conserva su nombre accesible (el titulo) y la lista tiene id propio", () => {
    renderScreen(undefined, "es", { notices: NOTICES });
    const group = document.querySelector<HTMLElement>("[data-download-notices]")!;
    expect(group.getAttribute("role")).toBe("group");
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Sobre el texto editado");
    expect(group.querySelector("ul")!.id).not.toBe("");
  });

  it("con fallos parciales Y avisos, la descripcion junta resumen, avisos e informe", () => {
    renderScreen(PARTIAL, "es", { summary: "Resumen.", notices: NOTICES });
    const button = screen.getByRole("button", { name: "Descargar" });
    const ids = (button.getAttribute("aria-describedby") ?? "").split(/\s+/);
    // Resumen, titulo de los avisos, sus dos avisos y el informe de fallos.
    expect(ids).toHaveLength(5);
    const text = described(button);
    expect(text.indexOf("Resumen.")).toBeLessThan(text.indexOf("Sobre el texto editado"));
    expect(text.indexOf("Sobre el texto editado")).toBeLessThan(text.indexOf("Contrato B.pdf"));
  });
});
