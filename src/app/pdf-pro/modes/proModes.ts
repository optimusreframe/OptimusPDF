import type { ProModeDefinition } from "./modeTypes";

/**
 * Registro de modos de PDF Pro. Cada modo se registra a si mismo (efecto secundario de importar
 * su modulo) con `registerProMode`; el host busca el de la pestana activa con `getProMode`.
 */
const modes = new Map<ProModeDefinition["tab"], ProModeDefinition>();

/** Registra (o reemplaza) el modo de una pestana. Devuelve la funcion que lo retira. */
export function registerProMode(def: ProModeDefinition): () => void {
  modes.set(def.tab, def);
  return () => {
    if (modes.get(def.tab) === def) modes.delete(def.tab);
  };
}

export function getProMode(tab: string): ProModeDefinition | undefined {
  return modes.get(tab as ProModeDefinition["tab"]);
}

export function listProModes(): ProModeDefinition[] {
  return [...modes.values()];
}
