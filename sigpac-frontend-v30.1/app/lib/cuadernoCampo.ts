// lib/cuadernoCampo.ts
//
// Genera el "Cuaderno de Explotación" (modelo oficial RD 1311/2012) en formato Word
// (.docx), a partir de los datos ya preparados por page.tsx. Este módulo solo se
// encarga de la maquetación del documento — toda la lógica de negocio (qué parcelas,
// qué tratamientos, cómo se reparte la superficie SIGPAC entre cultivos, etc.) vive
// en page.tsx, que llama a generarCuadernoCampoDocx() con los datos ya formateados
// como texto.
//
// Secciones con datos de la app: 1.1 (si se han rellenado los "Datos de la
// explotación"), 1.2, 1.3, 1.4 (parcial), 2.1, 3.1, 3.2.
// Secciones sin fuente de datos en la app (se generan en blanco, igual que el
// original, para rellenar a mano): 2.2, 3.1 bis, 3.3, 3.4, 3.5, 4 y 5.

export interface SeccionTabla {
  numero: string          // p.ej. "1.2"
  titulo: string           // p.ej. "PERSONAS O EMPRESAS QUE INTERVIENEN EN EL TRATAMIENTO CON PRODUCTOS FITOSANITARIOS"
  subtitulo?: string
  headers: string[]
  colWidths: number[]      // pesos relativos, no necesitan sumar 1 (se normalizan)
  rows: string[][]
  filasVaciasMin?: number  // nº mínimo de filas a mostrar (se rellena con filas en blanco)
  notas?: string[]
  saltoPaginaAntes?: boolean
}

export interface CuadernoCampoData {
  campanaNombre: string
  campanaFechaInicio?: string
  campanaFechaFin?: string
  cabecera: string                          // texto de "Explotación/Titular de la explotación: ..."
  fechaApertura?: string
  datosGenerales: { label: string; value: string }[][]  // 1.1 — filas de pares label/value
  titular: { label: string; value: string }[][]
  secciones: SeccionTabla[]                 // 1.2, 1.3, 1.4, 2.1, 2.2, 3.1, 3.1bis, 3.2, 3.3, 3.4, 3.5, 4, 5 (en este orden)
}

const AZUL_TITULO = '1F4E78'
const GRIS_CABECERA = 'D9D9D9'
const BORDE = 'A6A6A6'

