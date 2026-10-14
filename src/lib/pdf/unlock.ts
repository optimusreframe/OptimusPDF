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
  pdfBytesToBlob,
  savePdfToBytes,
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
 * 3. Restricciones de firma. Aqui NO hay cifrado ninguno —o hay cifrado
 *    Y ademas firma, las dos cosas son independientes—: el documento se
 *    abre solo (o se descifra), pero el lector bloquea la edicion
 *    porque una firma restringe los cambios. Solo dos senales bloquean
 *    de verdad:
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
 * ------------------------------------------------------------------
 * Bug real corregido en esta version: inspeccionar SIN descifrar es
 * mentira cuando la estructura relevante vive dentro de un `/ObjStm`
 * (stream de objetos comprimido, tipico de un PDF moderno). El cifrado
 * alcanza tambien al contenido de esos streams, asi que cargar con
 * `ignoreEncryption: true` deja esos objetos SIN REGISTRAR: cualquier
 * referencia que apunte ahi (`/Perms`, `/AcroForm`...) no resuelve a
 * nada, exactamente igual que si la clave no existiera. Verificado en
 * Node contra un PDF real certificado por Adobe (AES-128 + DocMDP
 * `/P 1`): con `ignoreEncryption: true`, `/Perms` y `/AcroForm`
 * resuelven a `undefined`; con la contrasena real (aunque sea la
 * cadena vacia), resuelven al diccionario de verdad. El codigo anterior
 * envolvia esas resoluciones en `try/catch => undefined` y trataba ese
 * `undefined` como "no hay restriccion", cuando en realidad significaba
 * "no pude comprobarlo". La correccion separa el problema en dos:
 *
 * - `readEncryptionEnvelope` SOLO mira si hay cifrado, y con que filtro.
 *   Nunca toca `/Perms` ni `/AcroForm`. Una referencia de `/Encrypt` que
 *   no resuelve (rota) se trata como inspeccion incompleta, nunca como
 *   "no cifrado": lo contrario abriria la puerta a devolver una copia
 *   sin avisar de un cifrado que si estaba.
 * - `analyzeSignatures` SOLO se ejecuta sobre un documento genuinamente
 *   accesible (sin cifrar, o ya descifrado con la contrasena correcta).
 *   Nunca sobre el `probe` de `ignoreEncryption: true`.
 *
 * Ademas, las lecturas de `/Perms`, `/DocMDP`, `/AcroForm`, `/Fields`,
 * `/V`, `/Lock` y `/Reference` dejan de tratar "no se pudo leer" igual
 * que "no existe": una referencia rota, un tipo inesperado, o alcanzar
 * el limite de profundidad del arbol de campos sin terminar de
 * recorrerlo hacen fallar la inspeccion entera (`inspectionIncomplete`)
 * en vez de devolver silenciosamente "sin restriccion". Fallar cerrado.
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
 * cifrado, que ademas contiene los hashes de la contrasena. Cualquier
 * otro objeto invalido que aparezca tras descifrar (que no sea ese
 * resto reconocido) es sospechoso de ser un `/ObjStm` que tampoco se
 * decodifico bien, y tambien hace fallar la inspeccion.
 *
 * ------------------------------------------------------------------
 * Ronda 5: dos rutas de integridad reales que quedaban abiertas tras la
 * ronda 4, mas tres endurecimientos menores.
 *
 * 1. Una firma de aprobacion ACTIVA pero sin restriccion se invalidaba
 *    SIN pedir consentimiento. `hasSignatureRestrictions` solo cubria
 *    DocMDP/FieldMDP; un campo `/FT /Sig` con `/V` real, sin DocMDP, sin
 *    FieldMDP y sin `/Lock`, pasaba desapercibido. Pero `document.save()`
 *    invalida CUALQUIER firma ya aplicada, restrinja o no cambios: guardar
 *    esa copia rompia una firma valida sin que el usuario lo supiera. Se
 *    separa la deteccion en tres senales independientes —
 *    `hasSignatureFields` (hay campo, firmado o no), `hasActiveSignatures`
 *    (hay `/V` que resuelve a una firma real, con o sin restriccion) y
 *    `hasSignatureRestrictions` (DocMDP o FieldMDP, bloquea de verdad)— y
 *    el consentimiento y la invalidacion se disparan con
 *    `hasSignatureRestrictions || hasActiveSignatures`.
 *
 * 2. El recorrido del arbol de `/AcroForm` no heredaba `/FT` ni `/V` como
 *    lo hace la propia libreria (`PDFAcroField.getInheritableAttribute`,
 *    que asciende por `/Parent` y se queda con el primer valor propio que
 *    encuentra). Un nodo con `/FT /Sig` se trataba como terminal y sus
 *    `/Kids` no se visitaban, perdiendo el caso de un padre tipado que
 *    delega el `/V` y la restriccion real a sus hijos. Y un nodo sin `/V`
 *    propio se daba por "sin firma" sin mirar si lo heredaba de su
 *    `/Parent`. Se arreglo (en esa ronda) haciendo que el recorrido
 *    descienda SIEMPRE que haya `/Kids`, arrastrando en la recursion el
 *    `/V` YA efectivo del padre. Ese mecanismo de arrastre-hacia-abajo se
 *    sustituyo en la ronda 6 (ver mas abajo) por ascenso real de cada
 *    campo por su propia cadena de `/Parent`.
 *
 * 3. Tres endurecimientos mas: (a) `/Lock/Action /Include` (y `/Exclude`)
 *    con `/Fields` roto —referencia colgante o tipo incorrecto— pasaba
 *    como "sin restriccion" porque se leia con el resolutor tolerante;
 *    ahora usa el estricto y hace fallar la inspeccion. (b)
 *    `looksLikeXrefStream` aceptaba cualquier objeto invalido que
 *    contuviera la subcadena "/XRef" en cualquier parte de sus primeros
 *    2 KB; ahora exige una cabecera de diccionario real (`<<`) cuya
 *    propia clave `/Type` resuelva a `/XRef`. (c) La postcondicion de
 *    guardado ya no se comprueba solo sobre el `PDFDocument` en memoria:
 *    tras `savePdfToBlob`, los bytes reales se relen con una carga
 *    estricta (sin `ignoreEncryption`) y se repiten ahi las mismas
 *    comprobaciones de cifrado, DocMDP, FieldMDP, firmas activas y
 *    SigFlags, para blindar tambien contra una discrepancia entre lo que
 *    el modelo en memoria sugiere y lo que `document.save()` termina
 *    serializando de verdad.
 *
 * ------------------------------------------------------------------
 * Ronda 6: dos bloqueantes reales que quedaban de la ronda 5, mas dos
 * hallazgos menores y una decision de producto.
 *
 * 1. La postcondicion reforzada de la ronda 5 (punto 3c de arriba) solo
 *    volvia a analizar las firmas reserializadas dentro de
 *    `if (signaturesInvalidated)`. Si la primera inspeccion (paso 4 de
 *    `removeProtection`) FALLABA EN DETECTAR una firma que si estaba
 *    presente de verdad, `mustInvalidateSignatures` salia `false`,
 *    `signaturesInvalidated` tambien, se guardaba sin invalidar nada, y
 *    la relectura de los bytes reales NUNCA comprobaba si habia
 *    reaparecido una firma activa o restrictiva: exactamente el escenario
 *    contra el que esa segunda capa deberia defender. Ahora
 *    `analyzeSignatures(reloaded)` se ejecuta SIEMPRE que hay un blob que
 *    devolver, y `hasSignatureRestrictions`/`hasActiveSignatures` se
 *    exigen sin condicion; solo "sin campos de firma" y "SigFlags en 0"
 *    siguen condicionados a `signaturesInvalidated`, porque esos dos si
 *    son consecuencia especifica de haber ejecutado la limpieza.
 *
 * 2. La herencia de `/FT`/`/V` de la ronda 5 propagaba hacia abajo desde
 *    el nodo contenedor de `/Kids`, no ascendia por `/Parent` como hace
 *    de verdad la libreria (`PDFAcroField.getParent`/`ascend`,
 *    `node_modules/@cantoo/pdf-lib/src/core/acroform/PDFAcroField.ts:
 *    152,160`). En un arbol bien formado ambos caminos coinciden, pero si
 *    `/Kids` y `/Parent` discrepan —un PDF irregular que Adobe o la
 *    propia libreria todavia pueden interpretar— el descenso podia
 *    heredar del diccionario equivocado o no heredar nada, sin devolver
 *    `inspectionIncomplete`. Ahora `ascendForAttribute` hace que cada
 *    campo, descubierto via `/Kids`, resuelva su `/FT` y su `/V`
 *    efectivos ascendiendo de forma INDEPENDIENTE por su propia cadena de
 *    `/Parent` (con deteccion de ciclos y el mismo `MAX_FIELD_DEPTH`), y
 *    un `/FT` propio de tipo incorrecto ya no cae tolerantemente al
 *    heredado: hace fallar la inspeccion.
 *
 * 3. `looksLikeXrefStream` aceptaba falsos positivos estructurales: solo
 *    comprobaba que el texto empezara por `<<` y que la subcadena
 *    "/Type /XRef" apareciera en cualquier parte, incluso dentro de un
 *    string literal o un sub-diccionario anidado. Ahora `hasOuterXrefType`
 *    es un escaner de tokens que respeta strings literales `(...)` y
 *    lleva la cuenta de anidacion de `<<`/`>>` y `[`/`]`, y solo cuenta
 *    "/Type /XRef" como entrada del diccionario EXTERIOR (nivel de
 *    anidacion 1).
 *
 * 4. `/Lock/Action /Include` (o `/Exclude`) con `/Fields` COMPLETAMENTE
 *    AUSENTE —no roto, simplemente inexistente— llegaba a `restricts:
 *    false`. Como `/Fields` es obligatorio en el estandar para esos dos
 *    modos, "ausente" no equivale a "array vacio valido" dentro del
 *    modelo fail-closed: ahora tambien hace fallar la inspeccion.
 *
 * 5. Decision de producto: la herramienta sigue limitada estrictamente a
 *    DESBLOQUEAR. El caso SIN CIFRAR con una firma ACTIVA pero SIN
 *    restriccion (`hasActiveSignatures && !hasSignatureRestrictions`)
 *    vuelve a devolver `notProtected` (nada que desbloquear), como antes
 *    de la ronda 5: no se le ofrece al usuario invalidar una firma que no
 *    le impedia hacer nada. El resto de la maquina de decision de la
 *    ronda 5 —cifrado (con o sin firma activa) y restricciones reales,
 *    ambos con consentimiento— no cambia.
 *
 * ------------------------------------------------------------------
 * Ronda 7: dos hallazgos acotados sobre lo ya cerrado en las rondas 5-6.
 *
 * 1. La decision de producto del punto 5 de arriba solo estaba aplicada
 *    en el motor (aqui). La interfaz (`UnlockToolClient.tsx`) seguia
 *    tratando "sin cifrar + firma activa sin restriccion" como una
 *    operacion disponible: ofrecia el checkbox de consentimiento y
 *    habilitaba "Procesar" para un caso que el motor iba a rechazar con
 *    `notProtected`. Se corrige alli, no aqui: la UI ahora exige primero
 *    `encrypted || hasSignatureRestrictions` ("¿hay algo que hacer?")
 *    antes de evaluar si hace falta consentimiento.
 *
 * 2. `hasOuterXrefType` (mas abajo) no saltaba los comentarios PDF
 *    (`%` hasta fin de linea) ni distinguia clave de valor dentro del
 *    diccionario exterior, lo que aceptaba `<< /Foo 1 % /Type /XRef\n
 *    /Bar 2 >>` (el `/Type /XRef` vive dentro de un comentario) y
 *    `<< /Foo /Type /XRef 0 >>` (aqui "/Type" es el VALOR de la clave
 *    "/Foo", no una clave real). Ahora salta comentarios y alterna
 *    clave/valor a nivel del diccionario exterior (incluida la
 *    referencia indirecta `N G R` como un unico valor).
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
  | "consentRequired"
  /**
   * La estructura del documento no se pudo comprobar con seguridad
   * (referencia rota, tipo inesperado, arbol de campos sin terminar de
   * recorrer, u objetos invalidos tras descifrar). Nunca se interpreta
   * como "sin restriccion": se rechaza la operacion entera.
   */
  | "inspectionIncomplete";

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

