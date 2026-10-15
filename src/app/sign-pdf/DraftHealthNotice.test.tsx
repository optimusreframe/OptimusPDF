import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DraftHealthNotice } from "@/app/sign-pdf/DraftHealthNotice";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";

/** El aviso persistente del borrador (F0-fix: D1 y D2): sin autoguardado y/o otra pestana modifico la misma firma. */

const es = SIGN_STRINGS.es;
const en = SIGN_STRINGS.en;

afterEach(cleanup);

function mount(props: Partial<React.ComponentProps<typeof DraftHealthNotice>> = {}, strings = es) {
  const onViewDrafts = vi.fn();
  const view = render(
    <DraftHealthNotice failed={false} tab={null} strings={strings.resume} viewDraftsLabel={strings.draftsButton} onViewDrafts={onViewDrafts} {...props} />,
  );
  return { ...view, onViewDrafts, region: () => view.container.querySelector("[data-draft-health]") as HTMLElement };
}

describe("DraftHealthNotice", () => {
  it("sin nada que decir queda reducido a una region viva vacia (siempre montada, solo para lectores de pantalla)", () => {
    const { region } = mount();
    expect(region().className).toContain("sr-only");
    expect(region().getAttribute("data-draft-health-state")).toBe("ok");
    const live = screen.getByRole("status");
    expect(live.textContent).toBe("");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("el navegador no deja guardar: «Sin autoguardado: el navegador no deja guardar aquí. Descarga antes de salir.»", () => {
    const { region } = mount({ failed: true });
    expect(region().textContent).toContain("Sin autoguardado: el navegador no deja guardar aquí. Descarga antes de salir");
    expect(region().className).not.toContain("sr-only");
    expect(region().getAttribute("data-draft-health-state")).toBe("failed");
    // Sin enlace a borradores: no hay nada guardado a donde ir.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("otra pestana guardo una version mas nueva: lo dice y ofrece «Ver borradores» (44 px)", () => {
    const { region, onViewDrafts } = mount({ tab: "newer" });
    expect(region().textContent).toContain("Otra pestaña modificó esta firma");
    expect(region().textContent).toContain("copia aparte");
    const link = screen.getByRole("button", { name: "Ver borradores" });
    expect(link.className).toContain("h-11");
    fireEvent.click(link);
    expect(onViewDrafts).toHaveBeenCalledTimes(1);
  });

  it("lo de esta pestana ya se guardo aparte: «Otra pestaña modificó esta firma; esta copia se guardó aparte.»", () => {
    const { region } = mount({ tab: "forked" });
    expect(region().textContent).toContain("Otra pestaña modificó esta firma; esta copia se guardó aparte.");
    expect(screen.getByRole("button", { name: "Ver borradores" })).toBeTruthy();
  });

  it("los dos avisos a la vez se dicen los dos", () => {
    const { region } = mount({ failed: true, tab: "forked" });
    expect(region().textContent).toContain("Sin autoguardado");
    expect(region().textContent).toContain("esta copia se guardó aparte");
    expect(region().getAttribute("data-draft-health-state")).toBe("failed forked");
  });

  it("en ingles sale en ingles, sin claves crudas", () => {
    const { region } = mount({ failed: true, tab: "forked" }, en);
    expect(region().textContent).toContain(en.resume.draftFailedNotice);
    expect(region().textContent).toContain(en.resume.tabForkedNotice);
    expect(screen.getByRole("button", { name: "View drafts" })).toBeTruthy();
    expect(region().textContent).not.toMatch(/draftFailedNotice|tabForkedNotice/);
  });
});