export const generarCuadernoCampoDocx = async (data: CuadernoCampoData): Promise<Blob> => {
  const docx = await import('docx')
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
    BorderStyle, AlignmentType, PageOrientation, Footer, Header, ShadingType, VerticalAlign,
  } = docx

  const ANCHO_UTIL = 15838 // twips (A4 landscape 16838 - márgenes 500+500)
  const bordeFino = { style: BorderStyle.SINGLE, size: 4, color: BORDE }
  const bordesCelda = { top: bordeFino, bottom: bordeFino, left: bordeFino, right: bordeFino }

  const celdaTexto = (texto: string, opts: { bold?: boolean; size?: number; shading?: string; align?: any; color?: string } = {}) =>
    new TableCell({
      borders: bordesCelda,
      shading: opts.shading ? { type: ShadingType.CLEAR, fill: opts.shading, color: 'auto' } : undefined,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 40, bottom: 40, left: 60, right: 60 },
      children: [new Paragraph({
        alignment: opts.align || AlignmentType.LEFT,
        children: [new TextRun({ text: texto || '', bold: !!opts.bold, size: opts.size || 14, color: opts.color, font: 'Arial' })],
      })],
    })

  // Tabla genérica de datos con cabecera de columnas
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
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `${s.numero} ${s.titulo}`, bold: true, size: 18, font: 'Arial' })],
          }),
          ...(s.subtitulo ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: s.subtitulo, bold: true, italics: true, size: 15, font: 'Arial' })] })] : []),
        ],
      })],
    })

    const filaCabecera = new TableRow({
      tableHeader: true,
      children: s.headers.map(h => celdaTexto(h, { bold: true, size: 14, shading: 'F2F2F2', align: AlignmentType.CENTER })),
    })

    const filasCuerpo = filasDatos.map(fila => new TableRow({
      children: fila.map((v, i) => celdaTexto(v, { size: 14, align: i === 0 ? AlignmentType.CENTER : AlignmentType.LEFT })),
    }))

    const tabla = new Table({
      width: { size: ANCHO_UTIL, type: WidthType.DXA },
      columnWidths: anchos,
      rows: [filaTitulo, filaCabecera, ...filasCuerpo],
    })

    const bloques: any[] = [tabla, new Paragraph({ text: '', spacing: { after: 60 } })]
    if (s.notas && s.notas.length > 0) {
      s.notas.forEach(n => bloques.push(new Paragraph({
        children: [new TextRun({ text: n, size: 12, italics: true, color: '595959', font: 'Arial' })],
        spacing: { after: 20 },
      })))
    }
    bloques.push(new Paragraph({ text: '', spacing: { after: 160 } }))
    return bloques
  }

  // Tabla de pares label/value (secciones 1.1) — cada fila puede tener varios pares
  const tablaLabelValue = (titulo: string, filas: { label: string; value: string }[][], subtitulo?: string) => {
    const filasTabla: any[] = []
    filasTabla.push(new TableRow({
      children: [new TableCell({
        columnSpan: 2,
        borders: bordesCelda,
        shading: { type: ShadingType.CLEAR, fill: GRIS_CABECERA, color: 'auto' },
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: titulo, bold: true, size: 18, font: 'Arial' })] })],
      })],
    }))
    if (subtitulo) {
      filasTabla.push(new TableRow({
        children: [new TableCell({
          columnSpan: 2, borders: bordesCelda,
          shading: { type: ShadingType.CLEAR, fill: 'EDEDED', color: 'auto' },
          margins: { top: 40, bottom: 40, left: 60, right: 60 },
          children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: subtitulo, bold: true, size: 15, font: 'Arial' })] })],
        })],
      }))
    }
    filas.forEach(par => {
      par.forEach(({ label, value }) => {
        filasTabla.push(new TableRow({
          children: [
            new TableCell({ borders: bordesCelda, width: { size: Math.round(ANCHO_UTIL * 0.28), type: WidthType.DXA }, margins: { top: 50, bottom: 50, left: 60, right: 60 }, children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 14, font: 'Arial' })] })] }),
            new TableCell({ borders: bordesCelda, width: { size: Math.round(ANCHO_UTIL * 0.72), type: WidthType.DXA }, margins: { top: 50, bottom: 50, left: 60, right: 60 }, children: [new Paragraph({ children: [new TextRun({ text: value || ' ', size: 14, font: 'Arial' })] })] }),
          ],
        }))
      })
    })
    return new Table({ width: { size: ANCHO_UTIL, type: WidthType.DXA }, rows: filasTabla })
  }

  const parrafoTitulo = (texto: string) => new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 200, after: 240 },
    border: { top: { style: BorderStyle.SINGLE, size: 8, color: AZUL_TITULO }, bottom: { style: BorderStyle.SINGLE, size: 8, color: AZUL_TITULO }, left: { style: BorderStyle.SINGLE, size: 8, color: AZUL_TITULO }, right: { style: BorderStyle.SINGLE, size: 8, color: AZUL_TITULO } },
    children: [new TextRun({ text: texto, bold: true, size: 28, font: 'Arial', color: AZUL_TITULO })],
  })

  const children: any[] = []

  // Portada / cabecera general
  children.push(parrafoTitulo('CUADERNO DE EXPLOTACIÓN'))
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

  // Resto de secciones, en orden — cada una decide si lleva salto de página antes
  data.secciones.forEach(s => {
    if (s.saltoPaginaAntes) children.push(new Paragraph({ children: [], pageBreakBefore: true }))
    children.push(...tablaSeccion(s))
  })

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 16838, height: 11906, orientation: PageOrientation.LANDSCAPE },
          margin: { top: 500, bottom: 700, left: 500, right: 500 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [new TextRun({
              text: `Explotación/Titular de la explotación: ${data.cabecera || ''}      CAMPAÑA: ${data.campanaNombre}${data.campanaFechaInicio && data.campanaFechaFin ? ` (${data.campanaFechaInicio} - ${data.campanaFechaFin})` : ''}`,
              bold: true, size: 15, font: 'Arial',
            })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: 'Cuaderno de Explotación — generado automáticamente', size: 11, italics: true, color: '808080', font: 'Arial' })],
          })],
        }),
      },
      children,
    }],
  })

  return Packer.toBlob(doc)
}

export const descargarCuadernoCampo = async (data: CuadernoCampoData, nombreArchivo: string) => {
  const blob = await generarCuadernoCampoDocx(data)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombreArchivo
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