/** Radiografia de un documento cifrado con `/Filter /Standard`. */
export type StandardEncryptionInfo = {
  encrypted: true;
  encryptionFilter: "Standard";
  securityHandler: string;
};

/** Radiografia de un documento con un manejador de cifrado no soportado. */
export type UnsupportedEncryptionInfo = {
  encrypted: true;
  encryptionFilter: "unsupported";
  /** Nombre literal del `/Filter`, p. ej. "/Adobe.PubSec". Puede faltar. */
  securityHandler: string | null;
};

/**
 * Perfil completo de un documento genuinamente accesible: o no estaba
 * cifrado, o se descifro de verdad con la contrasena correcta. Solo en
 * ese punto tiene sentido hablar de restricciones de firma, porque solo
 * ahi `/Perms` y `/AcroForm` se pudieron leer de verdad.
 *
 * Union discriminada por `encrypted`: cuando es `true`, `encryptionFilter`
 * solo puede ser `"Standard"` y `securityHandler` nunca falta. Un perfil
 * `"ready"` con un manejador no soportado no existe: ese caso sale de
 * `inspectProtection` como `kind: "unsupported"` antes de llegar aqui, asi
 * que el tipo ya no permite escribir esa combinacion imposible.
 */
export type CompleteProtectionProfile = {
  /**
   * Hay al menos un campo `/FT /Sig`, firmado o no. Informativo: por si
   * solo NO bloquea nada y NO invalida nada al guardar.
   */
  hasSignatureFields: boolean;
  /**
   * Al menos un campo de firma tiene un `/V` (propio o heredado de su
   * `/Parent`) que resuelve a un diccionario de firma real: la firma esta
   * efectivamente aplicada, tenga o no restriccion. Guardar el documento
   * —con o sin restriccion— invalida criptograficamente esa firma, asi
   * que esta senal exige el mismo consentimiento que
   * `hasSignatureRestrictions`, pero SOLO cuando ademas hay algo que
   * hacer (`encrypted || hasSignatureRestrictions`; decision de producto
   * de la ronda 6). Sin cifrado y sin restriccion real, no hay ninguna
   * operacion que ofrecer, asi que tampoco hay nada para lo que pedir
   * consentimiento: `hasActiveSignatures` por si sola nunca lo exige.
   */
  hasActiveSignatures: boolean;
  /** `/Perms/DocMDP` existe de verdad en el catalogo. */
  hasDocMDPRestriction: boolean;
  /**
   * Alguna firma ya puesta restringe cambios por si misma: referencia
   * `/TransformMethod /FieldMDP` o diccionario `/Lock` activo.
   */
  hasFieldMDPRestriction: boolean;
  /** `/AcroForm/SigFlags` tal cual. Informativo, nunca decisorio. */
  sigFlags: number;
  /** DocMDP o FieldMDP: bloquean ediciones de verdad. */
  hasSignatureRestrictions: boolean;
} & (
  | { encrypted: false; encryptionFilter: null; securityHandler: null }
  | { encrypted: true; encryptionFilter: "Standard"; securityHandler: string }
);

/**
 * Resultado de inspeccionar un documento, como union discriminada: el
 * tipo impide por construccion leer `hasDocMDPRestriction` cuando la
 * inspeccion de firmas todavia no se ha podido completar (`"ready"` es
 * el unico caso con `profile`).
 */
export type ProtectionInspection =
  | { kind: "ready"; profile: CompleteProtectionProfile }
  | { kind: "passwordRequired"; encryption: StandardEncryptionInfo }
  | { kind: "unsupported"; encryption: UnsupportedEncryptionInfo };

/** Que se acabo retirando del documento. */
export type ProtectionAction =
  | "passwordRemoved"
  | "passwordAndSignaturesInvalidated"
  | "signaturesInvalidated";

export type RemoveProtectionResult = {
  blob: Blob;
  action: ProtectionAction;
};

