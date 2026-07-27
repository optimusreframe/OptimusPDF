import type { Language } from "@/lib/i18n";
import type { UnlockFailure } from "@/lib/pdf/unlock";

/** Copy propio de Desbloquear PDF (ES/EN). */
export type UnlockStrings = {
  passwordLabel: string;
  passwordHint: string;
  showPassword: string;
  hidePassword: string;

  errors: Record<UnlockFailure, string>;

  /** Estado mientras se lee la proteccion del archivo elegido. */
  inspecting: string;

  /** Antes de elegir archivo, o si la inspeccion no pudo completarse. */
  infoTitle: string;
  infoBody: string;

  /** Cifrado estandar: se prueba la contrasena vacia sin pedir nada. */
  standardTitle: string;
  standardBody: string;
  /** Tras fallar el intento automatico. */
  passwordNeededTitle: string;
  passwordNeededBody: string;

  /** Cifrado por certificado (`/Adobe.PubSec`): no soportado. */
  certificateTitle: string;
  certificateBody: string;
  /** Cualquier otro manejador de seguridad desconocido. */
  unsupportedHandlerTitle: string;
  unsupportedHandlerBody: string;

  /** Restricciones de firma: copia editable. */
  signaturesTitle: string;
  signaturesBody: string;
  signaturesWarning: string;
  signaturesConsent: string;
  signaturesConsentHint: string;

  /** Nada que quitar. */
  noProtectionTitle: string;
  noProtectionBody: string;

  legalNote: string;

  largeFile: string;
  filenameSuffix: string;
  /**
   * Salida del camino de firmas. No dice "sin firmas" a proposito: las
   * firmas siguen en el archivo, lo que deja de existir es su validez.
   */
  filenameSuffixSignatures: string;
};

const es: UnlockStrings = {
  passwordLabel: "Contraseña de apertura",
  passwordHint:
    "Escríbela tal cual, respetando mayúsculas y espacios. No la guardamos ni sale de esta pestaña.",
  showPassword: "Mostrar la contraseña",
  hidePassword: "Ocultar la contraseña",

  errors: {
    wrongPassword:
      "Esa contraseña no abre el documento. Revísala y vuelve a intentarlo.",
    notProtected:
      "Este documento no tiene ninguna protección que quitar: ya se puede editar e imprimir.",
    certificateEncryption:
      "Este PDF está cifrado con un certificado digital y no hay contraseña que lo abra aquí.",
    unsupportedSecurityHandler:
      "Este PDF usa un método de cifrado no reconocido: no sabemos abrirlo y ninguna contraseña lo cambiaría.",
    consentRequired:
      "Este documento tiene firmas que restringen los cambios. Marca la confirmación para crear la copia.",
  },

  inspecting: "Mirando qué protege a este documento…",

  infoTitle: "Qué hace esta herramienta",
  infoBody:
    "Retira del PDF lo que impide editarlo, imprimirlo o copiarlo: la contraseña, si la lleva, o la certificación de una firma digital. No rompe cifrados ni prueba combinaciones.",

  standardTitle: "Probablemente no haga falta contraseña",
  standardBody:
    "Este PDF está cifrado, pero la mayoría lo está solo para bloquear la impresión o la copia: se abren sin pedir nada. Pulsa Procesar y lo intentamos así. Si el documento exige de verdad una contraseña, te la pediremos entonces.",

  passwordNeededTitle: "Ahora sí necesitamos la contraseña",
  passwordNeededBody:
    "El intento sin contraseña no ha funcionado: este documento pide una de verdad para abrirse. Escríbela en el panel de opciones y vuelve a procesar. Si no la conoces, aquí no hay atajo.",

  certificateTitle: "Cifrado con certificado digital",
  certificateBody:
    "Este documento no se abre con una contraseña, sino con un certificado instalado en el equipo de quien debe leerlo. OptimusPDF no puede descifrar ese formato y escribir cualquier contraseña aquí no serviría de nada. Ábrelo en el lector donde tengas ese certificado y guarda desde allí una copia sin cifrar.",

  unsupportedHandlerTitle: "Método de cifrado no reconocido",
  unsupportedHandlerBody:
    "Este PDF usa un método de cifrado que no reconocemos: no es el estándar por contraseña ni el de certificado digital. No sabemos abrirlo y escribir cualquier contraseña aquí no serviría de nada. Ábrelo en el programa con el que se creó y guarda desde allí una copia sin cifrar.",

  signaturesTitle: "Bloqueado por una firma digital",
  signaturesBody:
    "Este PDF no lleva contraseña: se abre solo. Lo que impide editarlo es una firma que certifica el documento exactamente como está. Podemos crear una copia sin esa certificación, editable como cualquier otro PDF.",
  signaturesWarning:
    "La copia conservará el aspecto del sello, pero la firma dejará de valer: ya no podrá verificarse que esa firma autentique esta copia ni que el contenido permanezca intacto. Guarda el original firmado para trámites, auditorías o cualquier uso legal.",
  signaturesConsent:
    "Entiendo que la copia resultante no conservará firmas válidas",
  signaturesConsentHint:
    "Sin esta confirmación no creamos la copia: es un cambio que no se puede deshacer sobre el archivo descargado.",

  noProtectionTitle: "Sin protección que quitar",
  noProtectionBody:
    "Este archivo se abre y se edita sin restricciones: no hay contraseña ni certificación que retirar. Puedes usarlo tal cual en el resto de herramientas.",

  legalNote:
    "Quita la protección solo de documentos tuyos o para los que tengas permiso. Todo el proceso ocurre en tu navegador, así que la responsabilidad también se queda contigo.",

  largeFile:
    "El archivo pasa de 100 MB. Descifrarlo entero puede agotar la memoria de la pestaña.",
  filenameSuffix: "desbloqueado",
  filenameSuffixSignatures: "copia-editable-firmas-no-validas",
};

