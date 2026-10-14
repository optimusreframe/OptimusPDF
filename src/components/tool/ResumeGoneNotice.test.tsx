import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResumeGoneNotice } from "@/components/tool/ResumeGoneNotice";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(cleanup);

function renderNotice(gone: boolean, region?: "status" | "alert") {
  const dismiss = vi.fn();
  const utils = render(
    <LanguageProvider>
      <main>
        <input type="file" accept=".zip,application/zip" aria-label="zip" />
        <div>
          <input type="file" accept="application/pdf,.pdf" aria-label="pdf" />
          <button type="button">Seleccionar archivo</button>
        </div>
        <ResumeGoneNotice state={{ gone, dismiss }} region={region} />
      </main>
    </LanguageProvider>,
  );
  return { dismiss, ...utils };
}

describe("ResumeGoneNotice", () => {
  it("con el trabajo perdido dice el motivo y ofrece «Abrir de nuevo» (textos del diccionario)", () => {
    renderNotice(true);
    expect(screen.getByText(es.resume.gone)).toBeTruthy();
    expect(es.resume.gone).toContain("ya no se puede recuperar en este navegador");
    expect(screen.getByRole("button", { name: es.resume.reopen })).toBeTruthy();
    expect(screen.getByRole("button", { name: es.common.close })).toBeTruthy();
  });

  it("hay ES y EN con las mismas claves y el texto en ingles no es el espanol", () => {
    expect(Object.keys(en.resume)).toEqual(Object.keys(es.resume));
    expect(en.resume.gone).not.toBe(es.resume.gone);
    expect(en.resume.reopen).not.toBe(es.resume.reopen);
  });

  it("sin aviso deja solo una region viva vacia (se anuncia al aparecer)", () => {
    const { container } = renderNotice(false);
    const region = container.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");
    expect(screen.queryByRole("button", { name: es.resume.reopen })).toBeNull();
  });

  it("con region=alert no deja nada montado mientras no hay aviso y usa role=alert con el aviso", () => {
    const hidden = renderNotice(false, "alert");
    expect(hidden.container.querySelector('[role="alert"]')).toBeNull();
    expect(hidden.container.querySelector('[role="status"]')).toBeNull();
    cleanup();
    const shown = renderNotice(true, "alert");
    expect(shown.container.querySelector('[role="alert"]')?.textContent).toContain(es.resume.gone);
    expect(shown.container.querySelector('[role="status"]')).toBeNull();
  });

  it("«Abrir de nuevo» abre el selector de PDF (no el de .zip de importar configuracion)", () => {
    renderNotice(true);
    const pdf = screen.getByLabelText("pdf") as HTMLInputElement;
    const zip = screen.getByLabelText("zip") as HTMLInputElement;
    const pdfClick = vi.spyOn(pdf, "click");
    const zipClick = vi.spyOn(zip, "click");
    fireEvent.click(screen.getByRole("button", { name: es.resume.reopen }));
    expect(pdfClick).toHaveBeenCalledTimes(1);
    expect(zipClick).not.toHaveBeenCalled();
  });

  it("«Cerrar» retira el aviso y deja el foco en el boton de la zona de carga", () => {
    const { dismiss } = renderNotice(true);
    fireEvent.click(screen.getByRole("button", { name: es.common.close }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Seleccionar archivo" }));
  });

  it("los botones miden 44 px (h-11)", () => {
    renderNotice(true);
    for (const name of [es.resume.reopen, es.common.close]) {
      expect(screen.getByRole("button", { name }).className).toContain("h-11");
    }
  });
});
