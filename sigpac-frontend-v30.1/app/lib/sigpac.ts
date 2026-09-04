// lib/sigpac.ts
//
// Extraído de app/page.tsx. Contiene la lógica de referencia y fusión de
// recintos SIGPAC, usada tanto por el mapa (selección manual / dibujo) como
// por el importador de parcelas desde Excel (components/ImportarParcelasExcel.tsx).
//
// IMPORTANTE: si tocas esta lógica, revisa también los usos en page.tsx
// (buscarPorReferenciaSigpac, detectarRecintosBajoDibujo, etc.), que dependen
// exactamente de estas mismas funciones.

// Referencia de un recinto SIGPAC individual dentro de una parcela.
// Una parcela agrícola real puede estar formada por varios recintos SIGPAC:
// aquí guardamos cada uno con su referencia completa y la superficie que aporta.
export interface RecintoRef {
  provincia?: string
  municipio?: string
  agregado?: string
  zona?: string
  poligono?: string
  parcela?: string
  recinto?: string
  usoSigpac?: string
  supHa: number
}

// Busca el primer valor no vacío entre varias claves posibles de un objeto de
// propiedades (para tolerar distintas convenciones de nombres del backend/SIGPAC).
export const campoTexto = (props: any, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    if (props?.[k] !== undefined && props[k] !== null && props[k] !== '') return String(props[k])
  }
  return undefined
}

// Extrae la referencia SIGPAC (y superficie en ha) de las propiedades de un
// feature devuelto por el backend (/sigpac/punto, /sigpac/referencia).
export const extraerRecinto = (props: any): RecintoRef => {
  const supM2 = Number(props?.superficie || 0)
  return {
    provincia: campoTexto(props, 'provincia', 'PROVINCIA'),
    municipio: campoTexto(props, 'municipio', 'MUNICIPIO'),
    agregado: campoTexto(props, 'agregado', 'AGREGADO'),
    zona: campoTexto(props, 'zona', 'ZONA'),
    poligono: campoTexto(props, 'poligono', 'POLIGONO'),
    parcela: campoTexto(props, 'parcela', 'PARCELA'),
    recinto: campoTexto(props, 'recinto', 'RECINTO'),
    usoSigpac: campoTexto(props, 'uso_sigpac', 'USO_SIGPAC'),
    supHa: supM2 > 1000 ? supM2 / 10000 : supM2,
  }
}

// Formatea una referencia SIGPAC como "provincia/municipio/agregado/zona/poligono/parcela/recinto"
// (ej. "9/2/0/0/2/3/1"). Los campos que no se hayan podido leer se muestran como "?".
export const formatRefSigpac = (r: RecintoRef): string =>
  [r.provincia, r.municipio, r.agregado, r.zona, r.poligono, r.parcela, r.recinto]
    .map(v => (v === undefined || v === null || v === '' ? '?' : v))
    .join('/')

// Fusiona las geometrías de varios recintos SIGPAC en una única Feature MultiPolygon,
// para que el resto de la app (bbox, recorte de imágenes, clima, curvas de nivel...)
// siga tratando la parcela como una sola geometría, tenga 1 o N recintos.
export const fusionarPoligonosDeFeatures = (features: any[]): any => {
  const poligonos: any[] = []
  features.forEach((f: any) => {
    const geom = f?.geometry
    if (!geom) return
    if (geom.type === 'Polygon') poligonos.push(geom.coordinates)
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => poligonos.push(p))
  })
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: poligonos } }],
  }
}

// A partir de los features SIGPAC devueltos por el backend, construye:
// - el objeto parcelaInfo (origen, lista de recintos, y campos "compat" del primero)
// - el geojson fusionado a mostrar/guardar
// - la superficie total en ha
export const construirEstadoDesdeFeatures = (features: any[]) => {
  const recintos = features.map((f: any) => extraerRecinto(f.properties || {}))
  const supTotal = recintos.reduce((acc, r) => acc + r.supHa, 0)
  const fusionado = fusionarPoligonosDeFeatures(features)
  const info: any = {
    origen: recintos.length > 1 ? 'sigpac_multiple' : 'sigpac',
    recintos,
    // Campos "compat" con el resto de la app: se corresponden con el primer recinto.
    municipio: recintos[0]?.municipio,
    poligono: recintos[0]?.poligono,
    parcela: recintos[0]?.parcela,
    uso_sigpac: recintos[0]?.usoSigpac,
    superficie: supTotal,
  }
  return { info, fusionado, supTotal }
}

// Valida y descompone una referencia SIGPAC en formato texto
// "Provincia/Municipio/Agregado/Zona/Poligono/Parcela/Recinto" (7 números separados por "/").
// Devuelve null si el formato no es válido.
export const parsearRefSigpacTexto = (
  texto: string
): { pr: string; mu: string; ag: string; zo: string; po: string; pa: string; re: string } | null => {
  const partes = texto.split('/').map(p => p.trim()).filter(p => p !== '')
  if (partes.length !== 7 || partes.some(p => !/^\d+$/.test(p))) return null
  const [pr, mu, ag, zo, po, pa, re] = partes
  return { pr, mu, ag, zo, po, pa, re }
}