const en: UnlockStrings = {
  passwordLabel: "Opening password",
  passwordHint:
    "Type it exactly, capital letters and spaces included. We never store it and it never leaves this tab.",
  showPassword: "Show the password",
  hidePassword: "Hide the password",

  errors: {
    wrongPassword:
      "That password does not open the document. Check it and try again.",
    notProtected:
      "This document has no protection left to remove: you can already edit and print it.",
    certificateEncryption:
      "This PDF is encrypted with a digital certificate, so no password can open it here.",
    unsupportedSecurityHandler:
      "This PDF uses an encryption method we do not recognise: we cannot open it, and no password would change that.",
    consentRequired:
      "This document has signatures that restrict changes. Tick the confirmation to build the copy.",
  },

  inspecting: "Looking at what protects this document…",

  infoTitle: "What this tool does",
  infoBody:
    "It removes whatever stops you editing, printing or copying the PDF: the password, if it has one, or the certification of a digital signature. It does not break encryption or guess combinations.",

  standardTitle: "You probably do not need a password",
  standardBody:
    "This PDF is encrypted, but most of them are encrypted only to block printing or copying: they open without asking for anything. Press Process and we will try it that way. If the document really does require a password, we will ask for it then.",

  passwordNeededTitle: "Now we do need the password",
  passwordNeededBody:
    "Opening it without a password did not work: this document truly requires one. Type it in the options panel and process again. If you do not know it, there is no shortcut here.",

  certificateTitle: "Encrypted with a digital certificate",
  certificateBody:
    "This document does not open with a password but with a certificate installed on the machine of whoever is meant to read it. OptimusPDF cannot decrypt that format, and typing any password here would change nothing. Open it in the reader that holds the certificate and save an unencrypted copy from there.",

  unsupportedHandlerTitle: "Unrecognised encryption method",
  unsupportedHandlerBody:
    "This PDF uses an encryption method we do not recognise: it is neither the standard password scheme nor digital certificate encryption. We cannot open it, and typing any password here would change nothing. Open it in the program that created it and save an unencrypted copy from there.",

  signaturesTitle: "Locked by a digital signature",
  signaturesBody:
    "This PDF carries no password: it opens on its own. What stops you editing it is a signature certifying the document exactly as it stands. We can build a copy without that certification, editable like any other PDF.",
  signaturesWarning:
    "The copy will keep the look of the seal but the signature will stop counting: it will no longer be verifiable that the signature authenticates this copy or that the content remains intact. Keep the signed original for paperwork, audits or any legal use.",
  signaturesConsent: "I understand the resulting copy will keep no valid signatures",
  signaturesConsentHint:
    "Without this confirmation we do not build the copy: it is a change you cannot undo on the downloaded file.",

  noProtectionTitle: "Nothing to unlock",
  noProtectionBody:
    "This file opens and edits without restrictions: there is no password and no certification to take away. You can use it as it is in the rest of the tools.",

  legalNote:
    "Only remove protection from documents you own or are allowed to open. The whole process runs in your browser, so the responsibility stays with you too.",

  largeFile:
    "The file is over 100 MB. Decrypting all of it may exhaust the tab's memory.",
  filenameSuffix: "unlocked",
  filenameSuffixSignatures: "editable-copy-invalid-signatures",
};

export const UNLOCK_STRINGS: Record<Language, UnlockStrings> = { es, en };
