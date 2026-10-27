import { beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessingOverlay } from "@/components/tool/ProcessingOverlay";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

beforeAll(() => window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es"));

describe("ProcessingOverlay · progreso anunciado", () => {
  it("el mensaje del progreso («Optimizando foto 12 de 40») va en una region con aria-live=polite, descripcion del dialogo", async () => {
    const view = render(
      <LanguageProvider>
        <ProcessingOverlay progress={30} message="Optimizando foto 12 de 40" />
      </LanguageProvider>,
    );
    const dialog = await screen.findByRole("dialog");
    const message = screen.getByText("Optimizando foto 12 de 40");
    expect(message.getAttribute("aria-live")).toBe("polite");
    expect(message.getAttribute("aria-atomic")).toBe("true");
    expect(dialog.getAttribute("aria-describedby")).toBe(message.id);
    view.rerender(
      <LanguageProvider>
        <ProcessingOverlay progress={35} message="Optimizando foto 13 de 40" />
      </LanguageProvider>,
    );
    // El mismo elemento se actualiza (un lector de pantalla anuncia el cambio, no un nodo nuevo).
    expect(screen.getByText("Optimizando foto 13 de 40")).toBe(message);
  });
});
