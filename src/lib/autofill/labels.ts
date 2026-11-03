/**
 * Etiquetas de campo (ES/EN) y buscador de etiquetas dentro de una linea de texto. Una etiqueta («Insured:», «Policy No.»,
 * «Fecha de pérdida») senala que lo que sigue es el valor de una clave de `dataKeys.ts`. Se busca sobre el texto PLEGADO (sin
 * tildes, minusculas; misma longitud que el original) y los indices valen en el texto original.
 *
 * Una etiqueta solo cuenta si va seguida de dos puntos, o si ocupa su celda entera (el valor esta a la derecha o debajo), o —solo
 * para claves de valor muy tipado: poliza, reclamo, fecha, telefono, correo— si el valor sigue directamente («Policy No. 12-AB-3456»).
 */

import type { TextLine } from "@/lib/autofill/layout";
import { fold } from "@/lib/autofill/text";

export type LabelKind =
  | "insuredName1"
  | "insuredName2"
  | "phone"
  | "email"
  | "address"
  /** Direccion POSTAL (mailing/postal/billing): distinta de la de la propiedad en una hoja de declaraciones. */
  | "mailingAddress"
  /** «Named Insured and Mailing Address»: un bloque con el nombre (o dos) y la direccion postal debajo. */
  | "insuredBlock"
  | "insurer"
  | "policyNumber"
  | "claimNumber"
  | "claimType"
  | "lossDate"
  /** «Policy Period: 03/14/2026 to 03/14/2027»: las dos fechas de la vigencia. */
  | "policyPeriod"
  | "policyStart"
  | "policyEnd"
  /** Acreedor hipotecario: la etiqueta da el valor Y abre un contexto «de otra parte» (su direccion y telefono no son del asegurado). */
  | "mortgagee"
  /** Deducible general (AOP / todos los demas riesgos) y de viento/huracan/granizo. */
  | "deductible"
  | "windDeductible"
  /** «City, State, Zip»: la parte de ciudad-estado-CP de una direccion. */
  | "csz"
  /** Otra parte (ajustador, contratista, abogado…): fija el contexto pero no produce un valor. */
  | "party"
  /** Cualquier otra etiqueta (fax, firma, fecha de nacimiento…): corta el valor anterior y nunca es un valor. */
  | "stop";

type Party = "insured" | "other";

type LabelDef = {
  kind: LabelKind;
  /** Expresion sobre texto plegado. */
  re: string;
  /** 0..1: 1 = inequivoca; 0.9 = clara; 0.7 = debil (solo revision). */
  weight: number;
  /** El valor puede seguir sin dos puntos (valor muy tipado). */
  free?: boolean;
  party?: Party;
};

/** «(s)», «(es)», «(a)» tras una etiqueta: «Insured(s)», «Nombre(s)». Admite espacios dentro (los deja pdf.js). */
const P = "(?:\\s*\\(\\s*(?:s|es|a|as|os|a\\(s\\))\\s*\\))?";
const NO = "(?:no\\.?|nro\\.?|number|num\\.?|#|n\\.?\\s?[o°º]\\.?|numero)";

