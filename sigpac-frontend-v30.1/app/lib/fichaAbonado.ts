// lib/fichaAbonado.ts
//
// Genera la "Ficha de abonado aplicado" en formato Word (.docx), a partir de
// un plan de abonado ya guardado (subpestaña "Plan de abonado" de KAMPO).
// Sigue la plantilla en papel que ya usa el titular: cabecera con datos del
// abono/parcela, y una tabla de 13 nutrientes + materia orgánica comparando
// análisis de suelo / necesidades del cultivo / composición del abono / aplicado.

export interface FilaParcelaFicha { referencia: string }

export interface FichaAbonadoData {
  nombreComercial: string
  fabricante?: string
  dosisKgHa: number
  cultivo: string
  parcelas: FilaParcelaFicha[]           // una fila por parcela (normalmente 1)
  nutrientes: { etiqueta: string; analisis: string; necesidades: string; composicion: string; aplicado: string }[]
  materiaOrganica: { analisis: string; necesidades: string; composicion: string; aplicado: string }
  ph?: string
  ce?: string
  fecha?: string
  maquinaria: string[]                   // "Nombre (ROMA)" ya formateado, una por máquina
}

const BORDE = '999999'
const GRIS_CABECERA = 'D9D9D9'
// Formato español: coma como separador decimal (12,5 en vez de 12.5)
const fmt = (n: number, decimales: number = 1): string => n.toFixed(decimales).replace('.', ',')

