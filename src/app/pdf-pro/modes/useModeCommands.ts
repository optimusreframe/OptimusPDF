"use client";

import { useEffect, useRef } from "react";
import type { Language } from "@/lib/i18n";
import { getModeStrings } from "@/app/pdf-pro/modes/modeStrings";
import { registerCommand } from "@/app/pdf-pro/shell/proCommands";

/**
 * Comandos de la paleta Cmd/Ctrl+K de los modos Editar y Anotar (Wave 7 · U6): se registran mientras la suite esta
 * montada. Cada uno abre el modo y, cuando procede, le pide la herramienta («Añadir imagen» abre Editar con la
 * herramienta de imagen armada).
 */
export function useModeCommands({
  language,
  enterMode,
}: {
  language: Language;
  enterMode: (tab: "edit" | "annotate" | "sign", tool?: string) => void;
}): void {
  // El registro se rehace solo al cambiar de idioma: `enterMode` cambia de identidad con el estado de la suite y
  // volver a registrar en cada pintado haria repintar la suite (que escucha el registro) sin fin.
  const enterRef = useRef(enterMode);
  useEffect(() => {
    enterRef.current = enterMode;
  });
  useEffect(() => {
    const c = getModeStrings(language).commands;
    const enter = (tab: "edit" | "annotate" | "sign", tool?: string) => enterRef.current(tab, tool);
    const disposers = [
      registerCommand("mode:edit-text", {
        label: c.editText,
        group: "operations",
        shortcut: "E",
        keywords: ["editar", "edit", "texto", "text", "modificar", "cambiar"],
        run: () => enter("edit"),
      }),
      registerCommand("mode:annotate", {
        label: c.annotate,
        group: "operations",
        shortcut: "A",
        keywords: ["anotar", "annotate", "comentar", "comment", "marcar", "markup"],
        run: () => enter("annotate"),
      }),
      registerCommand("mode:add-image", {
        label: c.addImage,
        group: "operations",
        keywords: ["imagen", "image", "foto", "picture", "logo", "insertar", "insert"],
        run: () => enter("edit", "image"),
      }),
      registerCommand("mode:highlight", {
        label: c.highlight,
        group: "operations",
        keywords: ["resaltar", "resaltador", "highlight", "marcador", "subrayar"],
        run: () => enter("annotate", "highlight"),
      }),
      registerCommand("mode:add-note", {
        label: c.addNote,
        group: "operations",
        keywords: ["nota", "note", "comentario", "comment", "post-it"],
        run: () => enter("annotate", "note"),
      }),
      registerCommand("mode:sign", {
        label: c.signDocument,
        group: "operations",
        shortcut: "S",
        keywords: ["firmar", "sign", "firma", "signature", "rubrica"],
        run: () => enter("sign", "sign"),
      }),
      registerCommand("mode:fill", {
        label: c.fillForm,
        group: "operations",
        shortcut: "F",
        keywords: ["rellenar", "fill", "formulario", "form", "campos", "fields"],
        run: () => enter("sign", "fill"),
      }),
      registerCommand("mode:add-rect", {
        label: c.addShape,
        group: "operations",
        keywords: ["rectangulo", "rectangle", "forma", "shape", "figura", "dibujar", "draw"],
        run: () => enter("annotate", "rect"),
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [language]);
}