/** Lo mismo que `RemoveProtectionResult` pero con los BYTES del PDF resultante (`removeProtectionToBytes`). */
export type RemoveProtectionBytesResult = {
  bytes: Uint8Array;
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
const PARENT_KEY = PDFName.of("Parent");
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
 * Solo para entradas donde "no se pudo leer" ya tiene un valor por
 * defecto seguro documentado en el sitio de uso: la herencia de `/FT` y
 * `/AcroForm/SigFlags` (puramente informativo). El `/Action` de un
 * `/Lock` tambien se lee asi (su fallback ya es el conservador "restringe
 * de verdad"), pero desde esta ronda su `/Fields` YA NO se lee de forma
 * tolerante: ver `lockIsRestrictive`, que usa el resolutor estricto de
 * abajo porque `/Fields` es obligatorio para `/Include` y `/Exclude`.
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Lecturas estrictas: distinguen "ausente de verdad" de "no se pudo
 * comprobar".
 *
 * `Resolved<T>`:
 * - `"absent"`   -> la clave no existe, o resuelve a `PDFNull` (directo
 *                   o por referencia). Es la unica ausencia legitima.
 * - `"value"`    -> resuelve al tipo esperado. Ahi esta el valor.
 * - `"broken"`   -> la clave existe pero la referencia no resuelve a
 *                   nada (target sin registrar: el caso tipico de un
 *                   `/ObjStm` que no se pudo decodificar), o resuelve a
 *                   un tipo distinto del esperado. Nunca se trata como
 *                   ausencia: quien llama debe fallar cerrado.
 * ------------------------------------------------------------------ */

type Resolved<T extends PDFObject> =
  | { status: "absent" }
  | { status: "value"; value: T }
  | { status: "broken" };

function resolveStrict<T extends PDFObject>(
  dict: PDFDict,
  key: PDFName,
  isType: (object: PDFObject) => object is T,
): Resolved<T> {
  if (!dict.has(key)) return { status: "absent" };

  let resolved: PDFObject | undefined;
  try {
    // `dict.get(key)` es la entrada cruda (una `PDFRef` o un objeto en
    // linea); `context.lookup` SIN filtro de tipo la resuelve sin
    // lanzar por tipo incorrecto, para poder distinguir "resolvio a
    // otra cosa" de "no resolvio a nada" (referencia rota).
    resolved = dict.context.lookup(dict.get(key));
  } catch {
    return { status: "broken" };
  }

  if (resolved === undefined) return { status: "broken" };
  if (resolved === PDFNull) return { status: "absent" };
  return isType(resolved) ? { status: "value", value: resolved } : { status: "broken" };
}

const isPDFDict = (object: PDFObject): object is PDFDict => object instanceof PDFDict;
const isPDFArray = (object: PDFObject): object is PDFArray => object instanceof PDFArray;
const isPDFName = (object: PDFObject): object is PDFName => object instanceof PDFName;

function resolveStrictDict(dict: PDFDict, key: PDFName): Resolved<PDFDict> {
  return resolveStrict(dict, key, isPDFDict);
}

function resolveStrictArray(dict: PDFDict, key: PDFName): Resolved<PDFArray> {
  return resolveStrict(dict, key, isPDFArray);
}

function resolveStrictName(dict: PDFDict, key: PDFName): Resolved<PDFName> {
  return resolveStrict(dict, key, isPDFName);
}

/**
 * Resuelve una entrada de un array como diccionario, o informa que es
 * ilegible. A diferencia de `resolveStrict`, un indice de array no
 * tiene un estado "ausente" legitimo: siempre hay algo en esa posicion,
 * asi que dangling ref, `null` o tipo incorrecto son todos "broken".
 * `PDFArray.context` es privado en la libreria, por eso se usa
 * `lookupMaybe` (publico) y se captura el `UnexpectedObjectTypeError`
 * que lanza por tipo incorrecto en vez de acceder al contexto a mano.
 */
function resolveArrayEntryDict(
  array: PDFArray,
  index: number,
): { status: "value"; value: PDFDict } | { status: "broken" } {
  try {
    const value = array.lookupMaybe(index, PDFDict);
    return value === undefined ? { status: "broken" } : { status: "value", value };
  } catch {
    return { status: "broken" };
  }
}

/* ------------------------------------------------------------------ *
 * Campos de firma
 * ------------------------------------------------------------------ */

/**
 * Un campo `/FT /Sig` localizado dentro del arbol de campos, junto con el
 * array del que cuelga (`/AcroForm/Fields` o el `/Kids` de su padre)
 * para poder sacarlo de ahi sin tocar el objeto en si.
 *
 * `effectiveV` ya viene resuelto CON herencia: el `/V` propio de este
 * nodo si lo tiene, o si no el que resulte de ascender por su propia
 * cadena de `/Parent` (ver `ascendForAttribute` y `collectSignatureFields`).
 * Ni `fieldRestrictsChanges` ni `analyzeSignatures` vuelven a mirar `/V`
 * por su cuenta, para que no puedan discrepar entre si sobre cual es el
 * valor de verdad de este campo.
 */
type SignatureField = {
  /** Entrada tal cual aparece en el array: normalmente un `PDFRef`. */
  entry: PDFObject;
  dict: PDFDict;
  container: PDFArray;
  effectiveV: Resolved<PDFDict>;
};

/**
 * Resultado de recorrer el arbol de campos. `"incomplete"` cubre: el
 * propio `/AcroForm` o `/AcroForm/Fields` con referencia rota o tipo
 * incorrecto, una entrada del arbol que no resuelve a un diccionario de
 * campo, un `/FT` o `/V` (propio, o de cualquier nodo de su cadena de
 * `/Parent`) de tipo incorrecto o con referencia rota, un ascenso por
 * `/Parent` que entra en ciclo o supera `MAX_FIELD_DEPTH`, o alcanzar
 * `MAX_FIELD_DEPTH` en el descenso por `/Kids` sin terminar de
 * recorrerlo —este ultimo caso antes se cortaba en silencio y se
 * interpretaba como "no hay mas campos"; ahora hace fallar la inspeccion
 * entera.
 */
type FieldTreeResult =
  | { status: "ok"; fields: SignatureField[]; acroForm: PDFDict | undefined }
  | { status: "incomplete" };

/**
 * Asciende por la cadena REAL de `/Parent` de un nodo para resolver un
 * atributo heredable (`/FT` o `/V`), replicando el orden exacto de
 * `PDFAcroField.getInheritableAttribute`/`ascend`/`getParent` de
 * `@cantoo/pdf-lib` (`node_modules/@cantoo/pdf-lib/src/core/acroform/
 * PDFAcroField.ts`, lineas 152-164): visita el propio nodo primero, y si
 * no tiene la clave sube a su `/Parent` —unicamente si esa entrada es una
 * referencia indirecta (`PDFRef`); un `/Parent` en linea, ausente, o de
 * cualquier otro tipo hace que la propia libreria trate al nodo como si
 * no tuviera padre, y esta funcion reproduce exactamente eso— y repite.
 *
 * A diferencia de la libreria (que no tiene ninguna de las dos
 * protecciones y quedaria en un bucle infinito ante un `/Parent`
 * circular), esta version limita la profundidad con el mismo
 * `MAX_FIELD_DEPTH` que usa el descenso por `/Kids`, y detecta ciclos por
 * identidad de diccionario ya visitado.
 *
 * - La clave presente en el primer nodo de la cadena (propio o heredado)
 *   que resuelve al tipo esperado gana: `{ status: "value" }`.
 * - La clave presente pero rota —referencia colgante o tipo incorrecto—
 *   en CUALQUIER nodo de la cadena hace fallar el ascenso entero para
 *   ese nodo: `{ status: "broken" }`. No se sigue subiendo a buscar un
 *   valor alternativo, para que un valor propio roto nunca caiga
 *   silenciosamente al heredado.
 * - Una referencia `/Parent` que existe pero no resuelve a un
 *   diccionario, un ciclo, o superar `MAX_FIELD_DEPTH` nodos tambien es
 *   `{ status: "broken" }`.
 * - Si ningun nodo de la cadena, hasta la raiz (sin mas `/Parent`),
 *   tiene la clave, es legitimamente `{ status: "absent" }`.
 */
function ascendForAttribute<T extends PDFObject>(
  startDict: PDFDict,
  key: PDFName,
  isType: (object: PDFObject) => object is T,
): Resolved<T> {
  const visited = new Set<PDFDict>();
  let node: PDFDict = startDict;
  let depth = 0;

  for (;;) {
    if (depth > MAX_FIELD_DEPTH) return { status: "broken" };
    if (visited.has(node)) return { status: "broken" };
    visited.add(node);

    const ownResult = resolveStrict(node, key, isType);
    if (ownResult.status !== "absent") return ownResult;

    const parentEntry = node.get(PARENT_KEY);
    if (!(parentEntry instanceof PDFRef)) return { status: "absent" };

    try {
      node = node.context.lookup(parentEntry, PDFDict);
    } catch {
      return { status: "broken" };
    }
    depth += 1;
  }
}

/**
 * Recorre el arbol de campos del AcroForm y devuelve los de tipo firma,
 * junto con el propio `/AcroForm` ya resuelto para que quien llama no
 * tenga que volver a buscarlo (y no pueda discrepar sobre cual es).
 *
 * El descenso por `/Kids` sirve SOLO para DESCUBRIR todos los nodos del
 * arbol: ya no arrastra `/FT` ni `/V` hacia abajo. `/FT` y `/V` son
 * heredables ascendiendo por `/Parent` (ver `PDFAcroField.getParent`/
 * `ascend` en `@cantoo/pdf-lib`, `PDFAcroField.ts:152,160`), asi que cada
 * nodo resuelve su propio `/FT` y, si es de tipo `/Sig`, su propio `/V`
 * ascendiendo de forma INDEPENDIENTE por su propia cadena de `/Parent`
 * (`ascendForAttribute`), no heredando lo que el descenso por `/Kids` iba
 * arrastrando.
 *
 * Bug real corregido en esta version: antes se heredaba `/FT` y `/V`
 * propagandolos hacia abajo desde el nodo contenedor de `/Kids`. En un
 * arbol bien formado coincide con ascender por `/Parent`, pero si
 * `/Kids` y `/Parent` discrepan —un PDF irregular que Adobe o la propia
 * libreria todavia pueden interpretar— heredar por descenso puede tomar
 * el diccionario equivocado o no heredar nada, sin avisar. Ahora cada
 * nodo asciende por su PROPIO `/Parent`, que es como la libreria resuelve
 * de verdad la herencia. Ademas, un `/FT` propio de tipo incorrecto (no
 * un `PDFName`) ya no se lee tolerantemente para caer al heredado: hace
 * fallar la inspeccion entera (`ascendForAttribute` nunca cae a un
 * ancestro si el propio valor esta roto).
 *
 * Se sigue descendiendo SIEMPRE que haya `/Kids`, sin importar el tipo
 * efectivo del nodo actual (un `/FT /Sig` no es terminal por si solo: ver
 * ronda 5).
 */
function collectSignatureFields(catalog: PDFDict): FieldTreeResult {
  const acroFormResult = resolveStrictDict(catalog, ACRO_FORM_KEY);
  if (acroFormResult.status === "broken") return { status: "incomplete" };
  if (acroFormResult.status === "absent") {
    return { status: "ok", fields: [], acroForm: undefined };
  }
  const acroForm = acroFormResult.value;

  const fieldsResult = resolveStrictArray(acroForm, FIELDS_KEY);
  if (fieldsResult.status === "broken") return { status: "incomplete" };
  if (fieldsResult.status === "absent") {
    return { status: "ok", fields: [], acroForm };
  }
  const roots = fieldsResult.value;

  const found: SignatureField[] = [];
  const visited = new Set<PDFObject>();
  let incomplete = false;

  const visit = (container: PDFArray, depth: number): void => {
    if (incomplete) return;
    if (depth > MAX_FIELD_DEPTH) {
      // Antes: `return` silencioso, tratado como "no hay mas campos".
      // Ahora: no se puede afirmar que el recorrido termino, y eso
      // impide garantizar que no queda ninguna restriccion sin ver.
      incomplete = true;
      return;
    }
    for (let index = 0; index < container.size(); index += 1) {
      if (incomplete) return;
      const entry = container.get(index);
      if (visited.has(entry)) continue;
      visited.add(entry);

      const dictResult = resolveArrayEntryDict(container, index);
      if (dictResult.status !== "value") {
        incomplete = true;
        return;
      }
      const dict = dictResult.value;

      // `/FT` efectivo de ESTE nodo: asciende por su propia cadena de
      // `/Parent`, independiente de por donde se llego hasta el via
      // `/Kids`. Roto en cualquier punto de la cadena -> inspeccion
      // incompleta, nunca "sin firma".
      const ftResult = ascendForAttribute(dict, FT_KEY, isPDFName);
      if (ftResult.status === "broken") {
        incomplete = true;
        return;
      }
      const fieldType = ftResult.status === "value" ? ftResult.value.asString() : undefined;

      if (fieldType === SIG_FIELD_TYPE) {
        // Mismo principio para `/V`: ascenso independiente desde este
        // nodo, no herencia arrastrada por el descenso.
        const effectiveV = ascendForAttribute(dict, V_KEY, isPDFDict);
        if (effectiveV.status === "broken") {
          incomplete = true;
          return;
        }
        found.push({ entry, dict, container, effectiveV });
      }

      // Se desciende SIEMPRE que haya `/Kids`, sea cual sea el tipo
      // efectivo de este nodo: un `/FT /Sig` no es terminal por si solo.
      const kidsResult = resolveStrictArray(dict, KIDS_KEY);
      if (kidsResult.status === "broken") {
        incomplete = true;
        return;
      }
      if (kidsResult.status === "value") {
        visit(kidsResult.value, depth + 1);
      }
    }
  };

  visit(roots, 0);
  if (incomplete) return { status: "incomplete" };
  return { status: "ok", fields: found, acroForm };
}

type LockCheckResult = { status: "ok"; restricts: boolean } | { status: "incomplete" };

/**
 * Un diccionario `/Lock` restringe de verdad?
 *
 * `/Action /All` bloquea todo el formulario; `/Include` bloquea los
 * campos listados en `/Fields` (nada si la lista esta vacia de verdad);
 * `/Exclude` bloquea todo menos los listados, asi que siempre bloquea
 * algo. Sin `/Action` legible se asume que si restringe: es el lado
 * conservador.
 *
 * `/Fields` es obligatorio en el estandar para `/Include` y `/Exclude`
 * (ISO 32000-2, tabla 233). Antes, una resolucion rota de esa entrada
 * (referencia colgante o tipo incorrecto) se trataba igual que un array
 * vacio -> "no restrictivo": eso convertia un `/Lock/Include` roto en un
 * falso negativo. Ahora, para ambas acciones, `/Fields` roto hace fallar
 * la inspeccion entera en vez de asumir nada. Y una `/Fields` COMPLETAMENTE
 * AUSENTE (no rota: la clave simplemente no esta) tampoco se trata como
 * un array vacio valido, porque no es una ausencia legitima segun el
 * estandar: tambien hace fallar la inspeccion.
 */
function lockIsRestrictive(lock: PDFDict): LockCheckResult {
  const action = nameAt(lock, ACTION_KEY);
  if (action === "/Include" || action === "/Exclude") {
    const fieldsResult = resolveStrictArray(lock, FIELDS_KEY);
    if (fieldsResult.status === "broken" || fieldsResult.status === "absent") {
      return { status: "incomplete" };
    }
    if (action === "/Include") {
      return { status: "ok", restricts: fieldsResult.value.size() > 0 };
    }
    // /Exclude: bloquea todo menos lo listado, asi que bloquea algo
    // incluso si la lista esta vacia.
    return { status: "ok", restricts: true };
  }
  // Sin /Action, o /All: lado conservador.
  return { status: "ok", restricts: true };
}

type FieldMDPResult = { status: "ok"; restricts: boolean } | { status: "incomplete" };

/**
 * El campo de firma restringe cambios por si mismo?
 *
 * `effectiveV` ya llega resuelto con herencia desde `collectSignatureFields`
 * (propio `/V`, o el de la cadena de `/Parent` si este nodo no tiene uno):
 * esta funcion no vuelve a mirar `/V` en `field` para no poder discrepar
 * de lo que el recorrido ya decidio. Solo cuenta si hay firma de verdad:
 * en un campo sin `/V` efectivo ni `/Lock` ni las referencias de
 * transformacion han entrado en vigor. `/Lock`, `/Reference` y cada
 * elemento de `/Reference` se leen en modo estricto: un tipo incorrecto o
 * una referencia rota ya no se trata como "no restringe", sino como
 * inspeccion incompleta.
 */
function fieldRestrictsChanges(field: PDFDict, effectiveV: Resolved<PDFDict>): FieldMDPResult {
  if (effectiveV.status === "broken") return { status: "incomplete" };
  if (effectiveV.status === "absent") return { status: "ok", restricts: false };
  const signature = effectiveV.value;

  const lockResult = resolveStrictDict(field, LOCK_KEY);
  if (lockResult.status === "broken") return { status: "incomplete" };
  if (lockResult.status === "value") {
    const lockCheck = lockIsRestrictive(lockResult.value);
    if (lockCheck.status === "incomplete") return { status: "incomplete" };
    if (lockCheck.restricts) return { status: "ok", restricts: true };
  }

  const referencesResult = resolveStrictArray(signature, REFERENCE_KEY);
  if (referencesResult.status === "broken") return { status: "incomplete" };
  if (referencesResult.status === "absent") return { status: "ok", restricts: false };
  const references = referencesResult.value;

  for (let index = 0; index < references.size(); index += 1) {
    const referenceResult = resolveArrayEntryDict(references, index);
    if (referenceResult.status !== "value") return { status: "incomplete" };

    const transformMethod = resolveStrictName(referenceResult.value, TRANSFORM_METHOD_KEY);
    if (transformMethod.status === "broken") return { status: "incomplete" };
    if (
      transformMethod.status === "value" &&
      transformMethod.value.asString() === FIELD_MDP_METHOD
    ) {
      return { status: "ok", restricts: true };
    }
  }
  return { status: "ok", restricts: false };
}

/* ------------------------------------------------------------------ *
 * Analisis de firmas: SOLO sobre un documento genuinamente accesible
 * ------------------------------------------------------------------ */

type SignatureAnalysis =
  | {
      status: "ok";
      hasSignatureFields: boolean;
      /** Al menos un campo de firma tiene un `/V` efectivo (propio o heredado). */
      hasActiveSignatures: boolean;
      hasDocMDPRestriction: boolean;
      hasFieldMDPRestriction: boolean;
      hasSignatureRestrictions: boolean;
      sigFlags: number;
      /** Campos de firma ya resueltos, para que la limpieza los reutilice. */
      signatureFields: SignatureField[];
      /** `undefined` cuando `/Perms` esta legitimamente ausente. */
      perms: PDFDict | undefined;
      /** `undefined` cuando `/AcroForm` esta legitimamente ausente. */
      acroForm: PDFDict | undefined;
    }
  | { status: "incomplete" };

/**
 * Analiza las restricciones de firma de un documento. EXIGE que
 * `document` ya sea genuinamente accesible: sin cifrar, o cargado con
 * exito con la contrasena correcta. Llamarlo sobre un `probe` de
 * `ignoreEncryption: true` produce falsos negativos (ver cabecera del
 * archivo), asi que ninguna funcion de este modulo lo hace.
 *
 * Devuelve tambien `perms`, `acroForm` y `signatureFields` ya resueltos
 * para que `disableDigitalSignatures` los reutilice sin volver a
 * recorrer el arbol por separado: dos pasadas independientes podrian
 * discrepar entre si si el documento tuviera alguna entrada ambigua.
 */
function analyzeSignatures(document: PDFDocument): SignatureAnalysis {
  const catalog = document.catalog;

  const permsResult = resolveStrictDict(catalog, PERMS_KEY);
  if (permsResult.status === "broken") return { status: "incomplete" };
  const perms = permsResult.status === "value" ? permsResult.value : undefined;

  let hasDocMDPRestriction = false;
  if (perms) {
    const docMdpResult = resolveStrictDict(perms, DOC_MDP_KEY);
    if (docMdpResult.status === "broken") return { status: "incomplete" };
    hasDocMDPRestriction = docMdpResult.status === "value";
  }

  const fieldTree = collectSignatureFields(catalog);
  if (fieldTree.status === "incomplete") return { status: "incomplete" };
  const { fields: signatureFields, acroForm } = fieldTree;

  let hasFieldMDPRestriction = false;
  let hasActiveSignatures = false;
  for (const field of signatureFields) {
    if (field.effectiveV.status === "value") hasActiveSignatures = true;
    const result = fieldRestrictsChanges(field.dict, field.effectiveV);
    if (result.status === "incomplete") return { status: "incomplete" };
    if (result.restricts) hasFieldMDPRestriction = true;
  }

  // Informativo, nunca decisorio: una lectura tolerante aqui no oculta
  // ninguna restriccion real.
  const rawSigFlags = acroForm ? numberAt(acroForm, SIG_FLAGS_KEY) : undefined;
  const sigFlags =
    typeof rawSigFlags === "number" && Number.isFinite(rawSigFlags) ? rawSigFlags : 0;

  return {
    status: "ok",
    hasSignatureFields: signatureFields.length > 0,
    hasActiveSignatures,
    hasDocMDPRestriction,
    hasFieldMDPRestriction,
    // `SigFlags` queda deliberadamente fuera: no es una restriccion.
    hasSignatureRestrictions: hasDocMDPRestriction || hasFieldMDPRestriction,
    sigFlags,
    signatureFields,
    perms,
    acroForm,
  };
}

/* ------------------------------------------------------------------ *
 * Limpieza
 * ------------------------------------------------------------------ */

/** Espacios en blanco reconocidos por la especificacion PDF (tabla 1, ISO 32000-2). */
function isPdfWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\0";
}

/**
 * `true` si `head[index]` empieza un delimitador PDF (tabla 2) o un
 * espacio en blanco, o si `index` ya cayo fuera de la cadena: es decir,
 * si ahi termina cualquier nombre que empezara antes. Sirve para no
 * confundir "/XRef" con el prefijo de un nombre mas largo, tipo
 * "/XRefStuff".
 */
function isNameBoundary(head: string, index: number): boolean {
  if (index >= head.length) return true;
  const ch = head[index];
  return (
    isPdfWhitespace(ch) ||
    ch === "(" ||
    ch === ")" ||
    ch === "<" ||
    ch === ">" ||
    ch === "[" ||
    ch === "]" ||
    ch === "{" ||
    ch === "}" ||
    ch === "/" ||
    ch === "%"
  );
}

/**
 * Escaner de tokens minimo (no un parser PDF completo: no interpreta
 * streams) que decide si `head` contiene una entrada `/Type /XRef` que
 * pertenece de verdad, como CLAVE real, al diccionario EXTERIOR —justo
 * tras el primer `<<`, nivel de anidacion 1— en vez de a un string, a un
 * sub-diccionario o array anidados mas profundo, a un comentario, o al
 * VALOR de otra clave distinta.
 *
 * Lleva la cuenta de anidacion de `<<`/`>>` (`dictDepth`) y `[`/`]`
 * (`arrayDepth`), y salta por completo los strings literales `(...)`
 * respetando parentesis balanceados y el escape con `\`, para que ni
 * `<<`/`>>` ni "/Type"/"/XRef" cuenten si aparecen dentro de uno. Tambien
 * salta los hex strings `<...>` de angulo simple (no confundibles con
 * `<<` porque esa comprobacion va primero) y los comentarios PDF, que van
 * desde `%` hasta el siguiente fin de linea (`\n`/`\r`) o el final de la
 * cadena.
 *
 * Ademas alterna, SOLO en `dictDepth === 1 && arrayDepth === 0`, entre
 * "esperando una clave" y "esperando el valor de la ultima clave vista"
 * (`expectingKeyAtLevel1`), tal como exige la gramatica de un diccionario
 * PDF (`/Clave Valor /Clave Valor ...`). Un valor se da por completo —y
 * se vuelve a esperar clave— cuando: un nombre de valor termina; una
 * cadena, hex string, sub-diccionario o array anidado se cierra; o un
 * token "desnudo" (numero/booleano/null) resulta ser una referencia
 * indirecta completa `N G R` (se mira si, tras el primer numero, vienen
 * otro numero y luego el token "R") o un escalar suelto. Solo cuando
 * "/Type" aparece exactamente en posicion de CLAVE de ese nivel se
 * comprueba si el siguiente valor es el nombre "/XRef".
 *
 * Antes bastaba con que la subcadena "/Type /XRef" apareciera en
 * cualquier parte de los primeros 2 KB del objeto, lo que aceptaba falsos
 * positivos estructurales como `<< /Note (/Type /XRef) >>` (dentro de un
 * string), `<< /Foo << /Type /XRef >> >>` (dentro de un sub-diccionario
 * anidado), `<< /Foo 1 % /Type /XRef\n >>` (dentro de un comentario) o
 * `<< /Foo /Type /XRef 0 >>` (donde "/Type" es el VALOR de la clave
 * "/Foo", no una clave real), y podia borrar por error un objeto invalido
 * cualquiera cuyo contenido de texto solo mencionara "/XRef".
 */
function hasOuterXrefType(head: string): boolean {
  let index = 0;
  let dictDepth = 0;
  let arrayDepth = 0;
  // Solo importa dentro del nivel exterior (dictDepth === 1, arrayDepth
  // === 0): empieza en `true` porque el primer token tras el `<<` inicial
  // siempre es una clave.
  let expectingKeyAtLevel1 = true;
  // `true` mientras el VALOR que se esta consumiendo en el nivel exterior
  // corresponde a una clave "/Type" real (no a "/Foo" ni a nada anidado).
  let pendingKeyIsType = false;

  const atOuterLevel = () => dictDepth === 1 && arrayDepth === 0;
  // Un valor completo visto en el nivel exterior vuelve a dejar el
  // escaner "esperando clave"; en cualquier otro nivel no hace nada,
  // porque esa clave/valor pertenece a un contenedor anidado que el
  // escaner ignora deliberadamente.
  const completeValueIfOuter = () => {
    if (atOuterLevel()) expectingKeyAtLevel1 = true;
  };

  while (index < head.length) {
    const ch = head[index];

    if (ch === "%") {
      // Comentario PDF: desde "%" hasta el fin de linea o el final de la
      // cadena. No cuenta como delimitador ni como nombre.
      index += 1;
      while (index < head.length && head[index] !== "\n" && head[index] !== "\r") {
        index += 1;
      }
      continue;
    }

    if (isPdfWhitespace(ch)) {
      index += 1;
      continue;
    }

    if (ch === "(") {
      // String literal: se salta entero, respetando parentesis
      // balanceados y el escape `\x`, para que nada de su contenido
      // cuente como delimitador ni como nombre.
      index += 1;
      let parenDepth = 1;
      while (index < head.length && parenDepth > 0) {
        const inner = head[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === "(") parenDepth += 1;
        else if (inner === ")") parenDepth -= 1;
        index += 1;
      }
      completeValueIfOuter();
      continue;
    }

    if (ch === "<" && head[index + 1] === "<") {
      dictDepth += 1;
      index += 2;
      continue;
    }
    if (ch === ">" && head[index + 1] === ">") {
      dictDepth = Math.max(0, dictDepth - 1);
      index += 2;
      if (dictDepth === 0) {
        // Se acaba de cerrar el diccionario exterior mismo (el primer
        // `<<` que abrimos). Si "/Type /XRef" fuera una clave suya, ya
        // habriamos devuelto `true` antes de llegar aqui. Cualquier `<<`
        // que aparezca mas adelante en `head` (ej. dentro del payload de
        // un stream que sigue a este objeto invalido) pertenece a otra
        // cosa, nunca al diccionario que estamos comprobando -- de lo
        // contrario un segundo diccionario no relacionado mas adelante en
        // los mismos bytes podria dar un falso positivo.
        return false;
      }
      // Si al cerrar volvemos al nivel exterior, el sub-diccionario que
      // se acaba de cerrar era el valor completo de la ultima clave vista
      // ahi.
      completeValueIfOuter();
      continue;
    }
    if (ch === "<") {
      // Hex string de angulo simple: se salta hasta el `>` que lo cierra.
      index += 1;
      while (index < head.length && head[index] !== ">") index += 1;
      index += 1;
      completeValueIfOuter();
      continue;
    }

    if (ch === "[") {
      arrayDepth += 1;
      index += 1;
      continue;
    }
    if (ch === "]") {
      arrayDepth = Math.max(0, arrayDepth - 1);
      index += 1;
      completeValueIfOuter();
      continue;
    }

    if (ch === "/") {
      // Nombre: se consume hasta el siguiente delimitador o espacio.
      const start = index;
      index += 1;
      while (index < head.length && !isNameBoundary(head, index)) index += 1;

      if (atOuterLevel() && expectingKeyAtLevel1) {
        // Posicion de CLAVE real del diccionario exterior.
        pendingKeyIsType = head.startsWith("/Type", start) && start + 5 === index;
        expectingKeyAtLevel1 = false;
      } else {
        // Posicion de VALOR (de la clave anterior, o de un nivel
        // anidado que este escaner ignora). Solo importa si la clave
        // pendiente del nivel exterior era "/Type" de verdad.
        if (
          atOuterLevel() &&
          pendingKeyIsType &&
          head.startsWith("/XRef", start) &&
          start + 5 === index
        ) {
          return true;
        }
        completeValueIfOuter();
      }
      continue;
    }

    // Token "desnudo" (numero, referencia indirecta "N G R", booleano o
    // null): se consume hasta el siguiente delimitador o espacio. En el
    // nivel exterior, si se esta esperando un valor, se comprueba primero
    // si en realidad son los dos primeros tokens de una referencia
    // indirecta completa antes de dar el valor por terminado.
    {
      const start = index;
      while (
        index < head.length &&
        !isNameBoundary(head, index) &&
        !isPdfWhitespace(head[index])
      ) {
        index += 1;
      }
      if (index === start) {
        // Delimitador suelto no manejado explicitamente (p. ej. "{"),
        // se descarta sin mas para no quedarse detenido.
        index += 1;
        continue;
      }

      if (atOuterLevel() && !expectingKeyAtLevel1) {
        let lookahead = index;
        while (lookahead < head.length && isPdfWhitespace(head[lookahead])) lookahead += 1;
        const secondStart = lookahead;
        while (
          lookahead < head.length &&
          !isNameBoundary(head, lookahead) &&
          !isPdfWhitespace(head[lookahead])
        ) {
          lookahead += 1;
        }
        if (lookahead > secondStart) {
          let afterSecond = lookahead;
          while (afterSecond < head.length && isPdfWhitespace(head[afterSecond])) {
            afterSecond += 1;
          }
          if (head[afterSecond] === "R" && isNameBoundary(head, afterSecond + 1)) {
            // Referencia indirecta completa "N G R": los tres tokens
            // cuentan como UN solo valor para la clave pendiente.
            index = afterSecond + 1;
          }
        }
        completeValueIfOuter();
      }
      continue;
    }
  }

  return false;
}

/**
 * Reconoce los restos de una tabla de referencias cruzadas que quedaron
 * como objeto invalido tras descifrar: exige que el objeto empiece por un
 * diccionario (`<<`) y que la propia clave `/Type` de ESE diccionario
 * exterior (`hasOuterXrefType`) sea la que resuelve a `/XRef`.
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

  if (!head.trimStart().startsWith("<<")) return false;
  return hasOuterXrefType(head);
}

/**
 * Tras descifrar, ¿queda algun objeto invalido que NO sea el resto de
 * `/XRef` ya conocido? Si lo hay, es sospechoso de ser un `/ObjStm` que
 * tampoco se decodifico bien: el documento no se puede dar por limpio,
 * aunque el analisis de firmas no haya encontrado nada raro, porque ese
 * mismo analisis pudo estar mirando un catalogo incompleto.
 */
function hasUnexpectedInvalidObjects(document: PDFDocument): boolean {
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFInvalidObject && !looksLikeXrefStream(object)) {
      return true;
    }
  }
  return false;
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
 * Reutiliza los objetos YA RESUELTOS por `analyzeSignatures` (`perms`,
 * `acroForm`, `signatureFields`) en vez de volver a recorrer el
 * catalogo: son el mismo objeto en memoria que se acaba de analizar, asi
 * que no hay forma de que la limpieza discrepe de lo que se detecto.
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
function disableDigitalSignatures(
  document: PDFDocument,
  analysis: Extract<SignatureAnalysis, { status: "ok" }>,
): boolean {
  const catalog = document.catalog;
  let changed = false;

  if (analysis.perms?.has(DOC_MDP_KEY)) {
    analysis.perms.delete(DOC_MDP_KEY);
    changed = true;
    // Si `/Perms` se queda vacio deja de aportar nada; con cualquier otra
    // entrada (`/UR`, `/UR3`...) se conserva intacta.
    if (analysis.perms.keys().length === 0) catalog.delete(PERMS_KEY);
  }

  for (const field of analysis.signatureFields) {
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

  if (analysis.acroForm?.has(SIG_FLAGS_KEY)) {
    if (numberAt(analysis.acroForm, SIG_FLAGS_KEY) !== 0) {
      analysis.acroForm.set(SIG_FLAGS_KEY, PDFNumber.of(0));
      changed = true;
    }
  }

  return changed;
}

/* ------------------------------------------------------------------ *
 * Sobre de cifrado: SOLO `/Encrypt`, nunca `/Perms` ni `/AcroForm`
 * ------------------------------------------------------------------ */

type EncryptionEnvelope =
  | { status: "notEncrypted" }
  | { status: "standard"; securityHandler: string }
  | { status: "unsupported"; securityHandler: string | null }
  /** `/Encrypt` existe pero su referencia no resuelve: fallar cerrado. */
  | { status: "incomplete" };

/**
 * Determina si el documento esta cifrado y con que manejador, sin tocar
 * nada mas del catalogo. Una entrada `/Encrypt` ausente, o que resuelve
 * a `PDFNull`, se trata como "no cifrado" (asi lo equipara la
 * especificacion PDF). Una entrada presente cuya referencia NO resuelve
 * —el caso de un trailer danado, no el de este bug concreto, que vive
 * en `/Perms`/`/AcroForm`— nunca se trata como "no cifrado": se falla
 * cerrado con `"incomplete"`, porque no hay forma de saber si en
 * realidad si habia cifrado.
 */
function readEncryptionEnvelope(probe: PDFDocument): EncryptionEnvelope {
  const context = probe.context;
  const entry = context.trailerInfo.Encrypt;
  if (entry === undefined) return { status: "notEncrypted" };

  let resolved: PDFObject | undefined;
  try {
    resolved = context.lookup(entry);
  } catch {
    return { status: "incomplete" };
  }

  if (resolved === undefined) return { status: "incomplete" };
  if (resolved === PDFNull) return { status: "notEncrypted" };

  if (!(resolved instanceof PDFDict)) {
    // Hay algo ahi, pero no es un diccionario legible: no se puede
    // descifrar con esta libreria de ninguna manera. Es una encriptacion
    // real (nunca se afirma "no cifrado"), simplemente no reconocida.
    return { status: "unsupported", securityHandler: null };
  }

  const securityHandler = nameAt(resolved, FILTER_KEY) ?? null;
  return securityHandler === STANDARD_FILTER
    ? { status: "standard", securityHandler }
    : { status: "unsupported", securityHandler };
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

type LoadFailureKind = "password" | "handler" | "other";

/** Clasifica por que fallo `PDFDocument.load` con una contrasena real. */
function classifyLoadFailure(error: unknown): LoadFailureKind {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (PASSWORD_FAILURE_MESSAGES.some((known) => message.includes(known))) return "password";
  if (HANDLER_FAILURE_MESSAGES.some((known) => message.includes(known))) return "handler";
  return "other";
}

/**
 * Carga el documento real con la contrasena dada y comprueba que el
 * descifrado no dejo basura detras (ver `hasUnexpectedInvalidObjects`).
 * Lanza `UnlockError` clasificado, o el `PdfError` generico si el fallo
 * no es ni de contrasena ni de esquema.
 */
async function loadDecrypted(
  bytes: Uint8Array,
  password: string,
  securityHandler: string | null,
): Promise<PDFDocument> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(new Uint8Array(bytes), {
      password,
      updateMetadata: false,
    });
  } catch (error) {
    const kind = classifyLoadFailure(error);
    if (kind === "password") throw new UnlockError("wrongPassword");
    if (kind === "handler") throw new UnlockError(unsupportedHandlerFailure(securityHandler));
    // Ni contrasena ni esquema: es un fallo de lectura como cualquier
    // otro y se clasifica con los mismos criterios que el resto del
    // motor.
    throw toPdfError(error);
  }

  if (hasUnexpectedInvalidObjects(document)) {
    throw new UnlockError("inspectionIncomplete");
  }
  return document;
}

