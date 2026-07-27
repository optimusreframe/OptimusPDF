import type { Language } from "@/lib/i18n";
import type { UnlockFailure } from "@/lib/pdf/unlock";

/** Copy propio de Desbloquear PDF (ES/EN). */
export type UnlockStrings = {
  passwordLabel: string;
  passwordHint: string;
  showPassword: string;
  hidePassword: string;

  errors: Record<UnlockFailure, string>;

  infoTitle: string;
  infoBody: string;
  legalNote: string;

  largeFile: string;
  filenameSuffix: string;
};

const es: UnlockStrings = {
  passwordLabel: "Contraseña actual del PDF",
  passwordHint:
    "Déjala vacía si el documento se abre solo pero está bloqueado para imprimir o copiar: ese caso usa contraseña vacía.",
  showPassword: "Mostrar la contraseña",
  hidePassword: "Ocultar la contraseña",

  errors: {
    wrongPassword:
      "Esa contraseña no abre el documento. Revísala y vuelve a intentarlo.",
    notEncrypted:
      "Este PDF no está cifrado: no hay ninguna contraseña que quitar.",
  },

  infoTitle: "Necesitas la contraseña",
  infoBody:
    "Esta herramienta no rompe cifrados ni prueba combinaciones: abre el documento con la contraseña que escribas y lo vuelve a guardar sin protección. Si no la conoces, aquí no hay atajo.",
  legalNote:
    "Quita la protección solo de documentos tuyos o para los que tengas permiso. Todo el proceso ocurre en tu navegador, así que la responsabilidad también se queda contigo.",

  largeFile:
    "El archivo pasa de 100 MB. Descifrarlo entero puede agotar la memoria de la pestaña.",
  filenameSuffix: "desbloqueado",
};

const en: UnlockStrings = {
  passwordLabel: "Current PDF password",
  passwordHint:
    "Leave it empty if the document opens on its own but is locked for printing or copying: that case uses an empty password.",
  showPassword: "Show the password",
  hidePassword: "Hide the password",

  errors: {
    wrongPassword:
      "That password does not open the document. Check it and try again.",
    notEncrypted: "This PDF is not encrypted: there is no password to remove.",
  },

  infoTitle: "You need the password",
  infoBody:
    "This tool does not break encryption or guess combinations: it opens the document with the password you type and saves it again without protection. If you do not know it, there is no shortcut here.",
  legalNote:
    "Only remove protection from documents you own or are allowed to open. The whole process runs in your browser, so the responsibility stays with you too.",

  largeFile:
    "The file is over 100 MB. Decrypting all of it may exhaust the tab's memory.",
  filenameSuffix: "unlocked",
};

export const UNLOCK_STRINGS: Record<Language, UnlockStrings> = { es, en };
