import { describe, expect, it } from "vitest";
import { reportOfWrite } from "@/app/sign-pdf/draftWriteReport";

/** Lo que un autoguardado cuenta a la pantalla: solo «guardado» si de verdad se guardo (F0-fix, D1 y D2). */
describe("reportOfWrite", () => {
  it("un guardado correcto es `saved`", () => {
    expect(reportOfWrite({ ok: true })).toEqual({ kind: "saved" });
  });

  it("un guardado que fue a una copia aparte (otra pestana tenia lo nuevo) es `forked`, con el id de la copia", () => {
    expect(reportOfWrite({ ok: true, forkedTo: "s-copia" })).toEqual({ kind: "forked", toId: "s-copia" });
  });

  it("CUALQUIER fallo de escritura que no sea «no cabe» es `failed`: cuota, bloqueado, no disponible", () => {
    expect(reportOfWrite({ ok: false, reason: "unavailable" })).toEqual({ kind: "failed" });
  });

  it("«no cabe» es su propio motivo (`tooBig`), no un fallo", () => {
    expect(reportOfWrite({ ok: false, reason: "tooBig" })).toEqual({ kind: "tooBig" });
  });

  it("un guardado superado por otro mas nuevo no cuenta nada (ni exito ni fallo); sin resultado tampoco", () => {
    expect(reportOfWrite({ ok: false, reason: "superseded" })).toBeNull();
    expect(reportOfWrite(undefined)).toBeNull();
    expect(reportOfWrite(null)).toBeNull();
  });
});