/* ------------------------------------------------------------------ *
 * API publica
 * ------------------------------------------------------------------ */

/**
 * Averigua que protege al documento antes de tocarlo.
 *
 * Sin `options.password`: prueba automaticamente la contrasena vacia
 * (la mayoria de PDF "cifrados" solo bloquean permisos y se abren asi).
 * Si funciona, o si el documento no estaba cifrado, analiza firmas sobre
 * el documento real y devuelve `"ready"`. Si hace falta una contrasena
 * de verdad, devuelve `"passwordRequired"` SIN lanzar: es un estado
 * normal del flujo, no un error.
 *
 * Con `options.password`: es la contrasena que el usuario ha escrito a
 * proposito. Si no abre el documento, lanza `UnlockError("wrongPassword")`
 * —aqui si es un error, no un estado silencioso— porque quien llama ya
 * sabe que esta validando una contrasena concreta.
 *
 * En ambos casos, un manejador no soportado devuelve `"unsupported"` sin
 * lanzar, y una estructura que no se pudo comprobar con seguridad lanza
 * `UnlockError("inspectionIncomplete")`.
 */
export async function inspectProtection(
  file: File,
  options?: { password?: string },
): Promise<ProtectionInspection> {
  const bytes = await readFileBytes(file);
  if (bytes.byteLength === 0) throw new PdfError("corrupt");

  const probe = await loadProbe(bytes);
  const envelope = readEncryptionEnvelope(probe);

  if (envelope.status === "incomplete") throw new UnlockError("inspectionIncomplete");

  if (envelope.status === "unsupported") {
    return {
      kind: "unsupported",
      encryption: {
        encrypted: true,
        encryptionFilter: "unsupported",
        securityHandler: envelope.securityHandler,
      },
    };
  }

  if (envelope.status === "notEncrypted") {
    // Nada que descifrar: el propio `probe` ya es un documento genuino.
    const analysis = analyzeSignatures(probe);
    if (analysis.status === "incomplete") throw new UnlockError("inspectionIncomplete");
    return {
      kind: "ready",
      profile: {
        encrypted: false,
        encryptionFilter: null,
        securityHandler: null,
        hasSignatureFields: analysis.hasSignatureFields,
        hasActiveSignatures: analysis.hasActiveSignatures,
        hasDocMDPRestriction: analysis.hasDocMDPRestriction,
        hasFieldMDPRestriction: analysis.hasFieldMDPRestriction,
        sigFlags: analysis.sigFlags,
        hasSignatureRestrictions: analysis.hasSignatureRestrictions,
      },
    };
  }

  // envelope.status === "standard"
  const explicitPassword = options?.password;
  const passwordToTry = explicitPassword ?? "";

  let document: PDFDocument;
  try {
    document = await loadDecrypted(bytes, passwordToTry, envelope.securityHandler);
  } catch (error) {
    if (
      error instanceof UnlockError &&
      error.reason === "wrongPassword" &&
      explicitPassword === undefined
    ) {
      // Intento automatico con "" fallo: no es un error para el
      // llamador, es la senal de que hace falta una contrasena de
      // verdad.
      return {
        kind: "passwordRequired",
        encryption: {
          encrypted: true,
          encryptionFilter: "Standard",
          securityHandler: envelope.securityHandler,
        },
      };
    }
    if (error instanceof UnlockError && error.reason === "unsupportedSecurityHandler") {
      return {
        kind: "unsupported",
        encryption: {
          encrypted: true,
          encryptionFilter: "unsupported",
          securityHandler: envelope.securityHandler,
        },
      };
    }
    // Contrasena explicita incorrecta, esquema no soportado detectado
    // solo al intentar descifrar, o inspeccion incompleta: todo se deja
    // pasar tal cual, son errores de verdad.
    throw error;
  }

  const analysis = analyzeSignatures(document);
  if (analysis.status === "incomplete") throw new UnlockError("inspectionIncomplete");

  return {
    kind: "ready",
    profile: {
      encrypted: true,
      encryptionFilter: "Standard",
      securityHandler: envelope.securityHandler,
      hasSignatureFields: analysis.hasSignatureFields,
      hasActiveSignatures: analysis.hasActiveSignatures,
      hasDocMDPRestriction: analysis.hasDocMDPRestriction,
      hasFieldMDPRestriction: analysis.hasFieldMDPRestriction,
      sigFlags: analysis.sigFlags,
      hasSignatureRestrictions: analysis.hasSignatureRestrictions,
    },
  };
}

