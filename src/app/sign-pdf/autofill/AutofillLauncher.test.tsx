import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AutofillLauncher } from "@/app/sign-pdf/autofill/AutofillLauncher";
import { __resetAutofillEngineForTests } from "@/app/sign-pdf/autofill/autofillServices";
import { AUTOFILL_STRINGS } from "@/app/sign-pdf/autofill/strings";
import { LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { CLIENT_PROFILES_STORAGE_KEY, __resetClientProfilesCacheForTests, listClientProfiles, saveClientProfile } from "@/lib/clientProfile/store";
import type { DetectedField } from "@/lib/pdf/detectFields";
import type { ExtractEngine, ExtractResult, ExtractedValue } from "@/lib/autofill/types";

/**
 * La hoja «Rellenar con datos del cliente» (jsdom): estados vacio, leyendo, error, sin datos, con datos, con conflictos y con
 * pisado; rellenar + deshacer; perfil guardado y reutilizado; foco, Escape y ES/EN. El motor es un doble inyectado por el gancho
 * `__optimusAutofillEngine`; `planFill` es un doble que cumple el contrato (el motor real tiene sus propias pruebas).
 * TODOS los datos son INVENTADOS.
 */

vi.mock("@/lib/autofill", async () => {
  const { planFillDouble } = await import("@/app/sign-pdf/autofill/testing/planFillDouble");
  return { planFill: planFillDouble, extract: vi.fn(async () => { throw new Error("se inyecta __optimusAutofillEngine"); }) };
});
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const es = AUTOFILL_STRINGS.es;
const en = AUTOFILL_STRINGS.en;

let counter = 0;
function field(id: string, label: string | undefined, extra: Partial<DetectedField> = {}): DetectedField {
  counter += 1;
  return { id, pageIndex: 0, rect: { x: 0.1, y: 0.1 + counter * 0.01, width: 0.4, height: 0.03 }, ...(label ? { label } : {}), source: "acroform", confidence: "high", ...extra };
}

function found(key: string, value: string, extra: Partial<ExtractedValue> = {}): ExtractedValue {
  counter += 1;
  return {
    id: `v${counter}`,
    key,
    value,
    confidence: 0.95,
    tier: "high",
    reason: "junto a la etiqueta",
    evidence: { sourceIndex: 0, pageIndex: 1, snippet: `${key}: ${value}`, origin: "text-layer" },
    ...extra,
  };
}

function result(values: ExtractedValue[], extra: Partial<ExtractResult> = {}): ExtractResult {
  return { values, warnings: [], pagesRead: 2, usedOcr: false, ...extra };
}

function injectEngine(impl: ExtractEngine) {
  const engine = vi.fn(impl);
  globalThis.__optimusAutofillEngine = engine;
  return engine;
}

function Harness({ fields, initial = {}, dataKeys }: { fields: DetectedField[]; initial?: Record<string, string>; dataKeys?: Record<string, string> }) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  return (
    <>
      <AutofillLauncher textFields={fields} textValues={values} onTextValuesChange={setValues} fieldDataKeys={dataKeys} />
      <output data-values="">{JSON.stringify(values)}</output>
    </>
  );
}

const valuesOf = () => JSON.parse(document.querySelector("[data-values]")?.textContent ?? "{}") as Record<string, string>;

/** El idioma vive en una cache de modulo: se fija a mano en cada prueba (por defecto es). */
function SetLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(language), [language, setLanguage]);
  return null;
}

function renderHarness(props: React.ComponentProps<typeof Harness>, language: Language = "es") {
  return render(
    <LanguageProvider>
      <SetLanguage language={language} />
      <Harness {...props} />
    </LanguageProvider>,
  );
}

const FIELDS = () => [field("f-name", "Insured Name"), field("f-phone", "Phone"), field("f-policy", "Policy Number"), field("f-misc", "Observaciones")];

async function open(strings = es) {
  fireEvent.click(await screen.findByRole("button", { name: strings.button }));
  return await screen.findByRole("dialog");
}
const dialog = () => screen.getByRole("dialog");
const addPasted = async (text: string, strings = es) => {
  fireEvent.click(within(dialog()).getByRole("button", { name: strings.paste }));
  fireEvent.change(await within(dialog()).findByLabelText(strings.pasteLabel), { target: { value: text } });
  fireEvent.click(within(dialog()).getByRole("button", { name: strings.pasteAdd }));
};
const read = (strings = es) => fireEvent.click(within(dialog()).getByRole("button", { name: strings.read }));

