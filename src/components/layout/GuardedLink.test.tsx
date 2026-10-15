import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { GuardedLink } from "@/components/layout/GuardedLink";
import { __resetNavigationGuardForTests, registerNavigationGuard, type NavigationGuard } from "@/lib/navigationGuard";

/*
 * `next/link` se sustituye por un <a> que reproduce el contrato de `onNavigate` de Next 16 (`link.md`, «onNavigate»): se
 * llama con `{ preventDefault }` en una navegacion de cliente y, si alguien cancela, NO se navega. Asi se prueba lo que
 * `GuardedLink` anade, no el router.
 */
const navigated = vi.fn();
vi.mock("next/link", async () => {
  const React = await import("react");
  type Props = React.ComponentProps<"a"> & { href: string; onNavigate?: (event: { preventDefault: () => void }) => void };
  const Link = React.forwardRef<HTMLAnchorElement, Props>(function Link({ onNavigate, href, ...rest }, ref) {
    return (
      <a
        {...rest}
        ref={ref}
        href={href}
        onClick={(event) => {
          rest.onClick?.(event);
          event.preventDefault();
          let prevented = false;
          onNavigate?.({ preventDefault: () => (prevented = true) });
          if (!prevented) navigated(href);
        }}
      />
    );
  });
  return { default: Link };
});

afterEach(() => {
  __resetNavigationGuardForTests();
  navigated.mockClear();
});

describe("GuardedLink", () => {
  it("sin guarda registrada navega como un Link normal (y respeta su propio onNavigate)", () => {
    const own = vi.fn();
    render(
      <GuardedLink href="/merge-pdf" onNavigate={own}>
        Unir
      </GuardedLink>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Unir" }));
    expect(own).toHaveBeenCalledTimes(1);
    expect(navigated).toHaveBeenCalledWith("/merge-pdf");
  });

  it("una guarda que dice «cancela» impide la navegacion y recibe el destino", () => {
    const guard = vi.fn<NavigationGuard>(() => true);
    registerNavigationGuard(guard);
    render(<GuardedLink href="/merge-pdf">Unir</GuardedLink>);
    fireEvent.click(screen.getByRole("link", { name: "Unir" }));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls[0][0]).toBe("/merge-pdf");
    expect(navigated).not.toHaveBeenCalled();
  });

  it("una guarda que dice «deja pasar» no impide nada", () => {
    registerNavigationGuard(() => false);
    render(<GuardedLink href="/merge-pdf">Unir</GuardedLink>);
    fireEvent.click(screen.getByRole("link", { name: "Unir" }));
    expect(navigated).toHaveBeenCalledWith("/merge-pdf");
  });

  it("`proceed` repite el clic sobre el MISMO enlace saltandose la guarda: la navegacion sigue", () => {
    let proceed: (() => void) | null = null;
    const guard = vi.fn((_href: string, next: () => void) => {
      proceed = next;
      return true;
    });
    registerNavigationGuard(guard);
    render(<GuardedLink href="/split-pdf">Dividir</GuardedLink>);
    fireEvent.click(screen.getByRole("link", { name: "Dividir" }));
    expect(navigated).not.toHaveBeenCalled();
    proceed!();
    expect(navigated).toHaveBeenCalledWith("/split-pdf");
    // La guarda solo se consulto en el primer clic.
    expect(guard).toHaveBeenCalledTimes(1);
    // Y la excepcion no se queda puesta: el siguiente clic vuelve a consultarla.
    fireEvent.click(screen.getByRole("link", { name: "Dividir" }));
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("acepta una ruta como objeto (pathname + search + hash) y reenvia la referencia", () => {
    const guard = vi.fn<NavigationGuard>(() => true);
    registerNavigationGuard(guard);
    const ref = createRef<HTMLAnchorElement>();
    render(
      <GuardedLink ref={ref} href={{ pathname: "/recent", search: "?a=1", hash: "#x" }}>
        Recientes
      </GuardedLink>,
    );
    expect(ref.current?.tagName).toBe("A");
    fireEvent.click(screen.getByRole("link", { name: "Recientes" }));
    expect(guard.mock.calls[0][0]).toBe("/recent?a=1#x");
  });

  it("un enlace a la MISMA pagina no es «salir»: no consulta la guarda y navega", () => {
    window.history.replaceState(null, "", "/sign-pdf?s=s-aaaa-bbbb");
    const guard = vi.fn<NavigationGuard>(() => true);
    registerNavigationGuard(guard);
    render(<GuardedLink href="/sign-pdf">Firmar</GuardedLink>);
    fireEvent.click(screen.getByRole("link", { name: "Firmar" }));
    expect(guard).not.toHaveBeenCalled();
    expect(navigated).toHaveBeenCalledWith("/sign-pdf");
    // Otra pagina, aunque cuelgue de la misma raiz, SI se consulta.
    render(<GuardedLink href="/sign-pdf-otra">Otra</GuardedLink>);
    fireEvent.click(screen.getByRole("link", { name: "Otra" }));
    expect(guard).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, "", "/");
  });
});
