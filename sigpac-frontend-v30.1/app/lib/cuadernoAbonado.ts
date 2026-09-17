// lib/cuadernoAbonado.ts
//
// Genera el "Cuaderno de Abonado" en Word (.docx), mismo modelo/estilo que el
// Cuaderno de Campo (secciones 1.1-1.5, 2.1, 2.2 idénticas, RD 1311/2012),
// pero con una sección 3.1 propia: por cada parcela, la composición química
// del suelo y las necesidades del cultivo aparecen UNA sola vez, y debajo se
// repite un bloque "ABONO N" por cada plan de abonado aplicado a esa parcela
// (composición del producto, lo realmente aplicado, fecha, quién lo aplicó/
// recomendó con su ROPO, y la maquinaria usada con su ROMA).
//
// Módulo autocontenido a propósito (no importa nada de cuadernoCampo.ts) para
// no acoplar ambos generadores.

export interface SeccionTabla {
  numero: string
  titulo: string
  subtitulo?: string
  headers: string[]
  colWidths: number[]
  rows: string[][]
  filasVaciasMin?: number
  notas?: string[]
  saltoPaginaAntes?: boolean
  gruposCabecera?: { titulo: string; span: number }[]
}

export interface AbonoBloqueFicha {
  nombre: string
  fabricante?: string
  numRegistro?: string
  organico: boolean
  composicion: string[]   // en el mismo orden que NUTRIENTES_ORDEN (14 valores)
  aplicado: string[]      // idem
  fecha?: string
  cultivo?: string
  recomendadoPor?: string  // "Nombre (ROPO)"
  aplicadoPor?: string     // "Nombre (ROPO)"
  maquinaria: string[]     // "Nombre (ROMA)" — 0, 1 o varias
}

export interface ParcelaAbonadoFicha {
  idParcela: string                  // nombre/etiqueta de la parcela
  analisisSuelo: string[]            // 14 valores (mismo orden que NUTRIENTES_ORDEN)
  necesidadCultivo: string[]         // 14 valores
  abonos: AbonoBloqueFicha[]         // uno por plan de abonado aplicado, en orden cronológico
}

export interface CuadernoAbonadoData {
  campanaNombre: string
  campanaFechaInicio?: string
  campanaFechaFin?: string
  cabecera: string
  fechaApertura?: string
  datosGenerales: { label: string; value: string }[][]
  titular: { label: string; value: string }[][]
  seccionesPrevias: SeccionTabla[]    // 1.2, 1.3, 1.4, 1.5, 2.1, 2.2
  parcelas: ParcelaAbonadoFicha[]     // sección 3.1
}

export const NUTRIENTES_ORDEN = ['N', 'P', 'K', 'Ca', 'Mg', 'S', 'Fe', 'Zn', 'Mn', 'B', 'Cu', 'Cl', 'Mo', 'Materia orgánica']

const AZUL_TITULO = '1F4E78'
const GRIS_CABECERA = 'D9D9D9'
const BORDE = 'A6A6A6'
const VERDE_MARCA = '2FA85A'
const GRIS_MARCA = '262626'