beforeEach(() => {
  window.localStorage.clear();
  __resetClientProfilesCacheForTests();
  __resetAutofillEngineForTests();
  counter = 0;
});
afterEach(() => {
  cleanup();
  globalThis.__optimusAutofillEngine = undefined;
  globalThis.__optimusAutofillOcr = undefined;
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Boton y paso «elegir fuentes»
 * ------------------------------------------------------------------ */

describe("el boton (estado vacio)", () => {
  it("sin campos de texto no hay boton; casillas e iniciales tampoco cuentan", () => {
    renderHarness({ fields: [] });
    expect(screen.queryByRole("button", { name: es.button })).toBeNull();
    cleanup();
    renderHarness({ fields: [field("c", "Acepto", { type: "checkbox" }), field("i", "Iniciales", { type: "initials" })] });
    expect(screen.queryByRole("button", { name: es.button })).toBeNull();
  });

  it("con un campo de texto o de fecha aparece", () => {
    renderHarness({ fields: [field("d", "Fecha", { type: "date" })] });
    expect(screen.getByRole("button", { name: es.button })).toBeTruthy();
  });
});

describe("elegir fuentes", () => {
  it("las cinco vias: subir, tomar foto (capture), hoja escaneada, pegar texto y perfil; enlace al escaner; leer deshabilitado sin fuentes", async () => {
    renderHarness({ fields: FIELDS() });
    const sheet = await open();
    for (const label of [es.upload, es.camera, es.scanned, es.paste, es.profilesButton]) expect(within(sheet).getByRole("button", { name: new RegExp(`^${label}`) })).toBeTruthy();
    const link = within(sheet).getByRole("link", { name: es.scanLink });
    expect(link.getAttribute("href")).toBe("/scan-to-pdf");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    const camera = sheet.querySelector('[data-autofill-input="camera"]') as HTMLInputElement;
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.accept).toBe("image/*");
    expect(camera.multiple).toBe(false);
    expect((sheet.querySelector('[data-autofill-input="file"]') as HTMLInputElement).multiple).toBe(true);
    expect((within(sheet).getByRole("button", { name: es.read }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText(es.noSources)).toBeTruthy();
    expect(within(sheet).getByText(es.privacyLine)).toBeTruthy();
  });

  it("el foco entra a la hoja (primer control) y Escape la cierra devolviendolo al boton", async () => {
    renderHarness({ fields: FIELDS() });
    const trigger = screen.getByRole("button", { name: es.button });
    trigger.focus();
    fireEvent.click(trigger);
    const sheet = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement?.hasAttribute("data-autofill-initial")).toBe(true));
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("varios archivos con origen distinto; los que no son PDF ni imagen o pesan demasiado se rechazan diciendo cual; se pueden quitar", async () => {
    renderHarness({ fields: FIELDS() });
    const sheet = await open();
    const pdf = new File(["%PDF-1.4"], "poliza.pdf", { type: "application/pdf" });
    const photo = new File(["x"], "licencia.jpg", { type: "image/jpeg" });
    const doc = new File(["x"], "notas.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    fireEvent.change(sheet.querySelector('[data-autofill-input="file"]') as HTMLInputElement, { target: { files: [pdf, photo, doc] } });
    expect(await within(sheet).findByText(es.chosenTitle(2))).toBeTruthy();
    expect(sheet.querySelector("[data-autofill-notices]")?.textContent).toBe(es.rejectedType("notas.docx"));
    fireEvent.change(sheet.querySelector('[data-autofill-input="scan"]') as HTMLInputElement, { target: { files: [new File(["x"], "hoja.pdf", { type: "application/pdf" })] } });
    expect(await within(sheet).findByText(es.chosenTitle(3))).toBeTruthy();
    expect(within(sheet).getByText(/Archivo · PDF · /)).toBeTruthy();
    expect(within(sheet).getByText(/Hoja escaneada · PDF · /)).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: es.read }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(sheet).getByRole("button", { name: es.remove("licencia.jpg") }));
    expect(within(sheet).getByText(es.chosenTitle(2))).toBeTruthy();
    const huge = new File(["x"], "enorme.pdf", { type: "application/pdf" });
    Object.defineProperty(huge, "size", { value: 61 * 1024 * 1024 });
    fireEvent.change(sheet.querySelector('[data-autofill-input="file"]') as HTMLInputElement, { target: { files: [huge] } });
    await waitFor(() => expect(sheet.querySelector("[data-autofill-notices]")?.textContent).toBe(es.rejectedSize("enorme.pdf", 60)));
  });

  it("solo hasta 10 fuentes a la vez", async () => {
    renderHarness({ fields: FIELDS() });
    const sheet = await open();
    const files = Array.from({ length: 11 }, (_, i) => new File(["x"], `doc${i}.pdf`, { type: "application/pdf" }));
    fireEvent.change(sheet.querySelector('[data-autofill-input="file"]') as HTMLInputElement, { target: { files } });
    expect(await within(sheet).findByText(es.chosenTitle(10))).toBeTruthy();
    expect(sheet.querySelector("[data-autofill-notices]")?.textContent).toBe(es.rejectedCount(10));
  });

  it("pegar texto: se añade como fuente y el campo vuelve a quedar vacio", async () => {
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("Phone: 555-0100");
    expect(await within(dialog()).findByText(es.chosenTitle(1))).toBeTruthy();
    expect(within(dialog()).getByText(es.pastedName(1))).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Leyendo, error, sin datos
 * ------------------------------------------------------------------ */

describe("leyendo", () => {
  it("muestra el progreso real del motor y «Cancelar» corta la lectura y vuelve a elegir (las fuentes se conservan)", async () => {
    let signal: AbortSignal | undefined;
    let progress: ((fraction: number) => void) | undefined;
    const engine = injectEngine((_sources, options) => {
      signal = options.signal;
      progress = options.onProgress;
      return new Promise<ExtractResult>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    });
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("Phone: 555-0100");
    read();
    expect(await within(dialog()).findByText(es.reading)).toBeTruthy();
    expect(engine).toHaveBeenCalledTimes(1);
    expect(engine.mock.calls[0][1]).toMatchObject({ locale: "es" });
    act(() => progress?.(0.4));
    expect((within(dialog()).getByRole("progressbar") as HTMLElement).getAttribute("aria-valuenow")).toBe("40");
    // El foco pasa a «Cancelar» (el boton que lo tenia desaparecio).
    await waitFor(() => expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: es.cancel })));
    fireEvent.click(within(dialog()).getByRole("button", { name: es.cancel }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await waitFor(() => expect(dialog().querySelector("[data-autofill-notices]")?.textContent).toBe(es.cancelled));
    expect(within(dialog()).getByText(es.chosenTitle(1))).toBeTruthy();
    expect(within(dialog()).queryByText(es.reviewTitle)).toBeNull();
  });

  it("cerrar la hoja mientras lee cancela la lectura y nada se escribe", async () => {
    let signal: AbortSignal | undefined;
    injectEngine((_sources, options) => {
      signal = options.signal;
      return new Promise<ExtractResult>(() => {});
    });
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("Phone: 555-0100");
    read();
    await within(dialog()).findByText(es.reading);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(signal?.aborted).toBe(true);
    expect(valuesOf()).toEqual({});
  });
});

describe("error y sin datos", () => {
  it("si el motor falla: aviso claro, vuelve a elegir y las fuentes siguen ahi para reintentar", async () => {
    injectEngine(async () => {
      throw new Error("boom");
    });
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("Phone: 555-0100");
    read();
    expect((await within(dialog()).findByRole("alert")).textContent).toBe(es.readFailed);
    expect(within(dialog()).getByText(es.chosenTitle(1))).toBeTruthy();
    expect(JSON.stringify(document.body.textContent)).not.toContain("boom");
    injectEngine(async () => result([found("phone", "555-0100")]));
    read();
    expect(await within(dialog()).findByText(es.reviewTitle)).toBeTruthy();
  });

  it("sin datos: lo dice, con la advertencia del motor en lenguaje claro, y ofrece volver", async () => {
    injectEngine(async () => result([], { warnings: [{ code: "no-data", sourceIndex: 0, message: "x" }] }));
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("nada util");
    read();
    await within(dialog()).findByText(es.nothingFoundHint);
    expect(dialog().querySelector("[data-autofill-empty]")?.textContent).toContain(es.nothingFound);
    expect(dialog().querySelector('[data-autofill-warning="no-data"]')?.textContent).toBe(es.warning("no-data", es.pastedName(1)));
    fireEvent.click(within(dialog()).getByRole("button", { name: es.back }));
    expect(await within(dialog()).findByText(es.chosenTitle(1))).toBeTruthy();
  });

  it("ocr-unavailable explica que hace falta bajar el modelo de lectura una vez y que los PDF con texto no lo necesitan", async () => {
    injectEngine(async () => result([found("phone", "555-0100")], { warnings: [{ code: "ocr-unavailable", sourceIndex: 0, message: "x" }] }));
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("Phone: 555-0100");
    read();
    const warning = await within(dialog()).findByText(/descargar el modelo una vez/);
    expect(warning.textContent).toBe("Para leer fotos hace falta descargar el modelo una vez; los PDF con texto se leen sin descargar nada.");
    // Y se ofrece descargarlo y volver a leer (el motor nunca lo baja por su cuenta).
    expect(within(dialog()).getByRole("button", { name: es.modelRetry })).toBeTruthy();
  });

  it("cada codigo de aviso tiene su texto, sin mostrar el mensaje crudo del motor", () => {
    for (const strings of [es, en]) {
      for (const code of ["ocr-unavailable", "no-data", "page-skipped", "too-many-pages", "unreadable-source"] as const) {
        const text = strings.warning(code, "poliza.pdf");
        expect(text.length, code).toBeGreaterThan(10);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Con datos
 * ------------------------------------------------------------------ */

describe("con datos: revisar y rellenar", () => {
  const FOUND = () => [
    found("insuredName1", "MARIA PEREZ SOTO", { evidence: { sourceIndex: 0, pageIndex: 1, snippet: "Insured: MARIA PEREZ SOTO", origin: "text-layer" }, reason: "junto a «Insured:» en la pagina 2" }),
    found("phone", "555-0100", { tier: "review", confidence: 0.5 }),
    found("policyNumber", "POL-0001"),
    found("claimNumber", "CLM-0042"),
  ];

  async function toReview(values = FOUND(), props: Partial<React.ComponentProps<typeof Harness>> = {}) {
    injectEngine(async () => result(values));
    renderHarness({ fields: FIELDS(), ...props });
    await open();
    await addPasted("lo que sea");
    read();
    await within(dialog()).findByText(es.reviewTitle);
  }

  it("agrupa por clave con la etiqueta del registro; marcado por defecto SOLO lo de confianza alta; la de revisar queda sin marcar", async () => {
    await toReview();
    const review = dialog().querySelector("[data-autofill-review]") as HTMLElement;
    const groups = [...review.querySelectorAll("[data-autofill-group]")].map((node) => node.getAttribute("data-autofill-group"));
    expect(groups).toEqual(["insuredName1", "phone", "policyNumber", "claimNumber"]);
    const check = (label: string) => within(review.querySelector(`[data-autofill-group="${label}"]`) as HTMLElement).getByRole("checkbox") as HTMLInputElement;
    expect(check("insuredName1").checked).toBe(true);
    expect(check("phone").checked).toBe(false);
    expect(check("policyNumber").checked).toBe(true);
    // Etiquetas legibles del registro (no la clave interna).
    expect(within(review).getAllByText("Nombre del asegurado 1").length).toBeGreaterThan(0);
    expect(within(review).getAllByText("Teléfono").length).toBeGreaterThan(0);
  });

  it("la confianza se dice con TEXTO, y cada valor trae su evidencia «Pág. N: «…»» y el por que", async () => {
    await toReview();
    const name = dialog().querySelector('[data-autofill-group="insuredName1"]') as HTMLElement;
    expect(within(name).getByText(es.confidenceHigh)).toBeTruthy();
    expect(within(name).getByText("Pág. 2: «Insured: MARIA PEREZ SOTO»")).toBeTruthy();
    expect(within(name).getByText("Por qué: junto a «Insured:» en la pagina 2")).toBeTruthy();
    const phone = dialog().querySelector('[data-autofill-group="phone"]') as HTMLElement;
    expect(within(phone).getByText(es.confidenceReview)).toBeTruthy();
  });

  it("la vista previa dice a que CAMPO va cada valor; el que no tiene campo se dice aparte; «Rellenar N campos» escribe y cierra", async () => {
    await toReview();
    const rows = [...dialog().querySelectorAll("[data-autofill-row]")].map((row) => row.getAttribute("data-autofill-row"));
    expect(rows).toEqual(["f-name", "f-policy"]);
    expect(within(dialog()).getByText(es.mapRow("Insured Name", 1))).toBeTruthy();
    expect(dialog().querySelector("[data-autofill-unmatched]")?.textContent).toBe(es.noFieldFor("N.º de reclamo"));
    const fill = within(dialog()).getByRole("button", { name: es.fillButton(2) });
    fireEvent.click(fill);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(valuesOf()).toEqual({ "f-name": "MARIA PEREZ SOTO", "f-policy": "POL-0001" });
    // Region viva con el resultado, y el foco vuelve al boton.
    expect(document.querySelector("[data-autofill-status]")?.textContent).toContain(es.filled(2, null));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: es.button }));
  });

  it("marcar un dato «Revisar» lo suma a los campos; desmarcar uno lo quita", async () => {
    await toReview();
    const phone = within(dialog().querySelector('[data-autofill-group="phone"]') as HTMLElement).getByRole("checkbox");
    fireEvent.click(phone);
    expect(await within(dialog()).findByRole("button", { name: es.fillButton(3) })).toBeTruthy();
    fireEvent.click(within(dialog().querySelector('[data-autofill-group="policyNumber"]') as HTMLElement).getByRole("checkbox"));
    expect(await within(dialog()).findByRole("button", { name: es.fillButton(2) })).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(2) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-name": "MARIA PEREZ SOTO", "f-phone": "555-0100" }));
  });

  it("corregir un valor: lo escrito es lo corregido, con su marca «Corregido por ti»", async () => {
    await toReview();
    const input = dialog().querySelector('[data-autofill-value]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  María   Pérez Soto " } });
    expect(within(dialog()).getByText(es.edited)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(2) }));
    await waitFor(() => expect(valuesOf()["f-name"]).toBe("María Pérez Soto"));
  });

  it("un valor que queda vacio no se rellena", async () => {
    await toReview();
    fireEvent.change(dialog().querySelector('[data-autofill-value]') as HTMLInputElement, { target: { value: "   " } });
    expect(await within(dialog()).findByRole("button", { name: es.fillButton(1) })).toBeTruthy();
  });

  it("deshacer de UN paso: devuelve cada campo a lo que tenia, respeta lo que la persona cambio despues y anuncia", async () => {
    await toReview(FOUND(), { initial: { "f-misc": "nota previa" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(2) }));
    await waitFor(() => expect(valuesOf()["f-name"]).toBe("MARIA PEREZ SOTO"));
    const status = document.querySelector("[data-autofill-status]") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(within(status).getByRole("button", { name: es.undo }));
    expect(valuesOf()).toEqual({ "f-misc": "nota previa" });
    expect(status.textContent).toContain(es.undone);
    expect(within(status).queryByRole("button", { name: es.undo })).toBeNull();
  });
});

describe("con conflictos", () => {
  it("dos valores de confianza ALTA distintos para la misma clave: nada se marca solo, se elige uno y «Ninguno» es la opcion marcada", async () => {
    injectEngine(async () => result([found("phone", "555-0100"), found("phone", "555-0199", { confidence: 0.9 }), found("insuredName1", "ANA PEREZ")]));
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    const group = dialog().querySelector('[data-autofill-group="phone"]') as HTMLElement;
    expect(group.hasAttribute("data-autofill-multiple")).toBe(true);
    expect(within(group).getByText(es.groupConflict)).toBeTruthy();
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([false, false, true]);
    expect(within(group).getByRole("radio", { name: es.noneOption })).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: es.fillButton(1) })).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "555-0199" }));
    // El elegido muestra su campo para corregir.
    expect(group.querySelector("[data-autofill-value]")).toBeTruthy();
    fireEvent.click(await within(dialog()).findByRole("button", { name: es.fillButton(2) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-name": "ANA PEREZ", "f-phone": "555-0199" }));
  });

  it("uno alto y otro «Revisar» distinto: se marca el alto pero se ofrece elegir; el mismo valor repetido se junta en uno", async () => {
    injectEngine(async () => result([found("phone", "555-0100"), found("phone", "555-0199", { tier: "review", confidence: 0.4 }), found("phone", "(555) 0100", { tier: "review", confidence: 0.3 })]));
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    const group = dialog().querySelector('[data-autofill-group="phone"]') as HTMLElement;
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    // 555-0100 y «(555) 0100» son el mismo numero: dos candidatos distintos + «Ninguno».
    expect(radios).toHaveLength(3);
    expect(radios[0].checked).toBe(true);
  });
});

describe("con pisado", () => {
  it("un campo que ya tiene texto aparece SIN marcar y con la advertencia; solo se sustituye si la persona lo marca; deshacer devuelve el texto", async () => {
    injectEngine(async () => result([found("insuredName1", "ANA PEREZ"), found("phone", "555-0100")]));
    renderHarness({ fields: FIELDS(), initial: { "f-name": "Escrito a mano" } });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    const row = dialog().querySelector('[data-autofill-row="f-name"]') as HTMLElement;
    expect(row.hasAttribute("data-overwrites")).toBe(true);
    expect((within(row).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(within(row).getByText(es.overwrites("Escrito a mano"))).toBeTruthy();
    // Solo el campo vacio cuenta.
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(1) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-name": "Escrito a mano", "f-phone": "555-0100" }));
  });

  it("marcar a proposito el que pisa lo escribe, y deshacer devuelve lo que habia", async () => {
    injectEngine(async () => result([found("insuredName1", "ANA PEREZ")]));
    renderHarness({ fields: FIELDS(), initial: { "f-name": "Escrito a mano" } });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    expect((within(dialog()).getByRole("button", { name: es.fillNothing }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog().querySelector('[data-autofill-row="f-name"]') as HTMLElement).getByRole("checkbox"));
    fireEvent.click(await within(dialog()).findByRole("button", { name: es.fillButton(1) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-name": "ANA PEREZ" }));
    fireEvent.click(within(document.querySelector("[data-autofill-status]") as HTMLElement).getByRole("button", { name: es.undo }));
    expect(valuesOf()).toEqual({ "f-name": "Escrito a mano" });
  });

  it("si el campo ya dice lo mismo no hay fila ni cuenta como relleno", async () => {
    injectEngine(async () => result([found("insuredName1", "Ana Pérez")]));
    renderHarness({ fields: FIELDS(), initial: { "f-name": "ana perez" } });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    expect(dialog().querySelector("[data-autofill-row]")).toBeNull();
    expect(within(dialog()).getByText(es.noMatches)).toBeTruthy();
  });
});

describe("campos de fecha y origen de dato de la plantilla", () => {
  it("un valor que no es una fecha que se pueda escribir NO se escribe en un campo de fecha (nunca se adivina el formato)", async () => {
    injectEngine(async () => result([found("lossDate", "el 12 de marzo")]));
    renderHarness({ fields: [field("f-date", "Date of Loss", { type: "date" })] });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    const row = dialog().querySelector('[data-autofill-row="f-date"]') as HTMLElement;
    expect((within(row).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(within(row).getByText(es.notDate("Date of Loss"))).toBeTruthy();
    expect((within(dialog()).getByRole("button", { name: es.fillNothing }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("un valor ISO si se escribe en el campo de fecha", async () => {
    injectEngine(async () => result([found("lossDate", "2026-03-12")]));
    renderHarness({ fields: [field("f-date", "Date of Loss", { type: "date" })] });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(1) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-date": "2026-03-12" }));
  });

  it("el motor entrega las fechas en el formato del idioma (dd/mm/aaaa en es): se ve tal cual y el campo guarda AAAA-MM-DD", async () => {
    injectEngine(async () => result([found("lossDate", "30/09/2026")]));
    renderHarness({ fields: [field("f-date", "Date of Loss", { type: "date" })] });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    expect(dialog().querySelector("[data-autofill-row-value]")?.textContent).toBe("30/09/2026");
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(1) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-date": "2026-09-30" }));
  });

  it("en ingles el mismo campo lee mm/dd/aaaa", async () => {
    injectEngine(async () => result([found("lossDate", "09/30/2026")]));
    renderHarness({ fields: [field("f-date", "Date of Loss", { type: "date" })] }, "en");
    await open(en);
    await addPasted("x", en);
    read(en);
    await within(dialog()).findByText(en.reviewTitle);
    fireEvent.click(within(dialog()).getByRole("button", { name: en.fillButton(1) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-date": "2026-09-30" }));
  });

  it("el dataKey que fijo la plantilla gana sobre la etiqueta (un campo sin etiqueta recibe el dato)", async () => {
    injectEngine(async () => result([found("phone", "555-0100")]));
    renderHarness({ fields: [field("f-x", undefined)], dataKeys: { "f-x": "phone" } });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    expect(within(dialog()).getByText(es.mapRowNoLabel(1))).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(1) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-x": "555-0100" }));
  });
});

/* ------------------------------------------------------------------ *
 * Perfil
 * ------------------------------------------------------------------ */

describe("guardar como perfil y reutilizarlo", () => {
  it("«Guardar como perfil» propone el nombre del asegurado, guarda lo marcado (con su origen) y avisa; la persona puede cambiar el nombre", async () => {
    injectEngine(async () => result([found("insuredName1", "Maria Perez Soto"), found("phone", "555-0100"), found("claimNumber", "CLM-0042", { tier: "review", confidence: 0.4 })]));
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    const save = within(dialog()).getByRole("checkbox", { name: es.saveProfile }) as HTMLInputElement;
    expect(save.checked).toBe(false);
    expect(within(dialog()).queryByLabelText(es.profileName)).toBeNull();
    fireEvent.click(save);
    const name = (await within(dialog()).findByLabelText(es.profileName)) as HTMLInputElement;
    expect(name.value).toBe("Maria Perez Soto");
    fireEvent.change(name, { target: { value: "Pérez Soto, María" } });
    // Corregir un valor lo guarda como escrito a mano.
    fireEvent.change(dialog().querySelector('[data-autofill-group="phone"] [data-autofill-value]') as HTMLInputElement, { target: { value: "555-0111" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(2) }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [profile] = listClientProfiles();
    expect(profile.name).toBe("Pérez Soto, María");
    expect(Object.fromEntries(Object.entries(profile.values).map(([key, v]) => [key, [v.value, v.source]]))).toEqual({ insuredName1: ["Maria Perez Soto", "extracted"], phone: ["555-0111", "typed"] });
    expect(document.querySelector("[data-autofill-status]")?.textContent).toContain(es.profileSaved("Pérez Soto, María", false));
    // Lo de «Revisar» sin marcar NO se guardo.
    expect(profile.values.claimNumber).toBeUndefined();
  });

  it("sin nombre no se guarda ni se rellena y se dice por que; con 20 perfiles se dice y tampoco se rellena", async () => {
    injectEngine(async () => result([found("phone", "555-0100")]));
    renderHarness({ fields: FIELDS() });
    await open();
    await addPasted("x");
    read();
    await within(dialog()).findByText(es.reviewTitle);
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: es.saveProfile }));
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(1) }));
    expect((await within(dialog()).findByRole("alert")).textContent).toBe(es.profileNameRequired);
    expect(valuesOf()).toEqual({});
    for (let i = 0; i < 20; i += 1) saveClientProfile({ name: `Cliente ${i}`, values: { phone: "555-0100" } });
    fireEvent.change(within(dialog()).getByLabelText(es.profileName), { target: { value: "Uno mas" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(1) }));
    expect((await within(dialog()).findByRole("alert")).textContent).toBe(es.profileFull);
    expect(valuesOf()).toEqual({});
    expect(listClientProfiles()).toHaveLength(20);
  });

  it("un perfil guardado salta la lectura y va directo a revisar, con su origen; rellenar usa sus valores", async () => {
    saveClientProfile({ name: "Pérez, Ana", values: { insuredName1: "Ana Pérez", phone: "555-0100" } });
    const engine = injectEngine(async () => result([]));
    renderHarness({ fields: FIELDS() });
    await open();
    fireEvent.click(within(dialog()).getByRole("button", { name: new RegExp(`^${es.profilesButton}`) }));
    expect(await within(dialog()).findByRole("heading", { name: es.profilesTitle })).toBeTruthy();
    expect(within(dialog()).getByText(es.profileValues(2))).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: es.profileUse("Pérez, Ana") }));
    expect(await within(dialog()).findByText(es.reviewTitle)).toBeTruthy();
    expect(engine).not.toHaveBeenCalled();
    expect(within(dialog()).getAllByText(es.fromProfile("Pérez, Ana"))).toHaveLength(2);
    // Con un perfil no se ofrece volver a guardarlo.
    expect(within(dialog()).queryByRole("checkbox", { name: es.saveProfile })).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: es.fillButton(2) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-name": "Ana Pérez", "f-phone": "555-0100" }));
    expect(document.querySelector("[data-autofill-status]")?.textContent).toContain(es.filled(2, "«Pérez, Ana»"));
  });

  it("gestion: renombrar, corregir un valor, quitar un valor y borrar el perfil (con confirmacion); «Borrar datos» lo vacia en vivo", async () => {
    saveClientProfile({ name: "Pérez, Ana", values: { insuredName1: "Ana Pérez", phone: "555-0100" } });
    renderHarness({ fields: FIELDS() });
    await open();
    fireEvent.click(within(dialog()).getByRole("button", { name: new RegExp(`^${es.profilesButton}`) }));
    await within(dialog()).findByRole("heading", { name: es.profilesTitle });
    fireEvent.click(within(dialog()).getByRole("button", { name: es.profileEdit("Pérez, Ana") }));
    const name = await within(dialog()).findByLabelText(es.profileRenameLabel);
    fireEvent.change(name, { target: { value: "Pérez Ruiz, Ana" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: es.profileRename }));
    expect(await within(dialog()).findByText("Pérez Ruiz, Ana")).toBeTruthy();
    expect(listClientProfiles()[0].name).toBe("Pérez Ruiz, Ana");

    const phone = within(dialog().querySelector('[data-autofill-profile-value="phone"]') as HTMLElement);
    fireEvent.change(phone.getByLabelText("Teléfono"), { target: { value: "555-0777" } });
    fireEvent.click(phone.getByRole("button", { name: es.profileValueSave("Teléfono") }));
    await waitFor(() => expect(listClientProfiles()[0].values.phone).toMatchObject({ value: "555-0777", source: "typed" }));
    fireEvent.change(phone.getByLabelText("Teléfono"), { target: { value: "5" } });
    fireEvent.click(phone.getByRole("button", { name: es.profileValueSave("Teléfono") }));
    expect(await phone.findByRole("alert")).toBeTruthy();
    expect(listClientProfiles()[0].values.phone.value).toBe("555-0777");

    fireEvent.click(within(dialog().querySelector('[data-autofill-profile-value="insuredName1"]') as HTMLElement).getByRole("button", { name: es.profileValueRemove("Nombre del asegurado 1") }));
    await waitFor(() => expect(Object.keys(listClientProfiles()[0].values)).toEqual(["phone"]));

    fireEvent.click(within(dialog()).getByRole("button", { name: es.profileDelete("Pérez Ruiz, Ana") }));
    const confirm = await screen.findByRole("button", { name: es.profileDeleteConfirm });
    fireEvent.click(confirm);
    await waitFor(() => expect(listClientProfiles()).toEqual([]));
    expect(await within(dialog()).findByText(es.profilesEmpty)).toBeTruthy();
  });

  it("la lista de perfiles sigue al almacen en vivo (otra pestana o «Borrar datos»)", async () => {
    saveClientProfile({ name: "Pérez, Ana", values: { phone: "555-0100" } });
    renderHarness({ fields: FIELDS() });
    await open();
    fireEvent.click(within(dialog()).getByRole("button", { name: new RegExp(`^${es.profilesButton}`) }));
    await within(dialog()).findByText("Pérez, Ana");
    act(() => {
      window.localStorage.removeItem(CLIENT_PROFILES_STORAGE_KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: CLIENT_PROFILES_STORAGE_KEY }));
    });
    expect(await within(dialog()).findByText(es.profilesEmpty)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Modelo de lectura (OCR): el motor NUNCA lo descarga; la persona lo pide
 * ------------------------------------------------------------------ */

describe("modelo de lectura (OCR)", () => {
  type Prepare = "ok" | "offline" | "network" | "engine" | "hang";

  function injectOcr(state: { available: boolean; prepare?: Prepare }) {
    const api = {
      ocrModelAvailable: vi.fn(async () => state.available),
      prepareOcrModel: vi.fn((options?: { signal?: AbortSignal }) => {
        const mode = state.prepare ?? "ok";
        if (mode === "hang") {
          return new Promise<{ ok: true } | { ok: false; reason: "cancelled" }>((resolve) => options?.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" })));
        }
        if (mode === "ok") {
          state.available = true;
          return Promise.resolve({ ok: true as const });
        }
        return Promise.resolve({ ok: false as const, reason: mode });
      }),
    };
    globalThis.__optimusAutofillOcr = api;
    return api;
  }

  const photo = () => new File(["x"], "licencia.jpg", { type: "image/jpeg" });
  const pdf = () => new File(["%PDF-1.4"], "poliza.pdf", { type: "application/pdf" });

  async function openWith(files: { camera?: File; file?: File }) {
    renderHarness({ fields: FIELDS() });
    const sheet = await open();
    if (files.camera) fireEvent.change(sheet.querySelector('[data-autofill-input="camera"]') as HTMLInputElement, { target: { files: [files.camera] } });
    if (files.file) fireEvent.change(sheet.querySelector('[data-autofill-input="file"]') as HTMLInputElement, { target: { files: [files.file] } });
    await within(sheet).findByText(es.chosenTitle(files.camera && files.file ? 2 : 1));
    return sheet;
  }

  it("con una foto y SIN modelo no lee: explica, ofrece descargar con un boton y, al bajarlo, lee", async () => {
    const ocr = injectOcr({ available: false });
    const engine = injectEngine(async () => result([found("phone", "555-0100")]));
    await openWith({ camera: photo() });
    read();
    const body = await waitFor(() => {
      const node = dialog().querySelector("[data-autofill-model-body]");
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });
    expect(body.textContent).toBe("Para leer fotos hace falta descargar el modelo una vez; los PDF con texto se leen sin descargar nada.");
    expect(engine).not.toHaveBeenCalled();
    expect(ocr.prepareOcrModel).not.toHaveBeenCalled();
    // Solo hay fotos: no hay «Leer sin las fotos».
    expect(within(dialog()).queryByRole("button", { name: es.modelSkipPhotos })).toBeNull();
    await waitFor(() => expect(document.activeElement?.textContent).toBe(es.modelTitle));
    fireEvent.click(within(dialog()).getByRole("button", { name: es.modelDownload }));
    expect(await within(dialog()).findByText(es.reviewTitle)).toBeTruthy();
    expect(ocr.prepareOcrModel).toHaveBeenCalledTimes(1);
    expect(engine).toHaveBeenCalledTimes(1);
    expect(engine.mock.calls[0][0]).toHaveLength(1);
  });

  it("con el modelo ya descargado se lee directo, sin paso intermedio", async () => {
    const ocr = injectOcr({ available: true });
    const engine = injectEngine(async () => result([found("phone", "555-0100")]));
    await openWith({ camera: photo() });
    read();
    expect(await within(dialog()).findByText(es.reviewTitle)).toBeTruthy();
    expect(ocr.ocrModelAvailable).toHaveBeenCalledTimes(1);
    expect(ocr.prepareOcrModel).not.toHaveBeenCalled();
    expect(engine).toHaveBeenCalledTimes(1);
  });

  it("si no se puede saber si hay modelo, se supone que no hay: se ofrece descargarlo (nunca se queda colgado)", async () => {
    globalThis.__optimusAutofillOcr = {
      ocrModelAvailable: vi.fn(async () => {
        throw new Error("cache bloqueada");
      }),
      prepareOcrModel: vi.fn(async () => ({ ok: true as const })),
    };
    const engine = injectEngine(async () => result([]));
    await openWith({ camera: photo() });
    read();
    expect(await within(dialog()).findByRole("button", { name: es.modelDownload })).toBeTruthy();
    expect(engine).not.toHaveBeenCalled();
  });

  it("con solo PDF o texto no se pregunta por el modelo (se leen sin descargar nada)", async () => {
    const ocr = injectOcr({ available: false });
    injectEngine(async () => result([found("phone", "555-0100")]));
    await openWith({ file: pdf() });
    read();
    expect(await within(dialog()).findByText(es.reviewTitle)).toBeTruthy();
    expect(ocr.ocrModelAvailable).not.toHaveBeenCalled();
  });

  it("la descarga muestra su progreso con «Cancelar»: cancelar corta la descarga y vuelve al paso del modelo sin culpar a nadie", async () => {
    const ocr = injectOcr({ available: false, prepare: "hang" });
    const engine = injectEngine(async () => result([]));
    await openWith({ camera: photo() });
    read();
    fireEvent.click(await within(dialog()).findByRole("button", { name: es.modelDownload }));
    await waitFor(() => expect(dialog().querySelector("[data-autofill-downloading]")?.textContent).toContain(es.modelDownloading));
    await waitFor(() => expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: es.cancel })));
    fireEvent.click(within(dialog()).getByRole("button", { name: es.cancel }));
    expect(await within(dialog()).findByRole("button", { name: es.modelDownload })).toBeTruthy();
    expect(dialog().querySelector("[data-autofill-model-failure]")).toBeNull();
    expect(ocr.prepareOcrModel.mock.calls[0][0]?.signal?.aborted).toBe(true);
    expect(engine).not.toHaveBeenCalled();
  });

  for (const reason of ["offline", "network", "engine"] as const) {
    it(`si la descarga falla (${reason}) lo dice con su motivo y deja reintentar`, async () => {
      const state = { available: false, prepare: reason as Prepare };
      const ocr = injectOcr(state);
      injectEngine(async () => result([found("phone", "555-0100")]));
      await openWith({ camera: photo() });
      read();
      fireEvent.click(await within(dialog()).findByRole("button", { name: es.modelDownload }));
      const failure = await waitFor(() => {
        const node = dialog().querySelector("[data-autofill-model-failure]");
        expect(node).toBeTruthy();
        return node as HTMLElement;
      });
      expect(failure.textContent).toBe(es.modelFailed(reason));
      expect(failure.getAttribute("role")).toBe("alert");
      state.prepare = "ok";
      fireEvent.click(within(dialog()).getByRole("button", { name: es.modelRetryDownload }));
      expect(await within(dialog()).findByText(es.reviewTitle)).toBeTruthy();
      expect(ocr.prepareOcrModel).toHaveBeenCalledTimes(2);
    });
  }

  it("con fotos y un PDF, «Leer sin las fotos» manda al motor SOLO el PDF y lo dice en la revision", async () => {
    injectOcr({ available: false, prepare: "offline" });
    const engine = injectEngine(async () => result([found("phone", "555-0100")]));
    await openWith({ camera: photo(), file: pdf() });
    read();
    fireEvent.click(await within(dialog()).findByRole("button", { name: es.modelSkipPhotos }));
    expect(await within(dialog()).findByText(es.reviewTitle)).toBeTruthy();
    expect(engine).toHaveBeenCalledTimes(1);
    const sent = engine.mock.calls[0][0];
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("pdf");
    expect(dialog().querySelector("[data-autofill-skipped-photos]")?.textContent).toBe(es.skippedPhotos(1));
  });

  it("un PDF ESCANEADO se descubre al leer (el motor avisa ocr-unavailable): se ofrece descargar el modelo y volver a leer todo", async () => {
    const state = { available: false };
    const ocr = injectOcr(state);
    let calls = 0;
    const engine = injectEngine(async () => {
      calls += 1;
      return calls === 1 ? result([], { warnings: [{ code: "ocr-unavailable", sourceIndex: 0, message: "x" }] }) : result([found("phone", "555-0100")]);
    });
    await openWith({ file: pdf() });
    read();
    expect(await within(dialog()).findByText(es.nothingFoundHint)).toBeTruthy();
    expect(within(dialog()).getByText(es.warning("ocr-unavailable", null))).toBeTruthy();
    expect(ocr.ocrModelAvailable).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole("button", { name: es.modelRetry }));
    await waitFor(() => expect(engine).toHaveBeenCalledTimes(2));
    expect(ocr.prepareOcrModel).toHaveBeenCalledTimes(1);
    expect(await within(dialog()).findByRole("button", { name: es.fillButton(1) })).toBeTruthy();
    // Con el modelo ya puesto el boton de descargar no vuelve.
    expect(within(dialog()).queryByRole("button", { name: es.modelRetry })).toBeNull();
  });

  it("en ingles el paso del modelo habla ingles", async () => {
    injectOcr({ available: false });
    injectEngine(async () => result([]));
    renderHarness({ fields: FIELDS() }, "en");
    const sheet = await open(en);
    fireEvent.change(sheet.querySelector('[data-autofill-input="camera"]') as HTMLInputElement, { target: { files: [photo()] } });
    await within(sheet).findByText(en.chosenTitle(1));
    read(en);
    await within(dialog()).findByRole("button", { name: en.modelDownload });
    expect(dialog().querySelector("[data-autofill-model-body]")?.textContent).toBe("Reading photos needs a one-time download of the model; PDFs with text are read without downloading anything.");
    expect(within(dialog()).getByRole("button", { name: en.modelDownload })).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Ingles
 * ------------------------------------------------------------------ */

describe("ingles", () => {
  it("toda la hoja habla ingles y el motor recibe locale en", async () => {
    const engine = injectEngine(async () => result([found("phone", "555-0100", { tier: "review", confidence: 0.4 }), found("insuredName1", "ANA PEREZ")]));
    renderHarness({ fields: FIELDS() }, "en");
    await open(en);
    await addPasted("Phone: 555-0100", en);
    read(en);
    expect(await within(dialog()).findByText(en.reviewTitle)).toBeTruthy();
    expect(engine.mock.calls[0][1]).toMatchObject({ locale: "en" });
    expect(within(dialog()).getAllByText("Insured name 1").length).toBeGreaterThan(0);
    expect(within(dialog()).getByText(en.confidenceReview)).toBeTruthy();
    expect(within(dialog()).getByText(en.evidence(2, "insuredName1: ANA PEREZ"))).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: en.fillButton(1) }));
    await waitFor(() => expect(valuesOf()).toEqual({ "f-name": "ANA PEREZ" }));
    expect(document.querySelector("[data-autofill-status]")?.textContent).toContain(en.filled(1, null));
  });
});