const DEFS: LabelDef[] = [
  /* --- nombre del asegurado --- */
  { kind: "insuredName1", re: `named\\s+insured(?:'s)?(?:\\s+name)?${P}`, weight: 1, party: "insured" },
  { kind: "insuredName1", re: "(?:client|insured|owner|policy\\s*holder)\\s*/\\s*(?:client|insured|owner|policy\\s*holder)", weight: 1, party: "insured" },
  { kind: "insuredName1", re: `(?:primary\\s+)?insured(?:'s)?(?:\\s+name)?${P}(?:\\s+name)?`, weight: 1, party: "insured" },
  { kind: "insuredName1", re: `policy\\s*holder(?:'s)?(?:\\s+name)?${P}`, weight: 1, party: "insured" },
  { kind: "insuredName1", re: `client(?:'s)?(?:\\s+name)?${P}`, weight: 1, party: "insured" },
  { kind: "insuredName1", re: `customer(?:'s)?(?:\\s+name)?${P}`, weight: 0.9, party: "insured" },
  { kind: "insuredName1", re: `(?:home|property\\s+)?owner(?:'s)?(?:\\s+name)?${P}`, weight: 0.9, party: "insured" },
  { kind: "insuredName1", re: `name\\s+of\\s+(?:the\\s+)?(?:insured|client|policy\\s*holder|owner|customer)${P}`, weight: 1, party: "insured" },
  { kind: "insuredName1", re: "claimant(?:'s)?(?:\\s+name)?", weight: 0.9, party: "insured" },
  { kind: "insuredName1", re: "applicant(?:'s)?(?:\\s+name)?", weight: 0.8, party: "insured" },
  { kind: "insuredName1", re: `asegurado${P}(?:\\s+(?:principal|titular|1))?`, weight: 1, party: "insured" },
  { kind: "insuredName1", re: `nombre\\s+del?\\s+(?:asegurado|cliente|titular|propietario|contratante|reclamante)${P}`, weight: 1, party: "insured" },
  { kind: "insuredName1", re: "titular(?:\\s+de\\s+la\\s+poliza)?", weight: 0.9, party: "insured" },
  { kind: "insuredName1", re: `(?:cliente|propietario|contratante|reclamante|solicitante)${P}`, weight: 0.9, party: "insured" },
  { kind: "insuredName1", re: "nombres?\\s+y\\s+apellidos?", weight: 0.9 },
  { kind: "insuredName1", re: "nombre\\s+completo", weight: 0.8 },
  { kind: "insuredName1", re: `(?:full|printed?|legal|your)\\s+name${P}`, weight: 0.7 },
  { kind: "insuredName1", re: `name${P}`, weight: 0.7 },
  { kind: "insuredName1", re: `nombre${P}`, weight: 0.7 },

  /* --- segundo asegurado --- */
  { kind: "insuredName2", re: `co-?\\s*(?:insured|client|owner|policy\\s*holder|applicant)${P}(?:\\s+name)?`, weight: 1, party: "insured" },
  { kind: "insuredName2", re: `(?:second|2nd|additional|other|joint)\\s+(?:named\\s+)?(?:insured|client|owner|policy\\s*holder)${P}(?:\\s+name)?`, weight: 1, party: "insured" },
  { kind: "insuredName2", re: `(?:insured|client|owner|policy\\s*holder)\\s*(?:#|no\\.?|number)?\\s*(?:2|ii|two)\\b${P}`, weight: 0.9, party: "insured" },
  { kind: "insuredName2", re: "spouse(?:'s)?(?:\\s+name)?", weight: 0.8, party: "insured" },
  { kind: "insuredName2", re: `co-?\\s*(?:asegurado|titular|propietario|cliente)${P}`, weight: 1, party: "insured" },
  { kind: "insuredName2", re: `(?:segundo|2do\\.?|otro)\\s+(?:asegurado|titular|propietario|cliente)${P}`, weight: 1, party: "insured" },
  { kind: "insuredName2", re: `(?:asegurado|cliente|titular|propietario)\\s*(?:#|no\\.?|n\\.?\\s?[o°º]\\.?)?\\s*2\\b${P}`, weight: 0.9, party: "insured" },
  { kind: "insuredName2", re: "conyuge(?:\\s+del\\s+asegurado)?", weight: 0.8, party: "insured" },
  { kind: "insuredName2", re: "copropietario", weight: 0.9, party: "insured" },

  /* --- telefono --- */
  { kind: "phone", re: `(?:(?:home|work|cell|mobile|day|daytime|evening|alt|alternate|primary|contact|personal|main)\\s+)?(?:phone|telephone|tel)\\b\\.?(?:\\s*(?:${NO}))?${P}`, weight: 1 },
  { kind: "phone", re: `phone\\s*${NO}${P}`, weight: 1 },
  { kind: "phone", re: `(?:cell(?:ular)?|mobile)(?:\\s*(?:phone|number|${NO}))?${P}`, weight: 1 },
  { kind: "phone", re: `tel[eé]?fono(?:\\s*(?:celular|movil|fijo|de\\s+contacto|de\\s+casa|particular|principal))?(?:\\s*${NO})?${P}`, weight: 1 },
  { kind: "phone", re: "numero\\s+de\\s+(?:telefono|celular|contacto|contact)", weight: 1 },
  { kind: "phone", re: "(?:celular|movil|whatsapp|cel\\.?)", weight: 0.9 },
  { kind: "phone", re: "contact\\s+(?:phone|number)", weight: 0.9 },

  /* --- correo --- */
  { kind: "email", re: "e\\s*-?\\s*mail(?:\\s*(?:address|addr\\.?|direccion))?", weight: 1, free: true },
  { kind: "email", re: "(?:direccion\\s+de\\s+)?correo(?:\\s+electronico)?(?:\\s*\\(\\s*e-?mail\\s*\\))?", weight: 1, free: true },

  /* --- direccion --- */
  { kind: "address", re: "(?:address|location)\\s+of\\s+(?:the\\s+)?(?:loss|property|risk|insured|damage|claim)", weight: 1, party: "insured" },
  { kind: "address", re: "(?:loss|property|risk|damaged\\s+property|insured\\s+property|incident)\\s+(?:address|location)", weight: 1, party: "insured" },
  { kind: "address", re: "location\\s+of\\s+(?:the\\s+)?(?:loss|damage|property|risk)", weight: 1, party: "insured" },
  { kind: "address", re: "(?:damaged|insured|affected)\\s+property", weight: 0.9, party: "insured" },
  { kind: "address", re: "(?:home|residential|insured(?:'s)?|physical|street|service|current|permanent|site|client(?:'s)?)\\s+address", weight: 0.9 },
  { kind: "address", re: "(?:street\\s+)?address(?:\\s*(?:line)?\\s*1)?", weight: 0.9 },
  { kind: "address", re: "residence", weight: 0.8 },
  { kind: "address", re: "direccion\\s+de(?:l|\\s+la)?\\s+(?:propiedad|perdida|siniestro|inmueble|riesgo|residencia|vivienda|asegurado)", weight: 1, party: "insured" },
  { kind: "address", re: "ubicacion\\s+de(?:l|\\s+la)?\\s+(?:perdida|propiedad|siniestro|inmueble|riesgo)", weight: 1, party: "insured" },
  { kind: "address", re: "(?:direccion|domicilio)(?:\\s+(?:fisica|completa|actual|fiscal|del\\s+asegurado))?", weight: 0.9 },
  /* Hojas de declaraciones: la direccion de la PROPIEDAD (no la postal). */
  { kind: "address", re: "(?:residence|insured|dwelling|covered|described)\\s+(?:premises|location)", weight: 1, party: "insured" },
  { kind: "address", re: "(?:location|address)\\s+of\\s+(?:the\\s+)?(?:residence\\s+premises|insured\\s+(?:property|premises|location|dwelling|home)|dwelling|covered\\s+property)", weight: 1, party: "insured" },
  { kind: "address", re: "(?:residence\\s+)?premises(?:\\s+(?:address|location))?", weight: 0.95, party: "insured" },
  { kind: "address", re: "insured\\s+(?:home|dwelling)(?:\\s+(?:address|location))?", weight: 0.95, party: "insured" },
  { kind: "address", re: "(?:ubicacion|direccion|localizacion)\\s+(?:del\\s+riesgo|de\\s+la\\s+(?:propiedad|residencia|vivienda|casa)(?:\\s+asegurada)?|del\\s+inmueble(?:\\s+asegurado)?)", weight: 1, party: "insured" },
  { kind: "address", re: "(?:residencia|propiedad|vivienda|inmueble)\\s+asegurad[ao]", weight: 1, party: "insured" },

  /* --- direccion postal --- */
  { kind: "mailingAddress", re: "(?:mailing|postal|billing|correspondence)\\s+address(?:es)?", weight: 0.95 },
  { kind: "mailingAddress", re: "direccion\\s+(?:postal|de\\s+correspondencia|de\\s+envio|de\\s+facturacion)", weight: 0.95 },
  /* --- bloque: asegurado(s) + direccion postal --- */
  { kind: "insuredBlock", re: `(?:named\\s+)?insured${P}(?:'s)?(?:\\s+name${P})?\\s*(?:and|&|/)\\s*(?:mailing\\s+|postal\\s+)?address(?:es)?`, weight: 1, party: "insured" },
  { kind: "insuredBlock", re: `(?:policy\\s*holder|owner|applicant)${P}(?:'s)?(?:\\s+name${P})?\\s*(?:and|&|/)\\s*(?:mailing\\s+|postal\\s+)?address`, weight: 1, party: "insured" },
  { kind: "insuredBlock", re: `name${P}\\s*(?:and|&)\\s*(?:mailing\\s+)?address`, weight: 0.9, party: "insured" },
  { kind: "insuredBlock", re: `asegurad[oa]${P}(?:\\s+nombrad[oa]${P})?\\s*(?:y|/)\\s*(?:direccion|domicilio)(?:\\s+postal)?`, weight: 1, party: "insured" },
  { kind: "insuredBlock", re: `nombre${P}(?:\\s+del\\s+asegurado)?\\s*y\\s*(?:direccion|domicilio)(?:\\s+postal)?`, weight: 0.9, party: "insured" },

  /* --- aseguradora --- */
  { kind: "insurer", re: "name\\s+of\\s+(?:the\\s+)?(?:insurance\\s+(?:company|carrier|co\\.?)|insurer|carrier)", weight: 1 },
  { kind: "insurer", re: "insurance\\s+(?:company|carrier|co\\.?)(?:\\s+name)?", weight: 1 },
  { kind: "insurer", re: "(?:insurer|underwriter|carrier)(?:'s)?(?:\\s+name)?", weight: 1 },
  { kind: "insurer", re: "(?:nombre\\s+de\\s+(?:la\\s+)?)?aseguradora", weight: 1 },
  { kind: "insurer", re: "(?:compania|empresa)\\s+(?:de\\s+seguros?|aseguradora)", weight: 1 },
  { kind: "insurer", re: "(?:issuing|writing|underwriting)\\s+(?:company|carrier|insurer)|issued\\s+by|underwritten\\s+by", weight: 1 },
  { kind: "insurer", re: "compania\\s+emisora|aseguradora\\s+emisora|emitida\\s+por", weight: 1 },
  { kind: "insurer", re: "insurance", weight: 0.8 },

  /* --- numero de poliza --- */
  { kind: "policyNumber", re: `(?:pol(?:icy)?\\.?\\s*${NO}|policy\\s+id)`, weight: 1, free: true },
  { kind: "policyNumber", re: `policy\\s*/\\s*certificate\\s*${NO}`, weight: 0.9, free: true },
  { kind: "policyNumber", re: `(?:numero|nro\\.?|num\\.?|no\\.?|n\\.?\\s?[o°º]\\.?)\\s+(?:de\\s+(?:la\\s+)?)?poliza`, weight: 1, free: true },
  { kind: "policyNumber", re: `poliza(?:\\s*${NO})?`, weight: 0.95, free: true },
  { kind: "policyNumber", re: "policy", weight: 0.95 },

  /* --- numero de reclamo --- */
  { kind: "claimNumber", re: `(?:(?:supplemental|supplement)\\s+)?claim\\s*(?:${NO}|id|ref(?:erence)?\\.?(?:\\s*${NO})?)`, weight: 1, free: true },
  { kind: "claimNumber", re: `(?:numero|nro\\.?|num\\.?|no\\.?|n\\.?\\s?[o°º]\\.?)\\s+(?:de\\s+(?:la\\s+)?)?(?:reclamo|reclamacion|siniestro|expediente)`, weight: 1, free: true },
  { kind: "claimNumber", re: `(?:reclamo|reclamacion|siniestro)\\s*${NO}`, weight: 1, free: true },
  { kind: "claimNumber", re: "(?:claim|reclamo|reclamacion|siniestro|expediente)", weight: 0.95 },

  /* --- tipo de reclamo --- */
  { kind: "claimType", re: "type\\s+of\\s+(?:loss|claim|damage|peril)(?:\\s*/\\s*(?:description|cause))?", weight: 1 },
  { kind: "claimType", re: "(?:loss|claim|damage)\\s+type", weight: 1 },
  { kind: "claimType", re: "cause\\s+of\\s+(?:loss|damage)", weight: 1 },
  { kind: "claimType", re: "(?:damage|loss)\\s+caused\\s+by", weight: 1 },
  { kind: "claimType", re: "(?:peril|reason\\s+for\\s+(?:the\\s+)?claim|nature\\s+of\\s+(?:the\\s+)?(?:loss|claim|damage))", weight: 0.9 },
  { kind: "claimType", re: "description\\s+of\\s+(?:the\\s+)?(?:loss|damage)", weight: 0.8 },
  { kind: "claimType", re: "tipo\\s+de\\s+(?:reclamo|reclamacion|perdida|siniestro|dano|evento)(?:\\s*/\\s*descripcion)?", weight: 1 },
  { kind: "claimType", re: "causa\\s+de(?:l)?\\s+(?:la\\s+)?(?:perdida|dano|siniestro)", weight: 1 },
  { kind: "claimType", re: "dano\\s+causado\\s+por", weight: 1 },
  { kind: "claimType", re: "(?:naturaleza\\s+de(?:l)?\\s+(?:la\\s+)?(?:perdida|dano|siniestro)|motivo\\s+del\\s+reclamo)", weight: 0.9 },

  /* --- fecha de perdida --- */
  { kind: "lossDate", re: "date\\s+of\\s+(?:the\\s+)?(?:loss|damage|incident|accident|event|occurrence|casualty)", weight: 1, free: true },
  { kind: "lossDate", re: "(?:loss|incident|accident|event|damage)\\s+date", weight: 1, free: true },
  { kind: "lossDate", re: "d\\.?\\s*o\\.?\\s*l\\.?", weight: 0.95 },
  { kind: "lossDate", re: "date\\s+loss\\s+(?:occurred|happened)|loss\\s+(?:occurred|happened)(?:\\s+on)?", weight: 0.9, free: true },
  { kind: "lossDate", re: "fecha\\s+(?:de(?:l)?\\s+)?(?:la\\s+)?(?:perdida|siniestro|dano|incidente|ocurrencia|evento|accidente)", weight: 1, free: true },
  { kind: "lossDate", re: "fecha\\s+de\\s+ocurrencia", weight: 1, free: true },

  /* --- vigencia de la poliza --- */
  { kind: "policyPeriod", re: "policy\\s+(?:period|term)|(?:coverage|insurance)\\s+period|period\\s+of\\s+(?:insurance|coverage)|term\\s+of\\s+(?:the\\s+)?policy", weight: 1, free: true },
  { kind: "policyPeriod", re: "(?:periodo\\s+de\\s+(?:la\\s+)?(?:poliza|cobertura|vigencia)|vigencia(?:\\s+de\\s+la\\s+poliza)?|periodo\\s+de\\s+seguro)", weight: 1, free: true },
  { kind: "policyStart", re: "(?:policy\\s+)?(?:effective|inception)(?:\\s+date)?|effective\\s+from|eff\\.?\\s+date|(?:policy\\s+)?start(?:s)?(?:\\s+date)?|(?:policy\\s+)?begins?", weight: 1, free: true },
  { kind: "policyStart", re: "inicio\\s+de\\s+(?:la\\s+)?vigencia|vigente\\s+desde|fecha\\s+(?:de\\s+)?(?:efectividad|inicio|efectiva)|efectiv[ao]\\s+desde|fecha\\s+de\\s+entrada\\s+en\\s+vigor", weight: 1, free: true },
  { kind: "policyEnd", re: "(?:policy\\s+)?(?:expiration|expiry)(?:\\s+date)?|(?:policy\\s+)?expires|effective\\s+to|(?:policy\\s+)?end(?:s)?(?:\\s+date)?", weight: 1, free: true },
  { kind: "policyEnd", re: "vencimiento(?:\\s+de\\s+la\\s+poliza)?|vence|fecha\\s+de\\s+(?:vencimiento|expiracion|terminacion|fin)|fin\\s+de\\s+(?:la\\s+)?vigencia|vigente\\s+hasta", weight: 1, free: true },

  /* --- acreedor hipotecario (da valor y abre contexto «de otra parte») --- */
  { kind: "mortgagee", re: "(?:(?:first|second|1st|2nd|primary)\\s+)?mortgagee(?:s)?(?:\\s*(?:/|&|and)\\s*(?:lienholder|lender|loss\\s+payee|additional\\s+interest))?(?:\\s+(?:name|information|company))?", weight: 1, party: "other" },
  { kind: "mortgagee", re: "mortgage\\s+(?:company|holder|lender|servicer)(?:\\s+name)?|lienholder|loss\\s+payee", weight: 0.9, party: "other" },
  { kind: "mortgagee", re: "(?:(?:primer|1er)\\s+)?(?:acreedor|banco|prestamista|institucion\\s+financiera)\\s+hipotecari[oa]|hipotecari[oa]|acreedor", weight: 1, party: "other" },

  /* --- deducibles --- */
  { kind: "windDeductible", re: "(?:wind|windstorm|hurricane|named\\s+storm|tropical\\s+storm|hail)(?:\\s*(?:/|-|and|&|or)\\s*(?:hail|hurricane|wind|windstorm|named\\s+storm))?\\s+(?:peril\\s+)?deductible", weight: 1 },
  { kind: "windDeductible", re: "deductible\\s*[-–:]?\\s*(?:wind|windstorm|hurricane|named\\s+storm)(?:\\s*(?:/|and|&|or)\\s*hail)?", weight: 0.95 },
  { kind: "windDeductible", re: "deducible\\s+(?:de\\s+|por\\s+)?(?:viento|huracan|tormenta(?:\\s+nombrada)?|vendaval|granizo)(?:\\s*(?:/|y)\\s*granizo)?", weight: 1 },
  { kind: "deductible", re: "(?:all\\s+other\\s+perils|aop|all\\s+perils|other\\s+perils|section\\s+i|standard|basic|general|annual|policy)\\s+deductible", weight: 1 },
  { kind: "deductible", re: "deductible\\s*[-–:]?\\s*(?:all\\s+other\\s+perils|aop|all\\s+perils|section\\s+i)", weight: 1 },
  { kind: "deductible", re: "deducible\\s*[-–]?\\s*(?:todo\\s+otro\\s+riesgo|general|seccion\\s+i|todos\\s+los\\s+demas\\s+riesgos|todo\\s+riesgo|estandar|basico|anual)", weight: 1 },
  { kind: "deductible", re: "deductible|deducible", weight: 0.85 },

  /* --- ciudad, estado, CP --- */
  { kind: "csz", re: "city\\s*[,/]?\\s*(?:state|st\\.?)\\s*[,/]?\\s*(?:and\\s*)?(?:zip|postal)(?:\\s*code)?", weight: 1 },
  { kind: "csz", re: "ciudad\\s*[,/]?\\s*(?:estado|edo\\.?)\\s*[,/]?\\s*(?:y\\s*)?(?:c\\.?\\s?p\\.?|codigo\\s+postal)", weight: 1 },
  { kind: "csz", re: "city\\s*,?\\s*state", weight: 0.9 },

  /* --- otras partes (contexto) --- */
  { kind: "party", re: "(?:public\\s+)?adjuster(?:'s)?(?:\\s+name)?", weight: 1, party: "other" },
  { kind: "party", re: "(?:your\\s+|our\\s+)?(?:agent\\s+of\\s+record|writing\\s+agent|producing\\s+agent|contractor|vendor|provider|agent|agency|attorney|lawyer|law\\s+firm|representative|witness|restoration\\s+company|mitigation\\s+company|producer|broker|servicing\\s+agent|insurance\\s+agency|prepared\\s+by|company|firm|(?:authorized|third)\\s+party|payee)(?:'s)?(?:\\s+name)?", weight: 1, party: "other" },
  { kind: "party", re: "(?:su\\s+)?(?:ajustador(?:\\s+publico)?|contratista|proveedor|agente|agencia|productor|corredor|abogado|representante|testigo|empresa|compania|firma)(?:\\s+de\\s+\\w+)?", weight: 1, party: "other" },

  /* --- cortes --- */
  { kind: "stop", re: `(?:fax|facsimile)(?:\\s*${NO})?`, weight: 1 },
  { kind: "stop", re: "(?:office|oficina|toll\\s*free)(?:\\s*(?:phone|tel|telephone|telefono|#|no\\.?))?", weight: 1 },
  { kind: "stop", re: "(?:web\\s*site|website|web|www|url|sitio\\s+web)", weight: 1 },
  { kind: "stop", re: `(?:license|licence|lic\\.?|licencia)(?:\\s*${NO})?`, weight: 1 },
  { kind: "stop", re: "(?:signature|signed|sign|firma|firmado|initials|iniciales|date\\s+signed|dated)", weight: 1 },
  { kind: "stop", re: "(?:date|fecha)(?:\\s+of\\s+(?:birth|signing))?", weight: 1 },
  { kind: "stop", re: `(?:dob|date\\s+of\\s+birth|fecha\\s+de\\s+nacimiento|ssn|social\\s+security(?:\\s*${NO})?|seguro\\s+social)`, weight: 1 },
  { kind: "stop", re: "(?:city|state|zip(?:\\s*code)?|county|country|ciudad|estado|codigo\\s+postal|condado|pais|c\\.?p\\.)", weight: 1 },
  { kind: "stop", re: "(?:relationship|parentesco|occupation|ocupacion|employer|empleador|mortgage|loan\\s*(?:no|number|#)?|prestamo|amount|monto|coverage|cobertura|total|premium|prima|account\\s*(?:no|number|#)?)", weight: 1 },
  /* Poliza anterior o renovada («Renewal of Policy: …») y fechas de emision: no son el numero ni la vigencia de ESTA poliza. */
  { kind: "stop", re: `(?:renewal\\s+of|renews|replaces|supersedes|prior|previous|former|expiring)\\s+(?:policy|pol\\.?)(?:\\s*${NO})?`, weight: 1 },
  { kind: "stop", re: `(?:poliza\\s+(?:anterior|previa)|renovacion\\s+de\\s+(?:la\\s+)?poliza|sustituye\\s+(?:a\\s+)?(?:la\\s+)?poliza)(?:\\s*${NO})?`, weight: 1 },
  { kind: "stop", re: "(?:date\\s+issued|issue\\s+date|issued|prepared|printed|fecha\\s+de\\s+emision|emitida|preparada|impresa)", weight: 1 },
  { kind: "stop", re: "(?:email|e-mail|phone|tel|telefono|address|direccion)\\s+(?:of|de)\\s+(?:the\\s+)?(?:company|adjuster|agent|firm|contractor|compania|ajustador|agente|empresa|contratista)", weight: 1 },
];