/**
 * Quita del documento la proteccion que tenga y devuelve la copia junto
 * con lo que se ha retirado.
 *
 * Nunca confia en una inspeccion previa (la de `inspectProtection`, por
 * ejemplo): vuelve a leer el sobre de cifrado y a analizar las firmas
 * sobre el documento EXACTO que va a modificar, y verifica al final,
 * releyendo ese mismo documento ya mutado, que las restricciones
 * detectadas de verdad desaparecieron antes de guardar nada. Si algo de
 * eso no se puede confirmar, lanza en vez de devolver un resultado que
 * promete mas de lo que hizo.
 */
export async function removeProtection(
  file: File,
  options: UnlockOptions,
  onProgress?: ProgressCallback,
): Promise<RemoveProtectionResult> {
  const { bytes, action } = await removeProtectionToBytes(file, options, onProgress);
  return { blob: pdfBytesToBlob(bytes), action };
}

/**
 * Igual que `removeProtection` (mismas comprobaciones, antes y despues de guardar), pero entrega los BYTES del PDF
 * resultante sin pasar por un `Blob`: para quien sigue trabajando con bytes (PDF Pro). La relectura estricta de los
 * bytes guardados usa esos mismos bytes: ya no hace falta volver a leerlos de un `Blob`.
 */
