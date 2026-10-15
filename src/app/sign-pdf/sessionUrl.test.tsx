import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentSessionParam,
  hasSessionInUrl,
  hideSessionFromUrl,
  isBaseEntry,
  readSessionFromSearch,
  sessionTargetOf,
  showSessionInUrl,
  withSessionParam,
  withoutSessionParam,
} from "@/app/sign-pdf/sessionUrl";

/** La sesion de Firmar en la direccion (U0.3): lectura segura de `?s=`, y que escribirla NUNCA llene el historial. */

const SESSION = "s-mgl1abc-1k3v9x2a";
const OTHER = "s-mgl1abd-2k3v9x2b";
const HASH64 = "ab".repeat(32);

beforeEach(() => {
  window.history.replaceState(null, "", "/sign-pdf");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("lectura de ?s= (entrada no confiable)", () => {
  it("un id de sesion o una huella validos se aceptan, con su tipo", () => {
    expect(sessionTargetOf(SESSION)).toEqual({ kind: "session", id: SESSION });
    expect(sessionTargetOf(HASH64)).toEqual({ kind: "sign", id: HASH64 });
  });

  it.each([
    "",
    "s-",
    "<script>",
    "../../etc/passwd",
    `${HASH64}:${HASH64}`,
    HASH64.toUpperCase(),
    HASH64.slice(0, 63),
    "s-<img src=x onerror=1>-x",
    "__proto__",
    "x".repeat(300),
    "session:" + SESSION,
  ])("el valor %j no es un borrador valido", (value) => {
    expect(sessionTargetOf(value)).toBeNull();
    expect(readSessionFromSearch(`?s=${encodeURIComponent(value)}`).target).toBeNull();
  });

  it("no es un id si no es texto", () => {
    expect(sessionTargetOf(undefined)).toBeNull();
    expect(sessionTargetOf(42)).toBeNull();
    expect(sessionTargetOf(null)).toBeNull();
  });

  it("sin `s` no esta presente; con `s` invalido esta presente pero sin destino; repetido no restaura nada", () => {
    expect(readSessionFromSearch("")).toEqual({ present: false, target: null });
    expect(readSessionFromSearch("?resume=sign:x")).toEqual({ present: false, target: null });
    expect(readSessionFromSearch("?s=basura")).toEqual({ present: true, target: null });
    expect(readSessionFromSearch(`?s=${SESSION}&s=${OTHER}`)).toEqual({ present: true, target: null });
    expect(readSessionFromSearch(`?s=${SESSION}`)).toEqual({ present: true, target: { kind: "session", id: SESSION } });
  });

  it("construir la direccion conserva la ruta, el resto de parametros y el hash", () => {
    expect(withSessionParam("/sign-pdf", SESSION)).toBe(`/sign-pdf?s=${SESSION}`);
    expect(withSessionParam("/sign-pdf?a=1#x", SESSION)).toBe(`/sign-pdf?a=1&s=${SESSION}#x`);
    expect(withSessionParam(`/sign-pdf?s=${OTHER}`, SESSION)).toBe(`/sign-pdf?s=${SESSION}`);
    expect(withoutSessionParam(`/sign-pdf?a=1&s=${SESSION}#x`)).toBe("/sign-pdf?a=1#x");
    expect(withoutSessionParam("/sign-pdf")).toBe("/sign-pdf");
  });
});

describe("showSessionInUrl / hideSessionFromUrl", () => {
  it("con progreso añade UNA entrada de historial con ?s=<id> y la repeticion no añade ninguna mas", () => {
    const before = window.history.length;
    expect(showSessionInUrl(SESSION)).toBe("pushed");
    expect(window.location.search).toBe(`?s=${SESSION}`);
    expect(window.history.length).toBe(before + 1);
    // Un efecto que se repite (o cien renders) no llena el historial.
    for (let index = 0; index < 20; index += 1) expect(showSessionInUrl(SESSION)).toBe("same");
    expect(window.history.length).toBe(before + 1);
  });

  it("el id no lleva nada del trabajo: ni nombres de archivo ni de firmantes", () => {
    showSessionInUrl(SESSION);
    expect(window.location.href).not.toMatch(/Contrato|Ana|\.pdf/);
  });

  it("otra sesion (del documento suelto a la de varios) reescribe la MISMA entrada, sin apilar", () => {
    showSessionInUrl(HASH64);
    const length = window.history.length;
    expect(showSessionInUrl(SESSION)).toBe("replaced");
    expect(window.history.length).toBe(length);
    expect(currentSessionParam()).toBe(SESSION);
  });

  it("una direccion con `?s=` pegada a mano (sin nuestra marca) crea la entrada base detras", () => {
    window.history.replaceState(null, "", `/sign-pdf?s=${SESSION}`);
    const length = window.history.length;
    expect(showSessionInUrl(SESSION)).toBe("rebased");
    expect(window.history.length).toBe(length + 1);
    expect(currentSessionParam()).toBe(SESSION);
    // Y desde ahi ya es nuestra.
    expect(showSessionInUrl(SESSION)).toBe("same");
  });

  it("tras una recarga (misma entrada, con su marca) no se duplica: la marca viaja en el estado de la entrada", () => {
    showSessionInUrl(SESSION);
    const length = window.history.length;
    // Un `replaceState` ajeno (el router) que conserva el estado nuestro no cambia nada.
    window.history.replaceState({ ...(window.history.state as object) }, "", window.location.href);
    expect(showSessionInUrl(SESSION)).toBe("same");
    expect(window.history.length).toBe(length);
  });

  it("hide quita `s` SIN añadir entrada y conserva el resto de la direccion", () => {
    window.history.replaceState(null, "", "/sign-pdf?a=1");
    showSessionInUrl(SESSION);
    const length = window.history.length;
    expect(hideSessionFromUrl()).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/sign-pdf?a=1");
    expect(window.history.length).toBe(length);
    expect(hasSessionInUrl()).toBe(false);
    // Nada que quitar: no hace nada.
    const replace = vi.spyOn(window.history, "replaceState");
    expect(hideSessionFromUrl()).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it("si el progreso se va y vuelve se REUTILIZA nuestra entrada en vez de apilar otra", () => {
    const before = window.history.length;
    showSessionInUrl(SESSION);
    hideSessionFromUrl();
    for (let index = 0; index < 5; index += 1) {
      expect(showSessionInUrl(SESSION)).toBe("replaced");
      expect(hideSessionFromUrl()).toBe(true);
    }
    expect(showSessionInUrl(SESSION)).toBe("replaced");
    expect(window.history.length).toBe(before + 1);
  });

  it("hide de un `?s=` que no pusimos nosotros (basura pegada) no deja marca de entrada nuestra", () => {
    window.history.replaceState(null, "", "/sign-pdf?s=basura");
    expect(hideSessionFromUrl()).toBe(true);
    const before = window.history.length;
    // La entrada no era nuestra: el siguiente `show` SI empuja (hace falta una base detras).
    expect(showSessionInUrl(SESSION)).toBe("pushed");
    expect(window.history.length).toBe(before + 1);
  });
});

describe("la entrada base (detras de ?s=)", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("al empujar la entrada de la sesion la de detras queda marcada como BASE; la de la sesion no lo es", async () => {
    expect(isBaseEntry()).toBe(false);
    showSessionInUrl(SESSION);
    expect(isBaseEntry()).toBe(false);
    window.history.back();
    await settle();
    expect(isBaseEntry()).toBe(true);
    expect(hasSessionInUrl()).toBe(false);
    window.history.forward();
    await settle();
    expect(isBaseEntry()).toBe(false);
    expect(currentSessionParam()).toBe(SESSION);
  });

  it("el estado de la entrada base conserva lo que ya tenia (el del router de Next incluido)", async () => {
    window.history.replaceState({ __NA: true, otro: 1 }, "", "/sign-pdf");
    showSessionInUrl(SESSION);
    window.history.back();
    await settle();
    expect(window.history.state).toMatchObject({ __NA: true, otro: 1, optimusSignBase: true });
  });

  it("con un `?s=` pegado a mano la entrada base creada detras tambien queda marcada", async () => {
    window.history.replaceState(null, "", `/sign-pdf?s=${SESSION}`);
    expect(showSessionInUrl(SESSION)).toBe("rebased");
    window.history.back();
    await settle();
    expect(isBaseEntry()).toBe(true);
    expect(hasSessionInUrl()).toBe(false);
  });

  it("reutilizar la entrada (el progreso se fue y volvio) no crea otra base: solo una entrada nueva en total", async () => {
    // Al final del historial (los casos anteriores pudieron dejarlo a medias): empujar ahora SI suma una entrada.
    window.history.pushState(null, "", "/sign-pdf");
    const before = window.history.length;
    showSessionInUrl(SESSION);
    hideSessionFromUrl();
    showSessionInUrl(SESSION);
    hideSessionFromUrl();
    showSessionInUrl(SESSION);
    expect(window.history.length).toBe(before + 1);
    window.history.back();
    await settle();
    expect(isBaseEntry()).toBe(true);
  });
});
