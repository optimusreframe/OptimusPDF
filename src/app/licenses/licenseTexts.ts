/**
 * Enlaces CANONICOS a los textos de licencia (no se pega ningun texto largo en la pagina) y utilidades para trabajar con las
 * expresiones SPDX que declaran los paquetes (`MIT`, `(MIT OR GPL-3.0-or-later)`...).
 */

export const LICENSE_TEXT_URLS: Readonly<Record<string, string>> = {
  MIT: "https://opensource.org/license/mit",
  ISC: "https://opensource.org/license/isc-license-txt",
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "BSD-2-Clause": "https://opensource.org/license/bsd-2-clause",
  "BSD-3-Clause": "https://opensource.org/license/bsd-3-clause",
  "MPL-2.0": "https://www.mozilla.org/en-US/MPL/2.0/",
  "LGPL-2.0-or-later": "https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html",
  "LGPL-2.1-or-later": "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html",
  "GPL-3.0-or-later": "https://www.gnu.org/licenses/gpl-3.0.html",
  "OFL-1.1": "https://openfontlicense.org/open-font-license-official-text/",
};

/** Identificadores SPDX sueltos de una expresion: `(MIT OR GPL-3.0-or-later)` -> `["MIT", "GPL-3.0-or-later"]`. */
export function licenseIds(expression: string): string[] {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND|WITH)\s+|\s+·\s+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Paquetes que ofrecen dos licencias a eleccion: lo que dice la pagina es la que se usa. */
export const USED_UNDER: Readonly<Record<string, string>> = { jszip: "MIT" };

/** Paquetes que no corren en el navegador de quien usa la aplicacion sino en nuestro servidor. */
export const SERVER_SIDE: ReadonlySet<string> = new Set(["parse5"]);
