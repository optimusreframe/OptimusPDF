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

function renderScreen(report?: BatchReport, language: Language = "es") {
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