export const generarFichaAbonadoDocx = async (data: FichaAbonadoData): Promise<Blob> => {
  const docx = await import('docx')
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
    BorderStyle, AlignmentType, ShadingType, VerticalAlign,
  } = docx

  const ANCHO_UTIL = 9638 // twips (A4 retrato 11906 - márgenes 1134*2 aprox)
  const bordeFino = { style: BorderStyle.SINGLE, size: 4, color: BORDE }
  const bordesCelda = { top: bordeFino, bottom: bordeFino, left: bordeFino, right: bordeFino }

  const celda = (texto: string, opts: { bold?: boolean; shading?: string; align?: any; colSpan?: number; width?: number } = {}) =>
    new TableCell({
      borders: bordesCelda,
      columnSpan: opts.colSpan,
      width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
      shading: opts.shading ? { type: ShadingType.CLEAR, fill: opts.shading, color: 'auto' } : undefined,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 40, bottom: 40, left: 80, right: 80 },
      children: [new Paragraph({
        alignment: opts.align || AlignmentType.LEFT,
        children: [new TextRun({ text: texto || '', bold: !!opts.bold, size: 19, font: 'Arial' })],
      })],
    })

  const c1 = Math.round(ANCHO_UTIL * 0.30)
  const c2 = Math.round(ANCHO_UTIL * 0.20)
  const c3 = Math.round(ANCHO_UTIL * 0.30)
  const c4 = ANCHO_UTIL - c1 - c2 - c3

  const filasCabecera: InstanceType<typeof TableRow>[] = [
    new TableRow({ children: [
      celda('Nombre comercial', { bold: true, shading: GRIS_CABECERA, width: c1 }), celda(data.nombreComercial, { width: c2 }),
      celda('Dosis (kg/ha)', { bold: true, shading: GRIS_CABECERA, width: c3 }), celda(fmt(data.dosisKgHa), { width: c4 }),
    ]}),
    new TableRow({ children: [
      celda('Fabricante del abono', { bold: true, shading: GRIS_CABECERA }), celda(data.fabricante || '—'),
      celda('', { shading: GRIS_CABECERA }), celda(''),
    ]}),
    new TableRow({ children: [
      celda('Referencias SIGPAC', { bold: true, shading: GRIS_CABECERA }), celda(''),
      celda('Cultivo', { bold: true, shading: GRIS_CABECERA }), celda(data.cultivo || '—'),
    ]}),
  ]

  // Una fila por cada parcela/SIGPAC que traiga el plan (normalmente 1, pero
  // preparado para varias): numeradas 1, 2, 3... hasta N, sin filas vacías de más.
  const filasParcelas: InstanceType<typeof TableRow>[] = data.parcelas.map((p, i) => new TableRow({ children: [
    celda(String(i + 1), { bold: true, align: AlignmentType.RIGHT, colSpan: 2 }),
    celda(p.referencia || '—', { colSpan: 2 }),
  ]}))

  const tablaNutrientes = new Table({
    width: { size: ANCHO_UTIL, type: WidthType.DXA },
    columnWidths: [Math.round(ANCHO_UTIL * 0.22), Math.round(ANCHO_UTIL * 0.195), Math.round(ANCHO_UTIL * 0.195), Math.round(ANCHO_UTIL * 0.195), ANCHO_UTIL - Math.round(ANCHO_UTIL * 0.22) - 3 * Math.round(ANCHO_UTIL * 0.195)],
    rows: [
      new TableRow({ tableHeader: true, children: [
        celda('Nutrientes', { bold: true, shading: GRIS_CABECERA, align: AlignmentType.CENTER }),
        celda('Análisis suelo', { bold: true, shading: GRIS_CABECERA, align: AlignmentType.CENTER }),
        celda('Necesidades', { bold: true, shading: GRIS_CABECERA, align: AlignmentType.CENTER }),
        celda('Composición abono', { bold: true, shading: GRIS_CABECERA, align: AlignmentType.CENTER }),
        celda('Aplicado', { bold: true, shading: GRIS_CABECERA, align: AlignmentType.CENTER }),
      ]}),
      ...data.nutrientes.map(n => new TableRow({ children: [
        celda(n.etiqueta, { bold: true }),
        celda(n.analisis, { align: AlignmentType.CENTER }),
        celda(n.necesidades, { align: AlignmentType.CENTER }),
        celda(n.composicion, { align: AlignmentType.CENTER }),
        celda(n.aplicado, { align: AlignmentType.CENTER }),
      ]})),
      new TableRow({ children: [
        celda('Materia orgánica', { bold: true }),
        celda(data.materiaOrganica.analisis, { align: AlignmentType.CENTER }),
        celda(data.materiaOrganica.necesidades, { align: AlignmentType.CENTER }),
        celda(data.materiaOrganica.composicion, { align: AlignmentType.CENTER }),
        celda(data.materiaOrganica.aplicado, { align: AlignmentType.CENTER }),
      ]}),
    ],
  })

  const celdaMultilinea = (lineas: string[], opts: { colSpan?: number } = {}) =>
    new TableCell({
      borders: bordesCelda,
      columnSpan: opts.colSpan,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 40, bottom: 40, left: 80, right: 80 },
      children: (lineas.length > 0 ? lineas : ['—']).map(linea => new Paragraph({
        children: [new TextRun({ text: linea, size: 19, font: 'Arial' })],
      })),
    })

  const tablaFinal = new Table({
    width: { size: ANCHO_UTIL, type: WidthType.DXA },
    rows: [
      new TableRow({ children: [celda('pH', { bold: true, width: c1 }), celda(data.ph || '—', { colSpan: 3 })] }),
      new TableRow({ children: [celda('CE (dS/m)', { bold: true }), celda(data.ce || '—', { colSpan: 3 })] }),
      new TableRow({ children: [celda('Fecha', { bold: true }), celda(data.fecha || '—', { colSpan: 3 })] }),
      // Cada máquina en su propia línea dentro de la celda, no separadas por comas
      new TableRow({ children: [celda('Maquinaria', { bold: true }), celdaMultilinea(data.maquinaria, { colSpan: 3 })] }),
    ],
  })

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ children: [new TextRun({ text: 'FICHA DE ABONADO APLICADO', bold: true, size: 28, font: 'Arial' })] }),
        new Paragraph({ text: '' }),
        new Table({ width: { size: ANCHO_UTIL, type: WidthType.DXA }, columnWidths: [c1, c2, c3, c4], rows: filasCabecera }),
        new Paragraph({ text: '' }),
        new Table({ width: { size: ANCHO_UTIL, type: WidthType.DXA }, rows: filasParcelas }),
        new Paragraph({ text: '' }),
        tablaNutrientes,
        new Paragraph({ text: '' }),
        tablaFinal,
      ],
    }],
  })

  return Packer.toBlob(doc)
}

export const descargarFichaAbonado = async (data: FichaAbonadoData, nombreArchivo: string) => {
  const blob = await generarFichaAbonadoDocx(data)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombreArchivo
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
