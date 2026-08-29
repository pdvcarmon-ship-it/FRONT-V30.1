'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState, useRef } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'

const MapView = dynamic(() => import('./MapView'), { ssr: false })

// - Tipos mínimos compartidos con page.tsx (duplicados a propósito para no acoplar) -
interface FincaLite { id: string; nombre: string }
interface ParcelaLite { id: string; nombre: string; cultivo: string; supHa: number; geojson: any; fincaId?: string }

type ModoSuperficie = 'completa' | 'dibujado'

interface SistemaRiego {
  id: string
  nombre: string
  fincaId?: string
  origenAgua: string
  origenEnergia: string
  bomba: string
  filtros: string
  observaciones: string
  parcelaIds: string[]
  fechaRegistro: string
}

interface SectorRiego {
  id: string
  sistemaId: string
  nombre: string
  parcelaIds: string[]
  geojson?: any
  modoSuperficie: ModoSuperficie
  supHa: number
  tipoEmisor: string
  caudalGoteroLh: string
  numLineasGoteo: string // líneas de goteo por árbol
  distanciaGoterosM: string // separación entre goteros, en la misma línea
  distanciaLineasM: string // separación entre líneas (calles)
  eficienciaPct: string
  kc: string
  observaciones: string
  fechaRegistro: string
}

interface RiegoEvento {
  id: string
  sectorId: string
  fecha: string
  horas: string
  m3Calculado: number
  observaciones: string
  fechaRegistro: string
}

const EFICIENCIA_DEFECTO: Record<string, number> = {
  'Goteo': 90, 'Microaspersión': 85, 'Aspersión': 75, 'Superficie / manta': 60,
}
const TIPOS_EMISOR = ['Goteo', 'Microaspersión', 'Aspersión', 'Superficie / manta']

const nombreParcela = (p: ParcelaLite): string => p.nombre ? `${p.nombre} (${p.cultivo})` : p.cultivo

const COLORES_PIEZAS = ['#3ddc6e', '#4db8ff', '#ffb454', '#c084fc', '#ff6b6b', '#5eead4', '#facc15']

// Carga Turf.js por CDN, igual que MapView carga leaflet-draw, sin tocar package.json
let turfPromise: Promise<any> | null = null
const cargarTurf = (): Promise<any> => {
  if ((window as any).turf) return Promise.resolve((window as any).turf)
  if (turfPromise) return turfPromise
  turfPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/6.5.0/turf.min.js'
    script.onload = () => resolve((window as any).turf)
    script.onerror = reject
    document.head.appendChild(script)
  })
  return turfPromise
}

// Goteros por m²: (líneas por árbol) / (distancia entre líneas x distancia entre goteros)
const calcularGoterosPorHa = (s: SectorRiego): number => {
  const lineas = Number(s.numLineasGoteo) || 0
  const distGoteros = Number(s.distanciaGoterosM) || 0
  const distLineas = Number(s.distanciaLineasM) || 0
  if (!lineas || !distGoteros || !distLineas) return 0
  const goterosPorM2 = lineas / (distLineas * distGoteros)
  return goterosPorM2 * 10000
}

const calcularNumGoterosTotal = (s: SectorRiego): number => {
  const goterosPorHa = calcularGoterosPorHa(s)
  if (!goterosPorHa || !s.supHa) return 0
  return Math.round(goterosPorHa * s.supHa)
}

// m³ de un riego = caudal por gotero (L/h) x nº total de goteros x horas, pasado a m³
const calcularM3 = (s: SectorRiego, horas: number): number => {
  const caudal = Number(s.caudalGoteroLh) || 0
  const numGoteros = calcularNumGoterosTotal(s)
  if (!caudal || !numGoteros || !horas) return 0
  return (caudal * numGoteros * horas) / 1000
}

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'

interface KcPeriodo { id: string; desde: string; hasta: string; kc: string }

interface FilaCalculo {
  fecha: string; eto: number | null; kc: number; kr: number
  etc: number | null; precipitacion: number | null
  necesidadNeta: number | null; necesidadBruta: number | null; necesidadM3Ha: number | null
}

interface PrediccionRiego {
  fechaInicio: string; fechaFin: string; numDias: number
  eficienciaUsada: number; krUsado: number; estacion: string
  etoAcumulada: number; precipitacionAcumulada: number
  necesidadBrutaAcumulada: number; necesidadM3Ha: number
  supHa: number; necesidadTotalM3: number
  caudalM3hHa: number | null; horasTotal: number | null; horasMediaDia: number | null
  diasSinDato: number
  tabla: FilaCalculo[]
}