/** Un espacio de etiqueta nunca cruza un tabulador (separador de celdas): «No.<celda>Expediente» no es una etiqueta de dos celdas. */
const spaceOnly = (re: string): string => re.replace(/\\s/g, "[^\\S\\t]");

/** Filtro rapido: una linea sin ninguna palabra de etiqueta no pasa por las ~100 expresiones de una en una. */
const ANY_LABEL = new RegExp(`(?<![\\p{L}\\p{N}])(?:${DEFS.map((def) => spaceOnly(def.re)).join("|")})(?![\\p{L}\\p{N}])`, "u");

const COMPILED = DEFS.map((def) => ({ def, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${spaceOnly(def.re)})(?![\\p{L}\\p{N}])`, "gu") }));

/** Palabras que, justo antes de una etiqueta generica (telefono, correo, direccion), dicen de quien es el dato. */
const OTHER_QUALIFIER = /(?:adjuster|contractor|company|agent|agency|attorney|lawyer|firm|vendor|provider|representative|witness|lender|mortgagee|insurer|carrier|office|ajustador|contratista|compania|empresa|agente|agencia|abogado|proveedor|representante|testigo|prestamista|aseguradora|oficina)(?:'s)?\s*$/;
const INSURED_QUALIFIER = /(?:insured|policy\s*holder|client|customer|owner|claimant|asegurado|cliente|propietario|titular|reclamante|contratante)(?:'s)?\s*$/;

/** Palabras que pueden preceder a una etiqueta de linea de referencia sin volverla prosa («Re: Claim No. …», «Our policy number …»). */
const LEAD_WORDS = new Set(["re", "ref", "reference", "referencia", "asunto", "subject", "supplemental", "our", "your", "its", "su", "nuestro", "mi", "my", "the", "este", "esta"]);

export type LabelHit = {
  kind: LabelKind;
  weight: number;
  /** Posicion de la etiqueta (sin los dos puntos) en `line.text`. */
  start: number;
  end: number;
  /** Etiqueta tal como se leyo. */
  labelText: string;
  /** `colon` = con dos puntos; `cell` = ocupa su celda; `free` = el valor sigue sin dos puntos. */
  sep: "colon" | "cell" | "free";
  /** Celda que contiene la etiqueta. */
  cell: number;
  /** Tramo del valor en la MISMA celda (puede estar vacio): hasta la siguiente etiqueta o el fin de la celda. */
  valueStart: number;
  valueEnd: number;
  /** De quien es el dato segun la etiqueta o la palabra que la precede. */
  party?: Party;
  /** Inicio de la palabra calificadora («Insured» en «Insured Email:»), si la hubo. */
  qualStart?: number;
};

function cellOf(line: TextLine, index: number): number {
  let cell = 0;
  for (let i = 0; i < line.starts.length; i += 1) if (line.starts[i] <= index) cell = i;
  return cell;
}

function cellEnd(line: TextLine, cell: number): number {
  return line.starts[cell] + line.cells[cell].text.length;
}

/** Busca TODAS las etiquetas validas de una linea, en orden de aparicion y sin solaparse (gana la mas larga). */
export function scanLabels(line: TextLine): LabelHit[] {
  const folded = fold(line.text);
  if (!ANY_LABEL.test(folded)) return [];
  const raw: Array<{ def: LabelDef; start: number; end: number }> = [];
  for (const { def, re } of COMPILED) {
    re.lastIndex = 0;
    for (let match = re.exec(folded); match !== null; match = re.exec(folded)) {
      if (match[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      raw.push({ def, start: match.index, end: match.index + match[0].length });
    }
  }
  // Mas larga primero; a igual longitud, la de mayor peso; las demas que se solapen se descartan.
  raw.sort((a, b) => b.end - b.start - (a.end - a.start) || b.def.weight - a.def.weight || a.start - b.start);
  const kept: typeof raw = [];
  for (const candidate of raw) {
    if (kept.some((other) => candidate.start < other.end && candidate.end > other.start)) continue;
    kept.push(candidate);
  }
  kept.sort((a, b) => a.start - b.start);

  const hits: LabelHit[] = [];
  for (const { def, start, end } of kept) {
    const cell = cellOf(line, start);
    const endOfCell = cellEnd(line, cell);
    if (end > endOfCell) continue;
    const after = folded.slice(end, endOfCell);
    let sep: LabelHit["sep"] | null = null;
    let valueStart = end;
    // Una indicacion entre parentesis antes de los dos puntos («Insured (please print):», «Policy Number (if known):»).
    const hint = /^[ ]*\([^()]{1,40}\)/.exec(after);
    // Puntos guia de un listado en ancho fijo («POLICY NUMBER.......: HO3-123») valen como los dos puntos.
    const colon = /^[ ]*(?:\.{2,}[ ]*)?[:：]/.exec(hint ? after.slice(hint[0].length) : after);
    if (colon) {
      sep = "colon";
      valueStart = end + (hint ? hint[0].length : 0) + colon[0].length;
    } else if (/^[ ]*[\-–—.]?[ ]*$/.test(after)) {
      // La etiqueta ocupa su celda entera (valor a la derecha o debajo). Una palabra suelta al FINAL de un valor
      // («…Insurance Company») no es una etiqueta.
      if (folded.slice(line.starts[cell], start).replace(/[\s:;,.\-–—|•●·]/g, "") !== "") continue;
      sep = "cell";
      valueStart = endOfCell;
    } else if (def.free) {
      sep = "free";
      valueStart = end + (/^[ ]*(?:[#.\-–—]\s*)?/.exec(after)?.[0].length ?? 0);
    }
    if (sep === null) continue;
    // Calificador previo: «Insured Email», «Adjuster Phone».
    let party = def.party;
    let qualStart: number | undefined;
    if (def.kind === "phone" || def.kind === "email" || def.kind === "address" || def.kind === "mailingAddress" || def.kind === "insuredName1") {
      const prefix = folded.slice(line.starts[cell], start);
      const other = OTHER_QUALIFIER.exec(prefix);
      const insured = INSURED_QUALIFIER.exec(prefix);
      if (other) {
        party = "other";
        qualStart = line.starts[cell] + other.index;
      } else if (insured) {
        party = "insured";
        qualStart = line.starts[cell] + insured.index;
      }
    }
    // Una etiqueta de valor pegado que va tras varias palabras de una frase («…the date of loss March 14, 2026…») es prosa: menos fiable.
    let weight = def.weight;
    if (sep === "free") {
      const before = folded.slice(line.starts[cell], start).split(/[^\p{L}]+/u).filter((word) => word.length >= 2 && !LEAD_WORDS.has(word));
      if (before.length >= 2) weight *= 0.8;
    }
    hits.push({
      kind: def.kind,
      weight,
      start,
      end,
      labelText: line.text.slice(qualStart ?? start, end).replace(/\s+/g, " ").trim(),
      sep,
      cell,
      valueStart,
      valueEnd: endOfCell,
      party,
      qualStart,
    });
  }
  // El valor de cada etiqueta llega hasta la siguiente etiqueta de la misma celda.
  for (let i = 0; i < hits.length; i += 1) {
    const current = hits[i];
    for (let j = i + 1; j < hits.length; j += 1) {
      if (hits[j].cell !== current.cell) break;
      current.valueEnd = Math.min(current.valueEnd, hits[j].qualStart ?? hits[j].start);
      break;
    }
    if (current.valueEnd < current.valueStart) current.valueEnd = current.valueStart;
  }
  return hits;
}

/** Texto de un tramo de la linea, sin tabuladores. */
export function sliceLine(line: TextLine, from: number, to: number): string {
  return line.text.slice(from, to).replace(/\t/g, " ");
}
