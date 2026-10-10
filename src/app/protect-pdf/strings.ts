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
  /** Motivo junto a «Procesar»: falta repetir la contrasena. */
  confirmRequired: string;
  /** Hoja de contrasena de un PDF ya cifrado: el resultado se vuelve a cifrar con la contrasena NUEVA. */
  encryptedCopySheetBody: string;
  /** Aviso de la copia abierta (`{name}`). */
  encryptedCopyNotice: string;

  infoTitle: string;
  infoBody: string;
  noRecovery: string;
  permissionsNote: string;

  requirePasswordLabel: string;
  requirePasswordHint: string;
  openWithoutPasswordWarning: string;

  permissionsTitle: string;
  permissionsHint: string;
  permissionPrinting: string;
  permissionCopying: string;
  permissionModifying: string;
  permissionAnnotating: string;
  permissionFillingForms: string;
  permissionDocumentAssembly: string;
  legacyPdfDisclaimer: string;

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

  confirmRequired: "Repite la contraseña para confirmarla.",
  encryptedCopySheetBody:
    "Escríbela para abrirlo. Solo se usa en tu navegador y no se guarda. Se abrirá una copia y se protegerá con la contraseña nueva que elijas aquí.",
  encryptedCopyNotice:
    "{name}: se abrió una copia sin la contraseña antigua. El resultado se protegerá con la contraseña nueva; la antigua no se guarda.",
  errors: {
    empty: "Escribe una contraseña para cifrar el documento.",
    tooShort: "Usa al menos 4 caracteres.",
    unsupportedChars:
      "La contraseña solo puede contener caracteres Latin-1 (letras sin acentos o con acentos europeos, números y símbolos comunes). Caracteres como € o emoji no son compatibles. Quita o cambia: {chars}",
    mismatch: "Las dos contraseñas no coinciden.",
    nothingToDo:
      "Así como está configurado, este PDF saldría cifrado pero sin pedir contraseña y sin restringir nada: no cambiaría nada de verdad. Exige contraseña para abrir o restringe al menos un permiso.",
  },

  infoTitle: "Qué hace exactamente",
  infoBody:
    "El documento se cifra en tu navegador. Si dejas activado \"Requiere contraseña para abrir\", el archivo que descargas solo se abre escribiendo la contraseña. El cifrado va dentro del PDF, así que funciona en cualquier lector.",
  noRecovery:
    "Guarda la contraseña donde no la pierdas: el cifrado ocurre en tu dispositivo y aquí no queda ninguna copia con la que recuperar el documento.",
  permissionsNote:
    "Los permisos de abajo son declarativos: los respeta el lector que abre el PDF (Acrobat, la mayoría de lectores serios), no son una restricción criptográfica real. Cualquiera con la herramienta adecuada — incluida \"Desbloquear PDF\" de este mismo sitio, que prueba la contraseña vacía primero — puede quitarlos sin conocer ninguna contraseña.",

  requirePasswordLabel: "Requiere contraseña para abrir el archivo",
  requirePasswordHint:
    "Desactívalo para restringir permisos (imprimir, copiar...) sin pedir contraseña al abrir el documento. La contraseña que escribas abajo sigue siendo obligatoria: pasa a ser la contraseña de propietario, la única forma de volver a cambiar estos permisos o quitarlos más adelante.",
  openWithoutPasswordWarning:
    "El archivo se abrirá sin pedir contraseña. Para seguir editándolo con otras herramientas de OptimusPDF más adelante, primero tendrás que pasarlo por \"Desbloquear PDF\": el resto de herramientas de este sitio no abren PDFs cifrados directamente, aunque la contraseña de apertura esté vacía.",

  permissionsTitle: "Permisos del documento",
  permissionsHint:
    "Todos concedidos por defecto. Desmarca los que quieras restringir.",
  permissionPrinting: "Imprimir",
  permissionCopying: "Copiar texto e imágenes",
  permissionModifying: "Modificar el contenido",
  permissionAnnotating: "Anotar y comentar",
  permissionFillingForms: "Rellenar formularios",
  permissionDocumentAssembly: "Ensamblar el documento (insertar, girar o borrar páginas)",
  legacyPdfDisclaimer:
    "En PDFs que no declaran una versión entre 1.4 y 1.7 (incluye versiones antiguas como 1.0-1.3 y también la 2.0, la más reciente del estándar), \"Rellenar formularios\" y \"Ensamblar el documento\" no existen como permisos independientes: el lector los concede igual sin importar lo que marques aquí. Además, en esos casos el cifrado que se aplica es RC4 de 40 bits — mucho más débil que en un PDF 1.4-1.7, y no debería considerarse una protección seria contra alguien decidido a abrirlo.",

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

  confirmRequired: "Type the password again to confirm it.",
  encryptedCopySheetBody:
    "Type it to open the file. It is only used in your browser and is never saved. A copy will be opened and protected with the new password you choose here.",
  encryptedCopyNotice:
    "{name}: a copy without the old password was opened. The result will be protected with the new password; the old one is not saved.",
  errors: {
    empty: "Type a password to encrypt the document.",
    tooShort: "Use at least 4 characters.",
    unsupportedChars:
      "The password can only contain Latin-1 characters (letters with or without European accents, digits and common symbols). Characters like € or emoji are not supported. Remove or change: {chars}",
    mismatch: "The two passwords do not match.",
    nothingToDo:
      "As configured, this PDF would end up encrypted but ask for no password and restrict nothing: nothing would actually change. Require a password to open, or restrict at least one permission.",
  },

  infoTitle: "What this actually does",
  infoBody:
    "The document is encrypted in your browser. If you leave \"Require a password to open\" on, the file you download only opens by typing the password. The encryption lives inside the PDF, so it works in any reader.",
  noRecovery:
    "Keep the password somewhere safe: the encryption happens on your device and no copy is stored here to recover the document with.",
  permissionsNote:
    "The permissions below are declarative: they're respected by the reader that opens the PDF (Acrobat, most serious readers), not a real cryptographic restriction. Anyone with the right tool — including this site's own \"Unlock PDF\", which tries the empty password first — can strip them without knowing any password.",

  requirePasswordLabel: "Require a password to open the file",
  requirePasswordHint:
    "Turn off to restrict permissions (printing, copying...) without asking for a password when the document is opened. The password you type below is still required: it becomes the owner password, the only way to change or remove these permissions later.",
  openWithoutPasswordWarning:
    "The file will open without asking for a password. To keep editing it with other OptimusPDF tools later, you'll first need to run it through \"Unlock PDF\": this site's other tools don't open encrypted PDFs directly, even when the opening password is empty.",

  permissionsTitle: "Document permissions",
  permissionsHint: "All granted by default. Uncheck the ones you want to restrict.",
  permissionPrinting: "Printing",
  permissionCopying: "Copying text and images",
  permissionModifying: "Modifying the content",
  permissionAnnotating: "Annotating and commenting",
  permissionFillingForms: "Filling in forms",
  permissionDocumentAssembly: "Assembling the document (inserting, rotating or deleting pages)",
  legacyPdfDisclaimer:
    "In PDFs that don't declare a version between 1.4 and 1.7 (this includes old versions like 1.0-1.3, but also 2.0, the newest revision of the standard), \"Filling in forms\" and \"Assembling the document\" don't exist as independent permissions: the reader grants them regardless of what you check here. On top of that, the encryption applied in those cases is 40-bit RC4 — much weaker than a 1.4-1.7 PDF, and not something you should rely on as serious protection against someone determined to open it.",

  largeFile:
    "The file is over 100 MB. Encrypting all of it may exhaust the tab's memory.",
  filenameSuffix: "protected",
};

export const PROTECT_STRINGS: Record<Language, ProtectStrings> = { es, en };
