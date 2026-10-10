"use client";

import {
  PasswordSheet as GenericPasswordSheet,
  type PasswordSheetStrings,
} from "@/components/tool/PasswordSheet";
import type { EditFlowStrings } from "@/app/edit-pdf/flowStrings";

/*
 * Hoja de contrasena del editor (Wave 5 · U5). Desde la Wave 6 · U3 la hoja vive en
 * `components/tool/PasswordSheet` con textos genericos, y esta es solo el adaptador que
 * le pasa los del editor (`EditFlowStrings`): el contrato del editor no cambia.
 */

export type PasswordSheetProps = {
  open: boolean;
  /** Cierra la hoja sin quitar el archivo (Esc, fuera, Cerrar). */
  onClose: () => void;
  onSubmit: (password: string) => void;
  /** «Cancelar»: la persona renuncia a este documento. */
  onCancel: () => void;
  busy: boolean;
  /** La ultima contrasena no abrio el documento. */
  wrong: boolean;
  /** Otro fallo al abrir con esa contrasena. */
  failed: boolean;
  /** Aumenta con cada intento fallido: devuelve el foco al campo. */
  attempt: number;
  flow: EditFlowStrings;
};

export function editPasswordStrings(flow: EditFlowStrings): PasswordSheetStrings {
  return {
    title: flow.passwordTitle,
    body: flow.passwordBody,
    label: flow.passwordLabel,
    show: flow.passwordShow,
    hide: flow.passwordHide,
    submit: flow.passwordSubmit,
    opening: flow.passwordOpening,
    cancel: flow.passwordCancel,
    wrong: flow.passwordWrong,
    failed: flow.passwordFailed,
    close: flow.confirmClose,
  };
}

export function PasswordSheet({ flow, ...props }: PasswordSheetProps) {
  return <GenericPasswordSheet {...props} strings={editPasswordStrings(flow)} />;
}
