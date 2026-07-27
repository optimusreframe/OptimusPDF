import type { Language } from "@/lib/i18n";
import type { ProtectFailure } from "@/lib/pdf/protect";

/** Copy propio de Proteger PDF (ES/EN). */
export type ProtectStrings = {
  passwordLabel: string;
  confirmLabel: string;
  showPassword: string;
  hidePassword: string;

  strengthLabel: string;
  strengthWeak: string;
  strengthMedium: string;
  strengthStrong: string;
  strengthHint: string;

  errors: Record<ProtectFailure, string>;

  infoTitle: string;
  infoBody: string;
  noRecovery: string;
  permissionsNote: string;

  largeFile: string;
  filenameSuffix: string;
};

const es: ProtectStrings = {
  passwordLabel: "Contraseña",
  confirmLabel: "Repite la contraseña",
  showPassword: "Mostrar la contraseña",
  hidePassword: "Ocultar la contraseña",

  strengthLabel: "Fortaleza",
  strengthWeak: "Floja",
  strengthMedium: "Aceptable",
  strengthStrong: "Sólida",
  strengthHint:
    "Medimos solo longitud y variedad de caracteres. Una frase larga con mayúsculas, números y algún símbolo aguanta mucho más que una palabra corta.",

  errors: {
    empty: "Escribe una contraseña para cifrar el documento.",
    tooShort: "Usa al menos 4 caracteres.",
    mismatch: "Las dos contraseñas no coinciden.",
  },

  infoTitle: "Qué hace exactamente",
  infoBody:
    "El documento se cifra en tu navegador y el archivo que descargas solo se abre escribiendo la contraseña. El cifrado va dentro del PDF, así que funciona en cualquier lector.",
  noRecovery:
    "Guarda la contraseña donde no la pierdas: el cifrado ocurre en tu dispositivo y aquí no queda ninguna copia con la que recuperar el documento.",
  permissionsNote:
    "Se conservan todos los permisos (imprimir, copiar, anotar): la contraseña sirve para abrir, no para limitar lo que hace quien ya entró.",

  largeFile:
    "El archivo pasa de 100 MB. Cifrarlo entero puede agotar la memoria de la pestaña.",
  filenameSuffix: "protegido",
};

const en: ProtectStrings = {
  passwordLabel: "Password",
  confirmLabel: "Repeat the password",
  showPassword: "Show the password",
  hidePassword: "Hide the password",

  strengthLabel: "Strength",
  strengthWeak: "Weak",
  strengthMedium: "Fair",
  strengthStrong: "Solid",
  strengthHint:
    "We only measure length and character variety. A long phrase with capitals, digits and a symbol holds up far better than a short word.",

  errors: {
    empty: "Type a password to encrypt the document.",
    tooShort: "Use at least 4 characters.",
    mismatch: "The two passwords do not match.",
  },

  infoTitle: "What this actually does",
  infoBody:
    "The document is encrypted in your browser and the file you download only opens by typing the password. The encryption lives inside the PDF, so it works in any reader.",
  noRecovery:
    "Keep the password somewhere safe: the encryption happens on your device and no copy is stored here to recover the document with.",
  permissionsNote:
    "Every permission is kept (printing, copying, annotating): the password is there to open the file, not to limit whoever already got in.",

  largeFile:
    "The file is over 100 MB. Encrypting all of it may exhaust the tab's memory.",
  filenameSuffix: "protected",
};

export const PROTECT_STRINGS: Record<Language, ProtectStrings> = { es, en };
