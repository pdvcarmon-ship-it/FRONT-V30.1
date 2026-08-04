// lib/parcelaUtils.ts
//
// Utilidades generales sobre parcelas, compartidas entre app/page.tsx y
// components/ImportarParcelasExcel.tsx.

// Genera la URL de una imagen satélite (Esri World Imagery, gratuita, sin API key)
// recortada al bbox de la geometría de la parcela. Extraído de page.tsx para poder
// generar también la foto de las parcelas creadas desde el importador de Excel.
export const getEsriPreviewUrl = (geojson: any): string => {
  const geom = geojson.features[0].geometry
  const allCoords: number[][] = []
  if (geom.type === 'Polygon') allCoords.push(...geom.coordinates[0])
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => allCoords.push(...p[0]))
  const lons = allCoords.map(c => c[0])
  const lats = allCoords.map(c => c[1])
  const minLon = Math.min(...lons)
  const maxLon = Math.max(...lons)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)

  const bbox = `${minLon},${minLat},${maxLon},${maxLat}`
  const bboxSR = '4326'
  const size = '400,400'
  const imageSR = '4326'
  const format = 'jpg'
  return `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=${bboxSR}&size=${size}&imageSR=${imageSR}&format=${format}&f=image`
}

// Normaliza un valor de fecha proveniente de una celda de Excel a formato ISO
// "YYYY-MM-DD" — el único formato que usa el resto de la app (los <input type="date">
// exigen exactamente ese formato para poder mostrar/editar el valor).
//
// Por qué hace falta: cuando Excel reconoce una celda como fecha, la MUESTRA con el
// formato regional configurado en el Excel/ordenador de quien lo rellena (pueden ser
// "03/08/2015", "8/3/2015", "2015-08-03"... según su configuración regional). Para no
// depender de eso, hay que leer el Excel pidiendo los objetos Date "reales" de la celda
// (XLSX.read con { cellDates: true } y sheet_to_json con { raw: true }) en vez del texto
// formateado — así este parser solo necesita cubrir el caso de que la fecha se haya
// escrito como TEXTO plano (celda con formato "Texto"), no como fecha reconocida.
export const normalizarFechaExcel = (valor: any): string => {
  if (valor === null || valor === undefined || valor === '') return ''

  // 1) Celda de fecha real de Excel → SheetJS (con cellDates:true) la entrega como Date.
  //    OJO: SheetJS construye este objeto Date usando la HORA LOCAL del navegador
  //    (no UTC). Por eso hay que leerlo con los getters LOCALES (getFullYear/getMonth/
  //    getDate) y no con los UTC: usar getUTC* aquí resta el offset horario y, en
  //    zonas horarias por delante de UTC (como España, UTC+1/+2), hace que la fecha
  //    aparezca un día antes de la real. Comprobado empíricamente con la librería.
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    const y = valor.getFullYear()
    const m = String(valor.getMonth() + 1).padStart(2, '0')
    const d = String(valor.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  // 2) Número de serie de Excel (por si llega como número "pelado", p.ej. celda con
  //    formato General). Epoch de Excel: 1899-12-30 → 25569 días hasta 1970-01-01.
  if (typeof valor === 'number' && valor > 0) {
    const ms = Math.round((valor - 25569) * 86400 * 1000)
    const dt = new Date(ms)
    if (!isNaN(dt.getTime())) {
      const y = dt.getUTCFullYear()
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0')
      const d = String(dt.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
  }

  const texto = String(valor).trim()
  if (!texto) return ''

  // 3) Ya viene en ISO (YYYY-MM-DD) → se deja tal cual (rellenando ceros si hiciera falta).
  const isoMatch = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (isoMatch) {
    const [, y, m, d] = isoMatch
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }

  // 4) Texto plano con "/" o "-": se asume DD/MM/YYYY (formato español), que es el
  //    que usa la inmensa mayoría de los usuarios de Kampo. Si algún día hace falta
  //    soportar Excel en formato US (MM/DD/YYYY), este es el sitio a tocar.
  const sepMatch = texto.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
  if (sepMatch) {
    const [, dia, mes, y] = sepMatch
    return `${y}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`
  }

  // No se pudo interpretar de forma fiable: mejor vacío que una fecha incorrecta.
  return ''
}
