'use client'

// components/ImportarParcelasExcel.tsx
//
// Importación masiva de parcelas desde un Excel subido por el propio usuario.
//
// Formato de columnas esperado (en este orden, con cabecera en la fila 1):
//   grupo | nombre_parcela | sigpac_ref | cultivo | fecha_plantacion | finca | observaciones
//
// - `grupo`: filas con el mismo valor de `grupo` se agrupan en UNA sola parcela
//   con varios recintos SIGPAC (una fila por cada sigpac_ref). Es OPCIONAL: una
//   fila sin `grupo` se importa igualmente como parcela individual de 1 recinto.
// - Solo la PRIMERA fila de cada grupo necesita rellenar nombre_parcela, cultivo,
//   fecha_plantacion, finca y observaciones; las filas siguientes del mismo grupo
//   solo necesitan grupo + sigpac_ref.
// - sigpac_ref: formato "Provincia/Municipio/Agregado/Zona/Poligono/Parcela/Recinto"
//   (7 números separados por "/"), igual que el buscador manual del mapa.
// - fecha_plantacion: se normaliza siempre a "YYYY-MM-DD", sea cual sea el formato
//   regional con el que Excel la esté mostrando (ver lib/parcelaUtils.normalizarFechaExcel).
//
// Flujo:
//   1) Parseo del Excel (cliente, con SheetJS).
//   2) Por cada sigpac_ref, consulta a BACKEND /sigpac/referencia (con
//      concurrencia limitada) para traer la geometría real ANTES de mostrar
//      el preview (requisito explícito: no se importa nada a ciegas).
//   3) Preview en tabla (sin mapa): parcelas agrupadas + fincas nuevas detectadas
//      (con checkbox para confirmar cuáles crear) + errores.
//   4) Confirmación: crea las fincas marcadas y luego las parcelas en Supabase,
//      siempre bajo session.user.id (la "cuenta" es el usuario logueado).

import { useState, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import {
  construirEstadoDesdeFeatures,
  formatRefSigpac,
  parsearRefSigpacTexto,
  RecintoRef,
} from '../lib/sigpac'
import { getEsriPreviewUrl, normalizarFechaExcel } from '../lib/parcelaUtils'
import type { Session } from '@supabase/supabase-js'

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'

// --- Tipos mínimos (estructuralmente compatibles con los de page.tsx) ---

interface FincaMinima {
  id: string
  nombre: string
  descripcion: string
  fechaRegistro: string
}

interface CampanaMinima {
  id: string
  nombre: string
  fechaInicio: string
  fechaFin: string
}

interface ParcelaGuardadaMinima {
  id: string
  nombre: string
  cultivo: string
  fechaPlantacion: string
  infoAdicional: string
  geojson: any
  parcelaInfo: any
  supHa: number
  imagenPreview: string | null
  fechaGuardado: string
  fincaId?: string
  campanaId?: string
}

interface FilaExcel {
  grupo: string
  nombre_parcela: string
  sigpac_ref: string
  cultivo: string
  fecha_plantacion: string
  finca: string
  campana: string
  observaciones: string
  _fila: number // nº de fila en el Excel (para mensajes de error)
}

interface ParcelaPreview {
  grupo: string
  esIndividual: boolean
  nombre: string
  cultivo: string
  fechaPlantacion: string
  fincaNombre: string
  campanaNombre: string
  observaciones: string
  refs: RecintoRef[]
  refsTexto: string[]
  supTotalHa: number
  features: any[] // features SIGPAC crudos ya resueltos, listos para fusionar en la confirmación
}

interface ErrorPreview {
  grupo: string
  fila: number
  motivo: string
}

interface Props {
  session: Session
  fincas: FincaMinima[]
  setFincas: React.Dispatch<React.SetStateAction<FincaMinima[]>>
  campanas: CampanaMinima[]
  setCampanas: React.Dispatch<React.SetStateAction<CampanaMinima[]>>
  setMisParcelas: React.Dispatch<React.SetStateAction<ParcelaGuardadaMinima[]>>
  onClose: () => void
}

type Fase = 'subida' | 'procesando' | 'preview' | 'fechas_campanas' | 'importando' | 'hecho'

const COLUMNAS_ESPERADAS = ['grupo', 'nombre_parcela', 'sigpac_ref', 'cultivo', 'fecha_plantacion', 'finca', 'campana', 'observaciones']

// Ejecuta `tareas` con un límite de concurrencia, para no saturar el servicio SIGPAC.
async function ejecutarConConcurrencia<T>(items: T[], limite: number, fn: (item: T, idx: number) => Promise<void>) {
  let siguiente = 0
  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (siguiente < items.length) {
      const idx = siguiente++
      await fn(items[idx], idx)
    }
  })
  await Promise.all(trabajadores)
}

