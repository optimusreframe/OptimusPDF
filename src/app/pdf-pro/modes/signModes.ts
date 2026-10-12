import { ProFillMode } from "@/app/pdf-pro/modes/ProFillMode";
import { ProSignMode } from "@/app/pdf-pro/modes/ProSignMode";
import { registerProMode } from "@/app/pdf-pro/modes/proModes";

/**
 * Modos Firmar y Rellenar de PDF Pro (Wave 7 · U7). Importar este modulo los registra (efecto secundario, como
 * el resto de modos) en el registro de `proModes.ts`; el anfitrion monta el `Component` de la pestana activa en la
 * region central EN LUGAR del visor y convierte `onApply` en UN snapshot.
 *
 *  - `sign` (pestana «Firmar»): el lienzo, la paleta, el baul y la ceremonia de la herramienta Firmar, para UN
 *    documento (una cola de varios documentos se firma con la herramienta suelta) y, en el mismo sitio, un
 *    conmutador a «Rellenar formulario» (la barra de pestanas de PDF Pro no tiene una octava pestana).
 *  - `fill` (pestana «Rellenar», id de pestana `fill`): el mismo Rellenar a solas, para un anfitrion que le de
 *    una pestana propia; con la barra actual no se alcanza y nada depende de ello.
 *
 * Ambos llevan su propio deshacer (el de la sesion de lienzo): el anfitrion registra
 * `registerMode(id, { hasOwnUndo: true })` y el Ctrl/Cmd+Z global no actua mientras estan abiertos.
 */
export const SIGN_MODE_DEFINITIONS = [
  {
    id: "sign",
    tab: "sign",
    labelKey: "sign",
    Component: ProSignMode,
    preferredTool: "sign-pdf",
  },
  {
    id: "fill",
    tab: "fill",
    labelKey: "fill",
    Component: ProFillMode,
    preferredTool: "sign-pdf",
  },
] as const;

for (const definition of SIGN_MODE_DEFINITIONS) registerProMode(definition);