// Suma n días a una fecha "YYYY-MM-DD" trabajando siempre en UTC, para no
// depender de la zona horaria del navegador (evita el típico desfase de 1 día).
const sumarDiasISO = (fecha: string, n: number): string => {
  const [y, m, d] = fecha.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

const diasEntre = (desde: string, hasta: string): string[] => {
  const dias: string[] = []
  let f = desde
  let guarda = 0
  while (f <= hasta && guarda < 10000) {
    dias.push(f)
    f = sumarDiasISO(f, 1)
    guarda++
  }
  return dias
}

const kcParaFecha = (fecha: string, periodos: KcPeriodo[]): number | null => {
  const p = periodos.find(p => p.desde && p.hasta && fecha >= p.desde && fecha <= p.hasta && p.kc)
  return p ? Number(p.kc.replace(',', '.')) : null
}

const formatHoras = (horasDecimal: number | null): string => {
  if (horasDecimal === null || isNaN(horasDecimal)) return '—'
  const totalMin = Math.round(horasDecimal * 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h} h ${m.toString().padStart(2, '0')} min`
}

// Centroide aproximado de un GeoJSON (media de coordenadas del/los polígono/s)
const centroideDeGeojson = (gj: any): [number, number] | null => {
  try {
    const feats = gj?.features || []
    const coords: number[][] = []
    feats.forEach((f: any) => {
      const geom = f.geometry
      if (!geom) return
      if (geom.type === 'Polygon') coords.push(...geom.coordinates[0])
      else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => coords.push(...p[0]))
    })
    if (!coords.length) return null
    const lat = coords.reduce((a, c) => a + c[1], 0) / coords.length
    const lon = coords.reduce((a, c) => a + c[0], 0) / coords.length
    return [lat, lon]
  } catch { return null }
}

interface Props {
  session: Session | null
  fincas: FincaLite[]
  misParcelas: ParcelaLite[]
  isMobile: boolean
  sectorInicial?: string | null
  onConsumirSectorInicial?: () => void
  misPermisos: Record<string, boolean>
}

export default function RiegoTab({ session, fincas, misParcelas, isMobile, sectorInicial, onConsumirSectorInicial, misPermisos }: Props) {
  const [cargado, setCargado] = useState(false)
  const riegoFormRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [sistemas, setSistemas] = useState<SistemaRiego[]>([])
  const [sectores, setSectores] = useState<SectorRiego[]>([])
  const [eventos, setEventos] = useState<RiegoEvento[]>([])

  const [sistemaAbiertoId, setSistemaAbiertoId] = useState<string | null>(null)
  const [sistemaVerSectoresId, setSistemaVerSectoresId] = useState<string | null>(null)

  // - Calculadora de necesidades de riego -
  const [calculandoRiegoSectorId, setCalculandoRiegoSectorId] = useState<string | null>(null)
  const [predFechaInicio, setPredFechaInicio] = useState('')
  const [predFechaFin, setPredFechaFin] = useState('')
  const [predKcSimple, setPredKcSimple] = useState('')
  const [predKcPeriodos, setPredKcPeriodos] = useState<KcPeriodo[]>([])
  const [predKr, setPredKr] = useState('1')
  const [predCargando, setPredCargando] = useState(false)
  const [predError, setPredError] = useState('')
  const [predResultado, setPredResultado] = useState<PrediccionRiego | null>(null)
  const [filtroFincaId, setFiltroFincaId] = useState('')

  // - Formulario sistema -
  const [formSistema, setFormSistema] = useState(false)
  const [sistemaEditar, setSistemaEditar] = useState<SistemaRiego | null>(null)
  const [sNombre, setSNombre] = useState('')
  const [sFincaId, setSFincaId] = useState('')
  const [sOrigenAgua, setSOrigenAgua] = useState('')
  const [sOrigenEnergia, setSOrigenEnergia] = useState('')
  const [sBomba, setSBomba] = useState('')
  const [sFiltros, setSFiltros] = useState('')
  const [sObs, setSObs] = useState('')
  const [sParcelaIds, setSParcelaIds] = useState<string[]>([])
  const [sError, setSError] = useState('')

  // - Formulario sector -
  const [formSector, setFormSector] = useState<string | null>(null) // guarda sistemaId cuando está abierto
  const [sectorEditar, setSectorEditar] = useState<SectorRiego | null>(null)
  const [secNombre, setSecNombre] = useState('')
  const [secModo, setSecModo] = useState<ModoSuperficie>('completa')
  const [secParcelaIds, setSecParcelaIds] = useState<string[]>([])
  const [secGeojsonDibujado, setSecGeojsonDibujado] = useState<any>(null)
  const [secSupHaDibujada, setSecSupHaDibujada] = useState(0)
  const [cortando, setCortando] = useState(false) // mapa de recorte abierto
  const [modoCorte, setModoCorte] = useState(false) // dibujando la polilínea de corte
  const [restanteGeojson, setRestanteGeojson] = useState<any>(null) // parte de la/s parcela/s aún sin asignar a ningún sector
  const [restanteSupHa, setRestanteSupHa] = useState(0)
  const [calculandoRestante, setCalculandoRestante] = useState(false)
  const [piezasCorte, setPiezasCorte] = useState<{ id: number; geojson: any; supHa: number }[]>([])
  const [piezasSeleccionadasIds, setPiezasSeleccionadasIds] = useState<number[]>([])
  const [errorCorte, setErrorCorte] = useState('')
  const [secTipoEmisor, setSecTipoEmisor] = useState('Goteo')
  const [secCaudal, setSecCaudal] = useState('')
  const [secNumLineas, setSecNumLineas] = useState('')
  const [secDistGoteros, setSecDistGoteros] = useState('')
  const [secDistLineas, setSecDistLineas] = useState('')
  const [secEficiencia, setSecEficiencia] = useState('')
  const [secKc, setSecKc] = useState('')
  const [secObs, setSecObs] = useState('')
  const [secError, setSecError] = useState('')

  // - Registro de riego -
  const [formRiego, setFormRiego] = useState<string | null>(null) // guarda sectorId cuando está abierto
  const [rFecha, setRFecha] = useState('')
  const [rHoras, setRHoras] = useState('')
  const [rObs, setRObs] = useState('')

  // - Carga inicial -
  useEffect(() => {
    if (!session || cargado) return
    const cargar = async () => {
      try {
        const [sisRes, secRes, evRes] = await Promise.all([
          supabase.from('sistemas_riego').select('*').order('created_at', { ascending: false }),
          supabase.from('sectores_riego').select('*').order('created_at', { ascending: false }),
          supabase.from('riegos_eventos').select('*').order('fecha', { ascending: false }),
        ])
        if (sisRes.data) {
          setSistemas(sisRes.data.map((s: any) => ({
            id: s.id, nombre: s.nombre, fincaId: s.finca_id || undefined,
            origenAgua: s.origen_agua || '', origenEnergia: s.origen_energia || '',
            bomba: s.bomba || '', filtros: s.filtros || '', observaciones: s.observaciones || '',
            parcelaIds: s.parcela_ids || [], fechaRegistro: s.fecha_registro || '',
          })))
        }
        if (secRes.data) {
          setSectores(secRes.data.map((s: any) => ({
            id: s.id, sistemaId: s.sistema_id, nombre: s.nombre,
            parcelaIds: s.parcela_ids || [], geojson: s.geojson || null,
            modoSuperficie: (s.modo_superficie || 'completa') as ModoSuperficie,
            supHa: Number(s.sup_ha) || 0, tipoEmisor: s.tipo_emisor || 'Goteo',
            caudalGoteroLh: String(s.caudal_gotero_lh ?? ''), numLineasGoteo: String(s.num_lineas_goteo ?? ''),
            distanciaGoterosM: String(s.distancia_goteros_m ?? ''), distanciaLineasM: String(s.distancia_lineas_m ?? ''),
            eficienciaPct: String(s.eficiencia_pct ?? ''), kc: String(s.kc ?? ''),
            observaciones: s.observaciones || '', fechaRegistro: s.fecha_registro || '',
          })))
        }
        if (evRes.data) {
          setEventos(evRes.data.map((e: any) => ({
            id: e.id, sectorId: e.sector_id, fecha: e.fecha, horas: String(e.horas ?? ''),
            m3Calculado: Number(e.m3_calculado) || 0, observaciones: e.observaciones || '',
            fechaRegistro: e.fecha_registro || '',
          })))
        }
      } catch (e) {
        console.error('Error cargando riego:', e)
      } finally {
        setCargado(true)
      }
    }
    cargar()
  }, [session, cargado])

  // Si se llega desde MIS PARCELAS con un sector concreto, lo abre directamente
  useEffect(() => {
    if (!sectorInicial || !cargado) return
    const sector = sectores.find(s => s.id === sectorInicial)
    if (sector) {
      setSistemaAbiertoId(sector.sistemaId)
      abrirFormRiego(sector.id)
      setTimeout(() => riegoFormRefs.current[sector.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150)
    }
    onConsumirSectorInicial?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectorInicial, cargado])

  // - Sistemas: abrir formulario -
  const abrirFormSistema = (s?: SistemaRiego) => {
    if (!misPermisos['riego.crear_editar']) return
    if (s) {
      setSistemaEditar(s); setSNombre(s.nombre); setSFincaId(s.fincaId || '')
      setSOrigenAgua(s.origenAgua); setSOrigenEnergia(s.origenEnergia); setSBomba(s.bomba)
      setSFiltros(s.filtros); setSObs(s.observaciones); setSParcelaIds(s.parcelaIds)
    } else {
      setSistemaEditar(null); setSNombre(''); setSFincaId(''); setSOrigenAgua('')
      setSOrigenEnergia(''); setSBomba(''); setSFiltros(''); setSObs(''); setSParcelaIds([])
    }
    setSError(''); setFormSistema(true)
  }

  const guardarSistema = async () => {
    if (!misPermisos['riego.crear_editar']) return
    if (!sNombre.trim()) { setSError('El nombre es obligatorio'); return }
    if (!session) return
    const nuevo: SistemaRiego = {
      id: sistemaEditar?.id || String(Date.now()),
      nombre: sNombre.trim(), fincaId: sFincaId || undefined,
      origenAgua: sOrigenAgua.trim(), origenEnergia: sOrigenEnergia.trim(),
      bomba: sBomba.trim(), filtros: sFiltros.trim(), observaciones: sObs.trim(),
      parcelaIds: sParcelaIds,
      fechaRegistro: sistemaEditar?.fechaRegistro || new Date().toLocaleDateString('es-ES'),
    }
    setSistemas(sistemaEditar ? sistemas.map(s => s.id === nuevo.id ? nuevo : s) : [nuevo, ...sistemas])
    try {
      await supabase.from('sistemas_riego').upsert({
        id: nuevo.id, user_id: session.user.id, finca_id: nuevo.fincaId || null,
        nombre: nuevo.nombre, origen_agua: nuevo.origenAgua, origen_energia: nuevo.origenEnergia,
        bomba: nuevo.bomba, filtros: nuevo.filtros, observaciones: nuevo.observaciones,
        parcela_ids: nuevo.parcelaIds, fecha_registro: nuevo.fechaRegistro,
      })
    } catch (e) { console.error(e) }
    setFormSistema(false); setSistemaEditar(null)
  }

  const eliminarSistema = async (id: string) => {
    if (!misPermisos['riego.eliminar']) return
    const secEnSistema = sectores.filter(s => s.sistemaId === id).length
    if (secEnSistema > 0) { alert(`Este sistema tiene ${secEnSistema} sector(es). Elimínalos antes.`); return }
    if (!confirm('¿Eliminar este sistema de riego?')) return
    setSistemas(sistemas.filter(s => s.id !== id))
    try { await supabase.from('sistemas_riego').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // - Sectores: abrir formulario -
  const abrirFormSector = (sistemaId: string, s?: SectorRiego) => {
    if (!misPermisos['riego.crear_editar']) return
    setFormSector(sistemaId)
    if (s) {
      setSectorEditar(s); setSecNombre(s.nombre); setSecModo(s.modoSuperficie)
      setSecParcelaIds(s.parcelaIds); setSecGeojsonDibujado(s.geojson || null); setSecSupHaDibujada(s.supHa)
      setSecTipoEmisor(s.tipoEmisor); setSecCaudal(s.caudalGoteroLh); setSecNumLineas(s.numLineasGoteo)
      setSecDistGoteros(s.distanciaGoterosM); setSecDistLineas(s.distanciaLineasM)
      setSecEficiencia(s.eficienciaPct); setSecKc(s.kc); setSecObs(s.observaciones)
    } else {
      setSectorEditar(null); setSecNombre(''); setSecModo('completa'); setSecParcelaIds([])
      setSecGeojsonDibujado(null); setSecSupHaDibujada(0)
      setSecTipoEmisor('Goteo'); setSecCaudal(''); setSecNumLineas(''); setSecDistGoteros('')
      setSecDistLineas(''); setSecEficiencia(String(EFICIENCIA_DEFECTO['Goteo'])); setSecKc(''); setSecObs('')
    }
    setSecError(''); setCortando(false); setModoCorte(false); setPiezasCorte([]); setPiezasSeleccionadasIds([]); setErrorCorte('')
    setRestanteGeojson(null); setRestanteSupHa(0)
  }

  const parcelasDelSistema = (sistemaId: string): ParcelaLite[] => {
    const sis = sistemas.find(s => s.id === sistemaId)
    if (!sis) return []
    return misParcelas.filter(p => sis.parcelaIds.includes(p.id))
  }

  // Geometría a mostrar de un sector: la suya propia si es recortado, o la de sus parcelas si es "completa"
  const geojsonDelSector = (s: SectorRiego): any => {
    if (s.modoSuperficie === 'dibujado' && s.geojson) return s.geojson
    const features = misParcelas.filter(p => s.parcelaIds.includes(p.id)).flatMap(p => p.geojson?.features || [])
    if (!features.length) return null
    return { type: 'FeatureCollection', features }
  }

  // Sectores ya recortados de las mismas parcelas (en cualquier sistema, excluyendo el que se
  // está editando), para saber cuánto queda "libre" de la parcela y mostrarlo como referencia
  const sectoresDibujadosDeReferencia = (): SectorRiego[] => {
    return sectores.filter(s =>
      s.modoSuperficie === 'dibujado' && s.geojson && s.id !== sectorEditar?.id &&
      s.parcelaIds.some(id => secParcelaIds.includes(id))
    )
  }

  // Calcula la parte de la/s parcela/s seleccionada/s que aún no está asignada a ningún sector,
  // restando (con Turf) todos los trozos ya recortados de esas mismas parcelas
  useEffect(() => {
    if (secModo !== 'dibujado' || secParcelaIds.length === 0 || secGeojsonDibujado) {
      setRestanteGeojson(null); setRestanteSupHa(0)
      return
    }
    let cancelado = false
    setCalculandoRestante(true); setErrorCorte('')
    cargarTurf().then(turf => {
      if (cancelado) return
      try {
        const seleccionadas = misParcelas.filter(p => secParcelaIds.includes(p.id))
        const features = seleccionadas.flatMap(p => p.geojson?.features || [])
        if (!features.length) { setRestanteGeojson(null); setRestanteSupHa(0); return }

        let restante: any = features.length === 1 ? features[0] : features.reduce((acc: any, f: any) => turf.union(acc, f))

        const yaUsados = sectoresDibujadosDeReferencia()
        yaUsados.forEach(s => {
          const feats = s.geojson?.features || []
          feats.forEach((f: any) => {
            try { restante = turf.difference(restante, f) } catch { /* recorte inválido, se ignora */ }
          })
        })

        if (!restante) { setRestanteGeojson(null); setRestanteSupHa(0); return }
        const gj = { type: 'FeatureCollection', features: [restante] }
        setRestanteGeojson(gj)
        setRestanteSupHa(turf.area(restante) / 10000)
      } catch (e) {
        console.error('Error calculando superficie restante:', e)
        setErrorCorte('No se pudo calcular la superficie restante de la parcela.')
      } finally {
        if (!cancelado) setCalculandoRestante(false)
      }
    }).catch(() => { if (!cancelado) { setErrorCorte('No se pudo cargar la herramienta de geometría.'); setCalculandoRestante(false) } })
    return () => { cancelado = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secModo, secParcelaIds, secGeojsonDibujado, sectores])

  // Recibe la polilínea dibujada en el mapa y parte "restanteGeojson" en trozos
  const recortarConLinea = async (lineaGeojson: any) => {
    if (!restanteGeojson) return
    setErrorCorte('')
    try {
      const turf = await cargarTurf()
      const poligono = restanteGeojson.features[0]
      // Aviso (no bloqueante) si la línea no cruza de fuera a dentro y otra vez a fuera
      const inicio = turf.point(lineaGeojson.geometry.coordinates[0])
      const fin = turf.point(lineaGeojson.geometry.coordinates[lineaGeojson.geometry.coordinates.length - 1])
      const inicioDentro = turf.booleanPointInPolygon(inicio, poligono)
      const finDentro = turf.booleanPointInPolygon(fin, poligono)
      if (inicioDentro || finDentro) {
        setErrorCorte('La línea debe empezar y terminar fuera de la parcela, cruzándola por en medio. Vuelve a dibujarla.')
        setModoCorte(false)
        return
      }

      const lineaAncha = turf.buffer(lineaGeojson, 0.3, { units: 'meters' })
      const resultado = turf.difference(poligono, lineaAncha)
      if (!resultado) { setErrorCorte('El corte no ha dividido la parcela. Prueba a dibujar la línea de otra forma.'); setModoCorte(false); return }

      const piezas = turf.flatten(resultado).features.map((f: any, i: number) => ({
        id: i, geojson: { type: 'FeatureCollection', features: [f] }, supHa: turf.area(f) / 10000,
      })).filter((p: any) => p.supHa > 0.0001) // descarta restos ínfimos de precisión geométrica

      if (piezas.length < 2) { setErrorCorte('El corte no ha dividido la parcela en trozos. Prueba a dibujar la línea de otra forma.'); setModoCorte(false); return }

      setPiezasCorte(piezas)
      setModoCorte(false)
    } catch (e) {
      console.error('Error recortando:', e)
      setErrorCorte('No se ha podido recortar. Prueba a dibujar la línea de nuevo.')
      setModoCorte(false)
    }
  }

  const seleccionarPieza = (pieza: { geojson: any; supHa: number }) => {
    setSecGeojsonDibujado(pieza.geojson); setSecSupHaDibujada(pieza.supHa)
    setPiezasCorte([]); setPiezasSeleccionadasIds([]); setCortando(false); setModoCorte(false)
  }

  const togglePiezaSeleccionada = (id: number) => {
    setPiezasSeleccionadasIds(piezasSeleccionadasIds.includes(id) ? piezasSeleccionadasIds.filter(x => x !== id) : [...piezasSeleccionadasIds, id])
  }

  const confirmarPiezasSeleccionadas = () => {
    const elegidas = piezasCorte.filter(p => piezasSeleccionadasIds.includes(p.id))
    if (elegidas.length === 0) return
    const features = elegidas.flatMap(p => p.geojson.features)
    seleccionarPieza({ geojson: { type: 'FeatureCollection', features }, supHa: elegidas.reduce((acc, p) => acc + p.supHa, 0) })
  }

  const volverARecortar = () => {
    setSecGeojsonDibujado(null); setSecSupHaDibujada(0); setPiezasCorte([]); setPiezasSeleccionadasIds([]); setErrorCorte('')
  }

  const supHaCalculada = (): number => {
    if (secModo === 'dibujado') return secSupHaDibujada
    return misParcelas.filter(p => secParcelaIds.includes(p.id)).reduce((acc, p) => acc + (p.supHa || 0), 0)
  }

  const guardarSector = async () => {
    if (!misPermisos['riego.crear_editar']) return
    if (!formSector) return
    if (!secNombre.trim()) { setSecError('El nombre es obligatorio'); return }
    if (secModo === 'completa' && secParcelaIds.length === 0) { setSecError('Selecciona al menos una parcela'); return }
    if (secModo === 'dibujado' && !secGeojsonDibujado) { setSecError('Recorta el sector en el mapa'); return }
    if (!session) return

    const supHa = supHaCalculada()
    const nuevo: SectorRiego = {
      id: sectorEditar?.id || String(Date.now()),
      sistemaId: formSector, nombre: secNombre.trim(),
      parcelaIds: secParcelaIds,
      geojson: secModo === 'dibujado' ? secGeojsonDibujado : undefined,
      modoSuperficie: secModo,
      supHa, tipoEmisor: secTipoEmisor, caudalGoteroLh: secCaudal, numLineasGoteo: secNumLineas,
      distanciaGoterosM: secDistGoteros, distanciaLineasM: secDistLineas,
      eficienciaPct: secEficiencia, kc: secKc, observaciones: secObs.trim(),
      fechaRegistro: sectorEditar?.fechaRegistro || new Date().toLocaleDateString('es-ES'),
    }
    setSectores(sectorEditar ? sectores.map(s => s.id === nuevo.id ? nuevo : s) : [nuevo, ...sectores])
    try {
      await supabase.from('sectores_riego').upsert({
        id: nuevo.id, user_id: session.user.id, sistema_id: nuevo.sistemaId,
        parcela_ids: nuevo.parcelaIds, nombre: nuevo.nombre, geojson: nuevo.geojson || null,
        sup_ha: nuevo.supHa, modo_superficie: nuevo.modoSuperficie,
        tipo_emisor: nuevo.tipoEmisor, caudal_gotero_lh: Number(nuevo.caudalGoteroLh) || null,
        num_lineas_goteo: Number(nuevo.numLineasGoteo) || null, distancia_goteros_m: Number(nuevo.distanciaGoterosM) || null,
        distancia_lineas_m: Number(nuevo.distanciaLineasM) || null,
        eficiencia_pct: Number(nuevo.eficienciaPct) || null, kc: Number(nuevo.kc) || null,
        observaciones: nuevo.observaciones, fecha_registro: nuevo.fechaRegistro,
      })
    } catch (e) { console.error(e) }
    setFormSector(null); setSectorEditar(null)
  }

  const eliminarSector = async (id: string) => {
    if (!misPermisos['riego.eliminar']) return
    if (!confirm('¿Eliminar este sector de riego? También se borrarán sus riegos registrados.')) return
    setSectores(sectores.filter(s => s.id !== id))
    setEventos(eventos.filter(e => e.sectorId !== id))
    try { await supabase.from('sectores_riego').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // - Registro de riegos -
  const abrirFormRiego = (sectorId: string) => {
    if (!misPermisos['riego.crear_editar']) return
    setFormRiego(sectorId); setRFecha(new Date().toISOString().slice(0, 10)); setRHoras(''); setRObs('')
  }

  const guardarRiego = async () => {
    if (!misPermisos['riego.crear_editar']) return
    if (!formRiego || !session) return
    const sector = sectores.find(s => s.id === formRiego)
    if (!sector) return
    const horas = Number(rHoras) || 0
    if (!rFecha || horas <= 0) return
    const m3 = calcularM3(sector, horas)
    const nuevo: RiegoEvento = {
      id: String(Date.now()), sectorId: formRiego, fecha: rFecha, horas: rHoras,
      m3Calculado: m3, observaciones: rObs.trim(), fechaRegistro: new Date().toLocaleDateString('es-ES'),
    }
    setEventos([nuevo, ...eventos])
    try {
      await supabase.from('riegos_eventos').upsert({
        id: nuevo.id, user_id: session.user.id, sector_id: nuevo.sectorId, fecha: nuevo.fecha,
        horas, m3_calculado: nuevo.m3Calculado, observaciones: nuevo.observaciones, fecha_registro: nuevo.fechaRegistro,
      })
    } catch (e) { console.error(e) }
    setFormRiego(null)
  }

  const eliminarRiego = async (id: string) => {
    if (!misPermisos['riego.eliminar']) return
    if (!confirm('¿Eliminar este riego registrado?')) return
    setEventos(eventos.filter(e => e.id !== id))
    try { await supabase.from('riegos_eventos').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // - Calculadora de necesidades de riego -
  const abrirCalculoRiego = (sectorId: string) => {
    setCalculandoRiegoSectorId(sectorId)
    const hoy = new Date().toISOString().slice(0, 10)
    const hace7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    setPredFechaInicio(hace7); setPredFechaFin(hoy)
    setPredKcSimple(''); setPredKcPeriodos([{ id: '1', desde: hace7, hasta: hoy, kc: '' }])
    setPredKr('1')
    setPredResultado(null); setPredError(''); setPredCargando(false)
  }

  const periodoLargo = (): boolean => {
    if (!predFechaInicio || !predFechaFin) return false
    return diasEntre(predFechaInicio, predFechaFin).length >= 30
  }

  const anadirPeriodoKc = () => {
    const ultima = predKcPeriodos[predKcPeriodos.length - 1]
    const siguienteDesde = ultima?.hasta ? sumarDiasISO(ultima.hasta, 1) : predFechaInicio
    setPredKcPeriodos([...predKcPeriodos, { id: String(Date.now()), desde: siguienteDesde, hasta: predFechaFin, kc: '' }])
  }

  const actualizarPeriodoKc = (id: string, campo: 'desde' | 'hasta' | 'kc', valor: string) => {
    setPredKcPeriodos(predKcPeriodos.map(p => p.id === id ? { ...p, [campo]: valor } : p))
  }

  const eliminarPeriodoKc = (id: string) => {
    setPredKcPeriodos(predKcPeriodos.filter(p => p.id !== id))
  }

  const calcularNecesidadesRiego = async (sector: SectorRiego) => {
    setPredError(''); setPredResultado(null)
    if (!predFechaInicio || !predFechaFin) { setPredError('Indica la fecha inicial y final.'); return }
    if (predFechaFin < predFechaInicio) { setPredError('La fecha final no puede ser anterior a la inicial.'); return }

    const dias = diasEntre(predFechaInicio, predFechaFin)
    const periodos: KcPeriodo[] = periodoLargo()
      ? predKcPeriodos
      : [{ id: '1', desde: predFechaInicio, hasta: predFechaFin, kc: predKcSimple }]

    if (periodos.some(p => !p.kc)) { setPredError('Falta indicar el Kc de algún periodo.'); return }
    const diasSinKc = dias.filter(f => kcParaFecha(f, periodos) === null)
    if (diasSinKc.length > 0) { setPredError(`Hay ${diasSinKc.length} día(s) del periodo sin Kc asignado. Revisa que los periodos cubran todo el rango.`); return }
    if (!predKr) { setPredError('Falta indicar el Kr (coeficiente de localización).'); return }
    const kr = Number(predKr.replace(',', '.'))

    const geojson = geojsonDelSector(sector)
    const centro = geojson ? centroideDeGeojson(geojson) : null
    if (!centro) { setPredError('No se pudo determinar la ubicación del sector.'); return }

    setPredCargando(true)
    try {
      const r = await fetch(`${BACKEND}/clima/eto_periodo?lat=${centro[0]}&lon=${centro[1]}&fecha_inicio=${predFechaInicio}&fecha_fin=${predFechaFin}`)
      if (!r.ok) throw new Error(`Error ${r.status}`)
      const data = await r.json()
      const etoPorFecha = new Map<string, number | null>((data.dias || []).map((d: any) => [d.fecha, d.eto]))
      const precPorFecha = new Map<string, number>((data.dias || []).map((d: any) => [d.fecha, Number(d.precipitacion) || 0]))

      const eficiencia = (Number(sector.eficienciaPct) || 90) / 100
      let etoAcumulada = 0, precipitacionAcumulada = 0, necesidadBrutaAcumulada = 0, necesidadM3HaTotal = 0, diasSinDato = 0
      const tabla: FilaCalculo[] = dias.map(fecha => {
        const eto = etoPorFecha.has(fecha) ? etoPorFecha.get(fecha)! : null
        const kc = kcParaFecha(fecha, periodos) as number
        const precipitacion = precPorFecha.get(fecha) ?? 0
        precipitacionAcumulada += precipitacion
        if (eto === null) { diasSinDato++; return { fecha, eto: null, kc, kr, etc: null, precipitacion, necesidadNeta: null, necesidadBruta: null, necesidadM3Ha: null } }
        // 1. ETo → 2. Kc → 3. Kr → 4. ETc → 5. Precipitación efectiva → 6. Necesidad neta → 7. Necesidad bruta (÷ eficiencia)
        const etc = eto * kc * kr
        const necesidadNeta = Math.max(0, etc - precipitacion)
        const necesidadBruta = necesidadNeta / eficiencia
        const necesidadM3Ha = necesidadBruta * 10
        etoAcumulada += eto; necesidadBrutaAcumulada += necesidadBruta; necesidadM3HaTotal += necesidadM3Ha
        return { fecha, eto, kc, kr, etc, precipitacion, necesidadNeta, necesidadBruta, necesidadM3Ha }
      })

      const supHa = sector.supHa
      const necesidadTotalM3 = necesidadM3HaTotal * supHa
      const goterosPorHa = calcularGoterosPorHa(sector)
      const caudalGotero = Number(sector.caudalGoteroLh) || 0
      const caudalM3hHa = (goterosPorHa && caudalGotero) ? (goterosPorHa * caudalGotero) / 1000 : null
      const horasTotal = caudalM3hHa ? necesidadM3HaTotal / caudalM3hHa : null
      const horasMediaDia = horasTotal !== null ? horasTotal / dias.length : null

      setPredResultado({
        fechaInicio: predFechaInicio, fechaFin: predFechaFin, numDias: dias.length,
        eficienciaUsada: eficiencia * 100, krUsado: kr, estacion: data.estacion || '',
        etoAcumulada, precipitacionAcumulada, necesidadBrutaAcumulada, necesidadM3Ha: necesidadM3HaTotal,
        supHa, necesidadTotalM3, caudalM3hHa, horasTotal, horasMediaDia, diasSinDato, tabla,
      })
    } catch (e) {
      console.error(e)
      setPredError('No se pudieron obtener los datos de ETo. Inténtalo de nuevo.')
    } finally {
      setPredCargando(false)
    }
  }

  const inputStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none', width: '100%' }
  const labelStyle = { fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 4, display: 'block' }

  // Selector múltiple de parcelas reutilizado en sistema y sector
  const SelectorParcelas = ({ opciones, seleccion, onToggle }: { opciones: ParcelaLite[]; seleccion: string[]; onToggle: (id: string) => void }) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 140, overflow: 'auto', padding: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
      {opciones.map(p => {
        const sel = seleccion.includes(p.id)
        return (
          <button key={p.id} onClick={() => onToggle(p.id)}
            style={{ padding: '5px 10px', borderRadius: 14, background: sel ? 'rgba(77,184,255,0.15)' : 'var(--surface)', border: `1px solid ${sel ? 'var(--blue)' : 'var(--border)'}`, color: sel ? 'var(--blue)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>
            {nombreParcela(p)}
          </button>
        )
      })}
      {opciones.length === 0 && <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay parcelas disponibles</span>}
    </div>
  )

  const sistemasVista = filtroFincaId ? sistemas.filter(s => s.fincaId === filtroFincaId) : sistemas
  const sistemaFormSector = sistemas.find(s => s.id === formSector) || null

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: isMobile ? 12 : 24, background: 'var(--bg)' }}>
      {!formSistema && !formSector ? (
      <>
      {/* Cabecera */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Riego</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
            {sistemasVista.length} sistema{sistemasVista.length !== 1 ? 's' : ''} · {sectores.filter(s => sistemasVista.some(sv => sv.id === s.sistemaId)).length} sector{sectores.filter(s => sistemasVista.some(sv => sv.id === s.sistemaId)).length !== 1 ? 'es' : ''}
          </div>
        </div>
        {misPermisos['riego.crear_editar'] && (
          <button onClick={() => abrirFormSistema()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--blue)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ NUEVO SISTEMA</button>
        )}
      </div>

      {/* Filtro por finca */}
      {fincas.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          <button onClick={() => setFiltroFincaId('')} style={{ padding: '5px 12px', borderRadius: 14, background: !filtroFincaId ? 'rgba(61,220,110,0.12)' : 'var(--surface)', border: `1px solid ${!filtroFincaId ? 'var(--green)' : 'var(--border)'}`, color: !filtroFincaId ? 'var(--green)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: !filtroFincaId ? 700 : 400 }}>Todas las fincas</button>
          {fincas.map(f => (
            <button key={f.id} onClick={() => setFiltroFincaId(f.id)} style={{ padding: '5px 12px', borderRadius: 14, background: filtroFincaId === f.id ? 'rgba(61,220,110,0.12)' : 'var(--surface)', border: `1px solid ${filtroFincaId === f.id ? 'var(--green)' : 'var(--border)'}`, color: filtroFincaId === f.id ? 'var(--green)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: filtroFincaId === f.id ? 700 : 400 }}>{f.nombre}</button>
          ))}
        </div>
      )}

      {/* Lista de sistemas */}
      {sistemasVista.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12, border: '1px dashed var(--border)', borderRadius: 10 }}>
          {sistemas.length === 0 ? 'Aún no has creado ningún sistema de riego.' : 'Esta finca no tiene sistemas de riego.'}
        </div>
      )}

      {sistemasVista.map(sistema => {
        const finca = fincas.find(f => f.id === sistema.fincaId)
        const sectoresDelSistema = sectores.filter(s => s.sistemaId === sistema.id)
        const abierto = sistemaAbiertoId === sistema.id
        return (
          <div key={sistema.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 14, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)', cursor: 'pointer' }}
              onClick={() => setSistemaAbiertoId(abierto ? null : sistema.id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>💧</span>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{sistema.nombre}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                    {finca ? finca.nombre : 'Sin finca'} · {sectoresDelSistema.length} sector{sectoresDelSistema.length !== 1 ? 'es' : ''}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
                {misPermisos['riego.crear_editar'] && (
                  <button onClick={() => abrirFormSistema(sistema)} style={{ padding: '6px 12px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Editar</button>
                )}
                {misPermisos['riego.eliminar'] && (
                  <button onClick={() => eliminarSistema(sistema.id)} style={{ padding: '6px 12px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Eliminar</button>
                )}
              </div>
            </div>

            {abierto && (
              <div style={{ padding: 16 }}>
                {/* Datos del sistema */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px,1fr))', gap: 8, marginBottom: 16 }}>
                  {[
                    { k: 'Origen agua', v: sistema.origenAgua || '-' },
                    { k: 'Origen energía', v: sistema.origenEnergia || '-' },
                    { k: 'Bomba', v: sistema.bomba || '-' },
                    { k: 'Filtros', v: sistema.filtros || '-' },
                    { k: 'Parcelas', v: String(sistema.parcelaIds.length) },
                  ].map(s => (
                    <div key={s.k} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                      <div style={labelStyle}>{s.k}</div>
                      <div style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>{s.v}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--blue)' }}>SECTORES DE RIEGO</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {sectoresDelSistema.length > 0 && (
                      <button onClick={() => setSistemaVerSectoresId(sistemaVerSectoresId === sistema.id ? null : sistema.id)}
                        style={{ padding: '6px 12px', borderRadius: 6, background: sistemaVerSectoresId === sistema.id ? 'rgba(61,220,110,0.12)' : 'var(--surface)', border: `1px solid ${sistemaVerSectoresId === sistema.id ? 'var(--green)' : 'var(--border)'}`, color: sistemaVerSectoresId === sistema.id ? 'var(--green)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>
                        👁 {sistemaVerSectoresId === sistema.id ? 'Ocultar mapa' : 'Ver sectores'}
                      </button>
                    )}
                    {misPermisos['riego.crear_editar'] && (
                      <button onClick={() => abrirFormSector(sistema.id)} style={{ padding: '6px 12px', borderRadius: 6, background: 'rgba(77,184,255,0.1)', border: '1px solid var(--blue)', color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>+ Añadir sector</button>
                    )}
                  </div>
                </div>

                {sistemaVerSectoresId === sistema.id && sectoresDelSistema.length > 0 && (
                  <div style={{ height: 360, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--green)', marginBottom: 12 }}>
                    <MapView
                      onParcelaClick={() => {}}
                      onParcelasDibujadas={() => {}}
                      parcGeojson={null}
                      piezasResaltadas={sectoresDelSistema.map((s, i) => ({
                        geojson: geojsonDelSector(s), color: COLORES_PIEZAS[i % COLORES_PIEZAS.length], etiqueta: s.nombre,
                      }))}
                      imagenUrl={null}
                      indiceColor="#4db8ff"
                      seleccionando={false}
                      mododibujo={false}
                      onMododibujoCambiado={() => {}}
                    />
                  </div>
                )}

                {sectoresDelSistema.length === 0 && (
                  <div style={{ padding: 14, textAlign: 'center', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, border: '1px dashed var(--border)', borderRadius: 8 }}>
                    Este sistema todavía no tiene sectores.
                  </div>
                )}

                {sectoresDelSistema.map(sector => {
                  const eventosDelSector = eventos.filter(e => e.sectorId === sector.id)
                  const totalM3 = eventosDelSector.reduce((acc, e) => acc + e.m3Calculado, 0)
                  const parcelasSector = misParcelas.filter(p => sector.parcelaIds.includes(p.id))
                  const goterosPorHa = calcularGoterosPorHa(sector)
                  const numGoterosTotal = calcularNumGoterosTotal(sector)
                  return (
                    <div key={sector.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                        <div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{sector.nombre}</div>
                          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                            {sector.supHa.toFixed(2)} ha · {sector.tipoEmisor}
                            {parcelasSector.length > 0 ? ` (${parcelasSector.map(p => nombreParcela(p)).join(', ')})` : ''}
                            {sector.modoSuperficie === 'dibujado' ? ' · dibujado' : ''}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {misPermisos['riego.crear_editar'] && (
                            <button onClick={() => abrirFormRiego(sector.id)} style={{ padding: '5px 10px', borderRadius: 6, background: 'var(--blue)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>+ Registrar riego</button>
                          )}
                          {/* MÓDULO "PREDICCIÓN DE RIEGO" DESACTIVADO TEMPORALMENTE — botón comentado, ver bloque completo más abajo
                          <button onClick={() => abrirCalculoRiego(sector.id)} style={{ padding: '5px 10px', borderRadius: 6, background: 'rgba(61,220,110,0.1)', border: '1px solid var(--green)', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>📊 Calcular necesidades</button>
                          */}
                          {misPermisos['riego.crear_editar'] && (
                            <button onClick={() => abrirFormSector(sistema.id, sector)} style={{ padding: '5px 10px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>Editar</button>
                          )}
                          {misPermisos['riego.eliminar'] && (
                            <button onClick={() => eliminarSector(sector.id)} style={{ padding: '5px 10px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>Eliminar</button>
                          )}
                        </div>
                      </div>

                      {/* ============ INICIO módulo "Predicción de riego" desactivado — código intacto, solo comentado. Para reactivar: quita esta línea de apertura y la de cierre justo antes de la siguiente sección ============
                      {calculandoRiegoSectorId === sector.id && (
                        <div style={{ marginTop: 10, padding: 12, background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--green)' }}>PREDICCIÓN DE RIEGO</span>
                            <button onClick={() => setCalculandoRiegoSectorId(null)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }}>✕</button>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr', gap: 8, marginBottom: 8 }}>
                            <div><label style={labelStyle}>Fecha inicial</label><input type="date" value={predFechaInicio} onChange={e => setPredFechaInicio(e.target.value)} style={inputStyle} /></div>
                            <div><label style={labelStyle}>Fecha final</label><input type="date" value={predFechaFin} onChange={e => setPredFechaFin(e.target.value)} style={inputStyle} /></div>
                          </div>

                          {!periodoLargo() ? (
                            <div style={{ marginBottom: 10 }}>
                              <label style={labelStyle}>Kc del cultivo (periodo &lt; 30 días, un único valor)</label>
                              <input type="number" step="0.01" value={predKcSimple} onChange={e => setPredKcSimple(e.target.value)} style={inputStyle} placeholder="ej. 0,90" />
                            </div>
                          ) : (
                            <div style={{ marginBottom: 10 }}>
                              <label style={labelStyle}>Kc por periodos (el rango es de 30 días o más)</label>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
                                {predKcPeriodos.map(p => (
                                  <div key={p.id} style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr 70px 24px', gap: 6, alignItems: 'center' }}>
                                    <input type="date" value={p.desde} onChange={e => actualizarPeriodoKc(p.id, 'desde', e.target.value)} style={inputStyle} />
                                    <input type="date" value={p.hasta} onChange={e => actualizarPeriodoKc(p.id, 'hasta', e.target.value)} style={inputStyle} />
                                    <input type="number" step="0.01" value={p.kc} onChange={e => actualizarPeriodoKc(p.id, 'kc', e.target.value)} style={inputStyle} placeholder="Kc" />
                                    <button onClick={() => eliminarPeriodoKc(p.id)} style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer' }}>✕</button>
                                  </div>
                                ))}
                              </div>
                              <button onClick={anadirPeriodoKc} style={{ padding: '5px 10px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>+ Añadir periodo</button>
                            </div>
                          )}

                          <div style={{ marginBottom: 10 }}>
                            <label style={labelStyle}>Kr (coeficiente de localización, riego localizado)</label>
                            <input type="number" step="0.01" value={predKr} onChange={e => setPredKr(e.target.value)} style={inputStyle} placeholder="ej. 0,90 — usa 1 si no aplica" />
                          </div>

                          {predError && <div style={{ color: '#fca5a5', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 8 }}>{predError}</div>}

                          <button onClick={() => calcularNecesidadesRiego(sector)} disabled={predCargando} style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: predCargando ? 'default' : 'pointer', opacity: predCargando ? 0.6 : 1 }}>
                            {predCargando ? 'Calculando...' : 'Calcular necesidades de riego'}
                          </button>

                          {predResultado && (
                            <div style={{ marginTop: 12 }}>
                              <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 8 }}>
                                {predResultado.fechaInicio} → {predResultado.fechaFin} ({predResultado.numDias} días) · Estación: {predResultado.estacion} · Kr: {predResultado.krUsado.toFixed(2)}
                                {predResultado.diasSinDato > 0 && ` · ⚠ ${predResultado.diasSinDato} día(s) sin dato de ETo`}
                              </div>

                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px,1fr))', gap: 8, marginBottom: 10 }}>
                                {[
                                  { k: 'ETo acumulada', v: `${predResultado.etoAcumulada.toFixed(1)} mm` },
                                  { k: 'Precipitación (Pe)', v: `${predResultado.precipitacionAcumulada.toFixed(1)} mm` },
                                  { k: 'Necesidad bruta', v: `${predResultado.necesidadBrutaAcumulada.toFixed(1)} mm` },
                                  { k: 'Agua necesaria', v: `${predResultado.necesidadM3Ha.toFixed(1)} m³/ha`, destacado: true },
                                  { k: 'Superficie', v: `${predResultado.supHa.toFixed(3)} ha` },
                                  { k: 'Agua total sector', v: `${predResultado.necesidadTotalM3.toFixed(1)} m³`, destacado: true },
                                  { k: 'Caudal', v: predResultado.caudalM3hHa !== null ? `${predResultado.caudalM3hHa.toFixed(2)} m³/h/ha` : '—' },
                                  { k: 'Tiempo total riego', v: formatHoras(predResultado.horasTotal), destacado: true },
                                  { k: 'Tiempo medio diario', v: predResultado.horasTotal !== null ? `${formatHoras(predResultado.horasMediaDia)}/día` : '—' },
                                ].map(s => (
                                  <div key={s.k} style={{ background: s.destacado ? 'rgba(61,220,110,0.08)' : 'var(--surface2)', border: `1px solid ${s.destacado ? 'var(--green)' : 'var(--border)'}`, borderRadius: 6, padding: '8px 10px' }}>
                                    <div style={labelStyle}>{s.k}</div>
                                    <div style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 700, color: s.destacado ? 'var(--green)' : 'var(--text)', marginTop: 2 }}>{s.v}</div>
                                  </div>
                                ))}
                              </div>

                              <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10, fontFamily: 'var(--mono)' }}>
                                  <thead>
                                    <tr style={{ position: 'sticky', top: 0, background: 'var(--surface2)' }}>
                                      {['Fecha', 'ETo', 'Kc', 'ETc', 'Precip.', 'Nec. neta', 'm³/ha'].map(h => (
                                        <th key={h} style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {predResultado.tabla.map(fila => (
                                      <tr key={fila.fecha} style={{ borderBottom: '1px solid var(--border)' }}>
                                        <td style={{ padding: '5px 8px', color: 'var(--text)' }}>{fila.fecha}</td>
                                        <td style={{ padding: '5px 8px', color: 'var(--text)' }}>{fila.eto !== null ? fila.eto.toFixed(1) : '—'}</td>
                                        <td style={{ padding: '5px 8px', color: 'var(--text)' }}>{fila.kc.toFixed(2)}</td>
                                        <td style={{ padding: '5px 8px', color: 'var(--text)' }}>{fila.etc !== null ? fila.etc.toFixed(2) : '—'}</td>
                                        <td style={{ padding: '5px 8px', color: '#4db8ff' }}>{fila.precipitacion !== null ? fila.precipitacion.toFixed(1) : '—'}</td>
                                        <td style={{ padding: '5px 8px', color: 'var(--text)' }}>{fila.necesidadNeta !== null ? fila.necesidadNeta.toFixed(2) : '—'}</td>
                                        <td style={{ padding: '5px 8px', color: 'var(--green)', fontWeight: 700 }}>{fila.necesidadM3Ha !== null ? fila.necesidadM3Ha.toFixed(1) : '—'}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      ============ FIN módulo "Predicción de riego" desactivado ============ */}

                      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 8 }}>
                        <span>Caudal/gotero: {sector.caudalGoteroLh || '-'} L/h</span>
                        <span>Líneas/árbol: {sector.numLineasGoteo || '-'}</span>
                        <span>Dist. goteros: {sector.distanciaGoterosM || '-'} m</span>
                        <span>Dist. líneas: {sector.distanciaLineasM || '-'} m</span>
                        <span>Goteros/ha: {goterosPorHa ? Math.round(goterosPorHa) : '-'}</span>
                        <span>Goteros totales: {numGoterosTotal || '-'}</span>
                        <span>Eficiencia: {sector.eficienciaPct || '-'}%</span>
                      </div>

                      {/* Riegos registrados */}
                      {eventosDelSector.length > 0 && (
                        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
                          <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', fontWeight: 700, marginBottom: 6 }}>
                            RIEGOS ({eventosDelSector.length}) · TOTAL {totalM3.toFixed(1)} m³
                          </div>
                          {eventosDelSector.map(ev => (
                            <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text)', padding: '4px 0' }}>
                              <span>{ev.fecha} · {ev.horas}h · {ev.m3Calculado.toFixed(1)} m³{ev.observaciones ? ` · ${ev.observaciones}` : ''}</span>
                              {misPermisos['riego.eliminar'] && (
                                <button onClick={() => eliminarRiego(ev.id)} style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 10 }}>✕</button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Formulario de registro de riego */}
                      {formRiego === sector.id && (
                        <div ref={(el) => { riegoFormRefs.current[sector.id] = el }} style={{ marginTop: 10, padding: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8, marginBottom: 8 }}>
                            <div><label style={labelStyle}>Fecha</label><input type="date" value={rFecha} onChange={e => setRFecha(e.target.value)} style={inputStyle} /></div>
                            <div><label style={labelStyle}>Horas de riego</label><input type="number" step="0.1" value={rHoras} onChange={e => setRHoras(e.target.value)} style={inputStyle} placeholder="ej. 3.5" /></div>
                          </div>
                          <div style={{ marginBottom: 8 }}><label style={labelStyle}>Observaciones</label><input value={rObs} onChange={e => setRObs(e.target.value)} style={inputStyle} /></div>
                          {rHoras && (
                            <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', marginBottom: 8 }}>
                              ≈ {calcularM3(sector, Number(rHoras) || 0).toFixed(1)} m³ estimados
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={guardarRiego} style={{ padding: '6px 14px', borderRadius: 6, background: 'var(--blue)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>Guardar</button>
                            <button onClick={() => setFormRiego(null)} style={{ padding: '6px 14px', borderRadius: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Cancelar</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      </>
      ) : formSistema ? (
      <>
      {/* Vista dedicada de edición de sistema */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={() => { setFormSistema(false); setSistemaEditar(null) }} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, fontFamily: 'var(--mono)' }}>← volver</button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--blue)' }}>
          {sistemaEditar ? 'Editar sistema de riego' : 'Nuevo sistema de riego'}
        </span>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--blue)', borderRadius: 10, padding: 16 }}>
          <div style={{ marginBottom: 8 }}><label style={labelStyle}>Nombre</label><input value={sNombre} onChange={e => setSNombre(e.target.value)} style={inputStyle} /></div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <div>
              <label style={labelStyle}>Finca</label>
              <select value={sFincaId} onChange={e => setSFincaId(e.target.value)} style={inputStyle}>
                <option value="">Sin finca</option>
                {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
              </select>
            </div>
            <div><label style={labelStyle}>Origen del agua</label><input value={sOrigenAgua} onChange={e => setSOrigenAgua(e.target.value)} style={inputStyle} placeholder="Pozo, balsa, red..." /></div>
            <div><label style={labelStyle}>Origen de la energía</label><input value={sOrigenEnergia} onChange={e => setSOrigenEnergia(e.target.value)} style={inputStyle} placeholder="Eléctrica, solar, diésel..." /></div>
            <div><label style={labelStyle}>Bomba</label><input value={sBomba} onChange={e => setSBomba(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>Filtros</label><input value={sFiltros} onChange={e => setSFiltros(e.target.value)} style={inputStyle} /></div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>Parcelas que abastece este sistema</label>
            <SelectorParcelas
              opciones={misParcelas.filter(p => !sFincaId || p.fincaId === sFincaId)}
              seleccion={sParcelaIds}
              onToggle={(id) => setSParcelaIds(sParcelaIds.includes(id) ? sParcelaIds.filter(x => x !== id) : [...sParcelaIds, id])}
            />
          </div>

          <div style={{ marginBottom: 10 }}><label style={labelStyle}>Observaciones</label><input value={sObs} onChange={e => setSObs(e.target.value)} style={inputStyle} /></div>

          {sError && <div style={{ color: '#fca5a5', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 8 }}>{sError}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={guardarSistema} style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--blue)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>Guardar</button>
            <button onClick={() => { setFormSistema(false); setSistemaEditar(null) }} style={{ padding: '8px 16px', borderRadius: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Cancelar</button>
          </div>
      </div>
      </>
      ) : sistemaFormSector ? (
      <>
      {/* Vista dedicada de creación/edición de sector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={() => { setFormSector(null); setSectorEditar(null) }} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, fontFamily: 'var(--mono)' }}>← volver</button>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--blue)' }}>
          {sectorEditar ? 'Editar sector' : 'Nuevo sector de riego'}{sistemaFormSector ? ` — ${sistemaFormSector.nombre}` : ''}
        </span>
      </div>

      <div style={{ marginTop: 12, padding: 14, background: 'var(--surface2)', border: '1px solid var(--blue)', borderRadius: 8 }}>
          <div style={{ marginBottom: 8 }}><label style={labelStyle}>Nombre del sector</label><input value={secNombre} onChange={e => setSecNombre(e.target.value)} style={inputStyle} /></div>

          <div style={{ marginBottom: 8 }}>
            <label style={labelStyle}>Superficie</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {(['completa', 'dibujado'] as ModoSuperficie[]).map(m => (
                <button key={m} onClick={() => setSecModo(m)} style={{ flex: 1, padding: '6px 8px', borderRadius: 6, background: secModo === m ? 'rgba(77,184,255,0.15)' : 'var(--surface)', border: `1px solid ${secModo === m ? 'var(--blue)' : 'var(--border)'}`, color: secModo === m ? 'var(--blue)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', fontWeight: secModo === m ? 700 : 400 }}>
                  {m === 'completa' ? 'Parcela(s) completa(s)' : 'Dibujar en mapa'}
                </button>
              ))}
            </div>

            <label style={labelStyle}>{secModo === 'completa' ? 'Parcelas del sector' : 'Parcelas de referencia (opcional, se muestran en el mapa)'}</label>
            <SelectorParcelas
              opciones={parcelasDelSistema(sistemaFormSector.id)}
              seleccion={secParcelaIds}
              onToggle={(id) => setSecParcelaIds(secParcelaIds.includes(id) ? secParcelaIds.filter(x => x !== id) : [...secParcelaIds, id])}
            />

            {secModo === 'completa' && secParcelaIds.length > 0 && (
              <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', marginTop: 6 }}>
                Superficie total: {supHaCalculada().toFixed(2)} ha
              </div>
            )}

            {secModo === 'dibujado' && (
              <div style={{ marginTop: 8 }}>
                {secGeojsonDibujado ? (
                  <div>
                    <div style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(61,220,110,0.1)', border: '1px solid var(--green)', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 6 }}>
                      ✓ Sector recortado — {secSupHaDibujada.toFixed(3)} ha
                    </div>
                    <button onClick={volverARecortar} style={{ width: '100%', padding: '7px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>
                      ✕ Descartar y volver a recortar
                    </button>
                  </div>
                ) : secParcelaIds.length === 0 ? (
                  <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', padding: '8px 0' }}>
                    Selecciona arriba la/s parcela/s que quieres recortar.
                  </div>
                ) : calculandoRestante ? (
                  <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', padding: '8px 0' }}>Calculando superficie disponible...</div>
                ) : restanteSupHa <= 0.0001 ? (
                  <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: '#fca5a5', padding: '8px 0' }}>
                    Esta/s parcela/s ya está/n completamente asignada/s a otros sectores.
                  </div>
                ) : piezasCorte.length > 0 ? (
                  <div>
                    <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 6 }}>
                      La parcela ha quedado en {piezasCorte.length} trozos. Elige uno o varios para este sector (clic en la lista o directamente en el mapa):
                    </div>
                    <div style={{ height: 300, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 8 }}>
                      <MapView
                        onParcelaClick={() => {}}
                        onParcelasDibujadas={() => {}}
                        parcGeojson={null}
                        piezasResaltadas={piezasCorte.map((p, i) => ({
                          geojson: p.geojson, color: COLORES_PIEZAS[i % COLORES_PIEZAS.length],
                          seleccionado: piezasSeleccionadasIds.includes(p.id),
                          onClick: () => togglePiezaSeleccionada(p.id),
                        }))}
                        imagenUrl={null}
                        indiceColor="#4db8ff"
                        seleccionando={false}
                        mododibujo={false}
                        onMododibujoCambiado={() => {}}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                      {piezasCorte.map((p, i) => {
                        const sel = piezasSeleccionadasIds.includes(p.id)
                        return (
                          <button key={p.id} onClick={() => togglePiezaSeleccionada(p.id)}
                            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderRadius: 6, background: sel ? 'rgba(61,220,110,0.1)' : 'var(--surface)', border: `1px solid ${sel ? 'var(--green)' : COLORES_PIEZAS[i % COLORES_PIEZAS.length]}`, cursor: 'pointer' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)' }}>
                              <span style={{ width: 14, height: 14, borderRadius: 3, background: sel ? 'var(--green)' : 'transparent', border: `2px solid ${sel ? 'var(--green)' : COLORES_PIEZAS[i % COLORES_PIEZAS.length]}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: 'var(--bg)' }}>{sel ? '✓' : ''}</span>
                              Trozo {i + 1} — {p.supHa.toFixed(3)} ha
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    {piezasSeleccionadasIds.length > 0 && (
                      <button onClick={confirmarPiezasSeleccionadas} style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: 'pointer', marginBottom: 6 }}>
                        ✓ Confirmar {piezasSeleccionadasIds.length} trozo{piezasSeleccionadasIds.length !== 1 ? 's' : ''} ({piezasCorte.filter(p => piezasSeleccionadasIds.includes(p.id)).reduce((a, p) => a + p.supHa, 0).toFixed(3)} ha)
                      </button>
                    )}
                    <button onClick={() => { setPiezasCorte([]); setPiezasSeleccionadasIds([]); setModoCorte(true); setCortando(true) }} style={{ width: '100%', padding: '6px', borderRadius: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>
                      ✕ Ninguno vale, repetir corte
                    </button>
                  </div>
                ) : !cortando ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <button onClick={() => seleccionarPieza({ geojson: restanteGeojson, supHa: restanteSupHa })} style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'rgba(61,220,110,0.1)', border: '1px solid var(--green)', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>
                      ✓ Usar toda la superficie restante ({restanteSupHa.toFixed(3)} ha)
                    </button>
                    <button onClick={() => { setCortando(true); setModoCorte(true) }} style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'rgba(255,107,107,0.1)', border: '1px solid #ff6b6b', color: '#ff6b6b', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>
                      ✂ Recortar solo una parte ({restanteSupHa.toFixed(3)} ha disponibles)
                    </button>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 6, lineHeight: 1.5 }}>
                      Dibuja una línea empezando fuera de la parcela, cruzándola, y terminando fuera otra vez. Luego pulsa "✂ Recortar".
                    </div>
                    <div style={{ height: 340, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', position: 'relative' }}>
                      <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 1000, background: 'rgba(15,26,18,0.9)', border: '1px solid #ffb454', borderRadius: 6, padding: '4px 8px', fontSize: 9, fontFamily: 'var(--mono)', color: '#ffb454' }}>
                        ⬤ Naranja: superficie ya asignada a otros sectores
                      </div>
                      <MapView
                        onParcelaClick={() => {}}
                        onParcelasDibujadas={() => {}}
                        parcGeojson={restanteGeojson}
                        extraGeojsons={sectoresDibujadosDeReferencia().map(s => s.geojson)}
                        modoCorte={modoCorte}
                        onLineaCortada={recortarConLinea}
                        onModoCorteCambiado={setModoCorte}
                        imagenUrl={null}
                        indiceColor="#4db8ff"
                        seleccionando={false}
                        mododibujo={false}
                        onMododibujoCambiado={() => {}}
                      />
                    </div>
                  </div>
                )}
                {errorCorte && <div style={{ color: '#fca5a5', fontSize: 10, fontFamily: 'var(--mono)', marginTop: 6 }}>{errorCorte}</div>}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
            <div>
              <label style={labelStyle}>Tipo de emisor</label>
              <select value={secTipoEmisor} onChange={e => { setSecTipoEmisor(e.target.value); setSecEficiencia(String(EFICIENCIA_DEFECTO[e.target.value] || '')) }} style={inputStyle}>
                {TIPOS_EMISOR.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div><label style={labelStyle}>Caudal/gotero (L/h)</label><input type="number" step="0.1" value={secCaudal} onChange={e => setSecCaudal(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>Eficiencia (%)</label><input type="number" value={secEficiencia} onChange={e => setSecEficiencia(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>Líneas de goteo / árbol</label><input type="number" step="0.5" value={secNumLineas} onChange={e => setSecNumLineas(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>Dist. entre goteros (m)</label><input type="number" step="0.01" value={secDistGoteros} onChange={e => setSecDistGoteros(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>Dist. entre líneas / calles (m)</label><input type="number" step="0.01" value={secDistLineas} onChange={e => setSecDistLineas(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>Kc del cultivo</label><input type="number" step="0.01" value={secKc} onChange={e => setSecKc(e.target.value)} style={inputStyle} placeholder="ej. 0.85" /></div>
          </div>

          {Number(secNumLineas) > 0 && Number(secDistGoteros) > 0 && Number(secDistLineas) > 0 && (
            <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', marginBottom: 8 }}>
              ≈ {Math.round(calcularGoterosPorHa({ ...(sectorEditar || {} as SectorRiego), numLineasGoteo: secNumLineas, distanciaGoterosM: secDistGoteros, distanciaLineasM: secDistLineas } as SectorRiego))} goteros/ha
            </div>
          )}

          <div style={{ marginBottom: 10 }}><label style={labelStyle}>Observaciones</label><input value={secObs} onChange={e => setSecObs(e.target.value)} style={inputStyle} /></div>

          {secError && <div style={{ color: '#fca5a5', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 8 }}>{secError}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={guardarSector} style={{ padding: '8px 16px', borderRadius: 6, background: 'var(--blue)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>Guardar sector</button>
            <button onClick={() => { setFormSector(null); setSectorEditar(null) }} style={{ padding: '8px 16px', borderRadius: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Cancelar</button>
          </div>
      </div>
      </>
      ) : null}
    </div>
  )
}