export const generarCuadernoAbonadoDocx = async (data: CuadernoAbonadoData): Promise<Blob> => {
  const docx = await import('docx')
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
    BorderStyle, AlignmentType, PageOrientation, Footer, Header, ShadingType, VerticalAlign, TabStopType,
  } = docx

  const ANCHO_UTIL = 15838 // twips (A4 landscape 16838 - márgenes 500+500)
  const bordeFino = { style: BorderStyle.SINGLE, size: 4, color: BORDE }
  const bordesCelda = { top: bordeFino, bottom: bordeFino, left: bordeFino, right: bordeFino }

  const celdaTexto = (texto: string, opts: { bold?: boolean; size?: number; shading?: string; align?: any; color?: string; rowSpan?: number; colSpan?: number; width?: number } = {}) =>
    new TableCell({
      borders: bordesCelda,
      rowSpan: opts.rowSpan,
      columnSpan: opts.colSpan,
      width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
      shading: opts.shading ? { type: ShadingType.CLEAR, fill: opts.shading, color: 'auto' } : undefined,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 40, bottom: 40, left: 60, right: 60 },
      children: [new Paragraph({
        alignment: opts.align || AlignmentType.LEFT,
        children: [new TextRun({ text: texto || '', bold: !!opts.bold, size: opts.size || 14, color: opts.color, font: 'Arial' })],
      })],
    })

  // --- Tabla genérica de sección (idéntica a la del Cuaderno de Campo) ---
  const tablaSeccion = (s: SeccionTabla) => {
    const pesos = s.colWidths.length === s.headers.length ? s.colWidths : s.headers.map(() => 1)
    const sumaPesos = pesos.reduce((a, b) => a + b, 0)
    const anchos = pesos.map(p => Math.round((p / sumaPesos) * ANCHO_UTIL))

    const filasDatos = [...s.rows]
    const minimo = s.filasVaciasMin || 0
    while (filasDatos.length < minimo) filasDatos.push(s.headers.map(() => ''))

    const filaTitulo = new TableRow({
      children: [new TableCell({
        columnSpan: s.headers.length,
        borders: bordesCelda,
        shading: { type: ShadingType.CLEAR, fill: GRIS_CABECERA, color: 'auto' },
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${s.numero} ${s.titulo}`, bold: true, size: 18, font: 'Arial' })] }),
          ...(s.subtitulo ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: s.subtitulo, bold: true, italics: true, size: 15, font: 'Arial' })] })] : []),
        ],
      })],
    })

    const filaCabecera = new TableRow({
      tableHeader: true,
      children: s.headers.map(h => celdaTexto(h, { bold: true, size: 14, shading: 'F2F2F2', align: AlignmentType.CENTER })),
    })

    const filaGrupos = s.gruposCabecera ? new TableRow({
      tableHeader: true,
      children: s.gruposCabecera.map(g => new TableCell({
        columnSpan: g.span, borders: bordesCelda,
        shading: { type: ShadingType.CLEAR, fill: 'E7E6E6', color: 'auto' },
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 40, bottom: 40, left: 60, right: 60 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: g.titulo, bold: true, size: 13, font: 'Arial' })] })],
      })),
    }) : null

    const filasCuerpo = filasDatos.map(fila => new TableRow({
      children: fila.map((v, i) => celdaTexto(v, { size: 14, align: i === 0 ? AlignmentType.CENTER : AlignmentType.LEFT })),
    }))

    const tabla = new Table({ width: { size: ANCHO_UTIL, type: WidthType.DXA }, columnWidths: anchos, rows: [filaTitulo, ...(filaGrupos ? [filaGrupos] : []), filaCabecera, ...filasCuerpo] })

    const bloques: any[] = [tabla, new Paragraph({ text: '', spacing: { after: 60 } })]
    if (s.notas && s.notas.length > 0) {
      s.notas.forEach(n => bloques.push(new Paragraph({ children: [new TextRun({ text: n, size: 12, italics: true, color: '595959', font: 'Arial' })], spacing: { after: 20 } })))
    }
    bloques.push(new Paragraph({ text: '', spacing: { after: 160 } }))
    return bloques
  }

  // --- Tabla de pares label/value (secciones 1.1) ---
  const tablaLabelValue = (titulo: string, filas: { label: string; value: string }[][], subtitulo?: string) => {
    const filasTabla: any[] = []
    filasTabla.push(new TableRow({ children: [new TableCell({ columnSpan: 2, borders: bordesCelda, shading: { type: ShadingType.CLEAR, fill: GRIS_CABECERA, color: 'auto' }, margins: { top: 60, bottom: 60, left: 60, right: 60 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: titulo, bold: true, size: 18, font: 'Arial' })] })] })] }))
    if (subtitulo) {
      filasTabla.push(new TableRow({ children: [new TableCell({ columnSpan: 2, borders: bordesCelda, shading: { type: ShadingType.CLEAR, fill: 'EDEDED', color: 'auto' }, margins: { top: 40, bottom: 40, left: 60, right: 60 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: subtitulo, bold: true, size: 15, font: 'Arial' })] })] })] }))
    }
    filas.forEach(par => par.forEach(({ label, value }) => {
      filasTabla.push(new TableRow({
        children: [
          new TableCell({ borders: bordesCelda, width: { size: Math.round(ANCHO_UTIL * 0.28), type: WidthType.DXA }, margins: { top: 50, bottom: 50, left: 60, right: 60 }, children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 14, font: 'Arial' })] })] }),
          new TableCell({ borders: bordesCelda, width: { size: Math.round(ANCHO_UTIL * 0.72), type: WidthType.DXA }, margins: { top: 50, bottom: 50, left: 60, right: 60 }, children: [new Paragraph({ children: [new TextRun({ text: value || ' ', size: 14, font: 'Arial' })] })] }),
        ],
      }))
    }))
    return new Table({ width: { size: ANCHO_UTIL, type: WidthType.DXA }, rows: filasTabla })
  }

  const parrafoTitulo = (texto: string) => new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 240 },
    border: { top: { style: BorderStyle.SINGLE, size: 8, color: AZUL_TITULO }, bottom: { style: BorderStyle.SINGLE, size: 8, color: AZUL_TITULO }, left: { style: BorderStyle.SINGLE, size: 8, color: AZUL_TITULO }, right: { style: BorderStyle.SINGLE, size: 8, color: AZUL_TITULO } },
    children: [new TextRun({ text: texto, bold: true, size: 28, font: 'Arial', color: AZUL_TITULO })],
  })

  const logoRuns = (size: number) => [
    new TextRun({ text: 'K', bold: true, size, font: 'Arial', color: VERDE_MARCA }),
    new TextRun({ text: 'ULT', bold: true, size, font: 'Arial', color: GRIS_MARCA }),
    new TextRun({ text: 'A', bold: true, size, font: 'Arial', color: VERDE_MARCA }),
    new TextRun({ text: 'GRO', bold: true, size, font: 'Arial', color: GRIS_MARCA }),
  ]

  // --- Sección 3.1 (específica de abonado): análisis+necesidad una vez por
  // parcela, y un bloque de 4 filas repetido por cada abono aplicado ---
  const anchoIdParcela = Math.round(ANCHO_UTIL * 0.09)
  const anchoConcepto = Math.round(ANCHO_UTIL * 0.14)
  const anchoNutriente = Math.round((ANCHO_UTIL - anchoIdParcela - anchoConcepto) / NUTRIENTES_ORDEN.length)

  const filaTituloSeccion31 = new TableRow({
    children: [new TableCell({
      columnSpan: 2 + NUTRIENTES_ORDEN.length,
      borders: bordesCelda,
      shading: { type: ShadingType.CLEAR, fill: GRIS_CABECERA, color: 'auto' },
      margins: { top: 60, bottom: 60, left: 60, right: 60 },
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '3.1 REGISTRO DE ACTUACIONES DE ABONADO DE LA PARCELA', bold: true, size: 18, font: 'Arial' })] })],
    })],
  })
  const filaCabecera31 = new TableRow({
    tableHeader: true,
    children: [
      celdaTexto('Id parcela', { bold: true, size: 13, shading: 'F2F2F2', align: AlignmentType.CENTER }),
      celdaTexto('Nutrientes (Kg/ha)', { bold: true, size: 13, shading: 'F2F2F2', align: AlignmentType.CENTER }),
      ...NUTRIENTES_ORDEN.map(n => celdaTexto(n, { bold: true, size: 12, shading: 'F2F2F2', align: AlignmentType.CENTER })),
    ],
  })

  const filasCuerpo31: InstanceType<typeof TableRow>[] = []
  data.parcelas.forEach(p => {
    const totalFilas = 2 + p.abonos.length * 4
    let primeraFila = true
    const celdaId = () => {
      if (!primeraFila) return null
      primeraFila = false
      return celdaTexto(p.idParcela, { bold: true, rowSpan: totalFilas, align: AlignmentType.CENTER })
    }

    filasCuerpo31.push(new TableRow({ children: [
      celdaId(), celdaTexto('Análisis suelo', { bold: true, size: 12 }),
      ...p.analisisSuelo.map(v => celdaTexto(v, { size: 12, align: AlignmentType.CENTER })),
    ].filter(Boolean) as InstanceType<typeof TableCell>[] }))

    filasCuerpo31.push(new TableRow({ children: [
      celdaTexto('Necesidad del cultivo', { bold: true, size: 12 }),
      ...p.necesidadCultivo.map(v => celdaTexto(v, { size: 12, align: AlignmentType.CENTER })),
    ] }))

    p.abonos.forEach((ab, i) => {
      const infoAbono = `${ab.nombre}${ab.fabricante ? ` — Fabricante: ${ab.fabricante}` : ''}${ab.numRegistro ? ` — REGFER: ${ab.numRegistro}` : ''} — ${ab.organico ? 'Orgánico' : 'Inorgánico'}`
      filasCuerpo31.push(new TableRow({ children: [
        celdaTexto(`ABONO ${i + 1}`, { bold: true, size: 12 }),
        celdaTexto(infoAbono, { size: 12, colSpan: NUTRIENTES_ORDEN.length }),
      ] }))
      filasCuerpo31.push(new TableRow({ children: [
        celdaTexto('Composición abono', { bold: true, size: 12 }),
        ...ab.composicion.map(v => celdaTexto(v, { size: 12, align: AlignmentType.CENTER })),
      ] }))
      filasCuerpo31.push(new TableRow({ children: [
        celdaTexto('Aplicado', { bold: true, size: 12 }),
        ...ab.aplicado.map(v => celdaTexto(v, { size: 12, align: AlignmentType.CENTER })),
      ] }))
      const infoEjecucion = [
        ab.fecha ? `Fecha: ${ab.fecha}` : null,
        ab.cultivo ? `Cultivo: ${ab.cultivo}` : null,
        ab.recomendadoPor ? `Recomendado por: ${ab.recomendadoPor}` : null,
        ab.aplicadoPor ? `Aplicado por: ${ab.aplicadoPor}` : null,
        ab.maquinaria.length > 0 ? `Maquinaria: ${ab.maquinaria.join(', ')}` : null,
      ].filter(Boolean).join('   ·   ')
      filasCuerpo31.push(new TableRow({ children: [
        celdaTexto('Ejecución', { bold: true, size: 12 }),
        celdaTexto(infoEjecucion, { size: 12, colSpan: NUTRIENTES_ORDEN.length }),
      ] }))
    })
  })

  const tabla31 = new Table({
    width: { size: ANCHO_UTIL, type: WidthType.DXA },
    columnWidths: [anchoIdParcela, anchoConcepto, ...NUTRIENTES_ORDEN.map(() => anchoNutriente)],
    rows: [filaTituloSeccion31, filaCabecera31, ...filasCuerpo31],
  })

  const children: any[] = []

  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: logoRuns(36) }))
  children.push(parrafoTitulo('CUADERNO DE ABONADO'))
  children.push(new Paragraph({
    spacing: { after: 200 },
    children: [
      new TextRun({ text: 'Fecha de apertura del cuaderno: ', bold: true, size: 18, font: 'Arial' }),
      new TextRun({ text: data.fechaApertura || '____/____/______', size: 18, font: 'Arial' }),
    ],
  }))
  children.push(tablaLabelValue('1.1 DATOS GENERALES DE LA EXPLOTACIÓN', data.datosGenerales))
  children.push(new Paragraph({ text: '', spacing: { after: 160 } }))
  children.push(tablaLabelValue('TITULAR O REPRESENTANTE DE LA EXPLOTACIÓN', data.titular))
  children.push(new Paragraph({
    spacing: { before: 160 },
    children: [new TextRun({ text: '(1) La persona firmante se hace responsable de la veracidad de los datos consignados en el presente cuaderno de explotación.', size: 12, italics: true, color: '595959', font: 'Arial' })],
  }))

  data.seccionesPrevias.forEach(s => {
    if (s.saltoPaginaAntes) children.push(new Paragraph({ children: [], pageBreakBefore: true }))
    children.push(...tablaSeccion(s))
  })

  children.push(new Paragraph({ children: [], pageBreakBefore: true }))
  children.push(tabla31)
  children.push(new Paragraph({
    spacing: { before: 100 },
    children: [new TextRun({ text: 'El análisis de suelo y las necesidades del cultivo se muestran una sola vez por parcela; cada bloque "ABONO N" corresponde a una aplicación (plan de abonado) distinta sobre esa parcela.', size: 12, italics: true, color: '595959', font: 'Arial' })],
  }))

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: { top: 500, bottom: 700, left: 500, right: 500 } } },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.LEFT,
            tabStops: [{ type: TabStopType.LEFT, position: 1500 }],
            children: [
              ...logoRuns(16),
              new TextRun({ text: '\t', font: 'Arial' }),
              new TextRun({ text: `Explotación/Titular de la explotación: ${data.cabecera || ''}      CAMPAÑA: ${data.campanaNombre}${data.campanaFechaInicio && data.campanaFechaFin ? ` (${data.campanaFechaInicio} - ${data.campanaFechaFin})` : ''}`, bold: true, size: 15, font: 'Arial' }),
            ],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Cuaderno de Abonado — generado automáticamente', size: 11, italics: true, color: '808080', font: 'Arial' })] })],
        }),
      },
      children,
    }],
  })

  return Packer.toBlob(doc)
}

export const descargarCuadernoAbonado = async (data: CuadernoAbonadoData, nombreArchivo: string) => {
  const blob = await generarCuadernoAbonadoDocx(data)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombreArchivo
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