export async function removeProtectionToBytes(
  file: File,
  options: UnlockOptions,
  onProgress?: ProgressCallback,
): Promise<RemoveProtectionBytesResult> {
  const bytes = await readFileBytes(file);
  if (bytes.byteLength === 0) throw new PdfError("corrupt");

  // 1) Sobre de cifrado.
  const probe = await loadProbe(bytes);
  const envelope = readEncryptionEnvelope(probe);
  onProgress?.(0.1);

  if (envelope.status === "incomplete") throw new UnlockError("inspectionIncomplete");

  // 2) Manejador de seguridad no estandar: no existe contrasena que la
  //    libreria pueda usar, asi que no se intenta descifrar ni se pide
  //    nada al usuario.
  if (envelope.status === "unsupported") {
    throw new UnlockError(unsupportedHandlerFailure(envelope.securityHandler));
  }

  // 3) Cargar el documento real: el probe si no habia cifrado, o una
  //    carga nueva con la contrasena si lo habia.
  let document: PDFDocument;
  let encryptRef: PDFObject | undefined;
  if (envelope.status === "notEncrypted") {
    document = probe;
  } else {
    // Se anota antes de descifrar: al descifrar, la entrada desaparece
    // del trailer y ya no habria forma de localizar ese objeto original
    // para borrarlo.
    encryptRef = probe.context.trailerInfo.Encrypt;
    document = await loadDecrypted(bytes, options.password, envelope.securityHandler);
  }
  onProgress?.(0.35);

  // 4) Analizar firmas ESTRICTAMENTE sobre ese documento ya cargado
  //    (nunca sobre el probe sin descifrar).
  const analysis = analyzeSignatures(document);
  if (analysis.status === "incomplete") throw new UnlockError("inspectionIncomplete");

  // Sin cifrado: la herramienta esta limitada a DESBLOQUEAR, no a "quitar
  // firmas porque si" (decision de producto, ronda 6). Solo hay algo que
  // hacer si de verdad hay una restriccion de firma (DocMDP o FieldMDP).
  // Una firma de aprobacion ACTIVA pero SIN restriccion, sin cifrado, no
  // bloqueaba nada: no se le ofrece al usuario invalidar una firma que no
  // le impedia hacer nada, y por tanto tampoco se le pide consentimiento
  // por ella. Esta comprobacion va ANTES de la barrera de consentimiento
  // (y solo mira `hasSignatureRestrictions`, no `hasActiveSignatures`)
  // precisamente para que ese caso salga como "nada que hacer" en vez de
  // "hace falta tu permiso para invalidar". Con cifrado, en cambio,
  // siempre hay algo que hacer (descifrar), asi que esta comprobacion
  // nunca se activa en ese caso.
  if (envelope.status === "notEncrypted" && !analysis.hasSignatureRestrictions) {
    throw new UnlockError("notProtected");
  }

  // Guardar el documento —con `document.save()`/`savePdfToBlob`— invalida
  // criptograficamente CUALQUIER firma ya aplicada, restrinja o no
  // cambios: `hasActiveSignatures` cubre la firma de aprobacion normal
  // (sin DocMDP, sin FieldMDP, sin `/Lock`) que antes se rescribia sin
  // pedir nada porque solo se miraba `hasSignatureRestrictions`. Esta
  // formula no cambia con la decision de producto de arriba: una vez que
  // SI hay algo que hacer (esta cifrado, o hay restriccion real), seguir
  // exigiendo consentimiento tambien por una firma activa sin restriccion
  // es el mismo criterio que quedo fijado en la ronda 5.
  const mustInvalidateSignatures =
    analysis.hasSignatureRestrictions || analysis.hasActiveSignatures;

  // 5) Barrera de consentimiento. Se comprueba antes de mutar nada: si
  //    hay una firma restrictiva O una firma activa sin restriccion y
  //    nadie ha aceptado invalidarla, no se escribe ni un byte.
  if (mustInvalidateSignatures && options.acknowledgeSignatureInvalidation !== true) {
    throw new UnlockError("consentRequired");
  }
  onProgress?.(0.5);

  try {
    // 6) Mutar: retirar el cifrado (si lo habia) e invalidar firmas (si
    //    corresponde). La logica de limpieza en si no cambio respecto a
    //    las rondas 1-3; lo que fallaba era que nunca se activaba para
    //    una firma activa sin restriccion.
    if (envelope.status !== "notEncrypted") {
      stripEncryption(document, encryptRef);
    }

    const signaturesInvalidated =
      mustInvalidateSignatures && disableDigitalSignatures(document, analysis);

    if (mustInvalidateSignatures && !signaturesInvalidated) {
      // El analisis detecto una firma que hay que invalidar (restrictiva
      // o simplemente activa) pero la limpieza no encontro nada que
      // cambiar: no deberia poder pasar, y si pasa no se guarda una copia
      // que promete algo que no hizo.
      throw new UnlockError("inspectionIncomplete");
    }
    onProgress?.(0.7);

    // 7) Verificacion de postcondicion OBLIGATORIA, EN DOS CAPAS:
    //
    //    a) Sobre el documento YA MUTADO, todavia en memoria: se vuelve a
    //       analizar y se exige que la restriccion/firma activa de verdad
    //       haya desaparecido. Esto es lo que ya atrapaba el bug original
    //       de la ronda 4: se devolvia exito sin comprobar que el
    //       objetivo se habia cumplido.
    //    b) Sobre los BYTES REALES que se van a entregar: se guarda, se
    //       relee con una carga ESTRICTA (sin `ignoreEncryption`, la
    //       misma que usaria cualquier lector) y se repiten las mismas
    //       comprobaciones ahi. El modelo en memoria puede no coincidir
    //       con lo que `document.save()` termina serializando —es
    //       exactamente la clase de discrepancia que ya causo el bug del
    //       `/ObjStm` sin descifrar—, asi que la garantia fuerte es la
    //       que se hace contra el archivo que de verdad se va a
    //       descargar, no contra el objeto de JavaScript.
    const verification = analyzeSignatures(document);
    if (verification.status === "incomplete") throw new UnlockError("inspectionIncomplete");
    if (
      signaturesInvalidated &&
      (verification.hasSignatureRestrictions ||
        verification.hasActiveSignatures ||
        verification.hasSignatureFields)
    ) {
      throw new UnlockError("inspectionIncomplete");
    }
    if (
      signaturesInvalidated &&
      verification.acroForm !== undefined &&
      verification.sigFlags !== 0
    ) {
      throw new UnlockError("inspectionIncomplete");
    }

    const savedBytes = await savePdfToBytes(document);

    // 7b) Relectura estricta de los bytes reales ya guardados.
    let reloaded: PDFDocument;
    try {
      reloaded = await PDFDocument.load(savedBytes, { updateMetadata: false });
    } catch (error) {
      // Ni siquiera se puede releer sin cifrar el archivo que se acaba de
      // guardar: no hay forma de confirmar la postcondicion, asi que no
      // se entrega.
      throw toPdfError(error);
    }

    // El cifrado se retiro siempre que lo hubiera (independientemente de
    // si tambien hizo falta invalidar firmas).
    if (envelope.status !== "notEncrypted") {
      const reloadedEnvelope = readEncryptionEnvelope(reloaded);
      if (reloadedEnvelope.status !== "notEncrypted") {
        throw new UnlockError("inspectionIncomplete");
      }
    }

    // Se analiza SIEMPRE que haya un blob que devolver, no solo cuando
    // `signaturesInvalidated` fue `true` en la fase de mutacion. Bug real
    // corregido en esta version: si la primera inspeccion (paso 4) FALLA
    // EN DETECTAR una firma activa o restrictiva que si esta presente de
    // verdad, `mustInvalidateSignatures` sale `false`, no se invoca
    // `disableDigitalSignatures`, `signaturesInvalidated` queda `false`, y
    // antes esta relectura se saltaba entera: se guardaba y se entregaba
    // un documento con una firma activa o restrictiva de verdad sin que
    // NADA lo comprobara despues de guardar. Es exactamente el escenario
    // contra el que esta segunda capa deberia defender. Por eso las dos
    // comprobaciones siguientes YA NO estan condicionadas a
    // `signaturesInvalidated`: se exige SIEMPRE, haya hecho falta
    // invalidar algo o no, que los bytes reales ya guardados no traigan
    // ninguna restriccion de firma ni ninguna firma activa.
    const reloadedAnalysis = analyzeSignatures(reloaded);
    if (reloadedAnalysis.status === "incomplete") {
      throw new UnlockError("inspectionIncomplete");
    }
    if (reloadedAnalysis.hasSignatureRestrictions || reloadedAnalysis.hasActiveSignatures) {
      throw new UnlockError("inspectionIncomplete");
    }
    // "Sin campos de firma" y "SigFlags en 0" SI siguen condicionadas a
    // `signaturesInvalidated`: son la consecuencia especifica de haber
    // ejecutado la limpieza (`disableDigitalSignatures` borra `/FT` y
    // pone `/SigFlags` a 0), no del objetivo general de "no debe quedar
    // nada activo ni restrictivo", que ya quedo cubierto arriba sin
    // condicion. Cuando no hizo falta invalidar nada, es perfectamente
    // legitimo que sigan existiendo campos de firma sin `/V` (formularios
    // sin firmar) o un `/SigFlags` distinto de 0 que solo anuncia que
    // existen campos de firma, sin restringir nada (ver cabecera del
    // archivo).
    if (signaturesInvalidated) {
      if (reloadedAnalysis.hasSignatureFields) {
        throw new UnlockError("inspectionIncomplete");
      }
      if (reloadedAnalysis.acroForm !== undefined && reloadedAnalysis.sigFlags !== 0) {
        throw new UnlockError("inspectionIncomplete");
      }
    }

    onProgress?.(1);

    const action: ProtectionAction =
      envelope.status === "notEncrypted"
        ? "signaturesInvalidated"
        : signaturesInvalidated
          ? "passwordAndSignaturesInvalidated"
          : "passwordRemoved";

    return { bytes: savedBytes, action };
  } catch (error) {
    if (error instanceof UnlockError) throw error;
    throw toPdfError(error);
  }
}

