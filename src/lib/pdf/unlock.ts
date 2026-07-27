import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
} from "@cantoo/pdf-lib";
import type { PDFObject } from "@cantoo/pdf-lib";
import {
  PdfError,
  readFileBytes,
  savePdfToBlob,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";

/**
 * Motor de "quitar la proteccion" de un PDF.
 *
 * Un PDF puede estar bloqueado por tres mecanismos distintos que la
 * herramienta trataba antes como uno solo. Distinguirlos importa porque
 * cada uno se quita —o no se puede quitar— de forma diferente:
 *
 * 1. Cifrado estandar (`/Encrypt` con `/Filter /Standard`). Es el unico
 *    que `@cantoo/pdf-lib` sabe descifrar. Muchisimos documentos usan
 *    aqui la contrasena de usuario VACIA y solo ponen contrasena de
 *    propietario para bloquear impresion o copia: se abren sin pedir
 *    nada y se descifran con `password: ""`. Por eso se prueba siempre
 *    la cadena vacia primero y solo se pide contrasena si falla.
 *
 * 2. Manejador de seguridad no soportado (`/Filter` distinto de
 *    `/Standard`). El caso conocido es `/Adobe.PubSec`: la clave no es
 *    una contrasena, esta dentro de un certificado instalado en la
 *    maquina del destinatario. Cualquier otro filtro desconocido se
 *    reporta como manejador no reconocido, sin inventarse que es un
 *    certificado. En ninguno de los dos casos hay contrasena que valga,
 *    asi que no se miente con "contrasena incorrecta".
 *
 * 3. Restricciones de firma. Aqui NO hay cifrado ninguno: el documento se
 *    abre solo, pero el lector bloquea la edicion porque una firma
 *    restringe los cambios. Solo dos senales bloquean de verdad:
 *
 *    - `/Perms/DocMDP` en el catalogo (firma de certificacion).
 *    - Una firma ya puesta (`/V`) que ademas trae una referencia con
 *      `/TransformMethod /FieldMDP` o un diccionario `/Lock` activo.
 *
 *    `/AcroForm/SigFlags` NO es una de esas senales. Su bit 1
 *    (`SignaturesExist`) solo dice que existe un campo de firma, aunque
 *    este vacio, y su bit 2 (`AppendOnly`) es un aviso de que un guardado
 *    completo invalidaria firmas, no una prohibicion. Tratarlo como
 *    bloqueo reescribia —e invalidaba— documentos que no estaban
 *    bloqueados.
 *
 * Cuando hay restriccion de verdad, la salida es el equivalente de
 * `disableDigitalSignatures()` de qpdf (lo que ejecuta
 * `--remove-restrictions` desde qpdf 11.7): se borra `/FT`, `/V`, `/SV` y
 * `/Lock` de cada campo de firma, se saca el campo de `/AcroForm/Fields`
 * y se conserva su anotacion —y por tanto su apariencia— en la pagina.
 * Ademas se retira solo `/Perms/DocMDP`, no la clave `/Perms` entera,
 * porque ahi viven tambien `/UR` y `/UR3`, derechos de Reader que no
 * tienen nada que ver con la certificacion.
 *
 * Esta herramienta NO rompe contrasenas: si el cifrado estandar exige
 * una de verdad, hay que conocerla.
 *
 * Detalle del formato que costo encontrar (verificado en Node contra
 * `@cantoo/pdf-lib` 2.7.4): al descifrar, la libreria si limpia la
 * entrada `/Encrypt` del trailer, pero las tablas de referencias
 * cruzadas del archivo original —que en un PDF moderno son objetos
 * indirectos de tipo `/XRef`— no se pueden reinterpretar tras el
 * descifrado y quedan guardadas como objetos "invalidos" que se vuelven
 * a escribir tal cual. Ese bloque arrastra el `/Encrypt` viejo, asi que
 * el archivo resultante seguia anunciandose como cifrado y no se
 * reabria. Por eso se retiran tambien esos restos y el diccionario de
 * cifrado, que ademas contiene los hashes de la contrasena.
 */

export type UnlockOptions = {
  /**
   * Contrasena de apertura. La cadena vacia es un valor legitimo y es el
   * valor por defecto: se intenta siempre antes de pedirle nada al
   * usuario.
   */
  password: string;
  /**
   * Consentimiento explicito para invalidar las firmas del documento.
   *
   * Defensa en profundidad: el motor esta exportado y cualquiera puede
   * llamarlo sin pasar por la interfaz, asi que la invariante "no se
   * invalida una firma sin que el usuario lo haya aceptado" se hace
   * cumplir aqui y no solo en el boton.
   */
  acknowledgeSignatureInvalidation?: boolean;
};

export const DEFAULT_UNLOCK_OPTIONS: UnlockOptions = {
  password: "",
  acknowledgeSignatureInvalidation: false,
};

export type UnlockFailure =
  /** No hay cifrado ni restricciones de firma: no hay nada que quitar. */
  | "notProtected"
  /** Cifrado estandar cuya contrasena de apertura no es la aportada. */
  | "wrongPassword"
  /** Cifrado por certificado digital (`/Adobe.PubSec`). */
  | "certificateEncryption"
  /** Cualquier otro manejador de seguridad que no sabemos abrir. */
  | "unsupportedSecurityHandler"
  /** Hay restricciones de firma y nadie ha aceptado invalidarlas. */
  | "consentRequired";

/**
 * Error de desbloqueo. Hereda de `PdfError` usando el propio `reason`
 * como codigo, asi que `ToolShell` muestra el mensaje especifico en el
 * banner generico mientras la herramienta ademas resalta el motivo
 * exacto en su propio panel.
 */
export class UnlockError extends PdfError {
  readonly reason: UnlockFailure;

  constructor(reason: UnlockFailure) {
    super(reason, `unlock:${reason}`);
    this.name = "UnlockError";
    this.reason = reason;
  }
}

/** Esquema de cifrado del documento, si lo hay. */
export type EncryptionFilter = "Standard" | "unsupported";

/**
 * Radiografia de las protecciones del documento. Se obtiene SIN
 * descifrar nada: el catalogo, los nombres y los numeros de un PDF
 * cifrado se leen igual porque el cifrado solo alcanza a cadenas y
 * flujos.
 */
export type ProtectionProfile = {
  encrypted: boolean;
  /** `null` cuando no hay diccionario `/Encrypt`. */
  encryptionFilter: EncryptionFilter | null;
  /** Nombre literal del `/Filter`, p. ej. "/Adobe.PubSec". */
  securityHandler: string | null;
  /**
   * Hay al menos un campo `/FT /Sig`, firmado o no. Informativo: por si
   * solo NO bloquea nada.
   */
  hasSignatureFields: boolean;
  /** `/Perms/DocMDP` existe de verdad en el catalogo. */
  hasDocMDPRestriction: boolean;
  /**
   * Alguna firma ya puesta restringe cambios por si misma: referencia
   * `/TransformMethod /FieldMDP` o diccionario `/Lock` activo.
   */
  hasFieldMDPRestriction: boolean;
  /** `/AcroForm/SigFlags` tal cual. Informativo, nunca decisorio. */
  sigFlags: number;
  /** Unico motivo valido para ofrecer la copia editable. */
  hasSignatureRestrictions: boolean;
};

/** Que se acabo retirando del documento. */
export type ProtectionAction =
  | "passwordRemoved"
  | "passwordAndSignaturesInvalidated"
  | "signaturesInvalidated";

export type RemoveProtectionResult = {
  blob: Blob;
  action: ProtectionAction;
};

const PERMS_KEY = PDFName.of("Perms");
const DOC_MDP_KEY = PDFName.of("DocMDP");
const ACRO_FORM_KEY = PDFName.of("AcroForm");
const SIG_FLAGS_KEY = PDFName.of("SigFlags");
const FILTER_KEY = PDFName.of("Filter");
const FIELDS_KEY = PDFName.of("Fields");
const KIDS_KEY = PDFName.of("Kids");
const FT_KEY = PDFName.of("FT");
const V_KEY = PDFName.of("V");
const SV_KEY = PDFName.of("SV");
const LOCK_KEY = PDFName.of("Lock");
const ACTION_KEY = PDFName.of("Action");
const REFERENCE_KEY = PDFName.of("Reference");
const TRANSFORM_METHOD_KEY = PDFName.of("TransformMethod");

/** `PDFName.asString()` devuelve el nombre con su barra: "/Standard". */
const STANDARD_FILTER = "/Standard";
const PUBSEC_FILTER = "/Adobe.PubSec";
const SIG_FIELD_TYPE = "/Sig";
const FIELD_MDP_METHOD = "/FieldMDP";

/** Tope de recursion al recorrer el arbol de campos de un PDF hostil. */
const MAX_FIELD_DEPTH = 32;

/* ------------------------------------------------------------------ *
 * Lecturas tolerantes
 *
 * `lookupMaybe` LANZA cuando encuentra un tipo distinto al esperado. En
 * un PDF danado pero recuperable eso convertia una entrada rara en un
 * error generico sin descripcion. Estos envoltorios devuelven
 * `undefined` en ese caso: una entrada ilegible se trata como ausente.
 * ------------------------------------------------------------------ */

function dictAt(source: PDFDict, key: PDFName): PDFDict | undefined {
  try {
    return source.lookupMaybe(key, PDFDict);
  } catch {
    return undefined;
  }
}

function arrayAt(source: PDFDict, key: PDFName): PDFArray | undefined {
  try {
    return source.lookupMaybe(key, PDFArray);
  } catch {
    return undefined;
  }
}

function nameAt(source: PDFDict, key: PDFName): string | undefined {
  try {
    return source.lookupMaybe(key, PDFName)?.asString();
  } catch {
    return undefined;
  }
}

function numberAt(source: PDFDict, key: PDFName): number | undefined {
  try {
    return source.lookupMaybe(key, PDFNumber)?.asNumber();
  } catch {
    return undefined;
  }
}

function dictInArray(source: PDFArray, index: number): PDFDict | undefined {
  try {
    return source.lookupMaybe(index, PDFDict);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Campos de firma
 * ------------------------------------------------------------------ */

/**
 * Un campo `/FT /Sig` localizado dentro del arbol de campos, junto con el
 * array del que cuelga (`/AcroForm/Fields` o el `/Kids` de su padre)
 * para poder sacarlo de ahi sin tocar el objeto en si.
 */
type SignatureField = {
  /** Entrada tal cual aparece en el array: normalmente un `PDFRef`. */
  entry: PDFObject;
  dict: PDFDict;
  container: PDFArray;
};

/**
 * Recorre el arbol de campos del AcroForm y devuelve los de tipo firma.
 *
 * `/FT` es heredable, asi que se arrastra el del padre. Un nodo cuyo
 * `/FT` efectivo es `/Sig` se considera terminal: sus `/Kids` ya solo
 * pueden ser widgets (anotaciones), que no se tocan.
 */
function collectSignatureFields(catalog: PDFDict): SignatureField[] {
  const acroForm = dictAt(catalog, ACRO_FORM_KEY);
  const roots = acroForm ? arrayAt(acroForm, FIELDS_KEY) : undefined;
  if (!roots) return [];

  const found: SignatureField[] = [];
  const visited = new Set<PDFObject>();

  const visit = (
    container: PDFArray,
    inheritedType: string | undefined,
    depth: number,
  ): void => {
    if (depth > MAX_FIELD_DEPTH) return;
    for (let index = 0; index < container.size(); index += 1) {
      const entry = container.get(index);
      if (visited.has(entry)) continue;
      visited.add(entry);

      const dict = dictInArray(container, index);
      if (!dict) continue;

      const fieldType = nameAt(dict, FT_KEY) ?? inheritedType;
      if (fieldType === SIG_FIELD_TYPE) {
        found.push({ entry, dict, container });
        continue;
      }

      const kids = arrayAt(dict, KIDS_KEY);
      if (kids) visit(kids, fieldType, depth + 1);
    }
  };

  visit(roots, undefined, 0);
  return found;
}

/**
 * Un diccionario `/Lock` restringe de verdad?
 *
 * `/Action /All` bloquea todo el formulario; `/Include` bloquea los
 * campos listados (nada si la lista esta vacia); `/Exclude` bloquea todo
 * menos los listados, asi que siempre bloquea algo. Sin `/Action`
 * legible se asume que si restringe: es el lado conservador.
 */
function lockIsRestrictive(lock: PDFDict): boolean {
  const action = nameAt(lock, ACTION_KEY);
  if (action === "/Include") return (arrayAt(lock, FIELDS_KEY)?.size() ?? 0) > 0;
  return true;
}

/**
 * El campo de firma restringe cambios por si mismo?
 *
 * Solo cuenta si YA esta firmado (`/V` presente): en un campo vacio ni
 * `/Lock` ni las referencias de transformacion han entrado en vigor.
 */
function fieldRestrictsChanges(field: PDFDict): boolean {
  const signature = dictAt(field, V_KEY);
  if (!signature) return false;

  const lock = dictAt(field, LOCK_KEY);
  if (lock && lockIsRestrictive(lock)) return true;

  const references = arrayAt(signature, REFERENCE_KEY);
  if (!references) return false;
  for (let index = 0; index < references.size(); index += 1) {
    const reference = dictInArray(references, index);
    if (!reference) continue;
    if (nameAt(reference, TRANSFORM_METHOD_KEY) === FIELD_MDP_METHOD) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Limpieza
 * ------------------------------------------------------------------ */

/**
 * Reconoce los restos de una tabla de referencias cruzadas que quedaron
 * como objeto invalido tras descifrar. Se inspecciona la cabecera del
 * objeto: un `/XRef` ahi solo puede venir de ese resto.
 */
function looksLikeXrefStream(object: PDFObject): boolean {
  const size = object.sizeInBytes();
  if (size === 0 || size > 1024 * 1024) return false;

  const buffer = new Uint8Array(size);
  object.copyBytesInto(buffer, 0);
  const limit = Math.min(size, 2048);
  let head = "";
  for (let index = 0; index < limit; index += 1) {
    head += String.fromCharCode(buffer[index]);
  }
  return head.includes("/XRef");
}

/**
 * Deja el documento descifrado listo para guardarse como PDF normal.
 * `encryptRef` es la referencia al diccionario de cifrado leida del
 * archivo original (antes de descifrar).
 */
function stripEncryption(
  document: PDFDocument,
  encryptRef: PDFObject | undefined,
): void {
  const context = document.context;
  const doomed: PDFRef[] = [];

  const trailerEncrypt = context.trailerInfo.Encrypt;
  context.trailerInfo.Encrypt = undefined;
  if (trailerEncrypt instanceof PDFRef) doomed.push(trailerEncrypt);
  if (encryptRef instanceof PDFRef) doomed.push(encryptRef);

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFInvalidObject && looksLikeXrefStream(object)) {
      doomed.push(ref);
    }
  }

  for (const ref of doomed) context.delete(ref);
  context.security = undefined;
}

/**
 * Desactiva las firmas digitales del documento, igual que
 * `disableDigitalSignatures()` de qpdf.
 *
 * Por cada campo `/FT /Sig`: se borran `/V` (la referencia al
 * diccionario de firma, que es lo que de verdad invalida la firma),
 * `/SV`, `/Lock` y el propio `/FT` —para que el objeto deje de ser un
 * campo de formulario—, y el campo sale de la lista de la que colgaba.
 * Ademas se retira `/Perms/DocMDP` y se pone `/AcroForm/SigFlags` a 0.
 *
 * Cuatro decisiones deliberadas, todas del lado conservador:
 *
 * - De `/Perms` se borra SOLO la subentrada `/DocMDP`. La clave entera
 *   contiene tambien `/UR` y `/UR3` (derechos de uso de Reader), que no
 *   tienen nada que ver con la certificacion y borrarlos quitaria
 *   funcionalidad que el usuario no ha pedido perder.
 * - El campo se quita del array `/Fields` (o del `/Kids` de su padre)
 *   quitando SOLO esa entrada. No se usa `PDFForm.removeField`, que
 *   ademas hace `context.delete()` sobre el campo y sobre cada uno de
 *   sus `/Kids`: eso destruye los widgets, que siguen referenciados
 *   desde `/Annots` de la pagina, y el sello desapareceria de la vista.
 *   Conservar la anotacion es exactamente lo que hace qpdf.
 * - No se borra el objeto del diccionario de firma. Queda inalcanzable
 *   —ni `/V` ni `/Perms/DocMDP` apuntan ya a el— y eliminarlo a mano
 *   arriesga dejar referencias colgantes si algo mas lo comparte.
 * - Un padre que se quede sin `/Kids` se deja tal cual: sin `/FT` ni
 *   hijos, ningun lector lo interpreta, y borrarlo tocaria campos de
 *   formulario normales del usuario.
 *
 * Devuelve `true` si el documento cambio.
 */
function disableDigitalSignatures(document: PDFDocument): boolean {
  const catalog = document.catalog;
  let changed = false;

  const perms = dictAt(catalog, PERMS_KEY);
  if (perms?.has(DOC_MDP_KEY)) {
    perms.delete(DOC_MDP_KEY);
    changed = true;
    // Si `/Perms` se queda vacio deja de aportar nada; con cualquier otra
    // entrada (`/UR`, `/UR3`...) se conserva intacta.
    if (perms.keys().length === 0) catalog.delete(PERMS_KEY);
  }

  for (const field of collectSignatureFields(catalog)) {
    // `/FT` se borra junto a los demas para que el objeto deje de ser un
    // campo de formulario. Sin el, un widget que siguiera colgando de
    // `/Annots` no puede sobrevivir como campo de firma huerfano, que es
    // exactamente lo que hace qpdf. La anotacion y su `/AP` se conservan:
    // el sello se sigue viendo, pero ya no es una firma.
    for (const key of [FT_KEY, V_KEY, SV_KEY, LOCK_KEY]) {
      if (field.dict.has(key)) {
        field.dict.delete(key);
        changed = true;
      }
    }
    // El indice se busca ahora: cada `remove` desplaza a los siguientes.
    const index = field.container.indexOf(field.entry);
    if (index !== undefined && index >= 0) {
      field.container.remove(index);
      changed = true;
    }
  }

  const acroForm = dictAt(catalog, ACRO_FORM_KEY);
  if (acroForm?.has(SIG_FLAGS_KEY)) {
    if (numberAt(acroForm, SIG_FLAGS_KEY) !== 0) {
      acroForm.set(SIG_FLAGS_KEY, PDFNumber.of(0));
      changed = true;
    }
  }

  return changed;
}

/* ------------------------------------------------------------------ *
 * Perfil
 * ------------------------------------------------------------------ */

/** Lee el perfil de proteccion de un documento ya abierto sin descifrar. */
function readProfile(probe: PDFDocument): ProtectionProfile {
  const context = probe.context;
  const encryptEntry = context.trailerInfo.Encrypt;
  let encryptValue: PDFObject | undefined;
  try {
    encryptValue = context.lookup(encryptEntry);
  } catch {
    encryptValue = undefined;
  }
  // La especificacion PDF equipara una entrada con valor `null` a que la
  // entrada no exista, asi que `/Encrypt null` NO es un documento cifrado.
  const encrypted = encryptValue !== undefined && encryptValue !== PDFNull;

  let encryptionFilter: EncryptionFilter | null = null;
  let securityHandler: string | null = null;
  if (encrypted) {
    // Si `/Encrypt` existe pero no es un diccionario legible, o su
    // `/Filter` no es `/Standard`, no hay forma de descifrarlo aqui: se
    // clasifica como no soportado, nunca como contrasena incorrecta.
    let encryptDict: PDFDict | undefined;
    try {
      encryptDict = context.lookupMaybe(encryptEntry, PDFDict);
    } catch {
      encryptDict = undefined;
    }
    securityHandler = encryptDict ? (nameAt(encryptDict, FILTER_KEY) ?? null) : null;
    encryptionFilter =
      securityHandler === STANDARD_FILTER ? "Standard" : "unsupported";
  }

  const perms = dictAt(probe.catalog, PERMS_KEY);
  // `/Perms/DocMDP` solo cuenta si RESUELVE a un diccionario de firma. Que
  // la clave exista no basta: la especificacion PDF equipara una entrada
  // con valor `null` a que la entrada no este, y una referencia rota no
  // resuelve a nada. Comprobar solo la clave daba por certificados
  // documentos que no lo estaban, y eso acababa exigiendo consentimiento
  // para despues invalidar firmas sin motivo. Es el mismo criterio de
  // "null equivale a ausente" que se aplica arriba a `/Encrypt`.
  const hasDocMDPRestriction =
    perms !== undefined && dictAt(perms, DOC_MDP_KEY) !== undefined;

  const signatureFields = collectSignatureFields(probe.catalog);
  const hasSignatureFields = signatureFields.length > 0;
  const hasFieldMDPRestriction = signatureFields.some((field) =>
    fieldRestrictsChanges(field.dict),
  );

  const acroForm = dictAt(probe.catalog, ACRO_FORM_KEY);
  const rawSigFlags = acroForm ? numberAt(acroForm, SIG_FLAGS_KEY) : undefined;
  const sigFlags =
    typeof rawSigFlags === "number" && Number.isFinite(rawSigFlags)
      ? rawSigFlags
      : 0;

  return {
    encrypted,
    encryptionFilter,
    securityHandler,
    hasSignatureFields,
    hasDocMDPRestriction,
    hasFieldMDPRestriction,
    sigFlags,
    // `SigFlags` queda deliberadamente fuera: no es una restriccion.
    hasSignatureRestrictions: hasDocMDPRestriction || hasFieldMDPRestriction,
  };
}

/** Abre el documento sin descifrar, solo para leer su estructura. */
async function loadProbe(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    // Sin `password`, `PDFDocument.load` ni construye el descifrador, asi
    // que un esquema no soportado no revienta en este paso.
    return await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch (error) {
    throw toPdfError(error);
  }
}

/**
 * Averigua que protege al documento antes de tocarlo. La interfaz lo usa
 * para decidir que ofrecer: probar sin contrasena, avisar de que el
 * esquema no es compatible, o proponer una copia sin firmas validas.
 */
export async function inspectProtection(file: File): Promise<ProtectionProfile> {
  const bytes = await readFileBytes(file);
  if (bytes.byteLength === 0) throw new PdfError("corrupt");
  return readProfile(await loadProbe(bytes));
}

/** El filtro no soportado, en el codigo de error que le corresponde. */
function unsupportedHandlerFailure(handler: string | null): UnlockFailure {
  return handler === PUBSEC_FILTER
    ? "certificateEncryption"
    : "unsupportedSecurityHandler";
}

/**
 * Mensajes con los que `@cantoo/pdf-lib` rechaza construir el
 * descifrador por el ESQUEMA, no por la contrasena (ver
 * `src/core/crypto.ts` del paquete). Se enumeran para no volver a
 * confundirlos con una contrasena incorrecta.
 */
const HANDLER_FAILURE_MESSAGES = [
  "unknown encryption method",
  "unsupported encryption algorithm",
  "unknown crypto method",
  "invalid crypt filter name",
  "invalid key length",
];

/**
 * Los dos unicos mensajes que significan de verdad "esa contrasena no
 * abre el documento".
 */
const PASSWORD_FAILURE_MESSAGES = ["needs password", "password incorrect"];

/**
 * Quita del documento la proteccion que tenga y devuelve la copia junto
 * con lo que se ha retirado.
 *
 * La invalidacion de firmas solo se aplica cuando el perfil detecta una
 * restriccion real, y exige `acknowledgeSignatureInvalidation: true`. Sin
 * ese consentimiento la funcion lanza ANTES de tocar el documento.
 */
export async function removeProtection(
  file: File,
  options: UnlockOptions,
  onProgress?: ProgressCallback,
): Promise<RemoveProtectionResult> {
  const bytes = await readFileBytes(file);
  if (bytes.byteLength === 0) throw new PdfError("corrupt");

  // 1) Sondeo sin descifrar: distingue los tres mecanismos.
  const probe = await loadProbe(bytes);
  const profile = readProfile(probe);
  onProgress?.(0.2);

  // 2) Barrera de consentimiento. Se comprueba antes que nada: si hay
  //    firmas que restringen y nadie ha aceptado invalidarlas, no se
  //    escribe ni un byte.
  if (
    profile.hasSignatureRestrictions &&
    options.acknowledgeSignatureInvalidation !== true
  ) {
    throw new UnlockError("consentRequired");
  }

  // 3) Sin cifrado: o no hay nada que hacer, o lo que bloquea es una
  //    firma que restringe cambios.
  if (!profile.encrypted) {
    if (!profile.hasSignatureRestrictions) throw new UnlockError("notProtected");

    const changed = disableDigitalSignatures(probe);
    if (!changed) throw new UnlockError("notProtected");
    onProgress?.(0.6);

    try {
      const blob = await savePdfToBlob(probe);
      onProgress?.(1);
      return { blob, action: "signaturesInvalidated" };
    } catch (error) {
      throw toPdfError(error);
    }
  }

  // 4) Manejador de seguridad no estandar: no existe contrasena que la
  //    libreria pueda usar, asi que no se intenta descifrar ni se pide
  //    nada al usuario.
  if (profile.encryptionFilter !== "Standard") {
    throw new UnlockError(unsupportedHandlerFailure(profile.securityHandler));
  }

  // Se anota antes de descifrar: al descifrar, la entrada desaparece del
  // trailer y ya no habria forma de localizar ese objeto para borrarlo.
  const encryptRef = probe.context.trailerInfo.Encrypt;

  // 5) Carga real con contrasena. `pdf-lib` copia los bytes al parsear,
  //    pero se pasa una copia propia para no depender de ese detalle.
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(new Uint8Array(bytes), {
      password: options.password,
      updateMetadata: false,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);

    if (PASSWORD_FAILURE_MESSAGES.some((known) => message.includes(known))) {
      throw new UnlockError("wrongPassword");
    }
    if (HANDLER_FAILURE_MESSAGES.some((known) => message.includes(known))) {
      throw new UnlockError(unsupportedHandlerFailure(profile.securityHandler));
    }
    // Ni contrasena ni esquema: es un fallo de lectura como cualquier
    // otro y se clasifica con los mismos criterios que el resto del
    // motor. Antes acababa aqui todo y se reportaba como contrasena
    // incorrecta, que era mentira.
    throw toPdfError(error);
  }
  onProgress?.(0.6);

  try {
    // 6) Se retiran el cifrado y sus restos para que la salida sea un PDF
    //    normal y corriente.
    stripEncryption(document, encryptRef);

    // Un documento puede llevar las dos cosas: cifrado y firmas que
    // restringen.
    const signaturesInvalidated =
      profile.hasSignatureRestrictions && disableDigitalSignatures(document);

    const blob = await savePdfToBlob(document);
    onProgress?.(1);
    return {
      blob,
      action: signaturesInvalidated
        ? "passwordAndSignaturesInvalidated"
        : "passwordRemoved",
    };
  } catch (error) {
    throw toPdfError(error);
  }
}