const normalizar = (s: string) => s.trim().toLowerCase()

export default function ImportarParcelasExcel({ session, fincas, setFincas, campanas, setCampanas, setMisParcelas, onClose }: Props) {
  const [fase, setFase] = useState<Fase>('subida')
  const [progreso, setProgreso] = useState({ hecho: 0, total: 0 })
  const [parcelasOk, setParcelasOk] = useState<ParcelaPreview[]>([])
  const [errores, setErrores] = useState<ErrorPreview[]>([])
  const [fincasNuevas, setFincasNuevas] = useState<string[]>([])
  const [fincasNuevasSeleccionadas, setFincasNuevasSeleccionadas] = useState<Set<string>>(new Set())
  const [campanasNuevas, setCampanasNuevas] = useState<{ nombre: string; fechaInicio: string; fechaFin: string }[]>([])
  const [errorGeneral, setErrorGeneral] = useState('')
  const [resumenFinal, setResumenFinal] = useState({ parcelas: 0, fincas: 0, campanas: 0 })

  const descargarPlantilla = useCallback(async () => {
    const XLSX = await import('xlsx')
    const filaEjemplo1 = {
      grupo: '1', nombre_parcela: 'El Olivar', sigpac_ref: '41/7/0/0/6/7/3',
      cultivo: 'Olivo', fecha_plantacion: '2015-03-01', finca: 'Finca Norte',
      campana: '', observaciones: 'Riego por goteo',
    }
    const filaEjemplo2 = {
      grupo: '1', nombre_parcela: '', sigpac_ref: '41/7/0/0/6/8/1',
      cultivo: '', fecha_plantacion: '', finca: '', campana: '', observaciones: '',
    }
    const filaEjemplo3 = {
      grupo: '2', nombre_parcela: 'La Vega', sigpac_ref: '41/7/0/0/9/2/1',
      cultivo: 'Trigo', fecha_plantacion: '2024-11-15', finca: 'Finca Norte',
      campana: 'Cereal 2024/2025', observaciones: '',
    }
    const ws = XLSX.utils.json_to_sheet([filaEjemplo1, filaEjemplo2, filaEjemplo3], { header: COLUMNAS_ESPERADAS })
    ws['!cols'] = [{ wch: 8 }, { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 30 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Parcelas')
    XLSX.writeFile(wb, 'kampo_plantilla_parcelas.xlsx')
  }, [])

  const procesarArchivo = useCallback(async (file: File) => {
    setErrorGeneral('')
    setFase('procesando')
    setParcelasOk([])
    setErrores([])
    setFincasNuevas([])
    setFincasNuevasSeleccionadas(new Set())

    try {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      // cellDates:true -> las celdas de fecha llegan como objeto Date real (no como
      // texto formateado según la configuración regional de quien rellenó el Excel).
      const wb = XLSX.read(buf, { type: 'array', cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      // raw:true -> conserva esos objetos Date (y números) tal cual, en vez de
      // convertirlos a texto formateado (que es justo lo que causaba el bug de fechas).
      const filasRaw: any[] = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true })

      if (filasRaw.length === 0) {
        setErrorGeneral('El Excel no tiene filas de datos.')
        setFase('subida')
        return
      }

      // Normaliza cabeceras (tolera mayúsculas / espacios) y valida que existan las columnas mínimas
      const primeraFila = filasRaw[0]
      const cabecerasEncontradas = Object.keys(primeraFila).map(k => normalizar(k))
      const faltan = ['grupo', 'sigpac_ref'].filter(c => !cabecerasEncontradas.includes(c))
      if (faltan.length > 0) {
        setErrorGeneral(`Faltan columnas obligatorias en el Excel: ${faltan.join(', ')}. Descarga la plantilla si no estás seguro del formato.`)
        setFase('subida')
        return
      }

      const getColRaw = (row: any, col: string): any => {
        const key = Object.keys(row).find(k => normalizar(k) === col)
        return key ? row[key] : ''
      }
      const getCol = (row: any, col: string): string => {
        const v = getColRaw(row, col)
        return v === null || v === undefined ? '' : String(v).trim()
      }

      const filas: (FilaExcel & { esIndividual: boolean })[] = filasRaw.map((row, i) => {
        const grupoOriginal = getCol(row, 'grupo')
        return {
          // Fila sin `grupo`: se le asigna uno sintético único (parcela individual, 1 recinto).
          grupo: grupoOriginal || `__individual_${i + 2}`,
          esIndividual: !grupoOriginal,
          nombre_parcela: getCol(row, 'nombre_parcela'),
          sigpac_ref: getCol(row, 'sigpac_ref'),
          cultivo: getCol(row, 'cultivo'),
          fecha_plantacion: normalizarFechaExcel(getColRaw(row, 'fecha_plantacion')),
          finca: getCol(row, 'finca'),
          campana: getCol(row, 'campana'),
          observaciones: getCol(row, 'observaciones'),
          _fila: i + 2, // +2: fila 1 es cabecera, i es 0-indexed
        }
      }).filter(f =>
        // Descarta solo filas realmente en blanco (típico de filas sobrantes al final del Excel).
        // Cualquier dato presente (aunque falte sigpac_ref) se conserva para poder avisar del error.
        f.sigpac_ref !== '' || f.nombre_parcela !== '' || f.cultivo !== '' ||
        f.fecha_plantacion !== '' || f.finca !== '' || f.campana !== '' || f.observaciones !== '' || !f.esIndividual
      )

      // Agrupa por `grupo` (real o sintético)
      const grupos = new Map<string, FilaExcel[]>()
      const gruposIndividuales = new Set<string>()
      filas.forEach(f => {
        if (!grupos.has(f.grupo)) grupos.set(f.grupo, [])
        grupos.get(f.grupo)!.push(f)
        if (f.esIndividual) gruposIndividuales.add(f.grupo)
      })

      const erroresLocal: ErrorPreview[] = []

      // Prepara la lista plana de refs a resolver (una por fila con sigpac_ref válido)
      type RefAPedir = { grupo: string; fila: number; ref: ReturnType<typeof parsearRefSigpacTexto>; textoOriginal: string }
      const refsAPedir: RefAPedir[] = []
      grupos.forEach((filasGrupo, grupo) => {
        filasGrupo.forEach(f => {
          if (!f.sigpac_ref) {
            erroresLocal.push({ grupo, fila: f._fila, motivo: 'Fila sin sigpac_ref.' })
            return
          }
          const parsed = parsearRefSigpacTexto(f.sigpac_ref)
          if (!parsed) {
            erroresLocal.push({ grupo, fila: f._fila, motivo: `Referencia SIGPAC con formato inválido: "${f.sigpac_ref}" (debe ser 7 números separados por "/").` })
            return
          }
          refsAPedir.push({ grupo, fila: f._fila, ref: parsed, textoOriginal: f.sigpac_ref })
        })
      })

      setProgreso({ hecho: 0, total: refsAPedir.length })

      // Resultado de cada consulta SIGPAC: features (si ok) o motivo de error
      const resultados = new Map<number, { ok: true; features: any[] } | { ok: false; motivo: string }>()
      let hechos = 0

      await ejecutarConConcurrencia(refsAPedir, 5, async (item, idx) => {
        const { pr, mu, ag, zo, po, pa, re } = item.ref!
        try {
          const r = await fetch(`${BACKEND}/sigpac/referencia?pr=${pr}&mu=${mu}&ag=${ag}&zo=${zo}&po=${po}&pa=${pa}&re=${re}`)
          if (!r.ok) {
            const d = await r.json().catch(() => ({}))
            resultados.set(idx, { ok: false, motivo: d.detail || `Error ${r.status} consultando SIGPAC` })
          } else {
            const data = await r.json()
            const features = data.features || []
            if (!features.length) {
              resultados.set(idx, { ok: false, motivo: 'SIGPAC no devolvió datos para esa referencia.' })
            } else {
              resultados.set(idx, { ok: true, features })
            }
          }
        } catch (e: any) {
          resultados.set(idx, { ok: false, motivo: `Error de red consultando SIGPAC: ${e.message}` })
        } finally {
          hechos++
          setProgreso({ hecho: hechos, total: refsAPedir.length })
        }
      })

      // Agrupa resultados por grupo; si CUALQUIER ref de un grupo falla, todo el grupo va a errores
      const featuresPorGrupo = new Map<string, any[]>()
      const grupoConError = new Set<string>()

      refsAPedir.forEach((item, idx) => {
        const res = resultados.get(idx)!
        if (!res.ok) {
          erroresLocal.push({ grupo: item.grupo, fila: item.fila, motivo: res.motivo })
          grupoConError.add(item.grupo)
        } else {
          if (!featuresPorGrupo.has(item.grupo)) featuresPorGrupo.set(item.grupo, [])
          featuresPorGrupo.get(item.grupo)!.push(...res.features)
        }
      })

      const parcelasOkLocal: ParcelaPreview[] = []
      const fincasNuevasSet = new Set<string>()
      const campanasNuevasSet = new Set<string>()

      grupos.forEach((filasGrupo, grupo) => {
        if (grupoConError.has(grupo)) return
        const features = featuresPorGrupo.get(grupo) || []
        if (!features.length) return

        // Fila "maestra": la primera del grupo que traiga nombre_parcela o cultivo
        const maestra = filasGrupo.find(f => f.nombre_parcela || f.cultivo || f.finca || f.campana || f.observaciones) || filasGrupo[0]

        const { info, supTotal } = construirEstadoDesdeFeatures(features)

        if (maestra.finca) fincasNuevasSet.add(maestra.finca)
        if (maestra.campana) campanasNuevasSet.add(maestra.campana)

        parcelasOkLocal.push({
          grupo,
          esIndividual: gruposIndividuales.has(grupo),
          nombre: maestra.nombre_parcela,
          cultivo: maestra.cultivo,
          fechaPlantacion: maestra.fecha_plantacion,
          fincaNombre: maestra.finca,
          campanaNombre: maestra.campana,
          observaciones: maestra.observaciones,
          refs: info.recintos,
          refsTexto: info.recintos.map((r: RecintoRef) => formatRefSigpac(r)),
          supTotalHa: supTotal,
          features,
        })
      })

      // De las fincas mencionadas, solo son "nuevas" las que no existen ya en la cuenta
      const nombresFincasExistentes = new Set(fincas.map(f => normalizar(f.nombre)))
      const fincasNuevasLocal = Array.from(fincasNuevasSet).filter(n => !nombresFincasExistentes.has(normalizar(n)))

      // Igual con campañas: solo son "nuevas" las que no existen ya
      const nombresCampanasExistentes = new Set(campanas.map(c => normalizar(c.nombre)))
      const campanasNuevasLocal = Array.from(campanasNuevasSet).filter(n => !nombresCampanasExistentes.has(normalizar(n)))

      setParcelasOk(parcelasOkLocal)
      setErrores(erroresLocal)
      setFincasNuevas(fincasNuevasLocal)
      setFincasNuevasSeleccionadas(new Set(fincasNuevasLocal)) // todas marcadas por defecto
      setCampanasNuevas(campanasNuevasLocal.map(nombre => ({ nombre, fechaInicio: '', fechaFin: '' })))
      setFase('preview')
    } catch (e: any) {
      setErrorGeneral(`Error leyendo el Excel: ${e.message}`)
      setFase('subida')
    }
  }, [fincas, campanas])

  const onSeleccionarArchivo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) procesarArchivo(file)
    e.target.value = ''
  }

  const toggleFincaNueva = (nombre: string) => {
    setFincasNuevasSeleccionadas(prev => {
      const next = new Set(prev)
      if (next.has(nombre)) next.delete(nombre)
      else next.add(nombre)
      return next
    })
  }

  const actualizarFechaCampanaNueva = (nombre: string, campo: 'fechaInicio' | 'fechaFin', valor: string) => {
    setCampanasNuevas(prev => prev.map(c => c.nombre === nombre ? { ...c, [campo]: valor } : c))
  }

  const irAConfirmarImportacion = () => {
    if (campanasNuevas.length > 0) {
      setErrorGeneral('')
      setFase('fechas_campanas')
    } else {
      confirmarImportacion()
    }
  }

  const confirmarFechasCampanas = () => {
    const faltan = campanasNuevas.filter(c => !c.fechaInicio || !c.fechaFin)
    if (faltan.length > 0) {
      setErrorGeneral(`Falta indicar fecha de inicio/fin para: ${faltan.map(c => c.nombre).join(', ')}`)
      return
    }
    const invertidas = campanasNuevas.filter(c => c.fechaFin < c.fechaInicio)
    if (invertidas.length > 0) {
      setErrorGeneral(`La fecha fin es anterior a la de inicio en: ${invertidas.map(c => c.nombre).join(', ')}`)
      return
    }
    setErrorGeneral('')
    confirmarImportacion()
  }

  const confirmarImportacion = async () => {
    if (parcelasOk.length === 0) return
    setFase('importando')
    setErrorGeneral('')

    try {
      // 1) Crear las fincas nuevas marcadas
      const mapaFincas = new Map<string, string>() // nombre normalizado -> id
      fincas.forEach(f => mapaFincas.set(normalizar(f.nombre), f.id))

      const fincasACrear = fincasNuevas.filter(n => fincasNuevasSeleccionadas.has(n))
      const fincasCreadas: FincaMinima[] = []

      for (let i = 0; i < fincasACrear.length; i++) {
        const nombre = fincasACrear[i]
        const id = String(Date.now() + i)
        const nueva: FincaMinima = { id, nombre, descripcion: '', fechaRegistro: new Date().toLocaleDateString('es-ES') }
        const { error } = await supabase.from('fincas').upsert({
          id: nueva.id, user_id: session.user.id, nombre: nueva.nombre,
          descripcion: nueva.descripcion, fecha_registro: nueva.fechaRegistro,
        })
        if (error) throw new Error(`Creando finca "${nombre}": ${error.message}`)
        mapaFincas.set(normalizar(nombre), id)
        fincasCreadas.push(nueva)
      }

      // 1.5) Crear las campañas nuevas (todas las detectadas, con las fechas ya rellenadas)
      const mapaCampanas = new Map<string, string>() // nombre normalizado -> id
      campanas.forEach(c => mapaCampanas.set(normalizar(c.nombre), c.id))

      const campanasCreadas: CampanaMinima[] = []
      for (let i = 0; i < campanasNuevas.length; i++) {
        const c = campanasNuevas[i]
        const id = String(Date.now() + i + 500000)
        const nueva: CampanaMinima = { id, nombre: c.nombre, fechaInicio: c.fechaInicio, fechaFin: c.fechaFin }
        const { error } = await supabase.from('campanas').upsert({
          id: nueva.id, user_id: session.user.id, nombre: nueva.nombre,
          fecha_inicio: nueva.fechaInicio, fecha_fin: nueva.fechaFin,
        })
        if (error) throw new Error(`Creando campaña "${c.nombre}": ${error.message}`)
        mapaCampanas.set(normalizar(c.nombre), id)
        campanasCreadas.push(nueva)
      }

      // 2) Crear las parcelas
      const parcelasCreadas: ParcelaGuardadaMinima[] = []
      for (let i = 0; i < parcelasOk.length; i++) {
        const p = parcelasOk[i]
        const { info, fusionado, supTotal } = construirEstadoDesdeFeatures(p.features)
        const fincaId = p.fincaNombre ? mapaFincas.get(normalizar(p.fincaNombre)) : undefined
        const campanaId = p.campanaNombre ? mapaCampanas.get(normalizar(p.campanaNombre)) : undefined

        const nueva: ParcelaGuardadaMinima = {
          id: String(Date.now() + i + 100000), // offset para no chocar con los ids de fincas creadas arriba
          nombre: p.nombre,
          cultivo: p.cultivo,
          fechaPlantacion: p.fechaPlantacion,
          infoAdicional: p.observaciones,
          geojson: fusionado,
          parcelaInfo: info,
          supHa: supTotal,
          // Misma foto satélite (Esri, recortada al bbox) que usan las parcelas creadas a mano.
          imagenPreview: getEsriPreviewUrl(fusionado),
          fechaGuardado: new Date().toLocaleDateString('es-ES'),
          fincaId,
          campanaId,
        }

        const { error } = await supabase.from('parcelas').upsert({
          id: nueva.id, user_id: session.user.id, nombre: nueva.nombre, cultivo: nueva.cultivo,
          fecha_plantacion: nueva.fechaPlantacion, info_adicional: nueva.infoAdicional,
          geojson: nueva.geojson, parcela_info: nueva.parcelaInfo, sup_ha: nueva.supHa,
          imagen_preview: nueva.imagenPreview, fecha_guardado: nueva.fechaGuardado,
          finca_id: nueva.fincaId || null,
          campana_id: nueva.campanaId || null,
        })
        if (error) throw new Error(`Creando parcela "${p.nombre || p.grupo}": ${error.message}`)
        parcelasCreadas.push(nueva)
      }

      // 3) Actualizar estado del padre (mismo patrón optimista que guardarFinca/guardarParcela)
      if (fincasCreadas.length > 0) setFincas(prev => [...prev, ...fincasCreadas])
      if (campanasCreadas.length > 0) setCampanas(prev => [...prev, ...campanasCreadas])
      setMisParcelas(prev => [...parcelasCreadas, ...prev])

      setResumenFinal({ parcelas: parcelasCreadas.length, fincas: fincasCreadas.length, campanas: campanasCreadas.length })
      setFase('hecho')
    } catch (e: any) {
      setErrorGeneral(e.message || 'Error importando los datos.')
      setFase(campanasNuevas.length > 0 ? 'fechas_campanas' : 'preview')
    }
  }

  // --- Estilos reutilizados del resto de la app ---
  const label: React.CSSProperties = { display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }
  const botonPrimario: React.CSSProperties = { padding: '10px 16px', borderRadius: 8, background: 'var(--green)', border: '1px solid var(--green)', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }
  const botonSecundario: React.CSSProperties = { padding: '10px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 780, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>

        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)', letterSpacing: '0.06em' }}>
            📥 IMPORTAR PARCELAS DESDE EXCEL
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>

          {errorGeneral && (
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(255,59,48,0.1)', border: '1px solid rgba(255,59,48,0.35)', color: '#ff6b6b', fontFamily: 'var(--mono)', fontSize: 12, marginBottom: 16 }}>
              {errorGeneral}
            </div>
          )}

          {fase === 'subida' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
                Sube un Excel con las columnas <code>grupo, nombre_parcela, sigpac_ref, cultivo, fecha_plantacion, finca, campana, observaciones</code>.
                Las filas con el mismo <code>grupo</code> se juntan en una sola parcela con varios recintos SIGPAC.
                Si dejas <code>grupo</code> vacío, esa fila se importa como parcela individual (1 recinto).
                La columna <code>campana</code> es opcional; si el nombre no existe todavía, te pediré sus fechas antes de confirmar la importación.
              </div>

              <button onClick={descargarPlantilla} style={botonSecundario}>⬇ Descargar plantilla Excel</button>

              <label style={{ ...label, marginTop: 8 }}>Archivo Excel (.xlsx)</label>
              <input type="file" accept=".xlsx,.xls" onChange={onSeleccionarArchivo}
                style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)' }} />
            </div>
          )}

          {fase === 'procesando' && (
            <div style={{ textAlign: 'center', padding: 40, fontFamily: 'var(--mono)', color: 'var(--muted)', fontSize: 13 }}>
              🔎 Consultando SIGPAC... {progreso.total > 0 ? `${progreso.hecho}/${progreso.total}` : ''}
            </div>
          )}

          {(fase === 'preview' || fase === 'importando') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Parcelas listas para importar ({parcelasOk.length})
              </div>

              {parcelasOk.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Ninguna parcela válida para importar.</div>
              )}

              {parcelasOk.map((p, i) => (
                <div key={i} style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--green-dim)', border: '1px solid rgba(61,220,110,0.2)', fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
                    <span>{p.nombre || (p.esIndividual ? '(parcela individual)' : `(grupo ${p.grupo})`)} — {p.cultivo || 'sin cultivo'}</span>
                    <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{p.supTotalHa.toFixed(4)} ha</span>
                  </div>
                  <div style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                    {p.refs.length} recinto{p.refs.length > 1 ? 's' : ''} SIGPAC: {p.refsTexto.join(', ')}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>
                    Finca: {p.fincaNombre || 'sin asignar'} {p.fechaPlantacion && `· Plantación: ${p.fechaPlantacion}`}
                  </div>
                  {p.campanaNombre && <div style={{ color: 'var(--amber)', fontSize: 11, marginTop: 2 }}>Campaña: {p.campanaNombre}</div>}
                  {p.observaciones && <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>{p.observaciones}</div>}
                </div>
              ))}

              {fincasNuevas.length > 0 && (
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                    Fincas nuevas detectadas ({fincasNuevas.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {fincasNuevas.map(n => (
                      <label key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
                        <input type="checkbox" checked={fincasNuevasSeleccionadas.has(n)} onChange={() => toggleFincaNueva(n)} />
                        {n} <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10 }}>(se creará)</span>
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                    Las que desmarques se importarán sin finca asignada.
                  </div>
                </div>
              )}

              {campanasNuevas.length > 0 && (
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                    Campañas nuevas detectadas ({campanasNuevas.length})
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {campanasNuevas.map(c => (
                      <span key={c.nombre} style={{ padding: '4px 10px', borderRadius: 20, background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: 11, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
                        {c.nombre}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                    Al confirmar te pediré la fecha de inicio y fin de cada una.
                  </div>
                </div>
              )}

              {errores.length > 0 && (
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#ff6b6b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                    Filas con error ({errores.length}) — no se importarán
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {errores.map((e, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#fca5a5', fontFamily: 'var(--mono)' }}>
                        Fila {e.fila} ({e.grupo.startsWith('__individual_') ? 'parcela individual' : `grupo ${e.grupo}`}): {e.motivo}
                      </div>
                    ))}
                </div>
              </div>
              )}
            </div>
          )}

          {fase === 'fechas_campanas' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
                Indica la fecha de inicio y fin de cada campaña nueva antes de confirmar la importación.
              </div>
              {campanasNuevas.map(c => (
                <div key={c.nombre} style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>{c.nombre}</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <label style={label}>Fecha inicio</label>
                      <input type="date" value={c.fechaInicio} onChange={e => actualizarFechaCampanaNueva(c.nombre, 'fechaInicio', e.target.value)}
                        style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={label}>Fecha fin</label>
                      <input type="date" value={c.fechaFin} onChange={e => actualizarFechaCampanaNueva(c.nombre, 'fechaFin', e.target.value)}
                        style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {fase === 'hecho' && (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✅</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--green)', fontWeight: 700 }}>
                Importación completada
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                {resumenFinal.parcelas} parcela{resumenFinal.parcelas !== 1 ? 's' : ''} creada{resumenFinal.parcelas !== 1 ? 's' : ''}
                {resumenFinal.fincas > 0 && ` · ${resumenFinal.fincas} finca${resumenFinal.fincas !== 1 ? 's' : ''} nueva${resumenFinal.fincas !== 1 ? 's' : ''}`}
                {resumenFinal.campanas > 0 && ` · ${resumenFinal.campanas} campaña${resumenFinal.campanas !== 1 ? 's' : ''} nueva${resumenFinal.campanas !== 1 ? 's' : ''}`}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          {fase === 'preview' && (
            <>
              <button onClick={() => setFase('subida')} style={botonSecundario}>← Subir otro archivo</button>
              <button onClick={irAConfirmarImportacion} disabled={parcelasOk.length === 0} style={{ ...botonPrimario, opacity: parcelasOk.length === 0 ? 0.5 : 1 }}>
                {campanasNuevas.length > 0 ? 'Continuar' : `Confirmar importación (${parcelasOk.length})`}
              </button>
            </>
          )}
          {fase === 'fechas_campanas' && (
            <>
              <button onClick={() => setFase('preview')} style={botonSecundario}>← Atrás</button>
              <button onClick={confirmarFechasCampanas} style={botonPrimario}>
                Confirmar importación ({parcelasOk.length})
              </button>
            </>
          )}
          {fase === 'importando' && (
            <button disabled style={{ ...botonPrimario, opacity: 0.6 }}>Importando...</button>
          )}
          {(fase === 'subida' || fase === 'hecho') && (
            <button onClick={onClose} style={botonPrimario}>{fase === 'hecho' ? 'Cerrar' : 'Cancelar'}</button>
          )}
        </div>
      </div>
    </div>
  )
}
