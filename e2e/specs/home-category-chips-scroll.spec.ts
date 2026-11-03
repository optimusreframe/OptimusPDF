import { expect, test } from "@playwright/test";

/**
 * Barra de categorias de Inicio en movil: al desplazar la pagina, el indicador de la categoria activa (el «pulgar») tiene que
 * viajar DENTRO de la barra y quedar sobre su chip. Antes era un `layoutId` de motion que anima por coordenadas de pantalla:
 * con la pagina en inercia el pulgar cruzaba fuera de la barra, sobre la cabecera y el contenido (iPhone, Safari). Ademas el
 * chip activo se acerca con `scrollTo` solo sobre la lista, sin tocar el scroll de la ventana.
 *
 * Uso: PW_PORT=3951 npx playwright test e2e/specs/home-category-chips-scroll.spec.ts
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("Inicio movil · el indicador de categoria nunca sale de la barra mientras se desplaza", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForSelector("nav[data-scrolled]");

  const run = await page.evaluate(async () => {
    const nav = document.querySelector("nav[data-scrolled]") as HTMLElement;
    const seen = new Set<string>();
    const out = { frames: 0, pillOutsideNav: 0, maxVerticalMismatch: 0, scrollBackJumps: 0, actives: [] as string[] };
    const total = document.documentElement.scrollHeight - innerHeight;
    let y = 0;
    let lastY = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        y += 14;
        window.scrollTo(0, y);
        if (window.scrollY < lastY - 1) out.scrollBackJumps++;
        lastY = window.scrollY;
        const pill = nav.querySelector("[data-category-pill]");
        const active = nav.querySelector('[aria-current="location"]');
        if (active) seen.add(active.getAttribute("data-category") ?? "");
        if (pill && active && active.firstElementChild) {
          const p = pill.getBoundingClientRect();
          const n = nav.getBoundingClientRect();
          const label = active.firstElementChild.getBoundingClientRect();
          if (p.top < n.top - 1 || p.bottom > n.bottom + 1) out.pillOutsideNav++;
          out.maxVerticalMismatch = Math.max(out.maxVerticalMismatch, Math.abs(p.top - label.top));
        }
        out.frames++;
        if (y < total) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    out.actives = [...seen];
    return out;
  });

  expect(run.actives.length).toBeGreaterThan(5);
  expect(run.pillOutsideNav).toBe(0);
  expect(run.maxVerticalMismatch).toBeLessThanOrEqual(1);
  expect(run.scrollBackJumps).toBe(0);

  // Al parar, el indicador queda exactamente sobre el chip activo.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const nav = document.querySelector("nav[data-scrolled]") as HTMLElement;
        const pill = nav.querySelector("[data-category-pill]")!.getBoundingClientRect();
        const label = (nav.querySelector('[aria-current="location"]') as HTMLElement).firstElementChild!.getBoundingClientRect();
        return Math.round(Math.abs(pill.left - label.left) + Math.abs(pill.width - label.width) + Math.abs(pill.top - label.top));
      }),
    )
    .toBe(0);
});