/**
 * (Wave 5 · U5) Copia SIN cifrado de un PDF protegido, para poder editarlo.
 *
 * A diferencia de `removeProtection`, NO toca las firmas ni pide
 * consentimiento: solo retira el cifrado estandar con la contrasena dada
 * (`""` abre los PDF que solo bloquean permisos). Quien la usa avisa por su
 * cuenta de que editar invalida las firmas digitales. Lanza
 * `UnlockError("wrongPassword")` si la contrasena no abre el documento y los
 * demas `UnlockError` del motor (manejador no soportado, estructura dudosa).
 * Un documento que no esta cifrado se devuelve tal cual.
 */
export async function decryptPdfCopy(file: File, password: string): Promise<Blob> {
  const bytes = await readFileBytes(file);
  if (bytes.byteLength === 0) throw new PdfError("corrupt");

  const probe = await loadProbe(bytes);
  const envelope = readEncryptionEnvelope(probe);
  if (envelope.status === "incomplete") throw new UnlockError("inspectionIncomplete");
  if (envelope.status === "unsupported") {
    throw new UnlockError(unsupportedHandlerFailure(envelope.securityHandler));
  }
  if (envelope.status === "notEncrypted") {
    return new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  }

  // Se anota antes de descifrar: despues desaparece del trailer.
  const encryptRef = probe.context.trailerInfo.Encrypt;
  const document = await loadDecrypted(bytes, password, envelope.securityHandler);
  try {
    stripEncryption(document, encryptRef);
    const savedBytes = await savePdfToBytes(document);
    // Comprobacion sobre los bytes reales: se tienen que poder releer sin contrasena.
    const reloaded = await PDFDocument.load(savedBytes, {
      updateMetadata: false,
    });
    if (readEncryptionEnvelope(reloaded).status !== "notEncrypted") {
      throw new UnlockError("inspectionIncomplete");
    }
    return pdfBytesToBlob(savedBytes);
  } catch (error) {
    if (error instanceof UnlockError) throw error;
    throw toPdfError(error);
  }
}
