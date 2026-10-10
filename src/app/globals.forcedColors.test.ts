import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * W6-C · D6 y U7. El CSS de componentes comunes (`globals.css`) no se puede
 * ejecutar en jsdom, pero su contrato si se puede leer: el bloque
 * `@media (forced-colors: active)` (foco en Highlight, input range con
 * pista/pulgar visibles) y la ausencia del CSS muerto retirado en U7.
 */
const css = readFileSync(path.resolve(process.cwd(), "src/app/globals.css"), "utf8");

/** Cuerpo del bloque `@media (forced-colors: active) { ... }` (llaves equilibradas). */
function forcedBlock(): string {
  const start = css.indexOf("@media (forced-colors: active)");
  expect(start).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("bloque forced-colors sin cerrar");
}

describe("globals.css — forced-colors", () => {
  it("existe un unico bloque @media (forced-colors: active) y va fuera de @layer (gana a las utilidades)", () => {
    expect(css.match(/@media \(forced-colors: active\)/g)).toHaveLength(1);
    const before = css.slice(0, css.indexOf("@media (forced-colors: active)"));
    const opens = (before.match(/@layer[^{]*\{/g) ?? []).length;
    // Cada @layer { ... } anterior esta cerrado: la cuenta de llaves del archivo hasta aqui es 0.
    const balance = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(opens).toBeGreaterThan(0);
    expect(balance).toBe(0);
  });

  it("el anillo de foco global es Highlight de 2 px y excluye los contenedores con foco programático y el slider", () => {
    const block = forcedBlock();
    expect(block).toMatch(
      /:focus-visible:not\(\[tabindex="-1"\]\):not\(\.slider-ios\)\s*\{\s*outline:\s*2px solid Highlight;/,
    );
  });

  it("el slider desactiva el ajuste automático y pinta pista (ButtonText + relleno Highlight) y pulgar visibles", () => {
    const block = forcedBlock();
    expect(block).toMatch(/\.slider-ios\s*\{\s*forced-color-adjust:\s*none;/);
    expect(block).toMatch(/::-webkit-slider-runnable-track\s*\{[^}]*border:\s*1px solid ButtonText;[^}]*Highlight var\(--slider-fill\)/);
    expect(block).toMatch(/::-webkit-slider-thumb\s*\{[^}]*border:\s*2px solid ButtonText;[^}]*background:\s*ButtonFace;[^}]*box-shadow:\s*none/);
  });

  it("el slider cubre también Firefox (moz-range-track/progress/thumb)", () => {
    const block = forcedBlock();
    expect(block).toContain("::-moz-range-track");
    expect(block).toContain("::-moz-range-progress");
    expect(block).toContain("::-moz-range-thumb");
  });

  it("el foco del slider va en el pulgar (Highlight) y deshabilitado pasa a GrayText sin opacidad", () => {
    const block = forcedBlock();
    expect(block).toMatch(/\.slider-ios:focus-visible::-webkit-slider-thumb\s*\{\s*outline:\s*2px solid Highlight/);
    expect(block).toMatch(/\.slider-ios:disabled\s*\{\s*opacity:\s*1;/);
    expect(block).toMatch(/:disabled::-webkit-slider-thumb[\s\S]*border-color:\s*GrayText/);
  });

  it("usa solo palabras clave de color del sistema (nada de oklch/rgb/var(--color-*) dentro del bloque, salvo --slider-fill)", () => {
    const block = forcedBlock().replace(/var\(--slider-fill\)/g, "");
    expect(block).not.toMatch(/oklch|rgb\(|#[0-9a-f]{3,8}\b|var\(--color/i);
  });
});

describe("globals.css — CSS muerto retirado (U7)", () => {
  it.each(["hud-grid", "glow-signal-lg", "safe-bottom", "pb-tabbar", "--color-grid-line"])(
    "%s ya no está definido ni usado",
    (name) => {
      expect(css).not.toContain(name);
    },
  );

  it("conserva las utilidades que sí se usan", () => {
    for (const name of ["glow-signal", "safe-top", "slider-ios", "surface-card", "ui-label", "on-media"]) {
      expect(css).toContain(`@utility ${name}`);
    }
  });
});
