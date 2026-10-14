import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResumeGoneNotice } from "@/components/tool/ResumeGoneNotice";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { en } from "@/lib/locales/en";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
});
afterAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(cleanup);

describe("ResumeGoneNotice (EN)", () => {
  it("muestra el aviso y las acciones en ingles, sin claves crudas", () => {
    const { container } = render(
      <LanguageProvider>
        <ResumeGoneNotice state={{ gone: true, dismiss: () => {} }} />
      </LanguageProvider>,
    );
    expect(screen.getByText(en.resume.gone)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.resume.reopen })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.common.close })).toBeTruthy();
    expect(container.textContent).not.toMatch(/resume\.|recent\./);
  });
});
