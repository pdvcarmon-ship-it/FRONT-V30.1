// lib/fichaAbonado.ts
//
// Genera la "Ficha de abonado aplicado" en PDF, a partir de un plan de
// abonado ya guardado (subpestaña "Plan de abonado" de KAMPO). Sigue la
// plantilla en papel que ya usa el titular: cabecera con datos del
// abono/parcela/superficie, y una tabla de 13 nutrientes + materia orgánica
// comparando análisis de suelo / necesidades del cultivo / composición del
// abono / aplicado, más recomendado/aplicado por con su nº ROPO.
//
// Usa jsPDF + jspdf-autotable (nuevas dependencias — hace falta "npm install"
// tras incorporar estos cambios, ya que no estaban antes en package.json).

export interface FilaParcelaFicha { referencia: string; superficieHa?: number }

export interface FichaAbonadoData {
  nombreComercial: string
  fabricante?: string
  dosisKgHa: number
  cultivo: string
  superficieTotalHa?: number
  parcelas: FilaParcelaFicha[]           // una fila por parcela (normalmente 1)
  nutrientes: { etiqueta: string; analisis: string; necesidades: string; composicion: string; aplicado: string }[]
  materiaOrganica: { analisis: string; necesidades: string; composicion: string; aplicado: string }
  ph?: string
  ce?: string
  fecha?: string
  maquinaria: string[]                   // "Nombre (ROMA)" ya formateado, una por máquina
  recomendadoPor?: string                // "Nombre (ROPO)" ya formateado
  aplicadoPor?: string                   // "Nombre (ROPO)" ya formateado
}

const GRIS_CABECERA: [number, number, number] = [217, 217, 217]
const BORDE: [number, number, number] = [153, 153, 153]

// Formato español: coma como separador decimal (12,5 en vez de 12.5)
const fmt = (n: number, decimales: number = 1): string => n.toFixed(decimales).replace('.', ',')

const estiloBase = { font: 'helvetica', fontSize: 8, cellPadding: 4, lineColor: BORDE, lineWidth: 0.5, textColor: [20, 20, 20] as [number, number, number] }
const celdaEtiqueta = { fillColor: GRIS_CABECERA, fontStyle: 'bold' as const }

export const generarFichaAbonadoPdf = async (data: FichaAbonadoData) => {
  const { jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default

  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const margen = 40

  // Anchos de columna fijos (A4 apaisado no, vertical: 595pt - 2*40 margen = 515pt).
  // Sin esto, autoTable estrecha tanto la 1ª columna que "Nombre comercial" se
  // parte letra a letra — por eso se veía mal.
  const anchos4Col = { 0: { cellWidth: 105 }, 1: { cellWidth: 185 }, 2: { cellWidth: 115 }, 3: { cellWidth: 110 } }
  const anchosNutrientes = { 0: { cellWidth: 95 }, 1: { cellWidth: 105 }, 2: { cellWidth: 105 }, 3: { cellWidth: 105 }, 4: { cellWidth: 105 } }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text('FICHA DE ABONADO APLICADO', margen, 36)

  // --- Cabecera: nombre comercial, fabricante, dosis, cultivo, superficie total ---
  autoTable(doc, {
    startY: 48,
    margin: { left: margen, right: margen },
    theme: 'grid',
    styles: estiloBase,
    columnStyles: anchos4Col,
    body: [
      [{ content: 'Nombre comercial', colSpan: 2, styles: celdaEtiqueta }, data.nombreComercial || '—',
        { content: 'Dosis (kg/ha)', styles: celdaEtiqueta }, fmt(data.dosisKgHa)],
      [{ content: 'Fabricante del abono', colSpan: 2, styles: celdaEtiqueta }, { content: data.fabricante || '—', colSpan: 2 }],
      [{ content: 'Cultivo', colSpan: 2, styles: celdaEtiqueta }, data.cultivo || '—',
        { content: 'Superficie total (Ha)', styles: celdaEtiqueta }, data.superficieTotalHa != null ? fmt(data.superficieTotalHa, 2) : '—'],
    ],
  })

  // --- Lista de parcelas/SIGPAC + superficie de cada una ---
  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY,
    margin: { left: margen, right: margen },
    theme: 'grid',
    styles: estiloBase,
    columnStyles: anchos4Col,
    body: [
      ['', { content: 'Referencias SIGPAC', colSpan: 2, styles: { ...celdaEtiqueta, halign: 'center' as const } }, { content: 'Superficie (Ha)', styles: celdaEtiqueta }],
      ...data.parcelas.map((p, i) => [
        { content: String(i + 1), styles: { fontStyle: 'bold' as const, halign: 'right' as const } },
        { content: p.referencia || '—', colSpan: 2 },
        p.superficieHa != null ? fmt(p.superficieHa, 2) : '—',
      ]),
    ],
  })

  // --- Tabla de nutrientes ---
  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY + 10,
    margin: { left: margen, right: margen },
    theme: 'grid',
    styles: { ...estiloBase, halign: 'center' as const },
    head: [['Nutrientes', 'Análisis suelo', 'Necesidades', 'Composición abono', 'Aplicado']],
    headStyles: { fillColor: GRIS_CABECERA, textColor: [20, 20, 20], fontStyle: 'bold' },
    columnStyles: { ...anchosNutrientes, 0: { ...anchosNutrientes[0], halign: 'left', fontStyle: 'bold' } },
    body: [
      ...data.nutrientes.map(n => [n.etiqueta, n.analisis, n.necesidades, n.composicion, n.aplicado]),
      ['Materia orgánica', data.materiaOrganica.analisis, data.materiaOrganica.necesidades, data.materiaOrganica.composicion, data.materiaOrganica.aplicado],
    ],
  })

  // --- pH, CE, fecha, maquinaria, recomendado/aplicado por ---
  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY + 10,
    margin: { left: margen, right: margen },
    theme: 'grid',
    styles: estiloBase,
    columnStyles: anchos4Col,
    body: [
      [{ content: 'pH suelo', styles: celdaEtiqueta }, { content: data.ph || '—', colSpan: 3 }],
      [{ content: 'CE suelo (dS/m)', styles: celdaEtiqueta }, { content: data.ce || '—', colSpan: 3 }],
      [{ content: 'Fecha', styles: celdaEtiqueta }, { content: data.fecha || '—', colSpan: 3 }],
      [{ content: 'Maquinaria', styles: celdaEtiqueta }, { content: (data.maquinaria.length > 0 ? data.maquinaria : ['—']).join('\n'), colSpan: 3 }],
      [{ content: 'Recomendado por', styles: celdaEtiqueta }, data.recomendadoPor || '—',
        { content: 'Aplicado por', styles: celdaEtiqueta }, data.aplicadoPor || '—'],
    ],
  })

  return doc
}

export const descargarFichaAbonado = async (data: FichaAbonadoData, nombreArchivo: string) => {
  const doc = await generarFichaAbonadoPdf(data)
  doc.save(nombreArchivo)
}
