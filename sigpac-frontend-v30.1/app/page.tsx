'use client'

import dynamic from 'next/dynamic'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { supabase } from './lib/supabaseClient'
import LoginScreen from './LoginScreen'
import type { Session } from '@supabase/supabase-js'
import {
  RecintoRef,
  extraerRecinto,
  formatRefSigpac,
  fusionarPoligonosDeFeatures,
  construirEstadoDesdeFeatures,
} from './lib/sigpac'
import { getEsriPreviewUrl } from './lib/parcelaUtils'
import { calcularMisPermisos, puedeVerPestana } from './lib/permisosSesion'
const ImportarParcelasExcel = dynamic(() => import('./components/ImportarParcelasExcel'), { ssr: false })
const RiegoTab = dynamic(() => import('./components/RiegoTab'), { ssr: false })
const DonutChart = dynamic(() => import('./components/DonutChart'), { ssr: false })

const MapView = dynamic(() => import('./components/MapView'), { ssr: false })
const PermisosTab = dynamic(() => import('./components/PermisosTab'), { ssr: false })

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'

// Carga jsPDF + el plugin de tablas por CDN, igual que se hace con leaflet-draw/turf en
// otros componentes de Kampo, sin tocar package.json.
let jsPdfPromise: Promise<any> | null = null
const cargarJsPDF = (): Promise<any> => {
  if ((window as any).jspdf?.jsPDF && (window as any).jspdf.jsPDF.API.autoTable) return Promise.resolve((window as any).jspdf.jsPDF)
  if (jsPdfPromise) return jsPdfPromise
  jsPdfPromise = new Promise((resolve, reject) => {
    const scriptCore = document.createElement('script')
    scriptCore.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
    scriptCore.onload = () => {
      const scriptTable = document.createElement('script')
      scriptTable.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'
      scriptTable.onload = () => resolve((window as any).jspdf.jsPDF)
      scriptTable.onerror = reject
      document.head.appendChild(scriptTable)
    }
    scriptCore.onerror = reject
    document.head.appendChild(scriptCore)
  })
  return jsPdfPromise
}

const ZONAS_NDVI = [
  { zona: 1,  rango: '0.90 – 1.00', color: '#005000' },
  { zona: 2,  rango: '0.80 – 0.89', color: '#007800' },
  { zona: 3,  rango: '0.70 – 0.79', color: '#22aa22' },
  { zona: 4,  rango: '0.60 – 0.69', color: '#64c832' },
  { zona: 5,  rango: '0.50 – 0.59', color: '#dcdc00' },
  { zona: 6,  rango: '0.40 – 0.49', color: '#ffb400' },
  { zona: 7,  rango: '0.30 – 0.39', color: '#ff7800' },
  { zona: 8,  rango: '0.20 – 0.29', color: '#dc3c00' },
  { zona: 9,  rango: '0.10 – 0.19', color: '#c81e1e' },
  { zona: 10, rango: '0.00 – 0.09', color: '#8c0000' },
]

const ZONA_PCT: Record<number, number> = {1:100,2:90,3:80,4:70,5:60,6:50,7:40,8:30,9:15,10:5}

type Estado = 'idle' | 'cargando_parcela' | 'parcela_ok' | 'buscando' | 'cargando_rgb' | 'calculando_zonas' | 'done' | 'error'
type ModoVista = 'ninguna' | 'rgb' | 'zonas'
type Pestaña = 'mapa' | 'mis_parcelas' | 'tratamientos' | 'personal' | 'equipos' | 'riego' | 'tareas' | 'permisos'

const TIPOS_TRATAMIENTO = [
  'Herbicida', 'Fungicida', 'Insecticida', 'Abonado',
  'Corrector nutricional', 'Bioestimulante', 'Regulador de crecimiento', 'Otro'
]

const FUNCIONES_PERSONAL = [
  'Asesor en gestión integrada de plagas',
  'Asesor fitosanitario',
  'Ingeniero agrónomo / Ingeniero técnico agrícola',
  'Encargado',
  'Peón',
  'Aplicador de fitosanitarios',
  'Veterinario',
  'Gestor',
]

const FUNCIONES_RECOMENDADOR = ['Asesor en gestión integrada de plagas','Asesor fitosanitario','Ingeniero agrónomo / Ingeniero técnico agrícola','Gestor']
const FUNCIONES_APLICADOR = ['Aplicador de fitosanitarios','Peón','Encargado']

const TIPOS_CONTRATO = ['Fijo','Fijo discontinuo','Externo']

const TIPOS_MAQUINARIA = [
  'Tractor', 'Apero', 'Cosechadora', 'Pulverizador', 'Abonadora', 'Sembradora',
  'Plantadora / Trasplantadora', 'Equipo de riego', 'Remolque', 'Manipulador telescópico',
  'Carretilla elevadora', 'Motocultor', 'Desbrozadora', 'Trituradora', 'Poda',
  'Plataforma elevadora', 'Vehículo agrícola', 'Otro',
]

const SUBTIPOS_APERO = [
  'Arado de vertedera', 'Arado de discos', 'Chisel', 'Subsolador', 'Cultivador',
  'Grada de discos', 'Grada rotativa', 'Rodillo', 'Vibrocultivador', 'Fresadora',
  'Escardadora', 'Desbrozadora', 'Trituradora de restos', 'Trituradora forestal',
  'Atomizador', 'Barra de tratamientos', 'Pulverizador suspendido', 'Pulverizador arrastrado',
  'Pulverizador autopropulsado', 'Abonadora centrífuga', 'Abonadora pendular',
  'Sembradora de cereal', 'Sembradora monograno', 'Plantadora', 'Trasplantadora',
  'Empacadora', 'Henificadora', 'Rastrillo hilerador', 'Remolque agrícola', 'Cuba de agua',
  'Cuba de purín', 'Niveladora', 'Pala agrícola', 'Pinzas', 'Horquillas', 'Otro',
]

const SUBTIPOS_COSECHADORA = [
  'Cereales', 'Maíz', 'Algodón', 'Remolacha', 'Patata', 'Aceituna', 'Almendra', 'Uva', 'Forraje',
]

const subtiposPorTipo = (tipo: string): string[] => {
  if (tipo === 'Apero') return SUBTIPOS_APERO
  if (tipo === 'Cosechadora') return SUBTIPOS_COSECHADORA
  return []
}

const ICONO_FUNCION: Record<string, string> = {
  'Asesor en gestión integrada de plagas': '🌿',
  'Asesor fitosanitario': '🌿',
  'Ingeniero agrónomo / Ingeniero técnico agrícola': '📐',
  'Encargado': '👷',
  'Peón': '🧑‍🌾',
  'Aplicador de fitosanitarios': '🚿',
  'Veterinario': '🐄',
  'Gestor': '📋',
}

interface Personal {
  id: string
  nombre: string
  dni: string
  telefono: string
  direccion: string
  nroRopo: string
  nivelCapacitacion: string
  funciones: string[]          // Array de funciones (puede tener varias)
  tipoContrato: string
  activo: boolean
  fechaRegistro: string
  predeterminadoAplicador: boolean
  predeterminadoRecomendador: boolean
  fincaId?: string
  rol?: string                          // Fase 2: 'empresa' | 'encargado' | 'ingeniero' | 'tecnico' | 'peon'
  permisos?: Record<string, boolean>    // Fase 2: checklist individual, independiente por persona
  estadoAcceso?: string                 // Fase 3: 'sin_acceso' | 'pendiente' | 'activo'
  authUserId?: string                   // Fase 4: para saber si el logueado actual es esta persona
  fincaIds?: string[]                   // Fase 5: fincas asignadas — vacío = sin restricción
}

type UnidadDosis = 'L/ha' | 'Kg/ha' | 'g/ha' | 'mL/hL' | 'L/hL' | 'g/hL' | 'Kg/hL' | '%(v/v)' | '%(p/p)' | 'g/m²' | 'g/kg semilla' | 'mL/kg semilla' | 'mL/m²'| 'L/m²' | 'mg/m²'

interface Equipo {
  id: string
  tipo: string              // Tractor, Apero, Cosechadora, ...
  subtipo?: string          // solo si el tipo tiene subcategorías
  nombre: string
  dniCif?: string
  nroRoma?: string
  titularidad?: 'Propia' | 'Externa' | ''
  fincaId?: string          // solo si titularidad === 'Propia'
  observaciones?: string
  fechaRegistro: string
  fechaAdquisicion?: string        // Cuaderno de campo, sección 1.3
  fechaUltimaInspeccion?: string   // Cuaderno de campo, sección 1.3
}

// - HORAS DE TRABAJO -
// Un tramo de trabajo dedicado a una tarea/tratamiento: un día concreto, de una hora a otra.
interface DiaHorario {
  id: string
  fecha: string       // 'YYYY-MM-DD'
  horaInicio: string  // 'HH:MM'
  horaFin: string     // 'HH:MM'
}

interface Tratamiento {
  id: string
  tipo: string
  producto: string
  materiaActiva: string
  numRegistro?: string      // Nº de registro oficial del producto fitosanitario (cuaderno de campo, secciones 3.1/3.2)
  dosis: string
  unidadDosis: UnidadDosis;
  dosisMaxima: string
  unidadDosisMaxima?: UnidadDosis;
  aplicMaxima: string
  litrosCaldoHa?: string    // Litros de caldo aplicados por hectárea (para %(v/v), %(p/p), mL/hL, L/hL, g/hL, Kg/hL)
  kgSemillaHa?: string      // Kg de semilla sembrada por hectárea (para g/kg semilla, mL/kg semilla)
  porcentajeAplicado?: string   // % de la superficie de la parcela al que se aplica realmente (por defecto 100)
  porcentajeMaximo?: string     // % máximo permitido por la etiqueta del producto (opcional)
  densidad?: string         // Kg/L del producto. Por defecto 1. Se usa para convertir entre masa y volumen.
  fecha: string
  aplicador: string
  observaciones: string
  parcelaIds: string[]
  equipoIds?: string[]      // Hasta 2 equipos/maquinaria usados en el tratamiento
  fechaRegistro: string
  mrlResultado?: any
  recomendadoPor?: string
  aplicadoPor?: string
  fincaId?: string
  cultivoTrat?: string
  campanaId?: string
  tareaId?: string
  problemaFitosanitario?: string          // Plaga/enfermedad tratada (cuaderno de campo, sección 3.1)
  eficacia?: 'Buena' | 'Regular' | 'Mala' | ''  // Eficacia de la intervención (cuaderno de campo, sección 3.1)
  horasTrabajadas?: DiaHorario[]  // Días/horario dedicados a realizar este tratamiento
  horasPersonalId?: string        // Trabajador al que se le imputan esas horas
}

const TIPOS_TAREA = ['Tratamiento fitosanitario', 'Abonado', 'Poda', 'Laboreo', 'Siembra', 'Recolección', 'Riego', 'Mantenimiento', 'Otros'] as const

interface Tarea {
  id: string
  tipo: string
  tipoOtro?: string
  estado: 'pendiente' | 'realizada'
  campanaId?: string
  fincaId?: string
  parcelaIds: string[]
  creadoPor?: string
  ejecutorId?: string
  fechaPrevista: string
  equipoIds: string[]
  comentarios: string
  tratamientoId?: string
  borradorTratamiento?: any
  fechaRegistro: string
  horasTrabajadas?: DiaHorario[]  // Días/horario dedicados a realizar esta tarea (solo tareas NO fitosanitarias; las fito guardan sus horas en el Tratamiento vinculado)
  horasPersonalId?: string        // Trabajador al que se le imputan esas horas
}

// Días que faltan hasta la fecha prevista (negativo si ya pasó)
const diasHastaTarea = (fechaPrevista: string): number => {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
  const f = new Date(fechaPrevista + 'T00:00:00')
  return Math.round((f.getTime() - hoy.getTime()) / 86400000)
}

// Color de prioridad de una tarea: verde si realizada, rojo si pendiente y quedan ≤5 días
// (incluye vencidas), naranja si pendiente y quedan más de 5 días.
const colorPrioridadTarea = (t: Tarea): '#3ddc6e' | '#ff6b6b' | '#f59e0b' => {
  if (t.estado === 'realizada') return '#3ddc6e'
  return diasHastaTarea(t.fechaPrevista) <= 5 ? '#ff6b6b' : '#f59e0b'
}

// - HORAS DE TRABAJO: helpers -
const nuevoDiaHorario = (): DiaHorario => ({
  id: `dh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  fecha: '', horaInicio: '', horaFin: '',
})

// Minutos entre dos horas 'HH:MM'. Si la hora de fin no es posterior a la de inicio se
// asume que el turno cruza la medianoche (p. ej. 22:00 a 02:00).
const minutosEntreHoras = (horaInicio: string, horaFin: string): number => {
  if (!horaInicio || !horaFin) return 0
  const [h1, m1] = horaInicio.split(':').map(Number)
  const [h2, m2] = horaFin.split(':').map(Number)
  if ([h1, m1, h2, m2].some(n => Number.isNaN(n))) return 0
  let mins = (h2 * 60 + m2) - (h1 * 60 + m1)
  if (mins <= 0) mins += 24 * 60
  return mins
}

const formatDuracion = (mins: number): string => {
  const h = Math.floor(mins / 60), m = mins % 60
  return `${h} Hora${h === 1 ? '' : 's'} ${m} Min`
}

const totalMinutosDias = (dias: DiaHorario[]): number =>
  dias.reduce((acc, d) => acc + minutosEntreHoras(d.horaInicio, d.horaFin), 0)


// - CONVERSIÓN DE UNIDADES DE DOSIS -
// Unidades cuya conversión a "por hectárea" depende de cuántos litros de caldo se aplican por ha
const UNIDADES_NECESITAN_CALDO: UnidadDosis[] = ['mL/hL', 'L/hL', 'g/hL', 'Kg/hL', '%(v/v)', '%(p/p)']
// Unidades cuya conversión a "por hectárea" depende de la dosis de siembra (kg semilla/ha)
const UNIDADES_NECESITAN_SEMILLA: UnidadDosis[] = ['g/kg semilla', 'mL/kg semilla']

const unidadNecesitaCaldo = (u: UnidadDosis) => UNIDADES_NECESITAN_CALDO.includes(u)
const unidadNecesitaSemilla = (u: UnidadDosis) => UNIDADES_NECESITAN_SEMILLA.includes(u)

interface ConversionContexto {
  litrosCaldoHa?: number   // litros de caldo aplicados por hectárea
  kgSemillaHa?: number     // kg de semilla sembrada por hectárea
}

interface DosisCanonica {
  valor: number                    // valor en la unidad canónica (L/ha si fase='volumen', Kg/ha si fase='masa')
  fase: 'volumen' | 'masa'
  ok: boolean                      // false si faltan datos para poder convertir
  motivo?: string
}

// Convierte una dosis (valor + unidad) a su equivalente canónico por hectárea: L/ha (volumen) o Kg/ha (masa)
function dosisACanonico(valor: number, unidad: UnidadDosis, ctx: ConversionContexto): DosisCanonica {
  if (!isFinite(valor)) return { valor: 0, fase: 'volumen', ok: false, motivo: 'Valor inválido' }
  switch (unidad) {
    case 'L/ha': return { valor, fase: 'volumen', ok: true }
    case 'Kg/ha': return { valor, fase: 'masa', ok: true }
    case 'g/ha': return { valor: valor / 1000, fase: 'masa', ok: true }
    case 'L/m²': return { valor: valor * 10000, fase: 'volumen', ok: true }
    case 'mL/m²': return { valor: (valor * 10000) / 1000, fase: 'volumen', ok: true }
    case 'g/m²': return { valor: (valor * 10000) / 1000, fase: 'masa', ok: true }
    case 'mg/m²': return { valor: (valor * 10000) / 1000000, fase: 'masa', ok: true }
    case 'mL/hL': case 'L/hL': case 'g/hL': case 'Kg/hL': {
      const fase: 'volumen' | 'masa' = (unidad === 'mL/hL' || unidad === 'L/hL') ? 'volumen' : 'masa'
      if (!ctx.litrosCaldoHa || ctx.litrosCaldoHa <= 0) return { valor: 0, fase, ok: false, motivo: 'Falta indicar litros de caldo/ha' }
      const hLPorHa = ctx.litrosCaldoHa / 100
      if (unidad === 'mL/hL') return { valor: (valor * hLPorHa) / 1000, fase, ok: true }
      if (unidad === 'g/hL') return { valor: (valor * hLPorHa) / 1000, fase, ok: true }
      return { valor: valor * hLPorHa, fase, ok: true } // L/hL, Kg/hL
    }
    case '%(v/v)': {
      if (!ctx.litrosCaldoHa || ctx.litrosCaldoHa <= 0) return { valor: 0, fase: 'volumen', ok: false, motivo: 'Falta indicar litros de caldo/ha' }
      return { valor: (valor / 100) * ctx.litrosCaldoHa, fase: 'volumen', ok: true }
    }
    case '%(p/p)': {
      if (!ctx.litrosCaldoHa || ctx.litrosCaldoHa <= 0) return { valor: 0, fase: 'masa', ok: false, motivo: 'Falta indicar litros de caldo/ha' }
      // Se asume densidad del caldo ≈ 1 Kg/L (base agua)
      return { valor: (valor / 100) * ctx.litrosCaldoHa, fase: 'masa', ok: true }
    }
    case 'g/kg semilla': {
      if (!ctx.kgSemillaHa || ctx.kgSemillaHa <= 0) return { valor: 0, fase: 'masa', ok: false, motivo: 'Falta indicar kg semilla/ha' }
      return { valor: (valor * ctx.kgSemillaHa) / 1000, fase: 'masa', ok: true }
    }
    case 'mL/kg semilla': {
      if (!ctx.kgSemillaHa || ctx.kgSemillaHa <= 0) return { valor: 0, fase: 'volumen', ok: false, motivo: 'Falta indicar kg semilla/ha' }
      return { valor: (valor * ctx.kgSemillaHa) / 1000, fase: 'volumen', ok: true }
    }
    default: return { valor: 0, fase: 'volumen', ok: false, motivo: 'Unidad desconocida' }
  }
}

// Separa un valor canónico en sus dos "fases" (masa y volumen) usando la densidad (Kg/L, por defecto 1)
function fasesCanonico(valorCanon: number, fase: 'volumen' | 'masa', densidad: number) {
  const dens = densidad > 0 ? densidad : 1
  if (fase === 'masa') return { masa: valorCanon, volumen: valorCanon / dens }
  return { masa: valorCanon * dens, volumen: valorCanon }
}

// Convierte un valor canónico "por hectárea" a una unidad simple de dosis por hectárea o por m²
// (no soporta unidades relativas a caldo/semilla como destino, ya que no tiene sentido como dosis máxima declarada)
function canonicoAUnidadPorHa(valorCanon: number, fase: 'volumen' | 'masa', unidadDestino: UnidadDosis, densidad: number): number | null {
  const { masa, volumen } = fasesCanonico(valorCanon, fase, densidad)
  switch (unidadDestino) {
    case 'L/ha': return volumen
    case 'Kg/ha': return masa
    case 'g/ha': return masa * 1000
    case 'L/m²': return volumen / 10000
    case 'mL/m²': return (volumen * 1000) / 10000
    case 'g/m²': return (masa * 1000) / 10000
    case 'mg/m²': return (masa * 1000000) / 10000
    default: return null
  }
}

// Convierte un total canónico (Kg o L, ya multiplicado por la superficie tratada) a una unidad de stock
function canonicoATotalStock(valorCanon: number, fase: 'volumen' | 'masa', unidadDestino: 'L' | 'Kg' | 'g' | 'mg' | 'mL', densidad: number): number {
  const { masa, volumen } = fasesCanonico(valorCanon, fase, densidad)
  switch (unidadDestino) {
    case 'L': return volumen
    case 'mL': return volumen * 1000
    case 'Kg': return masa
    case 'g': return masa * 1000
    case 'mg': return masa * 1000000
  }
}

interface StockItem {
  id: string
  producto: string
  comprado: string
  unidad: 'L' | 'Kg' | 'g' | 'mg' | 'mL' 
  fechaRegistro: string
}

interface FitoProducto {
  id: number
  nombre: string
  num_registro: string
  titular: string
  formulado: string
  estado: string
  fecha_caducidad: string
  observaciones: string
  eliminado: boolean
  fecha_eliminacion?: string
  tiene_pdf?: boolean
  pdf_url?: string
  ficha_web_url?: string
}

interface Finca {
  id: string
  nombre: string
  descripcion: string
  fechaRegistro: string
}

interface Campana {
  id: string
  nombre: string
  fechaInicio: string
  fechaFin: string
}

// Un cultivo anterior de una parcela, conservado junto a la campaña en la que
// estuvo, para poder registrar tratamientos olvidados de campañas ya cerradas
// aunque la parcela ya tenga otro cultivo distinto ahora.
interface HistoricoCultivo {
  id: string
  parcelaId: string
  cultivo: string
  variedad?: string
  campanaId?: string
  fechaRegistro: string
}

// Una campaña ha finalizado cuando hoy es posterior a su fecha de fin
const campanaFinalizada = (c?: Campana | null): boolean => {
  if (!c) return false
  const hoy = new Date().toISOString().slice(0, 10)
  return hoy > c.fechaFin
}

// --- Detección de recintos SIGPAC bajo una parcela dibujada a mano ---
// El backend solo expone una consulta por punto (/sigpac/punto), no una consulta
// espacial por polígono. Para aproximar "qué recintos hay bajo el dibujo" sin tocar
// el backend, generamos una rejilla de puntos dentro del polígono dibujado y
// consultamos cada uno; los recintos SIGPAC distintos que aparezcan son los
// recintos "detectados". Es una aproximación por muestreo: un recinto muy
// pequeño o que solo roce el borde del dibujo por una franja estrecha podría no
// contener ningún punto de la rejilla y quedar sin detectar.

// Ray-casting: ¿el punto (lon,lat) está dentro del anillo de coordenadas [lon,lat][]?
const puntoEnAnillo = (lon: number, lat: number, anillo: number[][]): boolean => {
  let dentro = false
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i]
    const [xj, yj] = anillo[j]
    const interseca = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (interseca) dentro = !dentro
  }
  return dentro
}

const puntoEnGeometria = (lon: number, lat: number, geom: any): boolean => {
  if (!geom) return false
  if (geom.type === 'Polygon') return puntoEnAnillo(lon, lat, geom.coordinates[0])
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((poly: any) => puntoEnAnillo(lon, lat, poly[0]))
  return false
}

// Genera hasta `maxPuntos` puntos [lat, lon] dentro de la geometría, mediante una
// rejilla regular sobre su bbox filtrada por punto-en-polígono.
const generarPuntosMuestra = (geom: any, maxPuntos = 40): [number, number][] => {
  const anillos: number[][][] = geom.type === 'Polygon' ? [geom.coordinates[0]] : (geom.coordinates || []).map((p: any) => p[0])
  const todos = anillos.flat()
  if (!todos.length) return []
  const lons = todos.map((c: number[]) => c[0])
  const lats = todos.map((c: number[]) => c[1])
  const minLon = Math.min(...lons), maxLon = Math.max(...lons)
  const minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const lado = Math.max(4, Math.round(Math.sqrt(maxPuntos)))
  const pasoLon = (maxLon - minLon) / lado || 0.0001
  const pasoLat = (maxLat - minLat) / lado || 0.0001

  const puntos: [number, number][] = []
  for (let lat = minLat + pasoLat / 2; lat <= maxLat && puntos.length < maxPuntos; lat += pasoLat) {
    for (let lon = minLon + pasoLon / 2; lon <= maxLon && puntos.length < maxPuntos; lon += pasoLon) {
      if (puntoEnGeometria(lon, lat, geom)) puntos.push([lat, lon])
    }
  }
  if (!puntos.length) {
    // Rejilla demasiado gruesa para un dibujo muy pequeño/estrecho: probamos el centroide
    puntos.push([lats.reduce((a: number, b: number) => a + b, 0) / lats.length, lons.reduce((a: number, b: number) => a + b, 0) / lons.length])
  }
  return puntos
}

// Consulta /sigpac/punto en cada punto de muestra y devuelve los recintos SIGPAC
// distintos encontrados bajo la geometría dibujada.
const detectarRecintosBajoDibujo = async (geom: any): Promise<RecintoRef[]> => {
  const puntos = generarPuntosMuestra(geom, 40)
  const resultados = await Promise.allSettled(
    puntos.map(([lat, lon]) =>
      fetch(`${BACKEND}/sigpac/punto?lat=${lat}&lon=${lon}`).then(r => (r.ok ? r.json() : null))
    )
  )
  const vistos = new Set<string>()
  const recintos: RecintoRef[] = []
  resultados.forEach(res => {
    if (res.status !== 'fulfilled' || !res.value) return
    const props = res.value.features?.[0]?.properties
    if (!props) return
    const ref = extraerRecinto(props)
    const clave = formatRefSigpac(ref)
    if (clave.includes('?') || vistos.has(clave)) return
    vistos.add(clave)
    recintos.push(ref)
  })
  return recintos
}

interface ParcelaGuardada {
  id: string
  nombre: string
  cultivo: string
  variedad?: string
  fechaPlantacion: string
  infoAdicional: string
  geojson: any
  parcelaInfo: any
  supHa: number
  imagenPreview: string | null
  fechaGuardado: string
  fincaId?: string
  campanaId?: string
  // Datos agroambientales para el cuaderno de campo (sección 2.1) — opcionales
  secanoRegadio?: 'SEC' | 'ASP' | 'LOC' | 'GRA' | ''
  tipoCultivoAmbiente?: 'AL' | 'M' | 'BP' | 'INV' | ''
  sistAsesoramientoGip?: 'AE' | 'PI' | 'CP' | 'ATRIAS' | 'AS' | 'NO' | ''
}

// "CULTIVO (VARIEDAD)" si hay variedad, o solo "CULTIVO" si no — para no cambiar nada
// visualmente cuando no se ha rellenado ninguna variedad
const formatCultivoVariedad = (cultivo: string, variedad?: string): string =>
  variedad && variedad.trim() ? `${cultivo} (${variedad.trim()})` : cultivo

// Datos de la explotación agraria (titular/empresa + agrupación de asesoramiento), para
// rellenar automáticamente la cabecera del Cuaderno de Explotación (secciones 1.1 y 1.4).
// Un único registro por usuario.
interface DatosExplotacion {
  nombreRazonSocial: string
  nif: string
  nroRegExplotNacional: string
  nroRegExplotAutonomico: string
  direccion: string
  localidad: string
  cPostal: string
  provincia: string
  telefonoFijo: string
  telefonoMovil: string
  email: string
  // Titular o representante (si es distinto del anterior)
  titularNombre: string
  titularNif: string
  titularDireccion: string
  titularLocalidad: string
  titularCPostal: string
  titularProvincia: string
  titularTipoRepresentacion: string
  titularTelefono: string
  titularEmail: string
  // 1.4 Agrupación o entidad de asesoramiento
  agrupacionNombre: string
  agrupacionNif: string
  agrupacionNroIdentificacion: string
  agrupacionTipoExplotacion: string
}

const DATOS_EXPLOTACION_VACIO: DatosExplotacion = {
  nombreRazonSocial: '', nif: '', nroRegExplotNacional: '', nroRegExplotAutonomico: '',
  direccion: '', localidad: '', cPostal: '', provincia: '', telefonoFijo: '', telefonoMovil: '', email: '',
  titularNombre: '', titularNif: '', titularDireccion: '', titularLocalidad: '', titularCPostal: '',
  titularProvincia: '', titularTipoRepresentacion: '', titularTelefono: '', titularEmail: '',
  agrupacionNombre: '', agrupacionNif: '', agrupacionNroIdentificacion: '', agrupacionTipoExplotacion: '',
}

export default function Home() {
  // - Autenticación -
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [dataLoaded, setDataLoaded] = useState(false)

  // - Responsive -
  const [isMobile, setIsMobile] = useState(false)
  const [panelAbierto, setPanelAbierto] = useState(false)
  const [menuAbierto, setMenuAbierto] = useState(false)
  const [menuUsuarioAbierto, setMenuUsuarioAbierto] = useState(false)

  // - Navegación -
  const [pestana, setPestana] = useState<Pestaña>('mapa')

  // - Estado mapa -
  const [estado, setEstado] = useState<Estado>('idle')
  const [error, setError] = useState('')
  const [backendOk, setBackendOk] = useState<boolean | null>(null)
  const [showVerifRomaRopo, setShowVerifRomaRopo] = useState(false)
  const [verifNif, setVerifNif] = useState('')
  const [verifRegistro, setVerifRegistro] = useState<'ropo' | 'roma'>('ropo')
  const [verifLoading, setVerifLoading] = useState(false)
  const [verifResultado, setVerifResultado] = useState<any>(null)
  const [verifError, setVerifError] = useState('')
  const [seleccionando, setSeleccionando] = useState(false)
  const [anadiendoRecinto, setAnadiendoRecinto] = useState(false)
  const [sigpacRefInput, setSigpacRefInput] = useState('')
  const [errorSigpacRef, setErrorSigpacRef] = useState('')

  const [parcGeojson, setParcGeojson] = useState<any>(null)
  const [parcelaInfo, setParcelaInfo] = useState<any>(null)
  const [parcelaSupHa, setParcelaSupHa] = useState<number>(0)

  // Refs "espejo" del estado anterior: permiten que handleAnadirRecinto y el
  // enrutador de clics del mapa tengan siempre una referencia ESTABLE (deps [])
  // pero lean el valor más reciente, igual que hace handleMapClick hoy.
  const parcelaInfoRef = useRef<any>(null)
  const parcGeojsonRef = useRef<any>(null)
  const anadiendoRecintoRef = useRef(false)
  useEffect(() => { parcelaInfoRef.current = parcelaInfo }, [parcelaInfo])
  useEffect(() => { parcGeojsonRef.current = parcGeojson }, [parcGeojson])
  useEffect(() => { anadiendoRecintoRef.current = anadiendoRecinto }, [anadiendoRecinto])

  const [fechaInicio, setFechaInicio] = useState('2024-05-01')
  const [fechaFin, setFechaFin] = useState('2024-08-31')
  const [productos, setProductos] = useState<any[]>([])
  const [productoSel, setProductoSel] = useState('')

  const [imagenUrl, setImagenUrl] = useState<string | null>(null)
  const [modoVista, setModoVista] = useState<ModoVista>('ninguna')

  const [zonasData, setZonasData] = useState<any[]>([])
  const [mododibujo, setMododibujo] = useState(false)
  const [historico, setHistorico] = useState<any[]>([])
  const [mostrarHistorico, setMostrarHistorico] = useState(false)
  const [contornosUrl, setContornosUrl] = useState<string | null>(null)
  const [contornosStats, setContornosStats] = useState<any>(null)
  const [calculandoContornos, setCalculandoContornos] = useState(false)
  const [mdtColorUrl, setMdtColorUrl] = useState<string | null>(null)
  const [mdtColorStats, setMdtColorStats] = useState<any>(null)
  const [calculandoMdtColor, setCalculandoMdtColor] = useState(false)
  // Solo un mapa del MDT (curvas de nivel o mapa de colores) puede estar activo/visible a la vez
  const [mapaActivo, setMapaActivo] = useState<'contornos' | 'mdtColor' | null>(null)
  const [mapaVisible, setMapaVisible] = useState(false)
  const [kgPorHa, setKgPorHa] = useState<Record<string, string>>({})
  const [produccion, setProduccion] = useState<any>(null)

  // - Mis Parcelas -
  const [misParcelas, setMisParcelas] = useState<ParcelaGuardada[]>([])
  const [formularioVisible, setFormularioVisible] = useState(false)
  const [parcelaEditar, setParcelaEditar] = useState<ParcelaGuardada | null>(null)
  const [formNombre, setFormNombre] = useState('')
  const [formCultivo, setFormCultivo] = useState('')
  const [formVariedad, setFormVariedad] = useState('')
  const [formFechaPlantacion, setFormFechaPlantacion] = useState('')
  const [formInfoAdicional, setFormInfoAdicional] = useState('')
  const [formError, setFormError] = useState('')
  const [parcelaVistaEnMapa, setParcelaVistaEnMapa] = useState<any>(null)
  const [fincaVistaEnMapa, setFincaVistaEnMapa] = useState<Finca | null>(null)
  const [imagenPreviewForm, setImagenPreviewForm] = useState<string | null>(null)
  const [formFincaId, setFormFincaId] = useState('')
  const [formCampanaId, setFormCampanaId] = useState('')
  const [formSecanoRegadio, setFormSecanoRegadio] = useState<'' | 'SEC' | 'ASP' | 'LOC' | 'GRA'>('')
  const [formTipoCultivoAmbiente, setFormTipoCultivoAmbiente] = useState<'' | 'AL' | 'M' | 'BP' | 'INV'>('')
  const [formSistAsesoramientoGip, setFormSistAsesoramientoGip] = useState<'' | 'AE' | 'PI' | 'CP' | 'ATRIAS' | 'AS' | 'NO'>('')

  // - Tratamientos -
  const [tratamientos, setTratamientos] = useState<Tratamiento[]>([])
  const [parcelaDetalleId, setParcelaDetalleId] = useState<string | null>(null)
  const [riegoSectorFocus, setRiegoSectorFocus] = useState<string | null>(null)
  const parcelaDetalleRef = useRef<HTMLDivElement>(null)
  // Form tratamiento
  const [formTrat, setFormTrat] = useState(false)
  const [tratEditar, setTratEditar] = useState<Tratamiento | null>(null)
  const [tratParcelaCtx, setTratParcelaCtx] = useState<string | null>(null) // parcela ctx si viene desde ficha
  const [tTipo, setTTipo] = useState('')
  const [tCampanaId, setTCampanaId] = useState('')
  const [tProducto, setTProducto] = useState('')
  const [tMateriaActiva, setTMateriaActiva] = useState('')
  const [tNumRegistro, setTNumRegistro] = useState('')      // Nº de registro oficial del producto fitosanitario (cuaderno de campo, secciones 3.1/3.2)
  const [tDosis, setTDosis] = useState('')
  const [mrlResultado, setMrlResultado] = useState<any>(null)
  const [consultandoMrl, setConsultandoMrl] = useState(false)
  const [tUnidad, setTUnidad] = useState<UnidadDosis>('L/ha')
  const [tLitrosCaldoHa, setTLitrosCaldoHa] = useState('')
  const [tKgSemillaHa, setTKgSemillaHa] = useState('')
  const [tPorcentajeAplicado, setTPorcentajeAplicado] = useState('100')
  const [tPorcentajeMaximo, setTPorcentajeMaximo] = useState('')
  const [tDensidad, setTDensidad] = useState('1')
  const [tFecha, setTFecha] = useState('')
  const [tAplicador, setTAplicador] = useState('')
  const [tObs, setTObs] = useState('')
  const [tProblema, setTProblema] = useState('')
  const [tEficacia, setTEficacia] = useState<'' | 'Buena' | 'Regular' | 'Mala'>('')
  const [tParcelas, setTParcelas] = useState<string[]>([])
  const [tError, setTError] = useState('')
  const [tratExpandido, setTratExpandido] = useState<string | null>(null)
  const [climaAbierto, setClimaAbierto] = useState(false)
  const [climaDatos, setClimaDatos] = useState<any>(null)
  const [climaCargando, setClimaCargando] = useState(false)
  const [climaError, setClimaError] = useState('')
  // Filtros
  const [filtroTipo, setFiltroTipo] = useState('')
  const [filtroProducto, setFiltroProducto] = useState('')
  const [filtroCultivoTrat, setFiltroCultivoTrat] = useState('')
  const [tDosisMaxima, setTDosisMaxima] = useState('')
  const [tUnidadDosisMaxima, setTUnidadDosisMaxima] = useState<UnidadDosis>('L/ha')
  const [tAplicMaxima, setTAplicMaxima] = useState('')

  // - Subpestañas de TRATAMIENTOS -
  const [subTabTrat, setSubTabTrat] = useState<'realizados' | 'estadistica' | 'stock'>('realizados')
  const [statExpandido, setStatExpandido] = useState<string | null>(null)
  const [filtroCampanaEstadistica, setFiltroCampanaEstadistica] = useState('')
  const [filtroFincaEstadistica, setFiltroFincaEstadistica] = useState('')

  // - Stock -
  const [stock, setStock] = useState<StockItem[]>([])
  const [formStock, setFormStock] = useState(false)
  const [stockProducto, setStockProducto] = useState('')
  const [stockCantidad, setStockCantidad] = useState('')
  const [stockUnidad, setStockUnidad] = useState<'L' | 'Kg'>('L')

  // - Fincas -
  const [fincas, setFincas] = useState<Finca[]>([])
  const [formFinca, setFormFinca] = useState(false)
  const [fincaEditar, setFincaEditar] = useState<Finca | null>(null)
  const [campanaEditar, setCampanaEditar] = useState<Campana | null>(null)
  const [importarExcelVisible, setImportarExcelVisible] = useState(false)
  const [fNombre, setFNombre] = useState('')
  const [fDescripcion, setFDescripcion] = useState('')
  const [fError, setFError] = useState('')
  const [filtroFinca, setFiltroFinca] = useState('')
  const [filtroCultivoParcelas, setFiltroCultivoParcelas] = useState('')
  const [filtroFincaTrat, setFiltroFincaTrat] = useState('')
  const [filtroFincaPersonal, setFiltroFincaPersonal] = useState('')

  // - Campañas -
  const [campanas, setCampanas] = useState<Campana[]>([])
  const [tareas, setTareas] = useState<Tarea[]>([])
  const [tareaSeleccionadaId, setTareaSeleccionadaId] = useState<string | null>(null)
  const [filtroEstadoTarea, setFiltroEstadoTarea] = useState<'' | 'pendiente' | 'realizada'>('')
  const [filtroCampanaTarea, setFiltroCampanaTarea] = useState('')
  const [filtroFincaTarea, setFiltroFincaTarea] = useState('')
  const [filtroPersonalTarea, setFiltroPersonalTarea] = useState('')
  const [filtroTipoTarea, setFiltroTipoTarea] = useState('')
  // Formulario de "nueva tarea": primer paso elige el tipo
  const [formNuevaTareaVisible, setFormNuevaTareaVisible] = useState(false)
  const [nuevaTareaTipo, setNuevaTareaTipo] = useState('')
  // Formulario general (todos los tipos salvo Tratamiento fitosanitario)
  const [tarFormVisible, setTarFormVisible] = useState(false)
  const [tarEditar, setTarEditar] = useState<Tarea | null>(null)
  const [tarTipo, setTarTipo] = useState('')
  const [tarTipoOtro, setTarTipoOtro] = useState('')
  const [tarCampanaId, setTarCampanaId] = useState('')
  const [tarFincaId, setTarFincaId] = useState('')
  const [tarParcelaIds, setTarParcelaIds] = useState<string[]>([])
  const [tarCreadoPor, setTarCreadoPor] = useState('')
  const [tarEjecutorId, setTarEjecutorId] = useState('')
  const [tarFechaPrevista, setTarFechaPrevista] = useState('')
  const [tarEquipoIds, setTarEquipoIds] = useState<string[]>([])
  const [tarComentarios, setTarComentarios] = useState('')
  const [tarError, setTarError] = useState('')
  const [tarHorasTrabajadas, setTarHorasTrabajadas] = useState<DiaHorario[]>([])
  // Popup de horas de trabajo: se abre al marcar una tarea como realizada, o justo después
  // de guardar un tratamiento fitosanitario ya realizado (desde MIS PARCELAS o TRATAMIENTOS).
  const [horasPopupModo, setHorasPopupModo] = useState<
    null | { tipo: 'tarea_completar'; tareaId: string } | { tipo: 'tratamiento_guardado'; tratamientoId: string }
  >(null)
  const [horasPopupDias, setHorasPopupDias] = useState<DiaHorario[]>([])
  const [horasPopupPersonalId, setHorasPopupPersonalId] = useState('')
  const [horasPopupError, setHorasPopupError] = useState('')
  const [horasPopupGuardando, setHorasPopupGuardando] = useState(false)
  // Selector de año para la descarga de Excel de horario por trabajador
  const [excelAnioPersonal, setExcelAnioPersonal] = useState(new Date().getFullYear())
  // Vínculo activo cuando el formulario de TRATAMIENTOS se abre desde una tarea
  const [tareaEnCreacionId, setTareaEnCreacionId] = useState<string | null>(null)
  const [tRealizada, setTRealizada] = useState(true)
  const [historicoCultivos, setHistoricoCultivos] = useState<HistoricoCultivo[]>([])
  const [formCampanaVisible, setFormCampanaVisible] = useState(false)
  const [campNombre, setCampNombre] = useState('')
  const [campFechaInicio, setCampFechaInicio] = useState('')
  const [campFechaFin, setCampFechaFin] = useState('')
  const [campError, setCampError] = useState('')
  // Filtro de campaña en Mis Parcelas y en Tratamientos: persiste en localStorage
  // hasta que el usuario lo desmarca, de forma independiente en cada pestaña.
  const [filtroCampana, setFiltroCampana] = useState('')
  const [filtroCampanaTrat, setFiltroCampanaTrat] = useState('')
  useEffect(() => {
    const guardada = localStorage.getItem('kampo_filtro_campana_parcelas')
    if (guardada) setFiltroCampana(guardada)
    const guardadaTrat = localStorage.getItem('kampo_filtro_campana_tratamientos')
    if (guardadaTrat) setFiltroCampanaTrat(guardadaTrat)
  }, [])
  useEffect(() => {
    if (filtroCampana) localStorage.setItem('kampo_filtro_campana_parcelas', filtroCampana)
    else localStorage.removeItem('kampo_filtro_campana_parcelas')
  }, [filtroCampana])
  useEffect(() => {
    if (filtroCampanaTrat) localStorage.setItem('kampo_filtro_campana_tratamientos', filtroCampanaTrat)
    else localStorage.removeItem('kampo_filtro_campana_tratamientos')
  }, [filtroCampanaTrat])

  // - Personal -
  const [personal, setPersonal] = useState<Personal[]>([])
  // Fase 4: qué puede ver/hacer el usuario logueado. Dueño (no está en
  // `personal`) = acceso total; trabajador = sus permisos individuales.
  const misPermisos = useMemo(() => calcularMisPermisos(session?.user?.id, personal), [session, personal])
  // Id en `personal` del usuario logueado (undefined si es el dueño/empresa, que no tiene fila en personal)
  const miPersonalId = useMemo(() => personal.find(p => p.authUserId === session?.user?.id)?.id, [personal, session])
  // Fase 5: si el usuario logueado es un trabajador con fincas asignadas, solo
  // ve las parcelas de esas fincas. Sin asignación (dueño, o trabajador sin
  // restricción) ve todas las que sus permisos normales le permitan.
  const misParcelasVisibles = useMemo(() => {
    if (!misPermisos['parcelas.solo_fincas_asignadas']) return misParcelas
    const miFila = personal.find(p => p.authUserId === session?.user?.id)
    const fincasAsignadas = miFila?.fincaIds || []
    if (fincasAsignadas.length === 0) return misParcelas // permiso activo pero sin fincas marcadas: nada que restringir todavía
    return misParcelas.filter(p => p.fincaId && fincasAsignadas.includes(p.fincaId))
  }, [misParcelas, personal, session, misPermisos])
  const [personalDetalleId, setPersonalDetalleId] = useState<string | null>(null)
  const [formPersonal, setFormPersonal] = useState(false)
  const [personalEditar, setPersonalEditar] = useState<Personal | null>(null)
  const [pNombre, setPNombre] = useState('')
  const [pDni, setPDni] = useState('')
  const [pTelefono, setPTelefono] = useState('')
  const [pDireccion, setPDireccion] = useState('')
  const [pRopo, setPRopo] = useState('')
  const [pNivelCapacitacion, setPNivelCapacitacion] = useState('')
  const [pFunciones, setPFunciones] = useState<string[]>([])
  const [pContrato, setPContrato] = useState('')
  const [pFincaIds, setPFincaIds] = useState<string[]>([])
  const [pError, setPError] = useState('')
  const [filtroFuncion, setFiltroFuncion] = useState('')
  const [filtroContrato, setFiltroContrato] = useState('')

  // - Equipos (maquinaria) -
  const [equipos, setEquipos] = useState<Equipo[]>([])
  // - Datos de la explotación (cuaderno de campo) -
  const [datosExplotacion, setDatosExplotacion] = useState<DatosExplotacion>(DATOS_EXPLOTACION_VACIO)
  const [formDatosExplotacion, setFormDatosExplotacion] = useState(false)
  const [deForm, setDeForm] = useState<DatosExplotacion>(DATOS_EXPLOTACION_VACIO)
  const [deGuardando, setDeGuardando] = useState(false)
  // - Cuaderno de campo (descarga Word) -
  const [cuadernoModalVisible, setCuadernoModalVisible] = useState(false)
  const [cuadernoCampanaId, setCuadernoCampanaId] = useState('')
  const [cuadernoFincaIds, setCuadernoFincaIds] = useState<string[]>([])
  const [generandoCuaderno, setGenerandoCuaderno] = useState(false)
  const [equipoDetalleId, setEquipoDetalleId] = useState<string | null>(null)
  const [formEquipo, setFormEquipo] = useState(false)
  const [equipoEditar, setEquipoEditar] = useState<Equipo | null>(null)
  const [eTipo, setETipo] = useState('')
  const [eSubtipo, setESubtipo] = useState('')
  const [eNombre, setENombre] = useState('')
  const [eDniCif, setEDniCif] = useState('')
  const [eRoma, setERoma] = useState('')
  const [eTitularidad, setETitularidad] = useState<'Propia' | 'Externa' | ''>('')
  const [eFincaId, setEFincaId] = useState('')
  const [eObs, setEObs] = useState('')
  const [eFechaAdquisicion, setEFechaAdquisicion] = useState('')
  const [eFechaUltimaInspeccion, setEFechaUltimaInspeccion] = useState('')
  const [eError, setEError] = useState('')
  const [filtroTipoEquipo, setFiltroTipoEquipo] = useState('')
  const [filtroFincaEquipo, setFiltroFincaEquipo] = useState('')
  // Tratamiento: maquinaria seleccionada (máximo 2)
  const [tEquipoIds, setTEquipoIds] = useState<string[]>([])
  // Tratamiento: nuevos campos personal
  const [tRecomendadoPor, setTRecomendadoPor] = useState('')
  const [tCultivoSeleccionado, setTCultivoSeleccionado] = useState('')
  const [tFincaSeleccionada, setTFincaSeleccionada] = useState('')
  const [tAplicadoPor, setTAplicadoPor] = useState('')
  // Fitosanitarios
  const [fitoBusqueda, setFitoBusqueda] = useState('')
  const [fitoResultados, setFitoResultados] = useState<FitoProducto[]>([])
  const [fitoSeleccionado, setFitoSeleccionado] = useState<FitoProducto | null>(null)
  const [fitoBuscando, setFitoBuscando] = useState(false)
  const [fichaVisible, setFichaVisible] = useState(false)
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null)
  const [pdfCargando, setPdfCargando] = useState(false)

  // - Init -
  useEffect(() => {
    fetch(`${BACKEND}/health`).then(r => setBackendOk(r.ok)).catch(() => setBackendOk(false))
  }, [])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Cerrar panel al cambiar de pestaña en móvil
  useEffect(() => {
    if (isMobile) setPanelAbierto(false)
  }, [pestana, isMobile])

  // Auto-scroll to parcela detail when opened
  useEffect(() => {
    if (parcelaDetalleId && parcelaDetalleRef.current) {
      setTimeout(() => {
        parcelaDetalleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 50)
    }
  }, [parcelaDetalleId])

  // - Autenticación: escuchar sesión -
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess)
      if (!sess) setDataLoaded(false)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  // - Cargar datos del usuario desde Supabase al iniciar sesión -
  const cargarDatos = useCallback(async () => {
    if (!session) return
    try {
        const [pRes, tRes, sRes, hRes] = await Promise.all([
          supabase.from('parcelas').select('*').order('created_at', { ascending: false }),
          supabase.from('tratamientos').select('*').order('created_at', { ascending: false }),
          supabase.from('stock').select('*').order('created_at', { ascending: false }),
          supabase.from('historico').select('*').order('created_at', { ascending: false }).limit(20),
        ])

        if (pRes.data) {
          setMisParcelas(pRes.data.map((p: any) => ({
            id: p.id, nombre: p.nombre || '', cultivo: p.cultivo, variedad: p.variedad || undefined,
            fechaPlantacion: p.fecha_plantacion || '', infoAdicional: p.info_adicional || '',
            geojson: p.geojson, parcelaInfo: p.parcela_info, supHa: Number(p.sup_ha) || 0,
            imagenPreview: p.imagen_preview, fechaGuardado: p.fecha_guardado,
            fincaId: p.finca_id || undefined,
            campanaId: p.campana_id || undefined,
            secanoRegadio: p.secano_regadio || undefined,
            tipoCultivoAmbiente: p.tipo_cultivo_ambiente || undefined,
            sistAsesoramientoGip: p.sist_asesoramiento_gip || undefined,
          })))
        }

        if (tRes.data) {
          setTratamientos(tRes.data.map((t: any) => ({
            id: t.id, tipo: t.tipo, producto: t.producto, materiaActiva: t.materia_activa || '',
            numRegistro: t.num_registro || undefined,
            dosis: t.dosis || '', unidadDosis: t.unidad_dosis || 'L/ha',
            dosisMaxima: t.dosis_maxima || '', unidadDosisMaxima: t.unidad_dosis_maxima || t.unidad_dosis || 'L/ha', aplicMaxima: t.aplic_maxima || '',
            litrosCaldoHa: t.litros_caldo_ha != null ? String(t.litros_caldo_ha) : '',
            kgSemillaHa: t.kg_semilla_ha != null ? String(t.kg_semilla_ha) : '',
            porcentajeAplicado: t.porcentaje_aplicado != null ? String(t.porcentaje_aplicado) : '100',
            porcentajeMaximo: t.porcentaje_maximo != null ? String(t.porcentaje_maximo) : '',
            densidad: t.densidad != null ? String(t.densidad) : '1',
            fecha: t.fecha, aplicador: t.aplicador || '', observaciones: t.observaciones || '',
            parcelaIds: t.parcela_ids || [], equipoIds: t.equipo_ids || [], fechaRegistro: t.fecha_registro,
            mrlResultado: t.mrl_resultado || undefined,
            recomendadoPor: t.recomendado_por || undefined,
            aplicadoPor: t.aplicado_por || undefined,
            fincaId: t.finca_id || undefined,
            cultivoTrat: t.cultivo || undefined,
            campanaId: t.campana_id || undefined,
            tareaId: t.tarea_id || undefined,
            horasTrabajadas: t.horas_trabajadas || undefined,
            horasPersonalId: t.horas_personal_id || undefined,
            problemaFitosanitario: t.problema_fitosanitario || undefined,
            eficacia: t.eficacia || undefined,
          })))
        }

        if (sRes.data) {
          setStock(sRes.data.map((s: any) => ({
            id: s.id, producto: s.producto, comprado: s.comprado, unidad: s.unidad,
            fechaRegistro: s.fecha_registro,
          })))
        }

        const fincasRes = await supabase.from('fincas').select('*').order('created_at', { ascending: true })
        if (fincasRes.data) {
          setFincas(fincasRes.data.map((f: any) => ({
            id: f.id, nombre: f.nombre, descripcion: f.descripcion || '',
            fechaRegistro: f.fecha_registro || '',
          })))
        }

        const campanasRes = await supabase.from('campanas').select('*').order('fecha_inicio', { ascending: false })
        if (campanasRes.data) {
          setCampanas(campanasRes.data.map((c: any) => ({
            id: c.id, nombre: c.nombre, fechaInicio: c.fecha_inicio, fechaFin: c.fecha_fin,
          })))
        }

        const tareasRes = await supabase.from('tareas').select('*').order('fecha_prevista', { ascending: true })
        if (tareasRes.data) {
          setTareas(tareasRes.data.map((t: any) => ({
            id: t.id, tipo: t.tipo, tipoOtro: t.tipo_otro || undefined, estado: t.estado || 'pendiente',
            campanaId: t.campana_id || undefined, fincaId: t.finca_id || undefined, parcelaIds: t.parcela_ids || [],
            creadoPor: t.creado_por || undefined, ejecutorId: t.ejecutor_id || undefined,
            fechaPrevista: t.fecha_prevista || '', equipoIds: t.equipo_ids || [], comentarios: t.comentarios || '',
            tratamientoId: t.tratamiento_id || undefined, borradorTratamiento: t.borrador_tratamiento || undefined,
            fechaRegistro: t.fecha_registro || '',
            horasTrabajadas: t.horas_trabajadas || undefined,
            horasPersonalId: t.horas_personal_id || undefined,
          })))
        }

        const histCultivosRes = await supabase.from('historico_cultivos_parcela').select('*').order('created_at', { ascending: false })
        if (histCultivosRes.data) {
          setHistoricoCultivos(histCultivosRes.data.map((h: any) => ({
            id: h.id, parcelaId: h.parcela_id, cultivo: h.cultivo, variedad: h.variedad || undefined,
            campanaId: h.campana_id || undefined, fechaRegistro: h.fecha_registro || '',
          })))
        }

        const persRes = await supabase.from('personal').select('*').order('created_at', { ascending: false })
        if (persRes.data) {
          setPersonal(persRes.data.map((p: any) => ({
            id: p.id, nombre: p.nombre, dni: p.dni || '', telefono: p.telefono || '',
            direccion: p.direccion || '', nroRopo: p.nro_ropo || '',
            nivelCapacitacion: p.nivel_capacitacion || '',
            funciones: Array.isArray(p.funciones) ? p.funciones : (p.funcion ? [p.funcion] : []),
            tipoContrato: p.tipo_contrato,
            activo: p.activo !== false, fechaRegistro: p.fecha_registro || '',
            predeterminadoAplicador: p.predeterminado_aplicador || false,
            predeterminadoRecomendador: p.predeterminado_recomendador || false,
            fincaId: p.finca_id || undefined,
            rol: p.rol || undefined,
            permisos: p.permisos && typeof p.permisos === 'object' ? p.permisos : {},
            estadoAcceso: p.estado_acceso || 'sin_acceso',
            authUserId: p.auth_user_id || undefined,
            fincaIds: Array.isArray(p.finca_ids) ? p.finca_ids : [],
          })))
        }

        const equiposRes = await supabase.from('equipos').select('*').order('created_at', { ascending: false })
        if (equiposRes.data) {
          setEquipos(equiposRes.data.map((e: any) => ({
            id: e.id, tipo: e.tipo, subtipo: e.subtipo || '', nombre: e.nombre,
            dniCif: e.dni_cif || '', nroRoma: e.nro_roma || '',
            titularidad: e.titularidad || '', fincaId: e.finca_id || undefined,
            observaciones: e.observaciones || '', fechaRegistro: e.fecha_registro || '',
            fechaAdquisicion: e.fecha_adquisicion || undefined, fechaUltimaInspeccion: e.fecha_ultima_inspeccion || undefined,
          })))
        }

        const explotRes = await supabase.from('datos_explotacion').select('*').eq('user_id', session.user.id).maybeSingle()
        if (explotRes.data?.datos) {
          setDatosExplotacion({ ...DATOS_EXPLOTACION_VACIO, ...explotRes.data.datos })
        }

        if (hRes.data) {
          setHistorico(hRes.data.map((h: any) => ({
            id: h.id, fecha: h.fecha, fecha_guardado: h.fecha_guardado, parcela: h.parcela,
            sup_ha: h.sup_ha, sup_ha_num: Number(h.sup_ha_num) || 0,
            geojson: h.geojson, parcelaInfo: h.parcela_info, zonas: h.zonas,
          })))
        }
      } catch (e) {
        console.error('Error cargando datos:', e)
      } finally {
        setDataLoaded(true)
      }
  }, [session])

  // Carga inicial, una vez que hay sesión
  useEffect(() => {
    if (!session || dataLoaded) return
    cargarDatos()
  }, [session, dataLoaded, cargarDatos])

  // Refresca los datos al cambiar de pestaña, para ver lo que hayan creado
  // otros compañeros de la misma cuenta sin tener que recargar la app entera.
  useEffect(() => {
    if (!session || !dataLoaded) return
    cargarDatos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pestana])

  const cerrarSesion = async () => {
    await supabase.auth.signOut()
    setMisParcelas([]); setTratamientos([]); setStock([]); setHistorico([])
    setParcGeojson(null); setParcelaInfo(null); setParcelaSupHa(0)
    setPestana('mapa'); deseleccionar()
  }

  const comprobarRomaRopo = async () => {
    if (!verifNif.trim()) { setVerifError('Introduce tu NIF/NIE'); return }
    setVerifLoading(true); setVerifError(''); setVerifResultado(null)
    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession()
      const token = currentSession?.access_token
      const res = await fetch(`${BACKEND}/api/verificacion/roma-ropo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ registro: verifRegistro, nif: verifNif.trim().toUpperCase() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Error al consultar el registro')
      }
      const data = await res.json()
      setVerifResultado(data)
    } catch (e: any) {
      setVerifError(e.message || 'Error de conexion con el servicio')
    } finally {
      setVerifLoading(false)
    }
  }

  // Convierte "APELLIDOS, NOMBRE" (formato tipico de ROPO) a "Nombre Apellidos"
  const formatearNombreROPO = (raw: string): string => {
    if (!raw) return raw
    const partes = raw.split(',').map(p => p.trim())
    const reordenado = partes.length === 2 ? `${partes[1]} ${partes[0]}` : raw
    return reordenado
      .toLowerCase()
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  }

  // Autorrellena el formulario de Personal con un registro ROPO encontrado.
  // El usuario solo tendria que completar despues: puesto, tipo de contrato y finca.
  const aplicarResultadoROPO = (registro: any) => {
    if (registro.nombre_denominacion) setPNombre(formatearNombreROPO(registro.nombre_denominacion))
    setPDni(verifNif)
    if (registro.codigo_identificacion) setPRopo(registro.codigo_identificacion)
    // "Datos de contacto" no tiene un formato confirmado (puede venir vacio o
    // con telefono/email) -> lo volcamos en Contacto, el usuario puede
    // corregirlo a mano si no encaja.
    if (registro.datos_contacto) setPTelefono(registro.datos_contacto)
    if (registro.nivel_capacitacion_caducidad_carnet) setPNivelCapacitacion(registro.nivel_capacitacion_caducidad_carnet)
    setShowVerifRomaRopo(false)
  }

  // Autorrellena el formulario de Equipos con una maquina encontrada en ROMA.
  // Cada fila de ROMA es una maquina distinta (un mismo CIF puede tener varias).
  // El "tipo" que trae ROMA (ej. "Tractores", "Maquinas remolcadas") no
  // coincide con las opciones fijas del desplegable TIPOS_MAQUINARIA de Kampo
  // (ej. "Tractor", "Remolque") -> en vez de forzarlo y dejar el desplegable
  // en un valor invalido, se vuelca como texto en Observaciones para que el
  // usuario elija el tipo correcto a mano.
  const aplicarResultadoROMA = (registro: any) => {
    const nombreMaquina = [registro.marca, registro.modelo].filter(Boolean).join(' ')
    if (nombreMaquina) setENombre(nombreMaquina)
    if (registro.numero_inscripcion) setERoma(registro.numero_inscripcion)
    setEDniCif(verifNif)

    const lineasObs = [
      registro.marca && `Marca: ${registro.marca}`,
      registro.modelo && `Modelo: ${registro.modelo}`,
      registro.tipo && `Tipo (ROMA): ${registro.tipo}`,
      registro.fecha_primera_inscripcion && `Fecha de registro: ${registro.fecha_primera_inscripcion}`,
      registro.resultado_inspeccion && `Inspección: ${registro.resultado_inspeccion}`,
      registro.fecha_inspeccion && `Fecha inspección: ${registro.fecha_inspeccion}`,
      registro.codigo_une && `Código UNE: ${registro.codigo_une}`,
    ].filter(Boolean)
    setEObs(lineasObs.join('\n'))

    setShowVerifRomaRopo(false)
  }

  // - Helpers -
  const getBbox = (geojson: any): string => {
    const geom = geojson.features[0].geometry
    const allCoords: number[][] = []
    if (geom.type === 'Polygon') allCoords.push(...geom.coordinates[0])
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => allCoords.push(...p[0]))
    const lons = allCoords.map(c => c[0])
    const lats = allCoords.map(c => c[1])
    const pad = 0.00005
    return `${Math.min(...lons)-pad},${Math.min(...lats)-pad},${Math.max(...lons)+pad},${Math.max(...lats)+pad}`
  }

  const getFecha = () => productos.find(p => p.id === productoSel)?.fecha || fechaInicio

  const resetear = () => {
    setImagenUrl(null); setModoVista('ninguna')
    setZonasData([]); setProduccion(null); setKgPorHa({})
    setContornosUrl(null); setContornosStats(null)
    setMdtColorUrl(null); setMdtColorStats(null); setCalculandoMdtColor(false)
    setMapaActivo(null); setMapaVisible(false)
  }

  const deseleccionar = () => {
    setParcGeojson(null); setParcelaInfo(null); setParcelaSupHa(0)
    setProductos([]); setProductoSel(''); setEstado('idle')
    setError(''); setMododibujo(false); setSeleccionando(false); setAnadiendoRecinto(false)
    setParcelaVistaEnMapa(null); setFincaVistaEnMapa(null)
    resetear()
  }

  // - GUARDAR PARCELA -> abre formulario en MIS PARCELAS -
  const calcularCentroide = (geojson: any): [number, number] | null => {
    try {
      const geom = geojson.features[0].geometry
      const coords: number[][] = []
      if (geom.type === 'Polygon') coords.push(...geom.coordinates[0])
      else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => coords.push(...p[0]))
      if (!coords.length) return null
      const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length
      const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length
      return [lat, lon]
    } catch { return null }
  }

  const cargarClima = async (geojson: any, _reintento = false) => {
    const centro = calcularCentroide(geojson)
    if (!centro) return
    if (!_reintento) { setClimaCargando(true); setClimaError(''); setClimaDatos(null) }
    try {
      const r = await fetch(`${BACKEND}/clima/parcela?lat=${centro[0]}&lon=${centro[1]}`)
      if (!r.ok) throw new Error(`Error ${r.status}`)
      setClimaDatos(await r.json())
      setClimaCargando(false)
    } catch (e: any) {
      // El backend puede estar "despertando" (arranque en frío) la primera vez;
      // un segundo intento a los pocos segundos casi siempre funciona.
      if (!_reintento) {
        setTimeout(() => cargarClima(geojson, true), 4000)
        return
      }
      setClimaError('No se pudieron obtener datos meteorológicos')
      setClimaCargando(false)
    }
  }

  const abrirFormularioGuardar = () => {
    setFormNombre('')
    setFormCultivo('')
    setFormVariedad('')
    setFormInfoAdicional('')
    setFormFincaId('')
    setFormCampanaId('')
    setFormSecanoRegadio('')
    setFormTipoCultivoAmbiente('')
    setFormSistAsesoramientoGip('')
    setFormError('')
    setParcelaEditar(null)
    // Generar preview del satélite Esri recortado a la parcela
    if (parcGeojson) {
      const esriUrl = getEsriPreviewUrl(parcGeojson)
      setImagenPreviewForm(esriUrl)
    }
    setFormularioVisible(true)
    setPestana('mis_parcelas')
  }

  // - Funciones fincas -
  const guardarFinca = async () => {
    if (!fNombre.trim()) { setFError('El nombre es obligatorio'); return }
    if (!session) return
    const nueva: Finca = {
      id: fincaEditar?.id || String(Date.now()),
      nombre: fNombre.trim(),
      descripcion: fDescripcion.trim(),
      fechaRegistro: fincaEditar?.fechaRegistro || new Date().toLocaleDateString('es-ES'),
    }
    const lista = fincaEditar
      ? fincas.map(f => f.id === fincaEditar.id ? nueva : f)
      : [...fincas, nueva]
    setFincas(lista)
    try {
      await supabase.from('fincas').upsert({
        id: nueva.id, user_id: session.user.id, nombre: nueva.nombre,
        descripcion: nueva.descripcion, fecha_registro: nueva.fechaRegistro,
      })
    } catch (e) { console.error(e) }
    setFormFinca(false); setFincaEditar(null); setFNombre(''); setFDescripcion(''); setFError('')
  }

  const eliminarFinca = async (id: string) => {
    const parcEnFinca = misParcelas.filter(p => p.fincaId === id).length
    if (parcEnFinca > 0) {
      alert(`Esta finca tiene ${parcEnFinca} parcelas asignadas. Reasignalas antes de eliminar.`)
      return
    }
    if (!confirm('Eliminar esta finca?')) return
    setFincas(fincas.filter(f => f.id !== id))
    try { await supabase.from('fincas').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  const eliminarCampana = async (id: string) => {
    const parcEnCampana = misParcelas.filter(p => p.campanaId === id).length
    const tratEnCampana = tratamientos.filter(t => t.campanaId === id).length
    if (parcEnCampana > 0 || tratEnCampana > 0) {
      alert(`Esta campaña tiene ${parcEnCampana} parcela(s) y ${tratEnCampana} tratamiento(s) asignados. Reasignalos antes de eliminarla.`)
      return
    }
    if (!confirm('Eliminar esta campaña?')) return
    setCampanas(campanas.filter(c => c.id !== id))
    if (filtroCampana === id) setFiltroCampana('')
    if (filtroCampanaTrat === id) setFiltroCampanaTrat('')
    try { await supabase.from('campanas').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // - Funciones personal -
  const abrirFormPersonal = (p?: Personal) => {
    setPersonalEditar(p || null)
    setPNombre(p?.nombre || ''); setPDni(p?.dni || '')
    setPTelefono(p?.telefono || ''); setPDireccion(p?.direccion || '')
    setPRopo(p?.nroRopo || ''); setPNivelCapacitacion(p?.nivelCapacitacion || '')
    setPFunciones(p?.funciones || [])
    setPContrato(p?.tipoContrato || ''); setPFincaIds(p?.fincaIds || []); setPError('')
    setFormPersonal(true)
  }

  const guardarPersonal = async () => {
    if (!pNombre.trim()) { setPError('El nombre es obligatorio'); return }
    if (pFunciones.length === 0) { setPError('Selecciona al menos una función'); return }
    if (!pContrato) { setPError('El tipo de contrato es obligatorio'); return }
    if (!session) return

    const nuevo: Personal = {
      id: personalEditar?.id || String(Date.now()),
      nombre: pNombre.trim(), dni: pDni.trim(), telefono: pTelefono.trim(),
      direccion: pDireccion.trim(), nroRopo: pRopo.trim(),
      nivelCapacitacion: pNivelCapacitacion.trim(),
      funciones: pFunciones, tipoContrato: pContrato, activo: true,
      fechaRegistro: personalEditar?.fechaRegistro || new Date().toLocaleDateString('es-ES'),
      predeterminadoAplicador: personalEditar?.predeterminadoAplicador || false,
      predeterminadoRecomendador: personalEditar?.predeterminadoRecomendador || false,
      fincaIds: pFincaIds,
    }

    const lista = personalEditar
      ? personal.map(p => p.id === personalEditar.id ? nuevo : p)
      : [nuevo, ...personal]
    setPersonal(lista)

    try {
      const { error } = await supabase.from('personal').upsert({
        id: nuevo.id, user_id: session.user.id, nombre: nuevo.nombre,
        dni: nuevo.dni, telefono: nuevo.telefono, direccion: nuevo.direccion,
        nro_ropo: nuevo.nroRopo, nivel_capacitacion: nuevo.nivelCapacitacion, funciones: nuevo.funciones,
        funcion: nuevo.funciones[0] || '', // columna antigua (singular), aún NOT NULL en la tabla
        tipo_contrato: nuevo.tipoContrato, activo: nuevo.activo,
        fecha_registro: nuevo.fechaRegistro,
        predeterminado_aplicador: nuevo.predeterminadoAplicador,
        predeterminado_recomendador: nuevo.predeterminadoRecomendador,
        finca_ids: nuevo.fincaIds || [],
      })
      if (error) {
        console.error('Error guardando personal en Supabase:', error)
        setPError('No se pudo guardar en la base de datos: ' + error.message)
        return
      }
    } catch (e) {
      console.error('Error guardando personal:', e)
      setPError('No se pudo guardar en la base de datos.')
      return
    }

    setFormPersonal(false); setPersonalEditar(null)
  }

  // - Datos de la explotación (cuaderno de campo) -
  const abrirFormDatosExplotacion = () => {
    setDeForm(datosExplotacion)
    setFormDatosExplotacion(true)
  }

  const guardarDatosExplotacion = async () => {
    if (!session) return
    setDeGuardando(true)
    try {
      setDatosExplotacion(deForm)
      await supabase.from('datos_explotacion').upsert({ user_id: session.user.id, datos: deForm })
      setFormDatosExplotacion(false)
    } catch (e) {
      console.error('Error guardando datos de la explotación:', e)
    } finally {
      setDeGuardando(false)
    }
  }

  // - Funciones equipos (maquinaria) -
  const abrirFormEquipo = (e?: Equipo) => {
    setEquipoEditar(e || null)
    setETipo(e?.tipo || ''); setESubtipo(e?.subtipo || '')
    setENombre(e?.nombre || ''); setEDniCif(e?.dniCif || '')
    setERoma(e?.nroRoma || ''); setETitularidad(e?.titularidad || '')
    setEFincaId(e?.fincaId || ''); setEObs(e?.observaciones || '')
    setEFechaAdquisicion(e?.fechaAdquisicion || ''); setEFechaUltimaInspeccion(e?.fechaUltimaInspeccion || '')
    setEError('')
    setFormEquipo(true)
  }

  const guardarEquipo = async () => {
    if (!eTipo) { setEError('El tipo de maquinaria es obligatorio'); return }
    if (subtiposPorTipo(eTipo).length > 0 && !eSubtipo) { setEError('Selecciona un subtipo'); return }
    if (!eNombre.trim()) { setEError('El nombre es obligatorio'); return }
    if (!session) return

    const nuevo: Equipo = {
      id: equipoEditar?.id || String(Date.now()),
      tipo: eTipo, subtipo: subtiposPorTipo(eTipo).length > 0 ? eSubtipo : '',
      nombre: eNombre.trim(), dniCif: eDniCif.trim(), nroRoma: eRoma.trim(),
      titularidad: eTitularidad, fincaId: eTitularidad === 'Propia' ? (eFincaId || undefined) : undefined,
      observaciones: eObs.trim(),
      fechaRegistro: equipoEditar?.fechaRegistro || new Date().toLocaleDateString('es-ES'),
      fechaAdquisicion: eFechaAdquisicion || undefined,
      fechaUltimaInspeccion: eFechaUltimaInspeccion || undefined,
    }

    const lista = equipoEditar
      ? equipos.map(e => e.id === equipoEditar.id ? nuevo : e)
      : [nuevo, ...equipos]
    setEquipos(lista)

    try {
      const { error } = await supabase.from('equipos').upsert({
        id: nuevo.id, user_id: session.user.id, tipo: nuevo.tipo, subtipo: nuevo.subtipo || null,
        nombre: nuevo.nombre, dni_cif: nuevo.dniCif || null, nro_roma: nuevo.nroRoma || null,
        titularidad: nuevo.titularidad || null, finca_id: nuevo.fincaId || null,
        observaciones: nuevo.observaciones || null, fecha_registro: nuevo.fechaRegistro,
        fecha_adquisicion: nuevo.fechaAdquisicion || null, fecha_ultima_inspeccion: nuevo.fechaUltimaInspeccion || null,
      })
      if (error) {
        console.error('Error guardando equipo en Supabase:', error)
        setEError('No se pudo guardar en la base de datos: ' + error.message)
        return
      }
    } catch (e) {
      console.error('Error guardando equipo:', e)
      setEError('No se pudo guardar en la base de datos.')
      return
    }

    setFormEquipo(false); setEquipoEditar(null)
  }

  const eliminarEquipo = async (id: string) => {
    if (!confirm('¿Eliminar este equipo?')) return
    setEquipos(equipos.filter(e => e.id !== id))
    if (equipoDetalleId === id) setEquipoDetalleId(null)
    try { await supabase.from('equipos').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  const setPredeterminado = async (pid: string, rol: 'aplicador' | 'recomendador', valor: boolean) => {
    if (!session) return
    // Quitar predeterminado anterior del mismo tipo
    const listaActualizada = personal.map(p => {
      if (rol === 'aplicador') return { ...p, predeterminadoAplicador: p.id === pid ? valor : false }
      return { ...p, predeterminadoRecomendador: p.id === pid ? valor : false }
    })
    setPersonal(listaActualizada)
    try {
      if (valor) {
        // Quitar predeterminado a todos los demás
        const otros = personal.filter(p => p.id !== pid)
        for (const otro of otros) {
          const field = rol === 'aplicador' ? 'predeterminado_aplicador' : 'predeterminado_recomendador'
          await supabase.from('personal').update({ [field]: false }).eq('id', otro.id)
        }
      }
      const field = rol === 'aplicador' ? 'predeterminado_aplicador' : 'predeterminado_recomendador'
      await supabase.from('personal').update({ [field]: valor }).eq('id', pid)
    } catch (e) { console.error('Error setPredeterminado:', e) }
  }

  const desactivarPersonal = async (id: string) => {
    const p = personal.find(p => p.id === id)
    if (!p) return
    const tratRelacionados = tratamientos.filter(t =>
      t.recomendadoPor === id || t.aplicadoPor === id
    ).length
    if (tratRelacionados > 0) {
      if (!confirm(`Esta persona tiene ${tratRelacionados} tratamiento(s) asociado(s). Desactivar en lugar de eliminar?`)) return
      const actualizado = { ...p, activo: false }
      setPersonal(personal.map(x => x.id === id ? actualizado : x))
      try { await supabase.from('personal').update({ activo: false }).eq('id', id) } catch (e) { console.error(e) }
    } else {
      if (!confirm('Eliminar este trabajador?')) return
      setPersonal(personal.filter(x => x.id !== id))
      try { await supabase.from('personal').delete().eq('id', id) } catch (e) { console.error(e) }
    }
  }

  const personalDetalle = personal.find(p => p.id === personalDetalleId) || null
  const equipoDetalle = equipos.find(e => e.id === equipoDetalleId) || null

  const tratamientosDePersonal = (pid: string, rol: 'recomendado' | 'aplicado') =>
    tratamientos.filter(t => rol === 'recomendado' ? t.recomendadoPor === pid : t.aplicadoPor === pid)
      .sort((a, b) => b.fecha.localeCompare(a.fecha))

  const tratamientosDeEquipo = (eid: string) =>
    tratamientos.filter(t => (t.equipoIds || []).includes(eid))
      .sort((a, b) => b.fecha.localeCompare(a.fecha))

  // - EXCEL de horario por trabajador -
  // Genera un libro con una fila por día del año elegido y una columna por tipo de tarea
  // (Tratamiento fitosanitario, Abonado, Poda, Laboreo, Siembra, Recolección, Riego,
  // Mantenimiento, Otros), con las horas (decimal) dedicadas ese día a cada tipo, y una
  // columna Total con la fórmula de suma — igual estructura que la plantilla de la empresa.
  const descargarExcelPersonal = async (p: Personal, anio: number) => {
    const XLSX = await import('xlsx')

    // Minutos por día y columna, para este trabajador
    const porDia: Record<string, Record<string, number>> = {}
    const sumar = (fecha: string, columna: string, mins: number) => {
      if (!fecha || mins <= 0) return
      if (!porDia[fecha]) porDia[fecha] = {}
      porDia[fecha][columna] = (porDia[fecha][columna] || 0) + mins
    }

    // Tareas (todas menos "Tratamiento fitosanitario", que se cuenta vía el Tratamiento vinculado)
    tareas.forEach(t => {
      if (t.tipo === 'Tratamiento fitosanitario') return
      const personalId = t.horasPersonalId || t.ejecutorId
      if (personalId !== p.id) return
      const columna = (TIPOS_TAREA as readonly string[]).includes(t.tipo) ? t.tipo : 'Otros'
      ;(t.horasTrabajadas || []).forEach(d => sumar(d.fecha, columna, minutosEntreHoras(d.horaInicio, d.horaFin)))
    })

    // Tratamientos fitosanitarios (creados desde una tarea o directamente desde MIS PARCELAS / TRATAMIENTOS)
    tratamientos.forEach(t => {
      const personalId = t.horasPersonalId || t.aplicadoPor
      if (personalId !== p.id) return
      ;(t.horasTrabajadas || []).forEach(d => sumar(d.fecha, 'Tratamiento fitosanitario', minutosEntreHoras(d.horaInicio, d.horaFin)))
    })

    const cols = TIPOS_TAREA as readonly string[]
    const header = ['Día', ...cols, 'Total']
    const filas: any[][] = [header]

    const inicio = new Date(anio, 0, 1)
    const fin = new Date(anio, 11, 31)
    for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) {
      const fechaStr = d.toISOString().slice(0, 10)
      const fila: any[] = [new Date(d)]
      cols.forEach(c => {
        const mins = porDia[fechaStr]?.[c] || 0
        fila.push(mins > 0 ? Math.round((mins / 60) * 100) / 100 : null)
      })
      filas.push(fila)
    }

    const ws = XLSX.utils.aoa_to_sheet(filas)
    // Fórmula de suma en la columna Total de cada fila (igual que la plantilla original)
    const colTotalLetra = XLSX.utils.encode_col(1 + cols.length)
    const colInicioLetra = XLSX.utils.encode_col(1)
    const colFinLetra = XLSX.utils.encode_col(cols.length)
    for (let fila = 2; fila <= filas.length; fila++) {
      const ref = `${colTotalLetra}${fila}`
      ws[ref] = { t: 'n', f: `SUM(${colInicioLetra}${fila}:${colFinLetra}${fila})` }
    }
    // Formato de fecha en la columna Día
    for (let fila = 2; fila <= filas.length; fila++) {
      const ref = `A${fila}`
      if (ws[ref]) ws[ref].z = 'dd/mm/yyyy'
    }
    ws['!cols'] = [{ wch: 12 }, ...cols.map(() => ({ wch: 16 })), { wch: 10 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, String(anio))
    const nombreArchivo = `horario_${p.nombre.replace(/[^a-zA-Z0-9]+/g, '_')}_${anio}.xlsx`
    XLSX.writeFile(wb, nombreArchivo)
  }

  const formatFechaEs = (fecha?: string): string => {
    if (!fecha) return ''
    const m = fecha.match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${m[3]}/${m[2]}/${m[1]}` : fecha
  }

  // Formatea una cifra de superficie al estilo español: "," para los decimales y "." para
  // separar los miles (p.ej. 1234.5678 -> "1.234,5678"). Se usa en el Cuaderno de Campo.
  const formatSupEs = (n: number, decimales = 2): string => {
    if (!isFinite(n)) return ''
    return n.toLocaleString('es-ES', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })
  }

  // - CUADERNO DE CAMPO (Word) -
  // Genera el Cuaderno de Explotación oficial (modelo RD 1311/2012) rellenando lo que la
  // app puede completar: 1.2, 1.3, 1.4 (parcial), 2.1, 3.1 y 3.2. El resto (2.2, 3.1 bis,
  // 3.3, 3.4, 3.5, 4 y 5) se genera en blanco, tal como el modelo original, para rellenar
  // a mano si procede.
  const generarCuaderno = async () => {
    const campanaSel = campanas.find(c => c.id === cuadernoCampanaId)
    if (!campanaSel) { alert('Selecciona una campaña para generar el cuaderno.'); return }
    setGenerandoCuaderno(true)
    try {
      const { descargarCuadernoCampo } = await import('./lib/cuadernoCampo')
      const idsFincaSel = cuadernoFincaIds.length > 0 ? new Set(cuadernoFincaIds) : null
      const fincasSeleccionadas = idsFincaSel ? fincas.filter(f => idsFincaSel.has(f.id)) : fincas

      // Cultivo/variedad de cada parcela PARA ESTA CAMPAÑA: el actual, si la parcela está
      // asignada a esta campaña o no tiene campaña asignada (cultivos plurianuales); si no,
      // se busca en el histórico de cultivos el que tenía la parcela en esta campaña. Las
      // parcelas sin ningún cultivo asociado a la campaña elegida quedan fuera del cuaderno.
      const cultivoCampanaPorParcela: Record<string, { cultivo: string; variedad?: string }> = {}
      misParcelas.forEach(p => {
        if (!p.campanaId || p.campanaId === campanaSel.id) {
          cultivoCampanaPorParcela[p.id] = { cultivo: p.cultivo, variedad: p.variedad }
        } else {
          const hist = historicoCultivos.find(h => h.parcelaId === p.id && h.campanaId === campanaSel.id)
          if (hist) cultivoCampanaPorParcela[p.id] = { cultivo: hist.cultivo, variedad: hist.variedad }
        }
      })

      // Parcelas de las fincas seleccionadas (todas, si no se ha restringido ninguna finca) que
      // además tengan un cultivo asociado a la campaña elegida.
      const parcelasSel = misParcelas.filter(p =>
        (!idsFincaSel || (p.fincaId && idsFincaSel.has(p.fincaId))) && !!cultivoCampanaPorParcela[p.id]
      )

      // --- 2.1 Identificación de parcelas + mapa de "Nº de orden" (se reutiliza en 3.1/3.2) ---
      const ordenPorParcela: Record<string, number> = {}
      const filasParcelas: string[][] = []
      parcelasSel.forEach((p, i) => {
        const orden = i + 1
        ordenPorParcela[p.id] = orden
        const { cultivo: cultivoCampana, variedad: variedadCampana } = cultivoCampanaPorParcela[p.id]
        const recintos: RecintoRef[] = (p.parcelaInfo?.recintos && p.parcelaInfo.recintos.length > 0)
          ? p.parcelaInfo.recintos
          : [{ provincia: '', municipio: '', agregado: '', zona: '', poligono: '', parcela: '', recinto: '', usoSigpac: '', supHa: p.supHa } as RecintoRef]
        // Reparto proporcional de la superficie cultivada (dibujada) entre los recintos SIGPAC
        // de la parcela — nunca puede superar la superficie SIGPAC de cada recinto, ya que un
        // mismo recinto puede contener más de un cultivo/parcela distintos.
        const sumaRecintos = recintos.reduce((a, r) => a + (Number(r.supHa) || 0), 0) || p.supHa || 0
        recintos.forEach(r => {
          const supSigpac = Number(r.supHa) || 0
          const supCultivada = sumaRecintos > 0 ? Math.min(supSigpac || p.supHa, (supSigpac / sumaRecintos) * p.supHa) : p.supHa
          filasParcelas.push([
            String(orden),
            r.provincia || '', r.municipio || '', r.agregado || '', r.zona || '',
            r.poligono || '', r.parcela || '', r.recinto || '', r.usoSigpac || '',
            supSigpac > 0 ? formatSupEs(supSigpac, 4) : '',
            supCultivada > 0 ? formatSupEs(supCultivada, 4) : formatSupEs(p.supHa, 4),
            cultivoCampana || '', variedadCampana || '',
            ({ SEC: 'Secano', ASP: 'Aspersión', LOC: 'Localizado', GRA: 'Gravedad' } as Record<string, string>)[p.secanoRegadio || ''] || '',
            ({ AL: 'Aire libre', M: 'Malla', BP: 'Cubierta bajo plástico', INV: 'Invernadero' } as Record<string, string>)[p.tipoCultivoAmbiente || ''] || '',
            ({ AE: 'AE', PI: 'PI', CP: 'CP', ATRIAS: 'ATRIAs', AS: 'AS', NO: 'NO' } as Record<string, string>)[p.sistAsesoramientoGip || ''] || '',
          ])
        })
      })

      // --- Tratamientos de la campaña elegida, en las fincas elegidas ---
      const tratamientosSel = tratamientos.filter(t => {
        if (t.campanaId !== campanaSel.id) return false
        if (!idsFincaSel) return true
        if (t.fincaId) return idsFincaSel.has(t.fincaId)
        return t.parcelaIds.some(pid => { const p = misParcelas.find(x => x.id === pid); return !!p?.fincaId && idsFincaSel.has(p.fincaId) })
      })

      const nombrePersonal = (id?: string) => personal.find(x => x.id === id)?.nombre || ''
      const nombreEquipo = (id: string) => { const e = equipos.find(x => x.id === id); return e ? `${e.tipo}${e.subtipo ? ' ' + e.subtipo : ''} — ${e.nombre}` : '' }

      const idsParcelasTexto = (ids: string[]): string => {
        if (ids.length === 0) return ''
        if (parcelasSel.length > 1 && ids.length === parcelasSel.length) return 'TODAS'
        return ids.map(id => ordenPorParcela[id]).filter(Boolean).sort((a, b) => a - b).join(', ')
      }

      const cultivoDeParcelas = (ids: string[]): { especie: string; variedad: string } => {
        const cultivos = Array.from(new Set(ids.map(id => cultivoCampanaPorParcela[id]?.cultivo).filter(Boolean))) as string[]
        const variedades = Array.from(new Set(ids.map(id => cultivoCampanaPorParcela[id]?.variedad).filter(Boolean))) as string[]
        return { especie: cultivos.length === 1 ? cultivos[0] : (cultivos.length > 1 ? 'Varios' : ''), variedad: variedades.length === 1 ? variedades[0] : '' }
      }

      const supTratada = (t: Tratamiento): number => {
        const pct = Number(t.porcentajeAplicado || '100') / 100
        return t.parcelaIds.reduce((acc, id) => acc + (misParcelas.find(p => p.id === id)?.supHa || 0), 0) * pct
      }

      // --- 3.1 Registro de actuaciones fitosanitarias (excluye los de semilla tratada, ver 3.2) ---
      const tratamientosFoliares = tratamientosSel.filter(t => t.unidadDosis !== 'g/kg semilla' && t.unidadDosis !== 'mL/kg semilla')
      const filas31 = tratamientosFoliares.map(t => {
        const { especie, variedad } = cultivoDeParcelas(t.parcelaIds)
        const st = supTratada(t)
        // Observaciones: las que haya escrito el usuario + el volumen de caldo aplicado (si la
        // unidad de dosis lo requiere) y el % de superficie aplicada (si es distinto del 100%).
        const notasExtra: string[] = []
        if (t.litrosCaldoHa && Number(t.litrosCaldoHa) > 0) notasExtra.push(`Vol. caldo: ${formatSupEs(Number(t.litrosCaldoHa), 2)} L/ha`)
        const pctAplicado = Number(t.porcentajeAplicado || '100')
        if (pctAplicado > 0 && pctAplicado < 100) notasExtra.push(`Sup. aplicada: ${formatSupEs(pctAplicado, 1)}%`)
        const observacionesCompletas = [t.observaciones || '', ...notasExtra].filter(Boolean).join(' — ')
        return [
          idsParcelasTexto(t.parcelaIds), especie, variedad, formatFechaEs(t.fecha),
          st > 0 ? formatSupEs(st, 2) : '',
          t.problemaFitosanitario || '',
          nombrePersonal(t.aplicadoPor) || t.aplicador || '',
          (t.equipoIds || []).map(nombreEquipo).join(', '),
          t.producto || '', t.numRegistro || '',
          `${t.dosis || ''} ${t.unidadDosis || ''}`.trim(),
          t.eficacia || '',
          observacionesCompletas,
        ]
      })

      // --- 3.2 Registro de uso de semilla tratada ---
      const tratamientosSemilla = tratamientosSel.filter(t => t.unidadDosis === 'g/kg semilla' || t.unidadDosis === 'mL/kg semilla')
      const filas32 = tratamientosSemilla.map(t => {
        const { especie, variedad } = cultivoDeParcelas(t.parcelaIds)
        const sup = supTratada(t)
        const kgSemillaHa = Number(t.kgSemillaHa || '0')
        return [
          formatFechaEs(t.fecha), idsParcelasTexto(t.parcelaIds), especie, variedad,
          sup > 0 ? formatSupEs(sup, 2) : '',
          kgSemillaHa > 0 && sup > 0 ? formatSupEs(kgSemillaHa * sup, 2) : '',
          `${t.materiaActiva || ''}${t.materiaActiva && t.producto ? ' / ' : ''}${t.producto || ''}`,
          t.numRegistro || '',
        ]
      })

      // --- 1.2 Personas/empresas que intervienen en tratamientos fitosanitarios ---
      const personalRelevante = personal.filter(p => esAplicador(p) || esRecomendador(p))
      const filas12 = personalRelevante.map((p, i) => [String(i + 1), p.nombre, p.dni || '', p.nroRopo || '', p.nivelCapacitacion || '', esRecomendador(p) ? 'X' : ''])

      // --- 1.3 Equipos de aplicación realmente usados en los tratamientos del año/fincas elegidos ---
      const idsEquiposUsados = Array.from(new Set(tratamientosSel.flatMap(t => t.equipoIds || [])))
      const equiposUsados = equipos.filter(e => idsEquiposUsados.includes(e.id))
      const filas13 = equiposUsados.map((e, i) => [String(i + 1), `${e.tipo}${e.subtipo ? ' ' + e.subtipo : ''} — ${e.nombre}`, e.nroRoma || '', formatFechaEs(e.fechaAdquisicion), formatFechaEs(e.fechaUltimaInspeccion)])

      // --- 1.4 Agrupación o entidad de asesoramiento ---
      const filas14 = (datosExplotacion.agrupacionNombre || datosExplotacion.agrupacionNif)
        ? [[datosExplotacion.agrupacionNombre, datosExplotacion.agrupacionNif, datosExplotacion.agrupacionNroIdentificacion, datosExplotacion.agrupacionTipoExplotacion]]
        : []

      const de = datosExplotacion
      const nombreCabecera = de.nombreRazonSocial || fincasSeleccionadas.map(f => f.nombre).join(', ') || ''

      const datosGenerales = [
        [{ label: 'Nombre y apellidos o razón social', value: de.nombreRazonSocial }, { label: 'NIF', value: de.nif }],
        [{ label: 'Nº Reg. Explotaciones Nacional', value: de.nroRegExplotNacional }, { label: 'Nº Reg. Explotaciones Autonómico', value: de.nroRegExplotAutonomico }],
        [{ label: 'Dirección', value: de.direccion }],
        [{ label: 'Localidad', value: de.localidad }, { label: 'C. Postal / Provincia', value: [de.cPostal, de.provincia].filter(Boolean).join(' / ') }],
        [{ label: 'Teléfono fijo / móvil', value: [de.telefonoFijo, de.telefonoMovil].filter(Boolean).join(' / ') }, { label: 'e-mail', value: de.email }],
      ]
      const titular = [
        [{ label: 'Nombre y apellidos', value: de.titularNombre }, { label: 'NIF', value: de.titularNif }],
        [{ label: 'Dirección', value: de.titularDireccion }],
        [{ label: 'Localidad', value: de.titularLocalidad }, { label: 'C. Postal / Provincia', value: [de.titularCPostal, de.titularProvincia].filter(Boolean).join(' / ') }],
        [{ label: 'Tipo de representación', value: de.titularTipoRepresentacion }, { label: 'Teléfono / e-mail', value: [de.titularTelefono, de.titularEmail].filter(Boolean).join(' / ') }],
      ]

      const NOTA_SIN_DATOS = 'Sección sin datos disponibles en la aplicación — a rellenar manualmente si procede.'

      const secciones = [
        {
          numero: '1.2', titulo: 'PERSONAS O EMPRESAS QUE INTERVIENEN EN EL TRATAMIENTO CON PRODUCTOS FITOSANITARIOS',
          headers: ['Nº orden', 'Nombre y apellidos / Empresas de servicios', 'NIF', 'Nº Inscripción ROPO', 'Tipo de carné', 'Asesor'],
          colWidths: [1, 3.2, 1.4, 1.6, 1.6, 1], rows: filas12, filasVaciasMin: 4,
          notas: ['Se marca "Asesor" cuando la persona tiene asignada una función de asesoramiento fitosanitario.'],
          saltoPaginaAntes: true,
        },
        {
          numero: '1.3', titulo: 'EQUIPOS DE APLICACIÓN DE PRODUCTOS FITOSANITARIOS PROPIOS DE LA EXPLOTACIÓN',
          headers: ['Nº orden', 'Descripción del equipo', 'Nº inscrip. ROMA', 'Fecha de adquisición', 'Fecha de la última inspección'],
          colWidths: [1, 3, 1.4, 1.6, 1.8], rows: filas13, filasVaciasMin: 3,
          notas: ['Se listan los equipos empleados en los tratamientos registrados en el año/fincas seleccionados.'],
        },
        {
          numero: '1.4', titulo: 'AGRUPACIÓN O ENTIDAD DE ASESORAMIENTO A LA QUE PERTENECE LA EXPLOTACIÓN',
          headers: ['Nombre o razón social', 'NIF', 'Nº de identificación', 'Tipo de explotación'],
          colWidths: [3, 1.4, 1.6, 1.6], rows: filas14, filasVaciasMin: 1,
        },
        {
          numero: '2.1', titulo: 'DATOS IDENTIFICATIVOS Y AGRONÓMICOS DE LAS PARCELAS',
          headers: ['Nº orden', 'Cod. Provincia', 'Término municipal', 'Cod. Agregado', 'Zona', 'Nº Polígono', 'Nº Parcela', 'Nº Recinto', 'Uso SIGPAC', 'Sup. SIGPAC (ha)', 'Sup. Cultivada (ha)', 'Especie', 'Variedad', 'Secano/Regadío', 'Aire libre/protegido', 'Sist. asesoramiento GIP'],
          colWidths: [0.8, 1, 2, 1, 0.8, 1, 1, 1, 1.4, 1.2, 1.2, 1.4, 1.2, 1.3, 1.6, 1.4],
          rows: filasParcelas, filasVaciasMin: 4,
          notas: ['La superficie cultivada puede ser inferior a la superficie SIGPAC del recinto cuando este alberga más de un cultivo o parcela.'],
          saltoPaginaAntes: true,
        },
        {
          numero: '2.2', titulo: 'DATOS IDENTIFICATIVOS MEDIOAMBIENTALES DE LAS PARCELAS',
          headers: ['Id. parcelas', 'Especie', 'Variedad', 'Incluido en la parcela (SI/NO)', 'Distancia (m)', 'Coordenadas UTM', 'Denominación', 'Totalmente (SI/NO)', 'Parcialmente (SI/NO)'],
          colWidths: [1, 1.4, 1.4, 1.6, 1.2, 1.6, 1.8, 1.4, 1.4], rows: [] as string[][], filasVaciasMin: 6,
          notas: [NOTA_SIN_DATOS], saltoPaginaAntes: true,
        },
        {
          numero: '3.1', titulo: 'REGISTRO DE ACTUACIONES FITOSANITARIAS DE LA PARCELA',
          headers: ['Id. Parcelas', 'Especie', 'Variedad', 'Fecha', 'Sup. tratada (ha)', 'Problema fitosanitario', 'Aplicador', 'Equipo', 'Nombre comercial', 'Nº Registro', 'Dosis', 'Eficacia', 'Observaciones'],
          colWidths: [0.9, 1.1, 1.1, 1, 1, 1.6, 1.3, 1.4, 1.4, 1, 1.1, 1, 1.6],
          rows: filas31, filasVaciasMin: 4, saltoPaginaAntes: true,
        },
        {
          numero: '3.1 bis', titulo: 'REGISTRO DE TRATAMIENTOS FITOSANITARIOS DE LA PARCELA',
          subtitulo: '(SOLAMENTE PARA CULTIVOS Y SUPERFICIES OBJETO DE ASESORAMIENTO)',
          headers: ['Especie', 'Variedad', 'Id. parcelas', 'Sup. cultivada (ha)', 'Sup. tratada (ha)', 'Plaga', 'Justificación de la actuación', 'Tipo de medida', 'Intensidad de la medida', 'Fecha', 'Nombre comercial', 'Nº registro', 'Dosis', 'Eficacia', 'Observaciones'],
          colWidths: [1, 1, 0.8, 1, 1, 1, 1.6, 1, 1.2, 0.9, 1.2, 0.9, 0.9, 1, 1.4], rows: [] as string[][], filasVaciasMin: 5,
          notas: ['Sección sin datos disponibles en la aplicación — solo aplica a cultivos con asesoramiento de gestión integrada de plagas.'],
          saltoPaginaAntes: true,
        },
        {
          numero: '3.2', titulo: 'REGISTRO DE USO DE SEMILLA TRATADA',
          headers: ['Fecha de siembra', 'Id. parcelas', 'Especie', 'Variedad', 'Sup. sembrada (ha)', 'Cantidad de semilla (kg)', 'Materia activa / Nombre comercial', 'Nº registro'],
          colWidths: [1.1, 1, 1.2, 1.2, 1.2, 1.4, 2, 1], rows: filas32, filasVaciasMin: 3, saltoPaginaAntes: true,
        },
        {
          numero: '3.3', titulo: 'REGISTRO DE TRATAMIENTOS POSTCOSECHA (en producto vegetal)',
          headers: ['Fecha', 'Producto vegetal tratado', 'Problemática fitosanitaria', 'Cantidad prod. veg. tratado (Tm)', 'Nombre comercial', 'Nº Registro', 'Cantidad utilizada (kg o l)'],
          colWidths: [1, 1.6, 1.6, 1.6, 1.6, 1, 1.4], rows: [] as string[][], filasVaciasMin: 3, notas: [NOTA_SIN_DATOS],
        },
        {
          numero: '3.4', titulo: 'REGISTRO DE TRATAMIENTOS DE LOS LOCALES DE ALMACENAMIENTO',
          headers: ['Fecha', 'Local tratado (tipo y dirección)', 'Problemática fitosanitaria', 'Volumen tratado (m³)', 'Nombre comercial', 'Nº Registro', 'Cantidad utilizada (kg o l)'],
          colWidths: [1, 2, 1.6, 1.2, 1.6, 1, 1.4], rows: [] as string[][], filasVaciasMin: 3, notas: [NOTA_SIN_DATOS], saltoPaginaAntes: true,
        },
        {
          numero: '3.5', titulo: 'REGISTRO DE TRATAMIENTOS DE LOS MEDIOS DE TRANSPORTE',
          headers: ['Fecha', 'Vehículo tratado (tipo, modelo y matrícula)', 'Problemática fitosanitaria', 'Volumen tratado (m³)', 'Nombre comercial', 'Nº Registro', 'Cantidad utilizada (kg o l)'],
          colWidths: [1, 2, 1.6, 1.2, 1.6, 1, 1.4], rows: [] as string[][], filasVaciasMin: 3, notas: [NOTA_SIN_DATOS],
        },
        {
          numero: '4', titulo: 'REGISTRO DE ANÁLISIS DE PRODUCTOS FITOSANITARIOS EN CASO DE HABERSE REALIZADO',
          headers: ['Fecha', 'Material analizado', 'Cultivo o cosecha muestreado/s', 'Nº Boletín de análisis', 'Laboratorio (nombre y dirección)', 'Sustancias activas detectadas'],
          colWidths: [1, 1.4, 1.6, 1.4, 2, 1.8], rows: [] as string[][], filasVaciasMin: 4, notas: [NOTA_SIN_DATOS], saltoPaginaAntes: true,
        },
        {
          numero: '5', titulo: 'REGISTRO DE COSECHA COMERCIALIZADA',
          headers: ['Fecha', 'Producto', 'Cantidad (kg)', 'Nº orden parcelas origen', 'Nº albarán/factura', 'Nº lote', 'Cliente: nombre/razón social', 'NIF', 'Dirección', 'Nº RGSEAA'],
          colWidths: [1, 1.2, 1, 1.4, 1.2, 0.9, 1.8, 1, 1.6, 1], rows: [] as string[][], filasVaciasMin: 5, notas: [NOTA_SIN_DATOS], saltoPaginaAntes: true,
        },
      ]

      await descargarCuadernoCampo(
        {
          campanaNombre: campanaSel.nombre,
          campanaFechaInicio: formatFechaEs(campanaSel.fechaInicio),
          campanaFechaFin: formatFechaEs(campanaSel.fechaFin),
          cabecera: nombreCabecera, datosGenerales, titular, secciones,
        },
        `cuaderno_explotacion_${campanaSel.nombre.trim().replace(/[^a-z0-9áéíóúñ]+/gi, '_')}.docx`
      )
    } catch (e: any) {
      console.error('Error generando el cuaderno de campo:', e)
      alert('No se pudo generar el cuaderno de campo: ' + (e?.message || e))
    } finally {
      setGenerandoCuaderno(false)
    }
  }

  // Cultivos únicos de mis parcelas (para desplegable en tratamiento)
  const cultivosUnicos = Array.from(new Set(misParcelas.map(p => p.cultivo).filter(Boolean))).sort()

  // Color fijo por cultivo (mismo color en todos los roscos, para poder comparar entre fincas)
  const PALETA_CULTIVOS = ['#3ddc6e', '#4db8ff', '#ffb84d', '#ff6b6b', '#c792ea', '#4dd0e1', '#f06292', '#aed581', '#ba68c8', '#ffd54f', '#81c784', '#7986cb']
  const colorDeCultivo = (cultivo: string) => PALETA_CULTIVOS[cultivosUnicos.indexOf(cultivo) % PALETA_CULTIVOS.length]

  // Datos para los roscos "% de cultivo por finca" (por superficie, ha)
  const roscosPorFinca = fincas
    .map(f => {
      const parcelasFinca = misParcelas.filter(p => p.fincaId === f.id)
      const supTotal = parcelasFinca.reduce((a, p) => a + p.supHa, 0)
      const porCultivo: Record<string, number> = {}
      parcelasFinca.forEach(p => { porCultivo[p.cultivo] = (porCultivo[p.cultivo] || 0) + p.supHa })
      const data = Object.entries(porCultivo)
        .map(([cultivo, sup]) => ({ cultivo, sup, pct: supTotal > 0 ? (sup / supTotal) * 100 : 0 }))
        .sort((a, b) => b.sup - a.sup)
      return { finca: f, data, supTotal }
    })
    .filter(d => d.data.length > 0)

  const roscosAMostrar = filtroFinca ? roscosPorFinca.filter(r => r.finca.id === filtroFinca) : roscosPorFinca

  // Renderiza los roscos "% cultivo por finca". Tamaño mayor en escritorio, sin recuadro en ningún caso.
  const renderRoscosFincas = () => {
    if (roscosAMostrar.length === 0) return null
    const tamDonut = isMobile ? 76 : 118
    const rInner = isMobile ? 21 : 34
    const rOuter = isMobile ? 36 : 56
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: isMobile ? 'flex-start' : 'flex-end', gap: isMobile ? 16 : 22, flex: isMobile ? undefined : 1, minWidth: 0 }}>
        {roscosAMostrar.map(({ finca, data }) => (
          <div key={finca.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ position: 'relative', width: tamDonut, height: tamDonut, flexShrink: 0 }}>
              <DonutChart
                slices={data.map(d => ({ value: d.sup, color: colorDeCultivo(d.cultivo) }))}
                innerRadius={rInner}
                outerRadius={rOuter}
              />
              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 4 }}>
                <span style={{ fontSize: isMobile ? 9 : 11, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)', lineHeight: 1.15, wordBreak: 'break-word' }}>{finca.nombre}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {data.map((d, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: colorDeCultivo(d.cultivo), flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', whiteSpace: 'nowrap' }}>{d.cultivo}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Cultivos disponibles para elegir en el asistente de tratamiento: los de la campaña
  // seleccionada (actuales de sus parcelas + históricos guardados para esa campaña), o
  // todos si aún no se ha elegido campaña. Así, al registrar un tratamiento olvidado de
  // una campaña ya cerrada, aparece el cultivo que había entonces aunque la parcela ya
  // tenga otro cultivo distinto ahora.
  const cultivosDisponiblesParaTrat = tCampanaId
    ? Array.from(new Set([
        ...misParcelas.filter(p => p.campanaId === tCampanaId || !p.campanaId).map(p => p.cultivo),
        ...historicoCultivos.filter(h => h.campanaId === tCampanaId).map(h => h.cultivo),
      ].filter(Boolean))).sort()
    : cultivosUnicos

  // Una parcela "coincide" con el cultivo elegido si es su cultivo actual, o si tiene un
  // registro histórico de ese cultivo para la campaña seleccionada.
  const parcelaCoincideCultivoTrat = (p: ParcelaGuardada): boolean => {
    if (!tCultivoSeleccionado) return true
    if (p.cultivo === tCultivoSeleccionado) return true
    return historicoCultivos.some(h => h.parcelaId === p.id && h.cultivo === tCultivoSeleccionado && h.campanaId === tCampanaId)
  }

  // Fincas disponibles para el cultivo seleccionado
  const fincasParaCultivo = tCultivoSeleccionado
    ? fincas.filter(f => misParcelas.some(p => parcelaCoincideCultivoTrat(p) && p.fincaId === f.id))
    : fincas

  // Parcelas filtradas por cultivo Y finca
  const parcelasFiltradas = misParcelas.filter(p => {
    if (!parcelaCoincideCultivoTrat(p)) return false
    if (tFincaSeleccionada && p.fincaId !== tFincaSeleccionada) return false
    return true
  })

  // Parcelas visibles en "Mis Parcelas" respetando filtro de finca y de campaña.
  // Al filtrar por campaña se muestran las parcelas de esa campaña MÁS las que no
  // tienen campaña asignada (cultivos no anuales), que siempre quedan visibles.
  const misParcelasVista = misParcelasVisibles.filter(p =>
    (!filtroFinca || p.fincaId === filtroFinca) &&
    (!filtroCampana || p.campanaId === filtroCampana || !p.campanaId) &&
    (!filtroCultivoParcelas || p.cultivo === filtroCultivoParcelas)
  )

  const esAplicador = (p: Personal) => p.funciones.some(f => FUNCIONES_APLICADOR.includes(f))
  const esRecomendador = (p: Personal) => p.funciones.some(f => FUNCIONES_RECOMENDADOR.includes(f))

  // Finca activa para filtrar el personal seleccionable en el formulario de tratamiento:
  // - Si el tratamiento viene desde una parcela concreta, se usa la finca de esa parcela.
  // - Si viene del asistente (cultivo → finca → parcelas), se usa la finca elegida en el paso 2
  //   (o la única finca existente, si solo hay una, aunque el paso no se muestre).
  const fincaActivaParaPersonalTrat = tratParcelaCtx
    ? (misParcelas.find(pc => pc.id === tratParcelaCtx)?.fincaId || '')
    : (tFincaSeleccionada || (fincas.length === 1 ? fincas[0].id : ''))

  // El personal externo (sin finca asignada) siempre está disponible; el personal con una
  // finca asignada solo puede seleccionarse en tratamientos de esa misma finca.
  const personalDisponibleEnFinca = (p: Personal) => !fincaActivaParaPersonalTrat || !p.fincaId || p.fincaId === fincaActivaParaPersonalTrat

  // Misma lógica para la maquinaria: la externa siempre está disponible; la propia solo
  // si su finca coincide con la finca activa del tratamiento.
  const equipoDisponibleEnFinca = (e: Equipo) => e.titularidad !== 'Propia' || !fincaActivaParaPersonalTrat || !e.fincaId || e.fincaId === fincaActivaParaPersonalTrat

  // Cultivo activo del tratamiento en curso (mismo criterio que la finca activa): si viene de
  // una parcela concreta, su cultivo actual — salvo que la campaña elegida no coincida con la
  // campaña actual de la parcela, en cuyo caso se busca el cultivo histórico de esa campaña.
  // Si viene del asistente, el elegido en el paso 1.
  const cultivoActivoParaTrat = tratParcelaCtx
    ? (() => {
        const p = misParcelas.find(pc => pc.id === tratParcelaCtx)
        if (!p) return ''
        if (!tCampanaId || p.campanaId === tCampanaId) return p.cultivo
        const hist = historicoCultivos.find(h => h.parcelaId === p.id && h.campanaId === tCampanaId)
        return hist ? hist.cultivo : p.cultivo
      })()
    : tCultivoSeleccionado

  // Tratamiento de referencia: el PRIMERO registrado para este mismo producto, este mismo
  // cultivo Y esta misma campaña. La dosis máxima, el nº máximo de aplicaciones, el % máximo
  // y la densidad son propiedades de la etiqueta del producto para ese cultivo — no deberían
  // cambiar entre tratamientos distintos del mismo producto sobre el mismo cultivo DENTRO de
  // la misma campaña — así que se toman siempre del primero que se registró en esa campaña.
  // Al cambiar de campaña se puede volver a fijar cada valor desde cero, sin arrastrar el de
  // una campaña anterior (los máximos legales pueden cambiar de una campaña a otra).
  const tratamientoReferenciaProductoCultivo = (): Tratamiento | null => {
    const prod = tProducto.trim().toLowerCase()
    if (!prod || !cultivoActivoParaTrat) return null
    const candidatos = tratamientos
      .filter(t => t.id !== tratEditar?.id && t.producto.trim().toLowerCase() === prod && (t.cultivoTrat || '') === cultivoActivoParaTrat && (t.campanaId || '') === (tCampanaId || ''))
      .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''))
    return candidatos[0] || null
  }
  const refProductoCultivo = tratamientoReferenciaProductoCultivo()

  // Avisos (no bloqueantes) si los valores actuales del formulario no coinciden con los del
  // tratamiento de referencia: el usuario puede seguir adelante si de verdad quiere cambiarlos.
  const avisosProductoCultivo: string[] = []
  if (refProductoCultivo) {
    if (tDosisMaxima.trim() && refProductoCultivo.dosisMaxima && (tDosisMaxima.trim() !== refProductoCultivo.dosisMaxima.trim() || tUnidadDosisMaxima !== refProductoCultivo.unidadDosisMaxima)) {
      avisosProductoCultivo.push(`Dosis máx. distinta a la de otros tratamientos de "${tProducto.trim()}" en ${cultivoActivoParaTrat} (registrada: ${refProductoCultivo.dosisMaxima} ${refProductoCultivo.unidadDosisMaxima || refProductoCultivo.unidadDosis}).`)
    }
    if (tAplicMaxima.trim() && refProductoCultivo.aplicMaxima && tAplicMaxima.trim() !== refProductoCultivo.aplicMaxima.trim()) {
      avisosProductoCultivo.push(`Nº máx. de aplicaciones distinto al registrado antes (${refProductoCultivo.aplicMaxima}).`)
    }
    if (tPorcentajeMaximo.trim() && refProductoCultivo.porcentajeMaximo && tPorcentajeMaximo.trim() !== refProductoCultivo.porcentajeMaximo.trim()) {
      avisosProductoCultivo.push(`% máximo distinto al registrado antes (${refProductoCultivo.porcentajeMaximo}%).`)
    }
    if (tDensidad.trim() && refProductoCultivo.densidad && tDensidad.trim() !== refProductoCultivo.densidad.trim()) {
      avisosProductoCultivo.push(`Densidad distinta a la registrada antes para este producto (${refProductoCultivo.densidad} Kg/L).`)
    }
  }

  // Al detectar un tratamiento de referencia para el mismo producto+cultivo, se rellenan
  // automáticamente los campos que el usuario aún no haya tocado (no se sobrescribe lo que
  // ya haya introducido a mano). El usuario puede modificarlos igualmente después.
  useEffect(() => {
    if (!formTrat || !refProductoCultivo) return
    if (!tDosisMaxima.trim()) { setTDosisMaxima(refProductoCultivo.dosisMaxima); setTUnidadDosisMaxima(refProductoCultivo.unidadDosisMaxima || refProductoCultivo.unidadDosis) }
    if (!tAplicMaxima.trim()) setTAplicMaxima(refProductoCultivo.aplicMaxima)
    if (!tPorcentajeMaximo.trim() && refProductoCultivo.porcentajeMaximo) setTPorcentajeMaximo(refProductoCultivo.porcentajeMaximo)
    if ((!tDensidad.trim() || tDensidad === '1') && refProductoCultivo.densidad && refProductoCultivo.densidad !== '1') setTDensidad(refProductoCultivo.densidad)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formTrat, refProductoCultivo?.id])

  // Numeración dinámica de los pasos del asistente de tratamiento (cultivo → finca → personal → maquinaria → parcelas)
  const pasoFincaVisible = fincas.length > 1
  const pasoPersonalVisible = personal.some(p => p.activo && (esRecomendador(p) || esAplicador(p)))
  const pasoEquipoVisible = equipos.length > 0
  const pasoNumCultivo = 1
  const pasoNumFinca = pasoFincaVisible ? 2 : null
  const pasoNumPersonal = pasoPersonalVisible ? (1 + (pasoFincaVisible ? 1 : 0) + 1) : null
  const pasoNumEquipo = pasoEquipoVisible ? (1 + (pasoFincaVisible ? 1 : 0) + (pasoPersonalVisible ? 1 : 0) + 1) : null
  const pasoNumParcelas = 1 + (pasoFincaVisible ? 1 : 0) + (pasoPersonalVisible ? 1 : 0) + (pasoEquipoVisible ? 1 : 0) + 1

  // Renderiza los selectores "Recomendado por" / "Aplicado por", filtrando el personal
  // a la finca activa (el personal externo, sin finca asignada, siempre aparece).
  const renderSelectoresPersonal = () => {
    const recomendadores = personal.filter(p => p.activo && esRecomendador(p) && personalDisponibleEnFinca(p))
    const aplicadores = personal.filter(p => p.activo && esAplicador(p) && personalDisponibleEnFinca(p))
    const predRecomendador = recomendadores.find(p => p.predeterminadoRecomendador)
    const predAplicador = aplicadores.find(p => p.predeterminadoAplicador)
    return (
      <>
        {recomendadores.length > 0 && (
          <div>
            <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recomendado por</label>
            <select
              value={tRecomendadoPor}
              onChange={e => setTRecomendadoPor(e.target.value)}
              style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: tRecomendadoPor ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}
            >
              <option value="">Sin asignar</option>
              {recomendadores.map(p => (
                <option key={p.id} value={p.id}>
                  {p.predeterminadoRecomendador ? '⭐ ' : ''}{p.nombre} ({p.funciones.filter(f => FUNCIONES_RECOMENDADOR.includes(f)).join(', ')})
                </option>
              ))}
            </select>
            {predRecomendador && !tRecomendadoPor && (
              <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 3 }}>
                Predeterminado: {predRecomendador.nombre}
                <button onClick={() => setTRecomendadoPor(predRecomendador.id)} style={{ marginLeft: 6, color: 'var(--green)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, fontFamily: 'var(--mono)', textDecoration: 'underline' }}>Usar</button>
              </div>
            )}
          </div>
        )}
        {aplicadores.length > 0 && (
          <div>
            <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Aplicado por</label>
            <select
              value={tAplicadoPor}
              onChange={e => setTAplicadoPor(e.target.value)}
              style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: tAplicadoPor ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}
            >
              <option value="">Sin asignar</option>
              {aplicadores.map(p => (
                <option key={p.id} value={p.id}>
                  {p.predeterminadoAplicador ? '⭐ ' : ''}{p.nombre} ({p.funciones.filter(f => FUNCIONES_APLICADOR.includes(f)).join(', ')})
                </option>
              ))}
            </select>
            {predAplicador && !tAplicadoPor && (
              <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 3 }}>
                Predeterminado: {predAplicador.nombre}
                <button onClick={() => setTAplicadoPor(predAplicador.id)} style={{ marginLeft: 6, color: 'var(--green)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, fontFamily: 'var(--mono)', textDecoration: 'underline' }}>Usar</button>
              </div>
            )}
          </div>
        )}
      </>
    )
  }

  // Renderiza el selector de maquinaria (checkboxes, máximo 2), filtrando a la finca activa.
  // La maquinaria externa siempre está disponible; la propia solo si es de la finca del tratamiento.
  const renderSelectorMaquinaria = () => {
    const disponibles = equipos.filter(equipoDisponibleEnFinca)
    if (disponibles.length === 0) return null
    const toggleEquipo = (id: string) => {
      setTEquipoIds(prev => {
        if (prev.includes(id)) return prev.filter(x => x !== id)
        if (prev.length >= 2) return prev // máximo 2
        return [...prev, id]
      })
    }
    return (
      <div>
        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Maquinaria (máx. 2) — opcional
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
          {disponibles.map(e => {
            const marcado = tEquipoIds.includes(e.id)
            const deshabilitado = !marcado && tEquipoIds.length >= 2
            return (
              <label key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 4, cursor: deshabilitado ? 'not-allowed' : 'pointer', opacity: deshabilitado ? 0.4 : 1, background: marcado ? 'rgba(61,220,110,0.08)' : 'transparent' }}>
                <input type="checkbox" checked={marcado} disabled={deshabilitado} onChange={() => toggleEquipo(e.id)} />
                <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: 'var(--sans)' }}>
                  {e.nombre} <span style={{ color: 'var(--muted)', fontSize: 10 }}>({e.tipo}{e.subtipo ? ` · ${e.subtipo}` : ''}{e.titularidad === 'Externa' ? ' · externa' : ''})</span>
                </span>
              </label>
            )
          })}
        </div>
        {tEquipoIds.length >= 2 && (
          <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 4 }}>Máximo 2 equipos por tratamiento.</div>
        )}
      </div>
    )
  }


  // - DATOS DE LA EXPLOTACIÓN: campo de texto reutilizable en el formulario -
  const campoDE = (key: keyof DatosExplotacion, label: string, tipo: 'text' | 'email' | 'tel' = 'text') => (
    <div>
      <label style={{ display: 'block', fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase' }}>{label}</label>
      <input type={tipo} value={deForm[key]} onChange={e => setDeForm({ ...deForm, [key]: e.target.value })}
        style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5, padding: '7px 9px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--sans)', outline: 'none' }} />
    </div>
  )

  // - HORAS DE TRABAJO: editor de días/horario reutilizable (popup y formulario de tarea) -
  const renderEditorDias = (dias: DiaHorario[], setDias: (d: DiaHorario[]) => void) => {
    const inputStyle: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none' }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {dias.map((d, i) => {
          const mins = minutosEntreHoras(d.horaInicio, d.horaFin)
          const completo = !!(d.fecha && d.horaInicio && d.horaFin)
          return (
            <div key={d.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '8px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', minWidth: 42 }}>Día {i + 1}</span>
              <input type="date" value={d.fecha} onChange={e => setDias(dias.map(x => x.id === d.id ? { ...x, fecha: e.target.value } : x))} style={{ ...inputStyle, flex: '1 1 130px' }} />
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>De:</span>
              <input type="time" value={d.horaInicio} onChange={e => setDias(dias.map(x => x.id === d.id ? { ...x, horaInicio: e.target.value } : x))} style={{ ...inputStyle, width: 90 }} />
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>A:</span>
              <input type="time" value={d.horaFin} onChange={e => setDias(dias.map(x => x.id === d.id ? { ...x, horaFin: e.target.value } : x))} style={{ ...inputStyle, width: 90 }} />
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: completo ? 'var(--green)' : 'var(--muted)', marginLeft: 'auto' }}>
                {completo ? `Total: ${formatDuracion(mins)}` : ''}
              </span>
              <button onClick={() => setDias(dias.filter(x => x.id !== d.id))} title="Eliminar día"
                style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}>✕</button>
            </div>
          )
        })}
        <button onClick={() => setDias([...dias, nuevoDiaHorario()])}
          style={{ alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 6, background: 'var(--surface2)', border: '1px dashed var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>
          + Añadir otro día
        </button>
        {dias.length > 0 && (
          <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
            Total acumulado: {formatDuracion(totalMinutosDias(dias))}
          </div>
        )}
      </div>
    )
  }


  const saveTratamientos = (lista: Tratamiento[]) => {
    setTratamientos(lista)
  }

  const upsertTratamientoDB = async (t: Tratamiento): Promise<string | null> => {
    if (!session) return null
    try {
      const { error } = await supabase.from('tratamientos').upsert({
        id: t.id, user_id: session.user.id, tipo: t.tipo, producto: t.producto,
        materia_activa: t.materiaActiva, num_registro: t.numRegistro || null, dosis: t.dosis, unidad_dosis: t.unidadDosis,
        dosis_maxima: t.dosisMaxima, unidad_dosis_maxima: t.unidadDosisMaxima || t.unidadDosis, aplic_maxima: t.aplicMaxima, fecha: t.fecha,
        litros_caldo_ha: t.litrosCaldoHa ? Number(t.litrosCaldoHa) : null,
        kg_semilla_ha: t.kgSemillaHa ? Number(t.kgSemillaHa) : null,
        porcentaje_aplicado: t.porcentajeAplicado ? Number(t.porcentajeAplicado) : 100,
        porcentaje_maximo: t.porcentajeMaximo ? Number(t.porcentajeMaximo) : null,
        densidad: t.densidad ? Number(t.densidad) : 1,
        aplicador: t.aplicador, observaciones: t.observaciones, parcela_ids: t.parcelaIds, equipo_ids: t.equipoIds || [],
        fecha_registro: t.fechaRegistro, mrl_resultado: t.mrlResultado || null,
        recomendado_por: t.recomendadoPor || null, aplicado_por: t.aplicadoPor || null,
        finca_id: t.fincaId || null, cultivo: t.cultivoTrat || null,
        campana_id: t.campanaId || null, tarea_id: t.tareaId || null,
        horas_trabajadas: t.horasTrabajadas && t.horasTrabajadas.length > 0 ? t.horasTrabajadas : null,
        horas_personal_id: t.horasPersonalId || null,
        problema_fitosanitario: t.problemaFitosanitario || null, eficacia: t.eficacia || null,
      })
      if (error) {
        console.error('Error guardando tratamiento en Supabase:', error)
        return 'No se pudo guardar en la base de datos: ' + error.message
      }
      return null
    } catch (e: any) {
      console.error('Error guardando tratamiento:', e)
      return 'No se pudo guardar en la base de datos.'
    }
  }

  const abrirFormTrat = (parcelaId?: string, trat?: Tratamiento, personalId?: string) => {
    if (!misPermisos['tratamientos.crear_editar']) return
    setTratEditar(trat || null)
    setTratParcelaCtx(parcelaId || null)
    setTRealizada(true)
    // Si viene desde ficha de personal, pre-rellenar recomendado/aplicado
    if (personalId) {
      const p = personal.find(x => x.id === personalId)
      if (p) {
        if (esRecomendador(p)) setTRecomendadoPor(personalId)
        if (esAplicador(p)) setTAplicadoPor(personalId)
      }
    }
    setTTipo(trat?.tipo || '')
    setTCampanaId(trat?.campanaId || '')
    setTProducto(trat?.producto || '')
    setTMateriaActiva(trat?.materiaActiva || '')
    setTNumRegistro(trat?.numRegistro || '')
    setTDosis(trat?.dosis || '')
    setMrlResultado(trat?.mrlResultado || null)
    setTUnidad(trat?.unidadDosis || 'L/ha')
    setTLitrosCaldoHa(trat?.litrosCaldoHa || '')
    setTKgSemillaHa(trat?.kgSemillaHa || '')
    setTPorcentajeAplicado(trat?.porcentajeAplicado || '100')
    setTPorcentajeMaximo(trat?.porcentajeMaximo || '')
    setTDensidad(trat?.densidad || '1')
    setTEquipoIds(trat?.equipoIds || [])
    setTDosisMaxima(trat?.dosisMaxima || '')
    setTUnidadDosisMaxima(trat?.unidadDosisMaxima || trat?.unidadDosis || 'L/ha')
    setTAplicMaxima(trat?.aplicMaxima || '')
    setTRecomendadoPor(trat?.recomendadoPor || '')
    setTAplicadoPor(trat?.aplicadoPor || '')
    // Si el tratamiento no tiene guardados cultivo/finca (p. ej. se creó desde una parcela
    // concreta en "Mis Parcelas"), los derivamos de la primera parcela asociada, para que al
    // editar aparezcan ya preseleccionados el cultivo, la finca y la parcela (siguen siendo editables).
    const parcelaRefEditar = trat?.parcelaIds?.length ? misParcelas.find(p => p.id === trat.parcelaIds[0]) : null
    setTCultivoSeleccionado(trat?.cultivoTrat || parcelaRefEditar?.cultivo || '')
    setTFincaSeleccionada(trat?.fincaId || parcelaRefEditar?.fincaId || '')
    setFitoBusqueda('')
    setFitoResultados([])
    setFitoSeleccionado(null)
    setTFecha(trat?.fecha || '')
    setTAplicador(trat?.aplicador || '')
    setTObs(trat?.observaciones || '')
    setTProblema(trat?.problemaFitosanitario || '')
    setTEficacia(trat?.eficacia || '')
    setTParcelas(trat?.parcelaIds || (parcelaId ? [parcelaId] : []))
    setTError('')
    setFormTrat(true)
  }


  const buscarFito = async (q: string) => {
    setFitoBusqueda(q)
    setFitoSeleccionado(null)
    if (q.length < 2) { setFitoResultados([]); return }
    setFitoBuscando(true)
    try {
      const r = await fetch(`${BACKEND}/fito/buscar?q=${encodeURIComponent(q)}`)
      const data = await r.json()
      setFitoResultados(data.productos || [])
    } catch { setFitoResultados([]) }
    finally { setFitoBuscando(false) }
  }

  const seleccionarFito = async (p: FitoProducto) => {
    setFitoSeleccionado(p)
    setFitoBusqueda(p.nombre)
    setFitoResultados([])
    setTProducto(p.nombre)
    setTNumRegistro(p.num_registro || '')
    // Auto-rellenar materia activa desde formulado del producto
    if (p.formulado) {
      // El formulado es tipo "GLIFOSATO 36% [SL] P/V" - extraer materia activa
      // Extraer materia activa: todo antes del primer numero
      const ma = p.formulado.split('%')[0].replace(/[0-9.,]+$/, '').trim()
      if (ma) setTMateriaActiva(ma)
    }
    try {
      const r = await fetch(`${BACKEND}/fito/producto/${p.id}`)
      if (r.ok) {
        const detalle = await r.json()
        setFitoSeleccionado(detalle)
        if (detalle.num_registro) setTNumRegistro(detalle.num_registro)
        if (detalle.formulado && !tMateriaActiva) {
          const ma2 = detalle.formulado.split('%')[0].replace(/[0-9.,]+$/, '').trim()
          if (ma2) setTMateriaActiva(ma2)
        }
      }
    } catch {}
  }

  const guardarTratamiento = async () => {
    if (!misPermisos['tratamientos.crear_editar']) return
    if (!tTipo) { setTError('El tipo es obligatorio'); return }
    if (!tCampanaId) { setTError('La campaña es obligatoria para registrar un tratamiento fitosanitario'); return }
    if (!tProducto.trim()) { setTError('El producto es obligatorio'); return }
    if (!tDosis.trim()) { setTError('La dosis es obligatoria'); return }
    if (!tFecha) { setTError(tRealizada ? 'La fecha es obligatoria' : 'La fecha prevista es obligatoria'); return }
    if (tParcelas.length === 0) { setTError('Selecciona al menos una parcela'); return }
    if (unidadNecesitaCaldo(tUnidad) && (!tLitrosCaldoHa.trim() || Number(tLitrosCaldoHa) <= 0)) { setTError('Indica los litros de caldo/ha para poder usar esta unidad'); return }
    if (unidadNecesitaSemilla(tUnidad) && (!tKgSemillaHa.trim() || Number(tKgSemillaHa) <= 0)) { setTError('Indica los kg de semilla/ha para poder usar esta unidad'); return }
    if (tPorcentajeAplicado.trim() && (Number(tPorcentajeAplicado) <= 0 || Number(tPorcentajeAplicado) > 100)) { setTError('El % de superficie aplicada debe estar entre 1 y 100'); return }

    const campanaElegida = campanas.find(c => c.id === tCampanaId)
    if (campanaElegida && tFecha < campanaElegida.fechaInicio) {
      setTError(`La fecha ${tRealizada ? 'del tratamiento' : 'prevista'} (${tFecha}) es anterior al inicio de la campaña "${campanaElegida.nombre}" (${campanaElegida.fechaInicio}). Elige una fecha dentro de la campaña, o selecciona otra.`)
      return
    }
    if (campanaElegida && tFecha > campanaElegida.fechaFin) {
      setTError(`La fecha ${tRealizada ? 'del tratamiento' : 'prevista'} (${tFecha}) es posterior al fin de la campaña "${campanaElegida.nombre}" (${campanaElegida.fechaFin}). Elige una fecha anterior o igual, o selecciona otra campaña.`)
      return
    }

    const datosComunes = {
      tipo: tTipo, producto: tProducto.trim(), materiaActiva: tMateriaActiva.trim(), numRegistro: tNumRegistro.trim() || undefined,
      dosis: tDosis.trim(), unidadDosis: tUnidad,
      litrosCaldoHa: unidadNecesitaCaldo(tUnidad) ? tLitrosCaldoHa.trim() : '',
      kgSemillaHa: unidadNecesitaSemilla(tUnidad) ? tKgSemillaHa.trim() : '',
      porcentajeAplicado: tPorcentajeAplicado.trim() && Number(tPorcentajeAplicado) > 0 ? tPorcentajeAplicado.trim() : '100',
      porcentajeMaximo: tPorcentajeMaximo.trim() || '',
      densidad: tDensidad.trim() && Number(tDensidad) > 0 ? tDensidad.trim() : '1',
      dosisMaxima: tDosisMaxima.trim(), unidadDosisMaxima: tUnidadDosisMaxima, aplicMaxima: tAplicMaxima.trim(),
      fecha: tFecha,
      aplicador: tAplicador.trim(), observaciones: tObs.trim(),
      problemaFitosanitario: tProblema.trim() || undefined,
      eficacia: tEficacia || undefined,
      parcelaIds: tParcelas,
      equipoIds: tEquipoIds.slice(0, 2),
      mrlResultado: mrlResultado || undefined,
      recomendadoPor: tRecomendadoPor || undefined,
      aplicadoPor: tAplicadoPor || undefined,
      fincaId: tFincaSeleccionada || (tratParcelaCtx ? misParcelas.find(p => p.id === tratParcelaCtx)?.fincaId : undefined) || undefined,
      cultivoTrat: cultivoActivoParaTrat || undefined,
      campanaId: tCampanaId,
    }

    if (!tRealizada) {
      // "No realizada": no se crea el tratamiento todavía — se guarda como borrador dentro de
      // la tarea (pendiente), para poder completarla más tarde sin volver a introducir datos.
      if (!session) return
      const tareaPrevia = tareaEnCreacionId ? tareas.find(x => x.id === tareaEnCreacionId) : undefined
      const nuevaTarea: Tarea = {
        id: tareaEnCreacionId || String(Date.now()),
        tipo: 'Tratamiento fitosanitario', estado: 'pendiente',
        campanaId: tCampanaId, fincaId: datosComunes.fincaId, parcelaIds: tParcelas,
        creadoPor: tRecomendadoPor || undefined, ejecutorId: tAplicadoPor || undefined,
        fechaPrevista: tFecha, equipoIds: tEquipoIds.slice(0, 2), comentarios: tObs.trim(),
        borradorTratamiento: datosComunes,
        tratamientoId: undefined, // al volver a "no realizada" se desvincula el tratamiento que hubiera
        fechaRegistro: tareaPrevia?.fechaRegistro || new Date().toLocaleDateString('es-ES'),
      }
      const { error: errorTarea } = await supabase.from('tareas').upsert({
        id: nuevaTarea.id, user_id: session.user.id, tipo: nuevaTarea.tipo, tipo_otro: null,
        estado: nuevaTarea.estado, campana_id: nuevaTarea.campanaId || null, finca_id: nuevaTarea.fincaId || null,
        parcela_ids: nuevaTarea.parcelaIds, creado_por: nuevaTarea.creadoPor || null, ejecutor_id: nuevaTarea.ejecutorId || null,
        fecha_prevista: nuevaTarea.fechaPrevista, equipo_ids: nuevaTarea.equipoIds, comentarios: nuevaTarea.comentarios,
        borrador_tratamiento: nuevaTarea.borradorTratamiento, tratamiento_id: null, fecha_registro: nuevaTarea.fechaRegistro,
      })
      if (errorTarea) {
        console.error('Error guardando tarea (borrador de tratamiento):', errorTarea)
        setTError(`No se pudo guardar: ${errorTarea.message}`)
        return
      }
      // Si esta tarea ya estaba realizada y enlazada a un tratamiento real, ese tratamiento
      // deja de tener sentido (la tarea vuelve a pendiente) — se elimina para no dejarlo huérfano.
      if (tareaPrevia?.tratamientoId) {
        saveTratamientos(tratamientos.filter(t => t.id !== tareaPrevia.tratamientoId))
        try { await supabase.from('tratamientos').delete().eq('id', tareaPrevia.tratamientoId) } catch (e) { console.error(e) }
      }
      setTareas(tareas.some(t => t.id === nuevaTarea.id) ? tareas.map(t => t.id === nuevaTarea.id ? nuevaTarea : t) : [nuevaTarea, ...tareas])
      setFormTrat(false); setTratEditar(null); setTareaEnCreacionId(null)
      setPestana('tareas'); setTareaSeleccionadaId(nuevaTarea.id)
      return
    }

    // Si la tarea de la que viene ya estaba realizada y enlazada a un tratamiento, se actualiza
    // ESE tratamiento en vez de crear uno nuevo (evita duplicados al reeditar una tarea completada).
    const tareaOrigen = tareaEnCreacionId ? tareas.find(t => t.id === tareaEnCreacionId) : undefined
    const tratamientoVinculadoOrigen = tareaOrigen?.tratamientoId ? tratamientos.find(t => t.id === tareaOrigen.tratamientoId) : undefined
    const idTratamientoDestino = tratEditar?.id || tareaOrigen?.tratamientoId || String(Date.now())

    const nuevo: Tratamiento = {
      id: idTratamientoDestino,
      ...datosComunes,
      fechaRegistro: tratEditar?.fechaRegistro || tratamientoVinculadoOrigen?.fechaRegistro || new Date().toLocaleDateString('es-ES'),
      tareaId: tareaEnCreacionId || tratEditar?.tareaId || undefined,
      // Las horas de trabajo no se editan en este formulario — se conservan las que ya
      // hubiera (reeditando un tratamiento existente, directamente o vía su tarea) y se
      // completan/ajustan justo después, en el popup de horas que se abre al guardar.
      horasTrabajadas: tratEditar?.horasTrabajadas || tratamientoVinculadoOrigen?.horasTrabajadas,
      horasPersonalId: tratEditar?.horasPersonalId || tratamientoVinculadoOrigen?.horasPersonalId,
    }
    const yaExiste = tratamientos.some(t => t.id === nuevo.id)
    const lista = yaExiste
      ? tratamientos.map(t => t.id === nuevo.id ? nuevo : t)
      : [nuevo, ...tratamientos]
    saveTratamientos(lista)
    const errorDB = await upsertTratamientoDB(nuevo)
    if (errorDB) { setTError(errorDB); return }

    // Si venía de una tarea (pendiente que ahora se completa, o ya realizada que se reedita),
    // se marca/mantiene como realizada y se enlaza al tratamiento correspondiente.
    if (tareaEnCreacionId) {
      const tareaVinculada = tareas.find(t => t.id === tareaEnCreacionId)
      if (tareaVinculada) {
        const actualizada = { ...tareaVinculada, estado: 'realizada' as const, tratamientoId: nuevo.id }
        setTareas(tareas.map(t => t.id === tareaEnCreacionId ? actualizada : t))
        try { await supabase.from('tareas').update({ estado: 'realizada', tratamiento_id: nuevo.id }).eq('id', tareaEnCreacionId) } catch (e) { console.error(e) }
      }
      setTareaEnCreacionId(null)
    }

    setFormTrat(false)
    setTratEditar(null)

    // El tratamiento ya está guardado como realizado — se abre el popup para indicar los
    // días y el horario dedicados a realizarlo (con lo que ya hubiera guardado, si lo hay).
    setHorasPopupModo({ tipo: 'tratamiento_guardado', tratamientoId: nuevo.id })
    setHorasPopupDias(nuevo.horasTrabajadas && nuevo.horasTrabajadas.length > 0 ? nuevo.horasTrabajadas : [nuevoDiaHorario()])
    setHorasPopupPersonalId(nuevo.horasPersonalId || nuevo.aplicadoPor || '')
    setHorasPopupError('')
  }

  // - TAREAS: creación / gestión -
  const abrirNuevaTarea = () => { setNuevaTareaTipo(''); setFormNuevaTareaVisible(true) }

  const continuarNuevaTarea = () => {
    if (!nuevaTareaTipo) return
    setFormNuevaTareaVisible(false)
    if (nuevaTareaTipo === 'Tratamiento fitosanitario') {
      setTareaEnCreacionId(null)
      abrirFormTrat()
      setTRealizada(false)
    } else {
      setTarEditar(null)
      setTarTipo(nuevaTareaTipo); setTarTipoOtro('')
      setTarCampanaId(''); setTarFincaId(''); setTarParcelaIds([])
      setTarCreadoPor(''); setTarEjecutorId('')
      setTarFechaPrevista(new Date().toISOString().slice(0, 10))
      setTarEquipoIds([]); setTarComentarios(''); setTarError('')
      setTarHorasTrabajadas([])
      setTarFormVisible(true)
    }
  }

  const guardarTareaGeneral = async () => {
    if (!misPermisos['tareas.crear_asignar'] && tarEjecutorId && tarEjecutorId !== miPersonalId) return
    if (!session) return
    if (!tarTipo) { setTarError('El tipo es obligatorio'); return }
    if (tarTipo === 'Otros' && !tarTipoOtro.trim()) { setTarError('Indica el tipo de tarea'); return }
    if (!tarFechaPrevista) { setTarError('La fecha prevista es obligatoria'); return }
    if (tarCampanaId) {
      const campanaElegida = campanas.find(c => c.id === tarCampanaId)
      if (campanaElegida && tarFechaPrevista < campanaElegida.fechaInicio) {
        setTarError(`La fecha prevista (${tarFechaPrevista}) es anterior al inicio de la campaña "${campanaElegida.nombre}" (${campanaElegida.fechaInicio}).`)
        return
      }
      if (campanaElegida && tarFechaPrevista > campanaElegida.fechaFin) {
        setTarError(`La fecha prevista (${tarFechaPrevista}) es posterior al fin de la campaña "${campanaElegida.nombre}" (${campanaElegida.fechaFin}).`)
        return
      }
    }

    const nueva: Tarea = {
      id: tarEditar?.id || String(Date.now()),
      tipo: tarTipo, tipoOtro: tarTipo === 'Otros' ? tarTipoOtro.trim() : undefined,
      estado: tarEditar?.estado || 'pendiente',
      campanaId: tarCampanaId || undefined, fincaId: tarFincaId || undefined, parcelaIds: tarParcelaIds,
      creadoPor: tarCreadoPor || undefined, ejecutorId: tarEjecutorId || undefined,
      fechaPrevista: tarFechaPrevista, equipoIds: tarEquipoIds, comentarios: tarComentarios.trim(),
      tratamientoId: tarEditar?.tratamientoId, borradorTratamiento: tarEditar?.borradorTratamiento,
      fechaRegistro: tarEditar?.fechaRegistro || new Date().toLocaleDateString('es-ES'),
      horasTrabajadas: tarHorasTrabajadas.filter(d => d.fecha && d.horaInicio && d.horaFin),
      horasPersonalId: tarEjecutorId || undefined,
    }
    setTareas(tarEditar ? tareas.map(t => t.id === nueva.id ? nueva : t) : [nueva, ...tareas])
    try {
      await supabase.from('tareas').upsert({
        id: nueva.id, user_id: session.user.id, tipo: nueva.tipo, tipo_otro: nueva.tipoOtro || null,
        estado: nueva.estado, campana_id: nueva.campanaId || null, finca_id: nueva.fincaId || null,
        parcela_ids: nueva.parcelaIds, creado_por: nueva.creadoPor || null, ejecutor_id: nueva.ejecutorId || null,
        fecha_prevista: nueva.fechaPrevista, equipo_ids: nueva.equipoIds, comentarios: nueva.comentarios,
        tratamiento_id: nueva.tratamientoId || null, borrador_tratamiento: nueva.borradorTratamiento || null,
        fecha_registro: nueva.fechaRegistro,
        horas_trabajadas: nueva.horasTrabajadas && nueva.horasTrabajadas.length > 0 ? nueva.horasTrabajadas : null,
        horas_personal_id: nueva.horasPersonalId || null,
      })
    } catch (e) { console.error('Error guardando tarea:', e) }
    setTarFormVisible(false); setTarEditar(null); setTareaSeleccionadaId(nueva.id)
  }

  const abrirEditarTareaGeneral = (t: Tarea) => {
    if (!misPermisos['tareas.crear_asignar'] && t.ejecutorId !== miPersonalId) return
    setTarEditar(t); setTarTipo(t.tipo); setTarTipoOtro(t.tipoOtro || '')
    setTarCampanaId(t.campanaId || ''); setTarFincaId(t.fincaId || ''); setTarParcelaIds(t.parcelaIds)
    setTarCreadoPor(t.creadoPor || ''); setTarEjecutorId(t.ejecutorId || '')
    setTarFechaPrevista(t.fechaPrevista); setTarEquipoIds(t.equipoIds); setTarComentarios(t.comentarios)
    setTarHorasTrabajadas(t.horasTrabajadas && t.horasTrabajadas.length > 0 ? t.horasTrabajadas : [])
    setTarError(''); setTarFormVisible(true)
  }

  // Reabre el cuestionario de tratamiento con los datos guardados en el borrador de la tarea,
  // para poder ajustarlos antes de completarla (sigue guardándose como "no realizada")
  const abrirEditarTareaTratamiento = (t: Tarea) => {
    const b = t.borradorTratamiento || {}
    setTareaEnCreacionId(t.id)
    abrirFormTrat(undefined, { ...b, id: t.id, parcelaIds: t.parcelaIds } as Tratamiento)
    setTratEditar(null) // no es un tratamiento real todavía, evita que guardarTratamiento intente actualizar uno
    setTRealizada(t.estado === 'realizada')
  }

  // Abre el popup de horas de trabajo antes de completar la tarea. La tarea se marca como
  // realizada de verdad al guardar el popup (ver guardarHorasPopup / completarTareaConHoras).
  const iniciarMarcarTareaRealizada = (t: Tarea) => {
    if (!session) return
    if (t.tipo === 'Tratamiento fitosanitario') {
      if (!misPermisos['tratamientos.crear_editar'] && t.ejecutorId !== miPersonalId) { alert('No tienes permiso para completar tratamientos fitosanitarios.'); return }
      if (!t.borradorTratamiento) { alert('Esta tarea no tiene datos de tratamiento guardados. Edítala primero.'); return }
    }
    setHorasPopupModo({ tipo: 'tarea_completar', tareaId: t.id })
    setHorasPopupDias(t.horasTrabajadas && t.horasTrabajadas.length > 0 ? t.horasTrabajadas : [nuevoDiaHorario()])
    setHorasPopupPersonalId(t.horasPersonalId || t.ejecutorId || '')
    setHorasPopupError('')
  }

  // Convierte directamente el borrador en un tratamiento realizado (tareas de tipo
  // "Tratamiento fitosanitario"), o marca la tarea como realizada (el resto de tipos),
  // guardando en cada caso los días/horario de trabajo indicados en el popup.
  const completarTareaConHoras = async (t: Tarea, dias: DiaHorario[], personalId: string) => {
    if (!session) return
    if (t.tipo === 'Tratamiento fitosanitario') {
      if (!t.borradorTratamiento) return
      const b = t.borradorTratamiento
      const nuevoTrat: Tratamiento = {
        id: String(Date.now()),
        tipo: b.tipo, producto: b.producto, materiaActiva: b.materiaActiva,
        dosis: b.dosis, unidadDosis: b.unidadDosis,
        litrosCaldoHa: b.litrosCaldoHa, kgSemillaHa: b.kgSemillaHa,
        porcentajeAplicado: b.porcentajeAplicado || '100', porcentajeMaximo: b.porcentajeMaximo,
        densidad: b.densidad || '1', dosisMaxima: b.dosisMaxima, unidadDosisMaxima: b.unidadDosisMaxima,
        aplicMaxima: b.aplicMaxima, fecha: new Date().toISOString().slice(0, 10),
        aplicador: b.aplicador || '', observaciones: b.observaciones || '',
        parcelaIds: b.parcelaIds || t.parcelaIds, fechaRegistro: new Date().toLocaleDateString('es-ES'),
        equipoIds: b.equipoIds || t.equipoIds, mrlResultado: b.mrlResultado,
        recomendadoPor: b.recomendadoPor, aplicadoPor: b.aplicadoPor || t.ejecutorId,
        fincaId: b.fincaId || t.fincaId, cultivoTrat: b.cultivoTrat, campanaId: b.campanaId || t.campanaId,
        tareaId: t.id,
        horasTrabajadas: dias.length > 0 ? dias : undefined,
        horasPersonalId: personalId || undefined,
        problemaFitosanitario: b.problemaFitosanitario, eficacia: b.eficacia,
      }
      saveTratamientos([nuevoTrat, ...tratamientos])
      await upsertTratamientoDB(nuevoTrat)
      const actualizada: Tarea = { ...t, estado: 'realizada', tratamientoId: nuevoTrat.id }
      setTareas(tareas.map(x => x.id === t.id ? actualizada : x))
      try { await supabase.from('tareas').update({ estado: 'realizada', tratamiento_id: nuevoTrat.id }).eq('id', t.id) } catch (e) { console.error(e) }
      return
    }
    const actualizada: Tarea = { ...t, estado: 'realizada', horasTrabajadas: dias.length > 0 ? dias : undefined, horasPersonalId: personalId || undefined }
    setTareas(tareas.map(x => x.id === t.id ? actualizada : x))
    try {
      await supabase.from('tareas').update({
        estado: 'realizada',
        horas_trabajadas: dias.length > 0 ? dias : null,
        horas_personal_id: personalId || null,
      }).eq('id', t.id)
    } catch (e) { console.error(e) }
  }

  // Guarda el popup de horas de trabajo. `omitir=true` (botón "sin horas" o la X de cerrar)
  // completa/cierra igualmente, pero sin guardar ningún día.
  const guardarHorasPopup = async (omitir: boolean = false) => {
    if (!horasPopupModo) return
    let diasValidos: DiaHorario[] = []
    if (!omitir) {
      const incompleto = horasPopupDias.some(d => (d.fecha || d.horaInicio || d.horaFin) && !(d.fecha && d.horaInicio && d.horaFin))
      if (incompleto) { setHorasPopupError('Completa la fecha, la hora de inicio y la hora de fin de cada día (o elimínalo).'); return }
      diasValidos = horasPopupDias.filter(d => d.fecha && d.horaInicio && d.horaFin)
      if (diasValidos.length > 0 && !horasPopupPersonalId) { setHorasPopupError(`No hay ejecutor/aplicador asignado. Asígnalo al editar ${horasPopupModo.tipo === 'tratamiento_guardado' ? 'el tratamiento' : 'la tarea'} antes de registrar horas.`); return }
    }
    setHorasPopupGuardando(true); setHorasPopupError('')
    try {
      if (horasPopupModo.tipo === 'tarea_completar') {
        const t = tareas.find(x => x.id === horasPopupModo.tareaId)
        if (t) await completarTareaConHoras(t, diasValidos, horasPopupPersonalId)
      } else {
        const idT = horasPopupModo.tratamientoId
        setTratamientos(prev => prev.map(x => x.id === idT ? { ...x, horasTrabajadas: diasValidos.length > 0 ? diasValidos : undefined, horasPersonalId: horasPopupPersonalId || undefined } : x))
        if (session) {
          try {
            await supabase.from('tratamientos').update({
              horas_trabajadas: diasValidos.length > 0 ? diasValidos : null,
              horas_personal_id: horasPopupPersonalId || null,
            }).eq('id', idT)
          } catch (e) { console.error(e) }
        }
      }
      setHorasPopupModo(null)
    } finally {
      setHorasPopupGuardando(false)
    }
  }

  const eliminarTarea = async (id: string) => {
    const tarea = tareas.find(t => t.id === id)
    if (!misPermisos['tareas.crear_asignar'] && tarea?.ejecutorId !== miPersonalId) return
    if (!confirm('¿Eliminar esta tarea?')) return
    setTareas(tareas.filter(t => t.id !== id))
    if (tareaSeleccionadaId === id) setTareaSeleccionadaId(null)
    try { await supabase.from('tareas').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  const consultarMRL = async (sustancia: string, cultivo: string) => {
    if (!sustancia.trim() || !cultivo.trim()) return
    setConsultandoMrl(true)
    setMrlResultado(null)
    try {
      const r = await fetch(`${BACKEND}/mrl/consultar?sustancia=${encodeURIComponent(sustancia)}&cultivo=${encodeURIComponent(cultivo)}`)
      const data = await r.json()
      setMrlResultado(data)
    } catch (e) {
      setMrlResultado({ encontrado: false, motivo: 'Error consultando la base de datos MRL' })
    } finally {
      setConsultandoMrl(false)
    }
  }

  const eliminarTratamiento = async (id: string) => {
    if (!misPermisos['tratamientos.eliminar']) return
    if (!confirm('Eliminar este tratamiento?')) return
    saveTratamientos(tratamientos.filter(t => t.id !== id))
    try { await supabase.from('tratamientos').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // Referencia SIGPAC de una parcela como texto, ya sea de un único recinto o de varios
  const referenciaSigpacDeParcela = (p: ParcelaGuardada): string => {
    const info = p.parcelaInfo
    if (!info) return '—'
    if (info.recintos && info.recintos.length > 0) {
      return info.recintos.map((r: RecintoRef) => formatRefSigpac(r)).join(', ')
    }
    if (info.municipio !== undefined) {
      return `Mun:${info.municipio} Pol:${info.poligono} Par:${info.parcela}`
    }
    return '—'
  }

  const [generandoPdfId, setGenerandoPdfId] = useState<string | null>(null)

  const generarPdfTratamiento = async (t: Tratamiento) => {
    setGenerandoPdfId(t.id)
    try {
      const jsPDF = await cargarJsPDF()
      const parcelasAfectadas = misParcelas.filter(p => t.parcelaIds.includes(p.id))
      const porcentajeAplicado = t.porcentajeAplicado ? Number(t.porcentajeAplicado) : 100

      const canon = dosisACanonico(Number(t.dosis) || 0, t.unidadDosis, {
        litrosCaldoHa: t.litrosCaldoHa ? Number(t.litrosCaldoHa) : undefined,
        kgSemillaHa: t.kgSemillaHa ? Number(t.kgSemillaHa) : undefined,
      })
      const unidadConsumo = canon.fase === 'volumen' ? 'L' : 'KG'
      const consumoPorParcela = parcelasAfectadas.map(p => canon.valor * p.supHa * (porcentajeAplicado / 100))
      const totalConsumido = consumoPorParcela.reduce((a, v) => a + v, 0)
      const totalSupHa = parcelasAfectadas.reduce((a, p) => a + p.supHa, 0)

      // Nº de esta aplicación: posición cronológica entre los tratamientos del mismo
      // producto + cultivo + campaña (mismo criterio que usa el resto de la app)
      const mismosCriterios = tratamientos
        .filter(x => x.producto.trim().toLowerCase() === t.producto.trim().toLowerCase()
          && (x.cultivoTrat || '') === (t.cultivoTrat || '') && (x.campanaId || '') === (t.campanaId || ''))
        .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || a.fechaRegistro.localeCompare(b.fechaRegistro))
      const numAplicacion = mismosCriterios.findIndex(x => x.id === t.id) + 1

      // "Nombre Apellidos (DNI-ROPO)" — busca la persona por su id guardado en el tratamiento
      const formatPersona = (id?: string): string => {
        if (!id) return '—'
        const p = personal.find(x => x.id === id)
        if (!p) return '—'
        const codigo = [p.dni, p.nroRopo].filter(Boolean).join('-')
        return codigo ? `${p.nombre} (${codigo})` : p.nombre
      }
      const recomendadoPorStr = formatPersona(t.recomendadoPor)
      const aplicadoPorStr = t.aplicadoPor ? formatPersona(t.aplicadoPor) : (t.aplicador || '—')

      // Cada máquina en su propia línea: "nombre, tipo (nº ROMA)" — máximo 2 máquinas por tratamiento
      const maquinariaStr = (t.equipoIds || []).map(id => {
        const e = equipos.find(x => x.id === id)
        if (!e) return null
        const tipoStr = e.subtipo ? `${e.tipo} ${e.subtipo}` : e.tipo
        return `${e.nombre}, ${tipoStr} (${e.nroRoma || 'sin ROMA'})`
      }).filter(Boolean).join('\n') || '—'

      const campanaNombre = campanas.find(c => c.id === t.campanaId)?.nombre || '—'
      const cultivoStr = t.cultivoTrat || parcelasAfectadas[0]?.cultivo || '—'

      const doc = new jsPDF()
      doc.setFontSize(14)
      doc.text(`Tratamiento — ${t.producto}`, 14, 16)

      const body: any[] = [
        [{ content: 'Nombre producto', styles: { fontStyle: 'bold' } }, t.producto,
         { content: 'Materia activa', styles: { fontStyle: 'bold' } }, t.materiaActiva || '—'],
        [{ content: 'Tipo de tratamiento', styles: { fontStyle: 'bold' } }, t.tipo,
         { content: `Total consumido (${unidadConsumo})`, styles: { fontStyle: 'bold' } }, totalConsumido.toFixed(2)],
        [{ content: `Dosis (${t.unidadDosis})`, styles: { fontStyle: 'bold' } }, t.dosis,
         { content: `Dosis máxima (${t.unidadDosisMaxima || t.unidadDosis})`, styles: { fontStyle: 'bold' } }, t.dosisMaxima || '—'],
      ]
      if (t.litrosCaldoHa) {
        body.push([{ content: 'Volumen del caldo (L):', styles: { fontStyle: 'bold' } }, t.litrosCaldoHa, '', ''])
      }
      body.push(
        [{ content: 'Nº de la aplicación:', styles: { fontStyle: 'bold' } }, String(numAplicacion),
         { content: 'Nº de aplicaciones máxima:', styles: { fontStyle: 'bold' } }, t.aplicMaxima || '—'],
        [{ content: '% Superficie aplicada', styles: { fontStyle: 'bold' } }, `${porcentajeAplicado}%`,
         { content: '% Superficie máxima a aplicar', styles: { fontStyle: 'bold' } }, t.porcentajeMaximo ? `${t.porcentajeMaximo}%` : '—'],
        [{ content: 'Recomendado por', styles: { fontStyle: 'bold' } }, { content: recomendadoPorStr, colSpan: 3 }],
        [{ content: 'Aplicado por', styles: { fontStyle: 'bold' } }, { content: aplicadoPorStr, colSpan: 3 }],
        [{ content: 'Maquinaria', styles: { fontStyle: 'bold' } }, { content: maquinariaStr, colSpan: 3 }],
        [{ content: 'Cultivo', styles: { fontStyle: 'bold' } }, { content: cultivoStr, colSpan: 3 }],
        [{ content: 'Fecha de aplicación', styles: { fontStyle: 'bold' } }, t.fecha,
         { content: 'Campaña', styles: { fontStyle: 'bold' } }, campanaNombre],
        [{ content: 'REFERENCIAS SIGPAC', styles: { fontStyle: 'bold', fillColor: [235, 235, 235] } },
         { content: 'Superficie', styles: { fontStyle: 'bold', fillColor: [235, 235, 235] } },
         { content: 'Producto consumido', styles: { fontStyle: 'bold', fillColor: [235, 235, 235] } },
         { content: '% Superficie', styles: { fontStyle: 'bold', fillColor: [235, 235, 235] } }],
      )
      parcelasAfectadas.forEach((p, i) => {
        body.push([
          referenciaSigpacDeParcela(p),
          `${p.supHa.toFixed(2)} ha`,
          `${consumoPorParcela[i].toFixed(2)} ${unidadConsumo}`,
          `${porcentajeAplicado}%`,
        ])
      })
      // Fila de totales: solo se suman superficie y producto consumido — el % de superficie no se suma
      body.push([
        { content: 'Total', styles: { fontStyle: 'bold', fillColor: [235, 235, 235] } },
        { content: `${totalSupHa.toFixed(2)} ha`, styles: { fontStyle: 'bold', fillColor: [235, 235, 235] } },
        { content: `${totalConsumido.toFixed(2)} ${unidadConsumo}`, styles: { fontStyle: 'bold', fillColor: [235, 235, 235] } },
        { content: '', styles: { fillColor: [235, 235, 235] } },
      ])

      ;(doc as any).autoTable({
        startY: 22,
        body,
        theme: 'grid',
        styles: { fontSize: 9, cellPadding: 3, valign: 'middle', lineColor: [180, 180, 180] },
        columnStyles: { 0: { cellWidth: 48 }, 2: { cellWidth: 48 } },
      })

      if (t.observaciones) {
        const finalY = (doc as any).lastAutoTable.finalY || 22
        doc.setFontSize(9)
        doc.text(`Observaciones: ${t.observaciones}`, 14, finalY + 8, { maxWidth: 180 })
      }

      doc.save(`tratamiento_${t.producto.replace(/[^a-z0-9]+/gi, '_')}_${t.fecha}.pdf`)
    } catch (e) {
      console.error('Error generando PDF del tratamiento:', e)
      alert('No se ha podido generar el PDF. Inténtalo de nuevo.')
    } finally {
      setGenerandoPdfId(null)
    }
  }

  const tratamientosDeParcela = (parcelaId: string) =>
    tratamientos.filter(t => t.parcelaIds.includes(parcelaId))
      .sort((a, b) => b.fecha.localeCompare(a.fecha))

  const tratamientosFiltrados = tratamientos
    .filter(t => !filtroTipo || t.tipo === filtroTipo)
    .filter(t => !filtroProducto || t.producto.toLowerCase().includes(filtroProducto.toLowerCase()))
    .filter(t => !filtroCultivoTrat || t.parcelaIds.some(pid => misParcelas.find(p => p.id === pid)?.cultivo === filtroCultivoTrat))
    .filter(t => !filtroCampanaTrat || t.campanaId === filtroCampanaTrat)
    .sort((a, b) => b.fecha.localeCompare(a.fecha))

  const totalHaTratadas = () => {
    const parcelasUnicas = new Set(tratamientos.flatMap(t => t.parcelaIds))
    return Array.from(parcelasUnicas).reduce((acc: number, id: string) => {
      const p = misParcelas.find(p => p.id === id)
      return acc + (p?.supHa || 0)
    }, 0)
  }

  // - Funciones STOCK -
  const saveStock = (lista: StockItem[]) => {
    setStock(lista)
  }

  const upsertStockDB = async (s: StockItem) => {
    if (!session) return
    try {
      await supabase.from('stock').upsert({
        id: s.id, user_id: session.user.id, producto: s.producto,
        comprado: s.comprado, unidad: s.unidad, fecha_registro: s.fechaRegistro,
      })
    } catch (e) { console.error('Error guardando stock:', e) }
  }

  const guardarStockItem = async () => {
    if (!misPermisos['tratamientos.crear_editar']) return
    if (!stockProducto.trim() || !stockCantidad.trim() || Number(stockCantidad) <= 0) return
    const nombreNorm = stockProducto.trim().toLowerCase()
    const existente = stock.find(s => s.producto.toLowerCase() === nombreNorm && s.unidad === stockUnidad)

    let nuevaLista: StockItem[]
    let itemActualizado: StockItem
    if (existente) {
      itemActualizado = { ...existente, comprado: (Number(existente.comprado) + Number(stockCantidad)).toString(), fechaRegistro: new Date().toLocaleDateString('es-ES') }
      nuevaLista = stock.map(s => s.id === existente.id ? itemActualizado : s)
    } else {
      itemActualizado = {
        id: String(Date.now()),
        producto: stockProducto.trim(),
        comprado: stockCantidad.trim(),
        unidad: stockUnidad,
        fechaRegistro: new Date().toLocaleDateString('es-ES'),
      }
      nuevaLista = [itemActualizado, ...stock]
    }
    saveStock(nuevaLista)
    upsertStockDB(itemActualizado)
    setStockProducto(''); setStockCantidad(''); setStockUnidad('L'); setFormStock(false); setFitoBusqueda(''); setFitoResultados([])
  }

  const eliminarStockItem = async (id: string) => {
    if (!misPermisos['tratamientos.crear_editar']) return
    if (!confirm('Eliminar este producto del stock?')) return
    saveStock(stock.filter(s => s.id !== id))
    try { await supabase.from('stock').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // Busca el item de stock de un producto (por nombre, sin distinguir mayúsc./minúsc.)
  const buscarStockItem = (nombreProducto: string): StockItem | undefined =>
    stock.find(s => s.producto.toLowerCase() === nombreProducto.toLowerCase())

  // Calcula el total usado de un producto en todos los tratamientos, convertido a la unidad del stock
  // (suma de: dosis convertida a canónico L/ha o Kg/ha, x superficie de cada parcela, convertido a la unidad del stock
  // usando la densidad declarada en cada tratamiento)
  const calcularUsoProducto = (nombreProducto: string): number => {
    const stockItem = buscarStockItem(nombreProducto)
    const unidadStock = stockItem?.unidad || 'L'

    return tratamientos
      .filter(t => t.producto.toLowerCase() === nombreProducto.toLowerCase())
      .reduce((acc, t) => {
        const supTotal = misParcelas
          .filter(p => t.parcelaIds.includes(p.id))
          .reduce((a, p) => a + p.supHa, 0)
        const canon = dosisACanonico(Number(t.dosis) || 0, t.unidadDosis, {
          litrosCaldoHa: t.litrosCaldoHa ? Number(t.litrosCaldoHa) : undefined,
          kgSemillaHa: t.kgSemillaHa ? Number(t.kgSemillaHa) : undefined,
        })
        if (!canon.ok) return acc // no se puede convertir (faltan datos), se ignora en el cómputo
        const densidad = t.densidad ? Number(t.densidad) || 1 : 1
        const porcentajeAplicado = t.porcentajeAplicado ? Number(t.porcentajeAplicado) : 100
        const totalCanon = canon.valor * supTotal * (porcentajeAplicado / 100)
        return acc + canonicoATotalStock(totalCanon, canon.fase, unidadStock, densidad)
      }, 0)
  }

  // - Funciones ESTADÍSTICA -
  // Agrupa tratamientos por cultivo -> producto, calculando dosis ponderada y aplicaciones
  interface StatProducto {
    producto: string
    materiaActiva: string
    numAplicaciones: number
    aplicMaxima: number | null
    dosisPonderadaCanon: number        // valor canónico por hectárea (L/ha si faseCanon='volumen', Kg/ha si 'masa')
    faseCanon: 'volumen' | 'masa'
    dosisMaximaRaw: number | null
    unidadDosisMaxima: UnidadDosis | null
    densidad: number                   // Kg/L declarada en el tratamiento (última registrada), por defecto 1
    sinConvertir: boolean              // true si alguna aplicación no pudo convertirse (faltan datos de caldo/semilla)
    detalleParcelas: { nombre: string; dosisCanon: number; supHa: number; totalCanon: number; totalConsumidoCanon: number; sumaPorcentajes: number; numAplicPorc: number; porcentajeAplicado: number }[]
    // Acumuladores internos para la media ponderada de los valores máximos declarados
    // (dosis máxima y nº máx. de aplicaciones), por si distintos tratamientos del mismo
    // producto+cultivo(+campaña/finca) declaran valores distintos: se pondera cada valor
    // por (superficie tratada bajo ese valor) x (nº de tratamientos que declararon ese valor).
    _pesosDosisMax: Record<string, { valor: number; unidad: UnidadDosis; sup: number; count: number }>
    _pesosAplicMax: Record<string, { valor: number; sup: number; count: number }>
  }

  // Media ponderada de necesidades hídricas/riego → aquí: media ponderada de los valores
  // MÁXIMOS declarados en distintos tratamientos, cuando no coinciden entre sí.
  const mediaPonderadaValores = (pesos: Record<string, { valor: number; sup: number; count: number }>): number | null => {
    const entradas = Object.values(pesos)
    if (entradas.length === 0) return null
    let sumaPesos = 0, sumaValores = 0
    entradas.forEach(e => {
      const peso = e.sup * e.count
      sumaPesos += peso
      sumaValores += e.valor * peso
    })
    return sumaPesos > 0 ? sumaValores / sumaPesos : entradas[0].valor
  }

  const estadisticasPorCultivo = (): Record<string, StatProducto[]> => {
    const resultado: Record<string, Record<string, StatProducto>> = {}

    tratamientos
      .filter(t => !filtroCampanaEstadistica || t.campanaId === filtroCampanaEstadistica)
      .forEach(t => {
        const parcelasAfectadas = misParcelas
          .filter(p => t.parcelaIds.includes(p.id))
          .filter(p => !filtroFincaEstadistica || p.fincaId === filtroFincaEstadistica)
        if (parcelasAfectadas.length === 0) return // no queda superficie de este tratamiento en la finca elegida

        // Se clasifica por el cultivo que tenía el tratamiento al guardarse (cultivoTrat), no por
        // el cultivo ACTUAL de la parcela — así un tratamiento de una campaña ya cerrada sigue
        // contando para el cultivo que hubiera entonces, aunque la parcela ya tenga otro distinto.
        const cultivo = t.cultivoTrat || parcelasAfectadas[0]?.cultivo || 'Sin cultivo'

        const canon = dosisACanonico(Number(t.dosis) || 0, t.unidadDosis, {
          litrosCaldoHa: t.litrosCaldoHa ? Number(t.litrosCaldoHa) : undefined,
          kgSemillaHa: t.kgSemillaHa ? Number(t.kgSemillaHa) : undefined,
        })
        const porcentajeAplicado = t.porcentajeAplicado ? Number(t.porcentajeAplicado) : 100

        {
          if (!resultado[cultivo]) resultado[cultivo] = {}
          const key = t.producto.toLowerCase()
          const parcelasDeEsteCultivo = parcelasAfectadas
          const supEsteTrat = parcelasDeEsteCultivo.reduce((a, p) => a + p.supHa, 0)

          if (!resultado[cultivo][key]) {
            resultado[cultivo][key] = {
              producto: t.producto,
              materiaActiva: t.materiaActiva,
              numAplicaciones: 0,
              aplicMaxima: null,
              dosisPonderadaCanon: 0,
              faseCanon: canon.fase,
              dosisMaximaRaw: null,
              unidadDosisMaxima: null,
              densidad: t.densidad ? Number(t.densidad) || 1 : 1,
              sinConvertir: false,
              detalleParcelas: [],
              _pesosDosisMax: {},
              _pesosAplicMax: {},
            }
          }

          const entry = resultado[cultivo][key]
          entry.numAplicaciones += 1
          if (t.dosisMaxima) {
            const valor = Number(t.dosisMaxima)
            const unidad = t.unidadDosisMaxima || t.unidadDosis
            const claveValor = `${valor}|${unidad}`
            if (!entry._pesosDosisMax[claveValor]) entry._pesosDosisMax[claveValor] = { valor, unidad, sup: 0, count: 0 }
            entry._pesosDosisMax[claveValor].sup += supEsteTrat
            entry._pesosDosisMax[claveValor].count += 1
          }
          if (t.aplicMaxima) {
            const valor = Number(t.aplicMaxima)
            const claveValor = String(valor)
            if (!entry._pesosAplicMax[claveValor]) entry._pesosAplicMax[claveValor] = { valor, sup: 0, count: 0 }
            entry._pesosAplicMax[claveValor].sup += supEsteTrat
            entry._pesosAplicMax[claveValor].count += 1
          }
          if (t.densidad) entry.densidad = Number(t.densidad) || 1
          if (!canon.ok) entry.sinConvertir = true

          // Acumular: suma de dosis canónica por aplicación (no media), dividir por superficie al final
          parcelasDeEsteCultivo.forEach(p => {
            // Buscar si ya existe esta parcela en detalleParcelas para sumar dosis
            const existente = entry.detalleParcelas.find(d => d.nombre === (p.nombre || p.cultivo))
            const contribConsumo = canon.valor * p.supHa * (porcentajeAplicado / 100)
            if (existente) {
              // Misma parcela, nueva aplicación -> sumar dosis canónica
              existente.dosisCanon += canon.valor
              existente.totalCanon = existente.dosisCanon * existente.supHa
              existente.totalConsumidoCanon += contribConsumo
              existente.sumaPorcentajes += porcentajeAplicado
              existente.numAplicPorc += 1
            } else {
              entry.detalleParcelas.push({
                nombre: p.nombre || p.cultivo,
                dosisCanon: canon.valor,
                supHa: p.supHa,
                totalCanon: canon.valor * p.supHa,
                totalConsumidoCanon: contribConsumo,
                sumaPorcentajes: porcentajeAplicado,
                numAplicPorc: 1,
                porcentajeAplicado,
              })
            }
          })
        }
      })

    // Calcular dosis ponderada final: Σ(dosis_canónica_acumulada * sup) / Σsup
    // dosis_canónica_acumulada = suma de todas las aplicaciones (ya convertidas) en esa parcela
    const final: Record<string, StatProducto[]> = {}
    Object.entries(resultado).forEach(([cultivo, productos]) => {
      final[cultivo] = Object.values(productos).map(p => {
        const supTotal = p.detalleParcelas.reduce((a, d) => a + d.supHa, 0)
        const sumaTotal = p.detalleParcelas.reduce((a, d) => a + d.totalCanon, 0)
        const dosisMaxPonderada = mediaPonderadaValores(p._pesosDosisMax)
        const aplicMaxPonderada = mediaPonderadaValores(p._pesosAplicMax)
        // La unidad de la dosis máxima: la del valor con más peso (más superficie x nº tratamientos)
        const unidadGanadora = Object.values(p._pesosDosisMax).sort((a, b) => (b.sup * b.count) - (a.sup * a.count))[0]?.unidad || null
        return {
          ...p,
          dosisPonderadaCanon: supTotal > 0 ? sumaTotal / supTotal : 0,
          dosisMaximaRaw: dosisMaxPonderada,
          unidadDosisMaxima: unidadGanadora,
          aplicMaxima: aplicMaxPonderada,
          detalleParcelas: p.detalleParcelas.map(d => ({
            ...d,
            porcentajeAplicado: d.numAplicPorc > 0 ? Math.round((d.sumaPorcentajes / d.numAplicPorc) * 10) / 10 : d.porcentajeAplicado,
          })),
        }
      })
    })
    return final
  }

  const parcelaDetalle = misParcelas.find(p => p.id === parcelaDetalleId) || null

  const [riegoDeParcela, setRiegoDeParcela] = useState<{ sector: any; sistemaNombre: string }[]>([])
  useEffect(() => {
    if (!parcelaDetalleId || !session) { setRiegoDeParcela([]); return }
    let cancelado = false
    const cargar = async () => {
      try {
        const secRes = await supabase.from('sectores_riego').select('*').contains('parcela_ids', [parcelaDetalleId])
        const secs = secRes.data || []
        if (secs.length === 0) { if (!cancelado) setRiegoDeParcela([]); return }
        const sisIds = Array.from(new Set(secs.map((s: any) => s.sistema_id)))
        const sisRes = await supabase.from('sistemas_riego').select('id,nombre').in('id', sisIds)
        const sisMap = new Map((sisRes.data || []).map((s: any) => [s.id, s.nombre]))
        if (!cancelado) setRiegoDeParcela(secs.map((s: any) => ({ sector: s, sistemaNombre: sisMap.get(s.sistema_id) || 'Sistema' })))
      } catch (e) { console.error('Error cargando riego de parcela:', e) }
    }
    cargar()
    return () => { cancelado = true }
  }, [parcelaDetalleId, session])

  const guardarCampana = async (): Promise<Campana | null> => {
    setCampError('')
    if (!campNombre.trim()) { setCampError('El nombre es obligatorio'); return null }
    if (!campFechaInicio || !campFechaFin) { setCampError('Indica fecha de inicio y fin'); return null }
    if (campFechaFin < campFechaInicio) { setCampError('La fecha fin no puede ser anterior a la de inicio'); return null }
    if (!session) { setCampError('Debes iniciar sesión'); return null }

    const nueva: Campana = {
      id: campanaEditar?.id || String(Date.now()),
      nombre: campNombre.trim(),
      fechaInicio: campFechaInicio,
      fechaFin: campFechaFin,
    }
    try {
      const { error } = await supabase.from('campanas').upsert({
        id: nueva.id, user_id: session.user.id, nombre: nueva.nombre,
        fecha_inicio: nueva.fechaInicio, fecha_fin: nueva.fechaFin,
      })
      if (error) { setCampError('No se pudo guardar la campaña: ' + error.message); return null }
    } catch (e) {
      setCampError('No se pudo guardar la campaña.')
      return null
    }
    const lista = campanaEditar
      ? campanas.map(c => c.id === campanaEditar.id ? nueva : c)
      : [nueva, ...campanas]
    setCampanas(lista)
    setFormCampanaVisible(false)
    setCampanaEditar(null)
    setCampNombre('')
    setCampFechaInicio('')
    setCampFechaFin('')
    return nueva
  }

  // Guarda el cultivo (y campaña) que tenía la parcela ANTES de este cambio, como
  // registro histórico independiente — para rotaciones de cultivo (cereales,
  // leguminosas, oleaginosas...) donde el cultivo cambia de una campaña a otra.
  const [cultivoAnteriorGuardado, setCultivoAnteriorGuardado] = useState(false)
  const [popupCampanaHistorico, setPopupCampanaHistorico] = useState(false)
  const [popupCampanaSeleccionada, setPopupCampanaSeleccionada] = useState('')

  // Al pulsar el botón: si el cultivo anterior ya tenía campaña, se guarda directo. Si no
  // tenía (por ejemplo parcelas antiguas creadas antes de usar campañas), se pide primero
  // en un popup para no perder ese dato en el histórico.
  const abrirGuardarCultivoAnterior = () => {
    if (!parcelaEditar) return
    if (parcelaEditar.campanaId) {
      confirmarGuardarCultivoAnterior(parcelaEditar.campanaId)
    } else {
      setPopupCampanaSeleccionada('')
      setPopupCampanaHistorico(true)
    }
  }

  const confirmarGuardarCultivoAnterior = async (campanaId: string) => {
    if (!parcelaEditar || !session) return
    const nuevo: HistoricoCultivo = {
      id: String(Date.now()),
      parcelaId: parcelaEditar.id,
      cultivo: parcelaEditar.cultivo,
      variedad: parcelaEditar.variedad,
      campanaId: campanaId || undefined,
      fechaRegistro: new Date().toLocaleDateString('es-ES'),
    }
    setHistoricoCultivos([nuevo, ...historicoCultivos])
    try {
      await supabase.from('historico_cultivos_parcela').upsert({
        id: nuevo.id, user_id: session.user.id, parcela_id: nuevo.parcelaId,
        cultivo: nuevo.cultivo, variedad: nuevo.variedad || null, campana_id: nuevo.campanaId || null, fecha_registro: nuevo.fechaRegistro,
      })
      setCultivoAnteriorGuardado(true)
      setPopupCampanaHistorico(false)
    } catch (e) { console.error('Error guardando histórico de cultivo:', e) }
  }

  // Editar o eliminar una entrada del histórico de cultivos, por si el usuario se equivoca
  const [historicoEditarId, setHistoricoEditarId] = useState<string | null>(null)
  const [historicoEditCultivo, setHistoricoEditCultivo] = useState('')
  const [historicoEditVariedad, setHistoricoEditVariedad] = useState('')
  const [historicoEditCampanaId, setHistoricoEditCampanaId] = useState('')

  const abrirEditarHistorico = (h: HistoricoCultivo) => {
    setHistoricoEditarId(h.id)
    setHistoricoEditCultivo(h.cultivo)
    setHistoricoEditVariedad(h.variedad || '')
    setHistoricoEditCampanaId(h.campanaId || '')
  }

  const guardarEdicionHistorico = async () => {
    if (!historicoEditarId || !historicoEditCultivo.trim()) return
    const actualizado = { cultivo: historicoEditCultivo.trim(), variedad: historicoEditVariedad.trim() || undefined, campanaId: historicoEditCampanaId || undefined }
    setHistoricoCultivos(historicoCultivos.map(h => h.id === historicoEditarId ? { ...h, ...actualizado } : h))
    try {
      await supabase.from('historico_cultivos_parcela').update({
        cultivo: actualizado.cultivo, variedad: actualizado.variedad || null, campana_id: actualizado.campanaId || null,
      }).eq('id', historicoEditarId)
    } catch (e) { console.error('Error editando histórico de cultivo:', e) }
    setHistoricoEditarId(null)
  }

  const eliminarHistoricoCultivo = async (id: string) => {
    if (!confirm('¿Eliminar este registro del histórico de cultivos?')) return
    setHistoricoCultivos(historicoCultivos.filter(h => h.id !== id))
    try { await supabase.from('historico_cultivos_parcela').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // - Popup de cambio masivo de campaña/cultivo -
  // Para no tener que editar parcela por parcela cada vez que empieza una campaña nueva:
  // una tabla con todas las parcelas donde se puede actualizar el cultivo y asignar la
  // campaña nueva de golpe, guardando el histórico (cultivo + campaña anterior) de cada
  // una automáticamente si su cultivo cambia.
  interface FilaCambioCampana { parcelaId: string; nombre: string; cultivoActual: string; cultivoNuevo: string; variedadActual: string; variedadNueva: string; campanaActualId: string; campanaNuevaId: string }
  const [popupCambioCampanas, setPopupCambioCampanas] = useState(false)
  const [filasCambioCampana, setFilasCambioCampana] = useState<FilaCambioCampana[]>([])
  const [guardandoCambioCampanas, setGuardandoCambioCampanas] = useState(false)

  const abrirPopupCambioCampanas = (campanaNuevaDefecto?: string) => {
    setFilasCambioCampana(misParcelas.map(p => ({
      parcelaId: p.id, nombre: p.nombre || p.cultivo, cultivoActual: p.cultivo, cultivoNuevo: p.cultivo,
      variedadActual: p.variedad || '', variedadNueva: p.variedad || '',
      campanaActualId: p.campanaId || '', campanaNuevaId: campanaNuevaDefecto || '',
    })))
    setPopupCambioCampanas(true)
  }

  const actualizarFilaCambioCampana = (parcelaId: string, campo: 'cultivoNuevo' | 'variedadNueva' | 'campanaNuevaId', valor: string) => {
    setFilasCambioCampana(filasCambioCampana.map(f => f.parcelaId === parcelaId ? { ...f, [campo]: valor } : f))
  }

  const guardarCambiosCampana = async () => {
    if (!session) return
    const filasConCambios = filasCambioCampana.filter(f => f.cultivoNuevo.trim() !== f.cultivoActual || f.variedadNueva.trim() !== f.variedadActual || f.campanaNuevaId)
    if (filasConCambios.length === 0) { setPopupCambioCampanas(false); return }

    setGuardandoCambioCampanas(true)
    try {
      const nuevosHistoricos: HistoricoCultivo[] = []
      const parcelasActualizadas = [...misParcelas]

      for (const fila of filasConCambios) {
        const cambioCultivo = fila.cultivoNuevo.trim() !== fila.cultivoActual || fila.variedadNueva.trim() !== fila.variedadActual
        // Si cambia el cultivo o la variedad, se guarda primero el anterior en el histórico
        // (junto a la campaña que tenía hasta ahora, aunque no se haya elegido campaña nueva).
        if (cambioCultivo) {
          const hist: HistoricoCultivo = {
            id: String(Date.now()) + '_' + fila.parcelaId,
            parcelaId: fila.parcelaId, cultivo: fila.cultivoActual, variedad: fila.variedadActual || undefined,
            campanaId: fila.campanaActualId || undefined,
            fechaRegistro: new Date().toLocaleDateString('es-ES'),
          }
          nuevosHistoricos.push(hist)
          await supabase.from('historico_cultivos_parcela').upsert({
            id: hist.id, user_id: session.user.id, parcela_id: hist.parcelaId,
            cultivo: hist.cultivo, variedad: hist.variedad || null, campana_id: hist.campanaId || null, fecha_registro: hist.fechaRegistro,
          })
        }

        const idx = parcelasActualizadas.findIndex(p => p.id === fila.parcelaId)
        if (idx === -1) continue
        const actualizada: ParcelaGuardada = {
          ...parcelasActualizadas[idx],
          cultivo: cambioCultivo ? fila.cultivoNuevo.trim() : parcelasActualizadas[idx].cultivo,
          variedad: cambioCultivo ? (fila.variedadNueva.trim() || undefined) : parcelasActualizadas[idx].variedad,
          campanaId: fila.campanaNuevaId || parcelasActualizadas[idx].campanaId,
        }
        parcelasActualizadas[idx] = actualizada
        await supabase.from('parcelas').update({
          cultivo: actualizada.cultivo, variedad: actualizada.variedad || null, campana_id: actualizada.campanaId || null,
        }).eq('id', fila.parcelaId)
      }

      setHistoricoCultivos([...nuevosHistoricos, ...historicoCultivos])
      setMisParcelas(parcelasActualizadas)
      setPopupCambioCampanas(false)
    } catch (e) {
      console.error('Error guardando cambios de campaña:', e)
    } finally {
      setGuardandoCambioCampanas(false)
    }
  }

  const guardarParcela = async () => {
    if (!formCultivo.trim()) { setFormError('El cultivo es obligatorio'); return }
    if (!session) { setFormError('Debes iniciar sesión'); return }

    const nueva: ParcelaGuardada = {
      id: parcelaEditar?.id || String(Date.now()),
      nombre: formNombre.trim(),
      cultivo: formCultivo.trim(),
      variedad: formVariedad.trim() || undefined,
      fechaPlantacion: formFechaPlantacion,
      infoAdicional: formInfoAdicional.trim(),
      geojson: parcGeojson,
      parcelaInfo: parcelaInfo,
      supHa: parcelaSupHa,
      imagenPreview: imagenPreviewForm || imagenUrl,
      fechaGuardado: new Date().toLocaleDateString('es-ES'),
      fincaId: formFincaId || undefined,
      campanaId: formCampanaId || undefined,
      secanoRegadio: formSecanoRegadio || undefined,
      tipoCultivoAmbiente: formTipoCultivoAmbiente || undefined,
      sistAsesoramientoGip: formSistAsesoramientoGip || undefined,
    }

    let nuevaLista: ParcelaGuardada[]
    if (parcelaEditar) {
      nuevaLista = misParcelas.map(p => p.id === parcelaEditar.id ? nueva : p)
    } else {
      nuevaLista = [nueva, ...misParcelas]
    }
    setMisParcelas(nuevaLista)

    try {
      await supabase.from('parcelas').upsert({
        id: nueva.id, user_id: session.user.id, nombre: nueva.nombre, cultivo: nueva.cultivo,
        variedad: nueva.variedad || null,
        fecha_plantacion: nueva.fechaPlantacion, info_adicional: nueva.infoAdicional,
        geojson: nueva.geojson, parcela_info: nueva.parcelaInfo, sup_ha: nueva.supHa,
        imagen_preview: nueva.imagenPreview, fecha_guardado: nueva.fechaGuardado,
        finca_id: nueva.fincaId || null,
        campana_id: nueva.campanaId || null,
        secano_regadio: nueva.secanoRegadio || null,
        tipo_cultivo_ambiente: nueva.tipoCultivoAmbiente || null,
        sist_asesoramiento_gip: nueva.sistAsesoramientoGip || null,
      })
    } catch (e) { console.error('Error guardando parcela:', e) }

    setFormularioVisible(false)
    setParcelaEditar(null)
  }

  const cancelarFormulario = () => {
    setFormularioVisible(false)
    setParcelaEditar(null)
    setFormError('')
    // Deseleccionar parcela del mapa si era una parcela nueva (no una edición de una ya existente)
    if (!parcelaEditar) {
      setParcGeojson(null)      // borra el poligono del mapa
      setParcelaInfo(null)      // borra la info de la parcela
      setParcelaSupHa(0)        // resetea la superficie
      setAnadiendoRecinto(false) // sale del modo "+ añadir recinto" si estaba activo
      setEstado('idle')         // vuelve al estado inicial
      deseleccionar()           // llama a la funcion que limpia la seleccion en Leaflet
      setPestana('mapa')
    }
  }

  const abrirEditar = (p: ParcelaGuardada) => {
    setParcelaEditar(p)
    setFormNombre(p.nombre)
    setFormCultivo(p.cultivo)
    setFormVariedad(p.variedad || '')
    setFormFechaPlantacion(p.fechaPlantacion)
    setFormInfoAdicional(p.infoAdicional)
    setFormFincaId(p.fincaId || '')
    setFormCampanaId(p.campanaId || '')
    setFormSecanoRegadio(p.secanoRegadio || '')
    setFormTipoCultivoAmbiente(p.tipoCultivoAmbiente || '')
    setFormSistAsesoramientoGip(p.sistAsesoramientoGip || '')
    setFormError('')
    setCultivoAnteriorGuardado(false)
    setImagenPreviewForm(p.imagenPreview || (p.geojson ? getEsriPreviewUrl(p.geojson) : null))
    setFormularioVisible(true)
    setParcGeojson(p.geojson)
    setParcelaInfo(p.parcelaInfo)
    setParcelaSupHa(p.supHa)
  }

  const eliminarParcela = async (id: string) => {
    if (!confirm('Eliminar esta parcela?')) return
    const nueva = misParcelas.filter(p => p.id !== id)
    setMisParcelas(nueva)
    try { await supabase.from('parcelas').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  const verEnMapa = (p: ParcelaGuardada) => {
    // Limpiar estado anterior sin borrar lo que viene de la parcela
    setImagenUrl(null)
    setModoVista('ninguna')
    setZonasData([])
    setProduccion(null)
    setKgPorHa({})
    setContornosUrl(null)
    setContornosStats(null)
    setMdtColorUrl(null)
    setMdtColorStats(null)
    setMapaActivo(null)
    setMapaVisible(false)
    // Cargar parcela
    setParcGeojson(p.geojson)
    setParcelaInfo(p.parcelaInfo)
    setParcelaSupHa(p.supHa)
    setParcelaVistaEnMapa(p.geojson)
    setFincaVistaEnMapa(null)
    // Resetear búsqueda de imágenes para que el usuario pueda buscar
    setProductos([])
    setProductoSel('')
    setSeleccionando(false)
    setMododibujo(false)
    setAnadiendoRecinto(false)
    setError('')
    setEstado('parcela_ok')
    setPestana('mapa')
  }

  // Ver en el mapa, a la vez, todas las parcelas de una misma finca (marcadas en rojo)
  const verFincaEnMapa = (fincaId: string) => {
    const finca = fincas.find(f => f.id === fincaId)
    const parcelasFinca = misParcelas.filter(p => p.fincaId === fincaId && p.geojson)
    if (!finca || parcelasFinca.length === 0) return

    // "Disolvemos" la finca en una única Feature MultiPolygon (no hace falta que los
    // polígonos estén unidos entre sí) para que el resto de la app la trate exactamente
    // igual que si fuera una sola parcela: bbox, recorte de imágenes, curvas de nivel...
    const poligonos: any[] = []
    parcelasFinca.forEach(p => {
      const g = p.geojson
      const feats = g?.type === 'FeatureCollection' ? g.features
        : g?.type === 'Feature' ? [g]
        : g?.type ? [{ type: 'Feature', properties: {}, geometry: g }]
        : []
      feats.forEach((f: any) => {
        const geom = f.geometry
        if (!geom) return
        if (geom.type === 'Polygon') poligonos.push(geom.coordinates)
        else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((poly: any) => poligonos.push(poly))
      })
    })
    const combinado = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { finca: finca.nombre, num_parcelas: parcelasFinca.length },
        geometry: { type: 'MultiPolygon', coordinates: poligonos },
      }],
    }

    setImagenUrl(null)
    setModoVista('ninguna')
    setZonasData([])
    setProduccion(null)
    setKgPorHa({})
    setContornosUrl(null)
    setContornosStats(null)
    setMdtColorUrl(null)
    setMdtColorStats(null)
    setMapaActivo(null)
    setMapaVisible(false)
    setParcGeojson(combinado)
    setParcelaInfo(null)
    setParcelaSupHa(parcelasFinca.reduce((a, p) => a + p.supHa, 0))
    setParcelaVistaEnMapa(null)
    setFincaVistaEnMapa(finca)
    setProductos([])
    setProductoSel('')
    setSeleccionando(false)
    setMododibujo(false)
    setAnadiendoRecinto(false)
    setError('')
    setEstado('parcela_ok')
    setPestana('mapa')
  }

  // - Histórico -
  const guardarEnHistorico = async (zonasCalculadas: any[], fecha: string) => {
    if (!zonasCalculadas.length) return
    const entrada = {
      id: Date.now(),
      fecha,
      fecha_guardado: new Date().toLocaleDateString('es-ES'),
      parcela: parcelaInfo?.origen === 'dibujado_mano'
        ? 'Dibujada a mano'
        : parcelaInfo?.recintos?.length > 1
          ? `${parcelaInfo.recintos.length} recintos SIGPAC (${parcelaInfo.recintos.map((r: RecintoRef) => formatRefSigpac(r)).join(', ')})`
          : `Mun:${parcelaInfo?.municipio} Pol:${parcelaInfo?.poligono} Par:${parcelaInfo?.parcela}`,
      sup_ha: parcelaSupHa.toFixed(4),
      sup_ha_num: parcelaSupHa,
      geojson: parcGeojson,
      parcelaInfo: parcelaInfo,
      zonas: zonasCalculadas.filter(z => z.pixeles > 0).map(z => ({
        zona: z.zona, pixeles: z.pixeles,
        sup_ha_real: z.sup_ha_real.toFixed(4),
        sup_ha_real_num: z.sup_ha_real,
        pct: parcelaSupHa > 0 ? ((z.sup_ha_real / parcelaSupHa) * 100).toFixed(1) : '0',
      })),
    }
    const nuevo = [entrada, ...historico].slice(0, 20)
    setHistorico(nuevo)
    if (session) {
      try {
        await supabase.from('historico').insert({
          id: String(entrada.id), user_id: session.user.id, fecha: entrada.fecha,
          fecha_guardado: entrada.fecha_guardado, parcela: entrada.parcela,
          sup_ha: entrada.sup_ha, sup_ha_num: entrada.sup_ha_num,
          geojson: entrada.geojson, parcela_info: entrada.parcelaInfo, zonas: entrada.zonas,
        })
        // Limpiar entradas antiguas más allá de las 20 últimas
        const idsAConservar = nuevo.map(e => String(e.id))
        const { data: todas } = await supabase.from('historico').select('id').eq('user_id', session.user.id)
        if (todas) {
          const idsABorrar = todas.map((r: any) => r.id).filter((id: string) => !idsAConservar.includes(id))
          if (idsABorrar.length > 0) {
            await supabase.from('historico').delete().in('id', idsABorrar)
          }
        }
      } catch (e) { console.error('Error guardando histórico:', e) }
    }
  }

  // - Handlers mapa -
  const handleParcelasDibujadas = useCallback((geojson: any, supHa: number) => {
    setParcGeojson(geojson); setParcelaInfo({ origen: 'dibujado_mano', recintos: [], detectandoSigpac: true })
    setParcelaSupHa(supHa); setProductos([]); resetear(); setEstado('parcela_ok')
    setParcelaVistaEnMapa(null); setFincaVistaEnMapa(null); setAnadiendoRecinto(false)
    setPanelAbierto(true)

    // Detecta en segundo plano qué recintos SIGPAC quedan (total o parcialmente) bajo
    // el polígono dibujado, y los añade a parcelaInfo.recintos cuando terminan de llegar.
    const geom = geojson?.features?.[0]?.geometry
    if (geom) {
      detectarRecintosBajoDibujo(geom)
        .then(recintos => {
          setParcelaInfo((prev: any) => (prev?.origen === 'dibujado_mano' ? { ...prev, recintos, detectandoSigpac: false } : prev))
        })
        .catch(() => {
          setParcelaInfo((prev: any) => (prev?.origen === 'dibujado_mano' ? { ...prev, detectandoSigpac: false } : prev))
        })
    }
  }, [])

  const handleMapClick = useCallback(async (lat: number, lon: number) => {
    setSeleccionando(false); setAnadiendoRecinto(false); setEstado('cargando_parcela'); setError('')
    setParcGeojson(null); setParcelaInfo(null); setProductos([])
    setParcelaSupHa(0); setParcelaVistaEnMapa(null); setFincaVistaEnMapa(null); resetear()
    setPanelAbierto(true)  // Auto-open panel on mobile when parcela found
    try {
      const r = await fetch(`${BACKEND}/sigpac/punto?lat=${lat}&lon=${lon}`)
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || `Error ${r.status}`) }
      const data = await r.json()
      const features = data.features || []
      if (!features.length) throw new Error('Sin datos de recinto en ese punto')
      const { info, fusionado, supTotal } = construirEstadoDesdeFeatures(features)
      setParcGeojson(fusionado)
      setParcelaInfo(info)
      setParcelaSupHa(supTotal)
      setEstado('parcela_ok')
    } catch (e: any) { setEstado('error'); setError('No se encontró parcela: ' + e.message) }
  }, [])

  // Añade UN recinto SIGPAC más a la parcela ya seleccionada (modo "+ AÑADIR RECINTO").
  // A diferencia de handleMapClick, no borra nada: fusiona el nuevo recinto con los
  // ya acumulados (geometría MultiPolygon + lista de referencias + superficie total).
  const handleAnadirRecinto = useCallback(async (lat: number, lon: number) => {
    setError('')
    try {
      const r = await fetch(`${BACKEND}/sigpac/punto?lat=${lat}&lon=${lon}`)
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || `Error ${r.status}`) }
      const data = await r.json()
      const nuevaFeature = data.features?.[0]
      if (!nuevaFeature) throw new Error('Sin datos de recinto en ese punto')
      const nuevoRef = extraerRecinto(nuevaFeature.properties || {})
      const refNueva = formatRefSigpac(nuevoRef)

      const recintosPrevios: RecintoRef[] = parcelaInfoRef.current?.recintos || []
      if (recintosPrevios.some(r => formatRefSigpac(r) === refNueva)) {
        setError('Ese recinto ya estaba añadido a la parcela.')
        return
      }

      // Fusionamos la geometría ya acumulada (parcGeojson) con la del nuevo recinto.
      const geomPrevia = parcGeojsonRef.current?.features?.[0]?.geometry
      const poligonos: any[] = []
      if (geomPrevia?.type === 'Polygon') poligonos.push(geomPrevia.coordinates)
      else if (geomPrevia?.type === 'MultiPolygon') geomPrevia.coordinates.forEach((p: any) => poligonos.push(p))
      const nuevaGeom = nuevaFeature.geometry
      if (nuevaGeom?.type === 'Polygon') poligonos.push(nuevaGeom.coordinates)
      else if (nuevaGeom?.type === 'MultiPolygon') nuevaGeom.coordinates.forEach((p: any) => poligonos.push(p))

      const nuevosRecintos = [...recintosPrevios, nuevoRef]
      const supTotal = nuevosRecintos.reduce((acc, rr) => acc + rr.supHa, 0)

      setParcGeojson({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: poligonos } }],
      })
      setParcelaInfo((prev: any) => ({
        ...prev,
        origen: 'sigpac_multiple',
        recintos: nuevosRecintos,
        municipio: prev?.municipio ?? nuevoRef.municipio,
        poligono: prev?.poligono ?? nuevoRef.poligono,
        parcela: prev?.parcela ?? nuevoRef.parcela,
        uso_sigpac: prev?.uso_sigpac ?? nuevoRef.usoSigpac,
        superficie: supTotal,
      }))
      setParcelaSupHa(supTotal)
      setEstado('parcela_ok')
    } catch (e: any) { setError('No se pudo añadir el recinto: ' + e.message) }
  }, [])

  // Enrutador de clics del mapa: si el modo "+ AÑADIR RECINTO" está activo, acumula;
  // si no, hace una selección nueva (comportamiento de siempre). Referencia estable
  // (deps []) porque handleMapClick y handleAnadirRecinto también lo son.
  const onMapaClick = useCallback((lat: number, lon: number) => {
    if (anadiendoRecintoRef.current) handleAnadirRecinto(lat, lon)
    else handleMapClick(lat, lon)
  }, [handleAnadirRecinto, handleMapClick])

  // Busca una parcela escribiendo su referencia SIGPAC completa, p.ej. "41/7/0/0/6/7/3"
  // (Provincia/Municipio/Agregado/Zona/Poligono/Parcela/Recinto)
  const buscarPorReferenciaSigpac = async () => {
    setErrorSigpacRef('')
    const partes = sigpacRefInput.split('/').map(p => p.trim()).filter(p => p !== '')
    if (partes.length !== 7 || partes.some(p => !/^\d+$/.test(p))) {
      setErrorSigpacRef('Formato incorrecto. Debe ser 7 números separados por "/": Provincia/Municipio/Agregado/Zona/Polígono/Parcela/Recinto')
      return
    }
    const [pr, mu, ag, zo, po, pa, re] = partes
    setSeleccionando(false); setMododibujo(false); setAnadiendoRecinto(false); setEstado('cargando_parcela'); setError('')
    setParcGeojson(null); setParcelaInfo(null); setProductos([])
    setParcelaSupHa(0); setParcelaVistaEnMapa(null); setFincaVistaEnMapa(null); resetear()
    setPanelAbierto(true)
    try {
      const r = await fetch(`${BACKEND}/sigpac/referencia?pr=${pr}&mu=${mu}&ag=${ag}&zo=${zo}&po=${po}&pa=${pa}&re=${re}`)
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || `Error ${r.status}`) }
      const data = await r.json()
      const features = data.features || []
      if (!features.length) throw new Error('Sin datos de recinto')
      const { info, fusionado, supTotal } = construirEstadoDesdeFeatures(features)
      setParcGeojson(fusionado)
      setParcelaInfo(info)
      setParcelaSupHa(supTotal)
      setEstado('parcela_ok')
    } catch (e: any) { setEstado('error'); setError('No se encontró parcela: ' + e.message) }
  }

  const buscarImagenes = async () => {
    if (!parcGeojson?.features?.length) return
    setParcelaVistaEnMapa(null); setFincaVistaEnMapa(null)  // Permitir overlays al buscar imágenes
    setEstado('buscando'); setError(''); setProductos([]); resetear()
    try {
      const bbox = getBbox(parcGeojson)
      const r = await fetch(`${BACKEND}/sentinel/buscar?bbox=${bbox}&fecha_inicio=${fechaInicio}&fecha_fin=${fechaFin}&max_nubosidad=30`)
      if (!r.ok) throw new Error(`Error ${r.status}`)
      const data = await r.json()
      if (!data.productos?.length) { setEstado('parcela_ok'); setError('No hay imágenes en ese periodo.'); return }
      setProductos(data.productos); setProductoSel(data.productos[0].id); setEstado('parcela_ok')
    } catch (e: any) { setEstado('error'); setError('Error buscando imágenes: ' + e.message) }
  }

  const verImagenRGB = async () => {
    if (!productoSel || !parcGeojson) return
    setEstado('cargando_rgb'); setError(''); resetear()
    try {
      const bbox = getBbox(parcGeojson)
      const gp = encodeURIComponent(JSON.stringify(parcGeojson))
      const r = await fetch(`${BACKEND}/imagen/rgb?bbox=${bbox}&fecha=${getFecha()}&geojson=${gp}`)
      if (!r.ok) throw new Error(`Error ${r.status}`)
      const blob = await r.blob()
      setImagenUrl(URL.createObjectURL(blob)); setModoVista('rgb'); setEstado('parcela_ok')
    } catch (e: any) { setEstado('error'); setError('Error cargando imagen: ' + e.message) }
  }

  const calcularZonasNDVI = async () => {
    if (!productoSel || !parcGeojson) return
    setEstado('calculando_zonas'); setError(''); setZonasData([]); setProduccion(null); setKgPorHa({})
    try {
      const bbox = getBbox(parcGeojson)
      const gp = encodeURIComponent(JSON.stringify(parcGeojson))
      const r = await fetch(`${BACKEND}/ndvi/zonas?bbox=${bbox}&fecha=${getFecha()}&geojson=${gp}`)
      if (!r.ok) throw new Error(`Error ${r.status}`)
      const data = await r.json()
      setZonasData(data.zonas)
      const ir = await fetch(`${BACKEND}${data.imagen_url}`)
      const blob = await ir.blob()
      if (imagenUrl) URL.revokeObjectURL(imagenUrl)
      setImagenUrl(URL.createObjectURL(blob)); setModoVista('zonas'); setEstado('done')
      const totalPx = data.zonas.reduce((acc: number, z: any) => acc + z.pixeles, 0)
      const zonasConSupLocal = data.zonas.filter((z: any) => z.pixeles > 0).map((z: any) => ({
        ...z, sup_ha_real: totalPx > 0 ? (z.pixeles / totalPx) * parcelaSupHa : 0,
      }))
      guardarEnHistorico(zonasConSupLocal, getFecha())
    } catch (e: any) { setEstado('error'); setError('Error calculando NDVI: ' + e.message) }
  }

  const calcularContornos = async () => {
    if (!parcGeojson) return
    setParcelaVistaEnMapa(null); setFincaVistaEnMapa(null)  // Permitir que se pinte el overlay
    setCalculandoContornos(true); setError(''); setContornosUrl(null); setContornosStats(null)
    try {
      const bbox = getBbox(parcGeojson)
      const gp = encodeURIComponent(JSON.stringify(parcGeojson))
      const r = await fetch(`${BACKEND}/mdt/contornos?bbox=${bbox}&geojson=${gp}`)
      if (!r.ok) throw new Error(`Error ${r.status}`)
      const data = await r.json()
      setContornosStats(data.stats)
      const ir = await fetch(`${BACKEND}${data.imagen_url}`)
      const blob = await ir.blob()
      const url = URL.createObjectURL(blob)
      setContornosUrl(url)
      setMapaActivo('contornos')
      setMapaVisible(true)
      setImagenUrl(url)
      setModoVista('zonas')
    } catch (e: any) { setError('Error generando curvas de nivel: ' + e.message) }
    finally { setCalculandoContornos(false) }
  }

  const calcularMdtColor = async () => {
    if (!parcGeojson) return
    setParcelaVistaEnMapa(null); setFincaVistaEnMapa(null)  // Permitir que se pinte el overlay
    setCalculandoMdtColor(true); setError(''); setMdtColorUrl(null); setMdtColorStats(null)
    try {
      const bbox = getBbox(parcGeojson)
      const gp = encodeURIComponent(JSON.stringify(parcGeojson))
      const r = await fetch(`${BACKEND}/mdt/mapa_color?bbox=${bbox}&geojson=${gp}`)
      if (!r.ok) throw new Error(`Error ${r.status}`)
      const data = await r.json()
      setMdtColorStats(data.stats)
      const ir = await fetch(`${BACKEND}${data.imagen_url}`)
      const blob = await ir.blob()
      const url = URL.createObjectURL(blob)
      setMdtColorUrl(url)
      setMapaActivo('mdtColor')
      setMapaVisible(true)
      setImagenUrl(url)
      setModoVista('zonas')
    } catch (e: any) { setError('Error generando mapa de colores de altitud: ' + e.message) }
    finally { setCalculandoMdtColor(false) }
  }

  // Alterna la visibilidad del mapa del MDT actualmente activo (curvas de nivel
  // o mapa de colores, el que se haya generado el último). Solo uno de los dos
  // puede estar visible a la vez: al generar uno se oculta automáticamente el otro.
  const toggleMapaMdt = () => {
    if (mapaVisible) {
      setImagenUrl(null); setModoVista('ninguna'); setMapaVisible(false)
    } else {
      const url = mapaActivo === 'contornos' ? contornosUrl : mapaActivo === 'mdtColor' ? mdtColorUrl : null
      if (url) { setImagenUrl(url); setModoVista('zonas'); setMapaVisible(true) }
    }
  }

  const calcularProduccion = async (kgHaCalculado: Record<string, number>) => {
    const totalPixeles = zonasData.reduce((acc, z) => acc + z.pixeles, 0)
    const zonasConSup = zonasData.filter(z => z.pixeles > 0).map(z => ({
      ...z,
      superficie_ha: totalPixeles > 0 ? (z.pixeles / totalPixeles) * parcelaSupHa : 0,
      color_hex: ZONAS_NDVI.find(zn => zn.zona === z.zona)?.color || '#888',
    }))
    const kgFinal: Record<string, string> = {}
    Object.entries(kgHaCalculado).forEach(([z, v]) => { kgFinal[z] = String(v) })
    try {
      const r = await fetch(`${BACKEND}/ndvi/produccion`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zonas: zonasConSup, kg_por_ha: kgFinal }),
      })
      if (!r.ok) throw new Error(`Error ${r.status}`)
      setProduccion(await r.json())
    } catch (e: any) { setError('Error calculando producción: ' + e.message) }
  }

  // Regla de tres
  const kgHaCalculado: Record<string, number> = {}
  const entradas = Object.entries(kgPorHa).filter(([_, v]) => v !== '' && Number(v) > 0)
  if (entradas.length > 0) {
    const [zonaRef, kgRef] = entradas[0]
    const pctRef = ZONA_PCT[Number(zonaRef)] || 100
    const kgZona1 = Number(kgRef) / (pctRef / 100)
    Object.entries(ZONA_PCT).forEach(([z, pct]) => { kgHaCalculado[z] = Math.round(kgZona1 * (pct / 100)) })
  }

  const totalPixeles = zonasData.reduce((acc, z) => acc + z.pixeles, 0)
  const zonasConSup = zonasData.filter(z => z.pixeles > 0).map(z => ({
    ...z, sup_ha_real: totalPixeles > 0 ? (z.pixeles / totalPixeles) * parcelaSupHa : 0,
  }))

  const cargando = ['cargando_parcela', 'buscando', 'cargando_rgb', 'calculando_zonas'].includes(estado)

  // - Colores overlay -
  const indiceColorMapa = parcelaVistaEnMapa
    ? 'transparent'
    : modoVista === 'rgb' ? '#fbbf24' : '#3ddc6e'

  // - RENDER -

  // Pantalla de carga mientras se comprueba la sesión
  if (authLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100dvh', background: 'var(--bg)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 32 }}>🌱</div>
          <span className="spinner"/>
        </div>
      </div>
    )
  }

  // Pantalla de login/registro si no hay sesión
  if (!session) {
    return <LoginScreen onLogin={async () => {
      const { data } = await supabase.auth.getSession()
      setSession(data.session)
    }} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden' }} onClick={e => { if (menuAbierto && !(e.target as HTMLElement).closest('[data-menu]')) setMenuAbierto(false) }}>

      {/* - HEADER - */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0, position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', minHeight: isMobile ? 54 : 48 }}>

          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isMobile ? '0 10px' : '0 16px', flexShrink: 0 }}>
            <span style={{ fontSize: 16 }}>🌱</span>
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, letterSpacing: '0.05em' }}>
              <span style={{ color: 'var(--green)' }}>K</span>
              <span style={{ color: '#fff' }}>ULT</span>
              <span style={{ color: 'var(--green)' }}>A</span>
              <span style={{ color: '#fff' }}>GRO</span>
            </span>
          </div>

          {/* Hamburger (solo movil) */}
          {isMobile && (
            <div data-menu style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={() => setMenuAbierto(m => !m)}
                style={{ padding: '0 16px', height: 54, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5 }}
              >
                <span style={{ display: 'block', width: 22, height: 2, background: menuAbierto ? 'var(--green)' : 'var(--muted)', borderRadius: 2 }}/>
                <span style={{ display: 'block', width: 22, height: 2, background: menuAbierto ? 'var(--green)' : 'var(--muted)', borderRadius: 2 }}/>
                <span style={{ display: 'block', width: 22, height: 2, background: menuAbierto ? 'var(--green)' : 'var(--muted)', borderRadius: 2 }}/>
              </button>
              {menuAbierto && (
                <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 6000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0 0 10px 10px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', minWidth: 220 }}>
                  {(['mapa', 'mis_parcelas', 'tratamientos', 'tareas', 'riego', 'personal', 'equipos', 'permisos'] as Pestaña[]).filter(tab => puedeVerPestana(tab, misPermisos)).map(tab => (
                    <button key={tab} onClick={() => { setPestana(tab); setMenuAbierto(false) }}
                      style={{ display: 'block', width: '100%', padding: '15px 20px', border: 'none', background: pestana === tab ? 'rgba(61,220,110,0.08)' : 'transparent', fontFamily: 'var(--mono)', fontSize: 14, fontWeight: pestana === tab ? 700 : 400, cursor: 'pointer', color: pestana === tab ? 'var(--green)' : 'var(--text)', textAlign: 'left', borderLeft: `3px solid ${pestana === tab ? 'var(--green)' : 'transparent'}`, borderBottom: '1px solid var(--border)' }}
                    >
                      {tab === 'mapa' ? '🗺  MAPA' : tab === 'mis_parcelas' ? '📁  MIS PARCELAS' : tab === 'tratamientos' ? '🧪  TRATAMIENTOS' : tab === 'tareas' ? '📋  TAREAS' : tab === 'riego' ? '💧  RIEGO' : tab === 'personal' ? '👷  PERSONAL' : tab === 'equipos' ? '🚜  EQUIPOS' : '🔐  PERMISOS'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pestaña activa (movil) o tabs (desktop) */}
          {isMobile ? (
            <span style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)', paddingLeft: 4 }}>
              {pestana === 'mapa' ? '🗺 MAPA' : pestana === 'mis_parcelas' ? '📁 MIS PARCELAS' : pestana === 'tratamientos' ? '🧪 TRATAMIENTOS' : pestana === 'tareas' ? '📋 TAREAS' : pestana === 'riego' ? '💧 RIEGO' : pestana === 'personal' ? '👷 PERSONAL' : pestana === 'equipos' ? '🚜 EQUIPOS' : '🔐 PERMISOS'}
            </span>
          ) : (
            <div style={{ display: 'flex', flex: 1 }}>
              {(['mapa', 'mis_parcelas', 'tratamientos', 'tareas', 'riego', 'personal', 'equipos', 'permisos'] as Pestaña[]).filter(tab => puedeVerPestana(tab, misPermisos)).map(tab => (
                <button key={tab} onClick={() => setPestana(tab)}
                  style={{ padding: '12px 20px', border: 'none', background: 'transparent', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer', color: pestana === tab ? 'var(--green)' : 'var(--muted)', borderBottom: `2px solid ${pestana === tab ? 'var(--green)' : 'transparent'}`, letterSpacing: '0.06em', transition: 'all 0.15s', whiteSpace: 'nowrap' }}
                >
                  {tab === 'mapa' ? '🗺 MAPA' : tab === 'mis_parcelas' ? '📁 MIS PARCELAS' : tab === 'tratamientos' ? '🧪 TRATAMIENTOS' : tab === 'tareas' ? '📋 TAREAS' : tab === 'riego' ? '💧 RIEGO' : tab === 'personal' ? '👷 PERSONAL' : tab === 'equipos' ? '🚜 EQUIPOS' : '🔐 PERMISOS'}
                </button>
              ))}
            </div>
          )}

          {/* Usuario (clic para desplegar "Cerrar sesión") */}
          <div style={{ marginLeft: 'auto', position: 'relative', padding: '0 16px' }}>
            <button onClick={() => setMenuUsuarioAbierto(v => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: menuUsuarioAbierto ? 'var(--surface2)' : 'transparent', border: '1px solid var(--border)', borderRadius: 20, padding: '5px 10px 5px 12px', cursor: 'pointer' }}>
              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text)', maxWidth: isMobile ? 90 : 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                👤 {session.user.email}
              </span>
              <span style={{ fontSize: 8, color: 'var(--muted)' }}>{menuUsuarioAbierto ? '▲' : '▼'}</span>
            </button>

            {menuUsuarioAbierto && (
              <>
                {/* capa para cerrar el desplegable al tocar fuera */}
                <div onClick={() => setMenuUsuarioAbierto(false)} style={{ position: 'fixed', inset: 0, zIndex: 5999 }} />
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 6000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.5)', minWidth: 220, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)', wordBreak: 'break-all' }}>
                    {session.user.email}
                  </div>
                  <button onClick={() => { setMenuUsuarioAbierto(false); cerrarSesion() }}
                    style={{ display: 'block', width: '100%', padding: '12px 14px', border: 'none', background: 'transparent', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                    ⏻ CERRAR SESIÓN
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* - MODAL COMPROBAR ROMA / ROPO - */}
      {showVerifRomaRopo && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 460, maxHeight: '90vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>COMPROBAR ROMA / ROPO</span>
              <button onClick={() => setShowVerifRomaRopo(false)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18 }}>X</button>
            </div>
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)', lineHeight: 1.5 }}>
                Esta consulta se realiza en tiempo real contra el registro oficial del MAPA. Kultagro no certifica ni almacena esta información de forma permanente.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 6, background: 'var(--green-dim)', border: '1px solid rgba(61,220,110,0.3)' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Registro:</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>{verifRegistro.toUpperCase()}</span>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Tu NIF / NIE</label>
                <input type="text" value={verifNif} onChange={e => setVerifNif(e.target.value)} placeholder="12345678A" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
              </div>
              {verifError && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)' }}>{verifError}</div>}
              {verifResultado && (
                <div style={{ padding: '10px 12px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                  {verifResultado.encontrados === 0 ? (
                    <div>No se encontraron inscripciones para este NIF en {verifResultado.registro?.toUpperCase()}.</div>
                  ) : (
                    <div>
                      <div style={{ marginBottom: 8, color: 'var(--green)' }}>
                        ✅ {verifResultado.encontrados} {verifRegistro === 'roma' ? 'máquina(s) en alta encontrada(s)' : 'inscripción(es) encontrada(s)'}
                      </div>
                      {verifResultado.total_bruto_mapa != null && verifResultado.total_bruto_mapa > verifResultado.encontrados && (
                        <div style={{ marginBottom: 8, color: '#fbbf24', fontSize: 11 }}>
                          ⚠ El MAPA informa de {verifResultado.total_bruto_mapa} inscripciones en total para este NIF (incluye bajas, y puede haber páginas adicionales no traídas)
                        </div>
                      )}
                      {verifResultado.registros?.map((r: any, i: number) => (
                        <div key={i} style={{ padding: '8px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                          {Object.entries(r).filter(([k]) => k !== 'requiere_actualizacion_ccaa').map(([k, v]) => (
                            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: 'var(--muted)' }}>
                              <span>{k}</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{String(v ?? '-')}</span>
                            </div>
                          ))}
                          {r.requiere_actualizacion_ccaa && (
                            <div style={{ marginTop: 4, color: '#fca5a5' }}>⚠ Requiere actualizar datos en su Comunidad Autónoma</div>
                          )}
                          {verifRegistro === 'ropo' && (
                            <button type="button" onClick={() => aplicarResultadoROPO(r)} style={{ marginTop: 8, width: '100%', padding: '8px', borderRadius: 6, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
                              ✅ USAR ESTOS DATOS
                            </button>
                          )}
                          {verifRegistro === 'roma' && (
                            <button type="button" onClick={() => aplicarResultadoROMA(r)} style={{ marginTop: 8, width: '100%', padding: '8px', borderRadius: 6, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
                              ✅ USAR ESTOS DATOS
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
              <button onClick={comprobarRomaRopo} disabled={verifLoading} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: verifLoading ? 'default' : 'pointer', opacity: verifLoading ? 0.6 : 1 }}>
                {verifLoading ? 'CONSULTANDO...' : 'COMPROBAR'}
              </button>
              <button onClick={() => setShowVerifRomaRopo(false)} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CERRAR</button>
            </div>
          </div>
        </div>
      )}

      {/* - CONTENIDO - */}
      <div style={{ flex: pestana === 'tratamientos' ? '0 0 0px' : 1, overflow: 'hidden', display: 'flex' }}>

        {/* - PESTAÑA MAPA - */}
        {pestana === 'mapa' && (
          <div style={{ display: 'flex', width: '100%', height: '100%', position: 'relative' }}>

            {/* Sidebar - desktop: panel lateral | mobile: bottom sheet */}
            <aside style={{
              ...(isMobile ? {
                position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 1000,
                height: panelAbierto ? '70vh' : '52px',
                borderRadius: '16px 16px 0 0',
                transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: '0 -4px 24px rgba(0,0,0,0.4)',
              } : {
                width: 300, height: '100%', flexShrink: 0,
                borderRight: '1px solid var(--border)',
              }),
              overflowY: 'auto', padding: isMobile ? '0' : '16px',
              display: 'flex', flexDirection: 'column', gap: isMobile ? 0 : 14,
              background: 'var(--surface)',
            }}>
            {/* Mobile handle - solo barra drag, sin flecha */}
            {isMobile && (
              <div
                onClick={() => setPanelAbierto(p => !p)}
                style={{ padding: '14px 16px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: 'pointer', flexShrink: 0, minHeight: 56 }}
              >
                <div style={{ width: 44, height: 5, borderRadius: 3, background: 'var(--green)', opacity: 0.7 }}/>
                {parcGeojson && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--green)' }}>
                    {parcelaInfo?.origen === 'dibujado_mano'
                      ? parcelaInfo?.detectandoSigpac
                        ? 'Parcela dibujada · buscando SIGPAC…'
                        : parcelaInfo?.recintos?.length > 0
                          ? `Dibujada · ${parcelaInfo.recintos.length} recinto${parcelaInfo.recintos.length > 1 ? 's' : ''} SIGPAC`
                          : 'Parcela dibujada'
                      : parcelaInfo?.recintos?.length > 1
                        ? `${parcelaInfo.recintos.length} recintos SIGPAC`
                        : `Pol. ${parcelaInfo?.poligono || ''} - Par. ${parcelaInfo?.parcela || ''}`}
                    {parcelaSupHa > 0 ? ` · ${parcelaSupHa.toFixed(2)} ha` : ''}
                  </span>
                )}
              </div>
            )}
            <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '0 16px 16px' : '0', flexDirection: 'column', gap: 14, display: panelAbierto || !isMobile ? 'flex' : 'none' }}>

              {/* PASO 1 */}
              <section>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--green)', fontSize: 10, fontWeight: 700, color: 'var(--bg)', flexShrink: 0 }}>1</span>
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', letterSpacing: '0.08em' }}>SELECCIONAR PARCELA</span>
                </div>

                <button onClick={() => { const next = !seleccionando; setSeleccionando(next); setMododibujo(false); setAnadiendoRecinto(false); if (isMobile && next) setPanelAbierto(false) }} style={{ width: '100%', padding: '10px', borderRadius: 8, background: seleccionando ? 'var(--green)' : 'var(--surface2)', border: `1px solid ${seleccionando ? 'var(--green)' : 'var(--border)'}`, color: seleccionando ? 'var(--bg)' : 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 0.2s' }}>
                  {estado === 'cargando_parcela' ? <><span className="spinner"/> BUSCANDO...</> : seleccionando ? '✕ CANCELAR' : '⊕ CLIC EN EL MAPA'}
                </button>

                {seleccionando && <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'rgba(77,184,255,0.06)', border: '1px solid rgba(77,184,255,0.2)', fontSize: 11, color: 'var(--blue)', fontFamily: 'var(--mono)' }}>👆 Haz clic sobre una parcela en el mapa</div>}

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0' }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/><span style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>O</span><div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
                </div>

                <button onClick={() => { setMododibujo(m => !m); setSeleccionando(false); setAnadiendoRecinto(false) }} style={{ width: '100%', padding: '9px', borderRadius: 8, background: mododibujo ? 'rgba(77,184,255,0.15)' : 'var(--surface2)', border: `1px solid ${mododibujo ? 'var(--blue)' : 'var(--border)'}`, color: mododibujo ? 'var(--blue)' : 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 0.2s' }}>
                  {mododibujo ? '✕ CANCELAR DIBUJO' : '✏ DIBUJAR PARCELA A MANO'}
                </button>
                {mododibujo && <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 6, background: 'rgba(77,184,255,0.06)', border: '1px solid rgba(77,184,255,0.2)', fontSize: 10, color: 'var(--blue)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>✏ Haz clic para dibujar . Doble clic para cerrar</div>}

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0' }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }}/><span style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>O</span><div style={{ flex: 1, height: 1, background: 'var(--border)' }}/>
                </div>

                <label style={{ display: 'block', fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>🔎 Buscar por referencia SIGPAC</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={sigpacRefInput}
                    onChange={e => setSigpacRefInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') buscarPorReferenciaSigpac() }}
                    placeholder="Prov/Mun/Agr/Zona/Pol/Parc/Rec"
                    style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none' }}
                  />
                  <button onClick={buscarPorReferenciaSigpac} disabled={estado === 'cargando_parcela'} style={{ flexShrink: 0, padding: '9px 14px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, cursor: estado === 'cargando_parcela' ? 'wait' : 'pointer' }}>
                    🔎
                  </button>
                </div>
                {errorSigpacRef && <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 6, background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)', fontSize: 10, color: '#fca5a5', fontFamily: 'var(--mono)' }}>{errorSigpacRef}</div>}

                {fincaVistaEnMapa && (
                  <div style={{ marginTop: 8, padding: '10px', borderRadius: 6, background: 'rgba(255,59,48,0.08)', border: '1px solid rgba(255,59,48,0.25)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                    <div style={{ color: '#ff6b6b', fontWeight: 700, marginBottom: 6 }}>🏡 {fincaVistaEnMapa.nombre}</div>
                    <div style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                      <div>Parcelas: <span style={{ color: 'var(--text)' }}>{misParcelas.filter(p => p.fincaId === fincaVistaEnMapa.id).length}</span></div>
                      {parcelaSupHa > 0 && <div>Sup. total: <span style={{ color: 'var(--text)' }}>{parcelaSupHa.toFixed(2)} ha</span></div>}
                    </div>
                  </div>
                )}

                {parcelaInfo && (
                  <div style={{ marginTop: 8, padding: '10px', borderRadius: 6, background: 'var(--green-dim)', border: '1px solid rgba(61,220,110,0.2)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                    <div style={{ color: 'var(--green)', fontWeight: 700, marginBottom: 6 }}>
                      ✓ PARCELA SELECCIONADA{parcelaInfo.recintos?.length > 1 ? ` · ${parcelaInfo.recintos.length} RECINTOS` : ''}
                    </div>
                    <div style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
                      {parcelaInfo.origen === 'dibujado_mano'
                        ? <>
                            <div style={{ color: 'var(--blue)', fontSize: 10, marginBottom: 4 }}>✏ Dibujada a mano</div>
                            {parcelaInfo.detectandoSigpac
                              ? <div style={{ fontSize: 10, opacity: 0.75 }}>🔎 Buscando recintos SIGPAC bajo el dibujo…</div>
                              : parcelaInfo.recintos?.length > 0
                                ? <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <div style={{ fontSize: 9, opacity: 0.7 }}>Recintos SIGPAC detectados bajo el dibujo:</div>
                                    {parcelaInfo.recintos.map((r: RecintoRef, i: number) => (
                                      <div key={i} style={{ color: 'var(--text)' }}>{formatRefSigpac(r)}</div>
                                    ))}
                                  </div>
                                : <div style={{ fontSize: 10, opacity: 0.6 }}>Sin recintos SIGPAC detectados en esa zona</div>
                            }
                          </>
                        : parcelaInfo.recintos?.length > 1
                          ? <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
                              {parcelaInfo.recintos.map((r: RecintoRef, i: number) => (
                                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                  <span style={{ color: 'var(--text)' }}>{formatRefSigpac(r)}</span>
                                  <span>{r.supHa.toFixed(4)} ha</span>
                                </div>
                              ))}
                            </div>
                          : <>
                            {parcelaInfo.municipio && <div>Mun: <span style={{ color: 'var(--text)' }}>{parcelaInfo.municipio}</span></div>}
                            {parcelaInfo.poligono && <div>Pol: <span style={{ color: 'var(--text)' }}>{parcelaInfo.poligono}</span></div>}
                            {parcelaInfo.parcela && <div>Par: <span style={{ color: 'var(--text)' }}>{parcelaInfo.parcela}</span></div>}
                            {parcelaInfo.uso_sigpac && <div>Uso: <span style={{ color: 'var(--text)' }}>{parcelaInfo.uso_sigpac}</span></div>}
                          </>
                      }
                      {parcelaSupHa > 0 && <div>Sup. total: <span style={{ color: 'var(--text)' }}>{parcelaSupHa.toFixed(4)} ha</span></div>}
                    </div>
                  </div>
                )}

                {/* + AÑADIR RECINTO: solo tiene sentido sobre una parcela ya cargada desde SIGPAC (no dibujada a mano) */}
                {parcelaInfo && parcelaInfo.origen !== 'dibujado_mano' && !mododibujo && (
                  <button
                    onClick={() => { const next = !anadiendoRecinto; setAnadiendoRecinto(next); setSeleccionando(false); setMododibujo(false); if (isMobile && next) setPanelAbierto(false) }}
                    style={{ width: '100%', marginTop: 8, padding: '9px', borderRadius: 8, background: anadiendoRecinto ? 'rgba(77,184,255,0.15)' : 'var(--surface2)', border: `1px solid ${anadiendoRecinto ? 'var(--blue)' : 'var(--border)'}`, color: anadiendoRecinto ? 'var(--blue)' : 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 0.2s' }}
                  >
                    {anadiendoRecinto ? '✕ TERMINAR DE AÑADIR' : '+ AÑADIR RECINTO'}
                  </button>
                )}
                {anadiendoRecinto && <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 6, background: 'rgba(77,184,255,0.06)', border: '1px solid rgba(77,184,255,0.2)', fontSize: 10, color: 'var(--blue)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>👆 Pulsa otro recinto en el mapa. Puedes seguir pulsando para añadir varios</div>}

                {parcGeojson && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button onClick={deseleccionar} style={{ flex: 1, padding: '7px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>
                      ✕ DESELECCIONAR
                    </button>
                    <button onClick={abrirFormularioGuardar} style={{ flex: 1, padding: '7px', borderRadius: 6, background: 'rgba(61,220,110,0.1)', border: '1px solid rgba(61,220,110,0.3)', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                      💾 GUARDAR
                    </button>
                  </div>
                )}
              </section>

              {/* PASO 2: Periodo */}
              {parcGeojson && (
                <>
                  <hr style={{ borderColor: 'var(--border)', borderWidth: '0 0 1px 0' }} />
                  <section>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                      <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--green)', fontSize: 10, fontWeight: 700, color: 'var(--bg)', flexShrink: 0 }}>2</span>
                      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', letterSpacing: '0.08em' }}>PERIODO</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                      {[{ label: 'Desde', val: fechaInicio, set: setFechaInicio }, { label: 'Hasta', val: fechaFin, set: setFechaFin }].map(f => (
                        <div key={f.label}>
                          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{f.label}</div>
                          <input type="date" value={f.val} onChange={e => f.set(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5, padding: '5px 6px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}/>
                        </div>
                      ))}
                    </div>
                    <button onClick={buscarImagenes} disabled={cargando} style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'transparent', border: '1px solid var(--blue)', color: 'var(--blue)', fontSize: 11, fontFamily: 'var(--mono)', cursor: cargando ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      {estado === 'buscando' ? <><span className="spinner"/> BUSCANDO...</> : '◎ BUSCAR IMÁGENES'}
                    </button>
                    {productos.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Imagen ({productos.length} disponibles)</div>
                        <select value={productoSel} onChange={e => { setProductoSel(e.target.value); resetear() }} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5, padding: '5px 6px', color: 'var(--text)', fontSize: 10, fontFamily: 'var(--mono)', outline: 'none' }}>
                          {productos.map(p => <option key={p.id} value={p.id}>{p.fecha} . ☀ {p.claridad ?? (p.nubosidad != null ? 100 - p.nubosidad : '?')}% claridad . {p.size_mb}MB</option>)}
                        </select>
                        <button onClick={verImagenRGB} disabled={cargando} style={{ width: '100%', marginTop: 8, padding: '9px', borderRadius: 6, background: modoVista === 'rgb' ? 'rgba(251,191,36,0.15)' : 'var(--surface2)', border: `1px solid ${modoVista === 'rgb' ? 'var(--amber)' : 'var(--border)'}`, color: modoVista === 'rgb' ? 'var(--amber)' : 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, cursor: cargando ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 0.2s' }}>
                          {estado === 'cargando_rgb' ? <><span className="spinner" style={{ borderTopColor: 'var(--amber)' }}/> CARGANDO...</> : modoVista === 'rgb' ? '🛰 IMAGEN CARGADA' : '🛰 VER IMAGEN REAL'}
                        </button>
                      </div>
                    )}
                  </section>
                </>
              )}

              {/* PASO 3: NDVI */}
              {productos.length > 0 && (
                <>
                  <hr style={{ borderColor: 'var(--border)', borderWidth: '0 0 1px 0' }} />
                  <section>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                      <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--green)', fontSize: 10, fontWeight: 700, color: 'var(--bg)', flexShrink: 0 }}>3</span>
                      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', letterSpacing: '0.08em' }}>MAPA NDVI</span>
                    </div>
                    <button onClick={calcularZonasNDVI} disabled={cargando} style={{ width: '100%', padding: '11px', borderRadius: 8, background: cargando ? 'var(--surface2)' : 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: cargando ? 'wait' : 'pointer', letterSpacing: '0.08em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 0.2s' }}>
                      {estado === 'calculando_zonas' ? <><span className="spinner" style={{ borderTopColor: 'var(--bg)' }}/> PROCESANDO...</> : '▶ CALCULAR NDVI'}
                    </button>
                    {zonasConSup.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 9, color: 'var(--green)', fontFamily: 'var(--mono)', marginBottom: 8, letterSpacing: '0.08em', fontWeight: 700 }}>ZONAS NDVI . SUPERFICIE</div>
                        {zonasConSup.map(z => {
                          const zi = ZONAS_NDVI.find(zn => zn.zona === z.zona)!
                          const pct = parcelaSupHa > 0 ? ((z.sup_ha_real / parcelaSupHa) * 100).toFixed(1) : '0'
                          return (
                            <div key={z.zona} style={{ marginBottom: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                <div style={{ width: 10, height: 10, borderRadius: 2, background: zi.color, flexShrink: 0 }}/>
                                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', flex: 1 }}>Z{z.zona} <span style={{ opacity: 0.6 }}>({zi.rango})</span></div>
                                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 600 }}>{z.sup_ha_real.toFixed(4)} ha</div>
                                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: zi.color, width: 32, textAlign: 'right' }}>{pct}%</div>
                              </div>
                              <div style={{ height: 3, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                                <div style={{ height: '100%', width: `${pct}%`, background: zi.color, borderRadius: 2, transition: 'width 0.3s' }}/>
                              </div>
                            </div>
                          )
                        })}
                        <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 6, textAlign: 'right' }}>
                          Total: <span style={{ color: 'var(--green)', fontWeight: 700 }}>{parcelaSupHa.toFixed(4)} ha</span>
                        </div>
                      </div>
                    )}
                  </section>
                </>
              )}

              {/* PASO 4: Producción */}
              {zonasConSup.length > 0 && (
                <>
                  <hr style={{ borderColor: 'var(--border)', borderWidth: '0 0 1px 0' }} />
                  <section>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                      <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--green)', fontSize: 10, fontWeight: 700, color: 'var(--bg)', flexShrink: 0 }}>4</span>
                      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', letterSpacing: '0.08em' }}>CÁLCULO DE PRODUCCIÓN</span>
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8 }}>Introduce un valor y el resto se calcula por regla de tres</div>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                      <select id="zona-select" defaultValue="" style={{ flex: 1, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5, padding: '7px 8px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                        <option value="" disabled>Selecciona zona...</option>
                        {zonasConSup.map(z => {
                          const zi = ZONAS_NDVI.find(zn => zn.zona === z.zona)!
                          return <option key={z.zona} value={String(z.zona)}>Z{z.zona} . {zi.rango} . {z.sup_ha_real.toFixed(3)}ha</option>
                        })}
                      </select>
                      <input id="kg-input" type="number" min="0" placeholder="kg/ha" style={{ width: 90, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5, padding: '7px 8px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}/>
                      <button onClick={() => {
                        const sel = (document.getElementById('zona-select') as HTMLSelectElement)?.value
                        const kg  = (document.getElementById('kg-input') as HTMLInputElement)?.value
                        if (sel && kg && Number(kg) > 0) setKgPorHa({ [sel]: kg })
                      }} style={{ padding: '7px 10px', borderRadius: 5, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>✓</button>
                    </div>
                    {Object.keys(kgHaCalculado).length > 0 && (
                      <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', marginBottom: 8 }}>
                        <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 6, letterSpacing: '0.06em' }}>VALORES CALCULADOS:</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                          {zonasConSup.map(z => {
                            const zi = ZONAS_NDVI.find(zn => zn.zona === z.zona)!
                            const val = kgHaCalculado[String(z.zona)]
                            const esRef = kgPorHa[String(z.zona)] !== undefined && kgPorHa[String(z.zona)] !== ''
                            if (!val) return null
                            return (
                              <div key={z.zona} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <div style={{ width: 6, height: 6, borderRadius: 1, background: zi.color, flexShrink: 0 }}/>
                                <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: esRef ? 'var(--green)' : 'var(--muted)' }}>
                                  Z{z.zona}: <span style={{ color: esRef ? 'var(--green)' : 'var(--text)', fontWeight: esRef ? 700 : 400 }}>{val}</span>
                                </span>
                              </div>
                            )
                          })}
                        </div>
                        <button onClick={() => setKgPorHa({})} style={{ marginTop: 6, fontSize: 9, color: '#fca5a5', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Borrar valores</button>
                      </div>
                    )}
                    <button onClick={() => calcularProduccion(kgHaCalculado)} disabled={Object.keys(kgHaCalculado).length === 0} style={{ width: '100%', padding: '10px', borderRadius: 8, background: Object.keys(kgHaCalculado).length > 0 ? 'var(--green)' : 'var(--surface2)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: Object.keys(kgHaCalculado).length > 0 ? 'pointer' : 'not-allowed', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                      🌾 CALCULAR PRODUCCIÓN
                    </button>
                  </section>
                </>
              )}

              {/* Resultado producción */}
              {produccion && (
                <>
                  <hr style={{ borderColor: 'var(--border)', borderWidth: '0 0 1px 0' }} />
                  <section>
                    <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', letterSpacing: '0.08em', marginBottom: 10 }}>ESTIMACIÓN DE COSECHA</div>
                    {produccion.zonas.filter((z: any) => z.kg_por_ha > 0).map((z: any) => (
                      <div key={z.zona} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border)', fontSize: 10, fontFamily: 'var(--mono)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ width: 7, height: 7, borderRadius: 2, background: z.color_hex }}/>
                          <span style={{ color: 'var(--muted)' }}>Z{z.zona}</span>
                          <span style={{ color: 'var(--muted)', fontSize: 9, opacity: 0.6 }}>{z.superficie_ha.toFixed(4)}ha . {Math.round(z.kg_por_ha)}kg/ha</span>
                        </div>
                        <span style={{ color: 'var(--text)', fontWeight: 700 }}>{Math.round(z.kg_estimados).toLocaleString()} kg</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 10, padding: '12px', borderRadius: 8, background: 'var(--green-dim)', border: '1px solid rgba(61,220,110,0.3)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 11, fontFamily: 'var(--mono)' }}>
                        <span style={{ color: 'var(--muted)' }}>Superficie analizada</span>
                        <span style={{ color: 'var(--text)' }}>{produccion.total_ha.toFixed(4)} ha</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 11, fontFamily: 'var(--mono)' }}>
                        <span style={{ color: 'var(--muted)' }}>Total kilogramos</span>
                        <span style={{ color: 'var(--green)', fontWeight: 700 }}>{Math.round(produccion.total_kg).toLocaleString()} kg</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 5 }}>
                        <span style={{ color: 'var(--muted)' }}>Rendimiento medio</span>
                        <span style={{ color: 'var(--green)', fontWeight: 700 }}>{produccion.total_ha > 0 ? Math.round(produccion.total_kg / produccion.total_ha).toLocaleString() : 0} kg/ha</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontFamily: 'var(--mono)', fontWeight: 700, marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(61,220,110,0.2)' }}>
                        <span style={{ color: 'var(--muted)' }}>TOTAL TONELADAS</span>
                        <span style={{ color: 'var(--green)', fontSize: 18 }}>{produccion.total_toneladas.toFixed(3)} t</span>
                      </div>
                    </div>
                  </section>
                </>
              )}

              {/* MDT: curvas de nivel / mapa de colores por altitud (una sola sección, un solo mapa visible a la vez) */}
              {parcGeojson && (
                <>
                  <hr style={{ borderColor: 'var(--border)', borderWidth: '0 0 1px 0' }} />
                  <section>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                      <span style={{ fontSize: 16 }}>🗺</span>
                      <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--blue)', letterSpacing: '0.08em', fontWeight: 700 }}>CURVAS DE NIVEL</span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 10, lineHeight: 1.6 }}>MDT del IGN . Plano topográfico o mapa de colores por altitud</div>

                    <button onClick={calcularContornos} disabled={calculandoContornos} style={{ width: '100%', padding: '10px', borderRadius: 8, background: calculandoContornos ? 'var(--surface2)' : 'rgba(77,184,255,0.15)', border: '1px solid var(--blue)', color: 'var(--blue)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: calculandoContornos ? 'wait' : 'pointer', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 0.2s' }}>
                      {calculandoContornos ? <><span className="spinner" style={{ borderTopColor: 'var(--blue)' }}/> CALCULANDO MDT...</> : '🗺 GENERAR CURVAS DE NIVEL'}
                    </button>
                    <button onClick={calcularMdtColor} disabled={calculandoMdtColor} style={{ width: '100%', marginTop: 8, padding: '10px', borderRadius: 8, background: calculandoMdtColor ? 'var(--surface2)' : 'rgba(77,184,255,0.15)', border: '1px solid var(--blue)', color: 'var(--blue)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: calculandoMdtColor ? 'wait' : 'pointer', letterSpacing: '0.06em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, transition: 'all 0.2s' }}>
                      {calculandoMdtColor ? <><span className="spinner" style={{ borderTopColor: 'var(--blue)' }}/> CALCULANDO MDT...</> : 'GENERAR MAPA DE COLORES'}
                    </button>

                    {mapaActivo && (() => {
                      const statsActivas = mapaActivo === 'contornos' ? contornosStats : mdtColorStats
                      if (!statsActivas) return null
                      return (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                            {[
                              { k: 'Alt. mín', v: `${statsActivas.altitud_min}m` },
                              { k: 'Alt. máx', v: `${statsActivas.altitud_max}m` },
                              { k: 'Área', v: `${statsActivas.area_ha}ha` },
                              { k: 'Intervalo', v: mapaActivo === 'contornos' ? `${statsActivas.intervalo_m}m` : '—' },
                            ].map(s => (
                              <div key={s.k} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px' }}>
                                <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{s.k}</div>
                                <div style={{ fontSize: 13, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--blue)', marginTop: 2 }}>{s.v}</div>
                              </div>
                            ))}
                          </div>
                          {mapaActivo === 'contornos' && Array.isArray(statsActivas.leyenda) && statsActivas.leyenda.length > 0 && (
                            <div style={{ marginTop: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                              <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Índice de cotas</div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {statsActivas.leyenda.map((l: { cota: number; color: string }) => (
                                  <div key={l.cota} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <span style={{ width: 10, height: 3, borderRadius: 2, background: l.color, flexShrink: 0 }} />
                                    <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{l.cota}m</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {mapaActivo === 'contornos' && statsActivas.numeros_en_mapa && (
                            <div style={{ marginTop: 8, fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', lineHeight: 1.5 }}>
                              Hay muchas curvas principales: se alternan en rojo/negro y la cota va escrita sobre cada línea del mapa.
                            </div>
                          )}
                          <button onClick={toggleMapaMdt} style={{ width: '100%', marginTop: 8, padding: '8px', borderRadius: 6, background: mapaVisible ? 'rgba(77,184,255,0.15)' : 'var(--surface2)', border: `1px solid ${mapaVisible ? 'var(--blue)' : 'var(--border)'}`, color: mapaVisible ? 'var(--blue)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', fontWeight: 600 }}>
                            {mapaVisible ? 'OCULTAR MAPA' : 'VER MAPA'}
                          </button>
                        </div>
                      )
                    })()}
                  </section>
                </>
              )}

              {/* ============ INICIO histórico de mapas NDVI DESACTIVADO — código intacto, solo comentado ============
              <hr style={{ borderColor: 'var(--border)', borderWidth: '0 0 1px 0' }} />
              <section>
                <button onClick={() => setMostrarHistorico(h => !h)} style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', letterSpacing: '0.06em' }}>
                  <span>📋 HISTÓRICO ({historico.length})</span>
                  <span>{mostrarHistorico ? '▲' : '▼'}</span>
                </button>
                {mostrarHistorico && (
                  <div style={{ marginTop: 8 }}>
                    {historico.length === 0
                      ? <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', textAlign: 'center', padding: '12px 0' }}>Sin análisis guardados</div>
                      : <>
                        <button onClick={async () => { if (confirm('Borrar todo el histórico?')) { setHistorico([]); if (session) { try { await supabase.from('historico').delete().eq('user_id', session.user.id) } catch (e) { console.error(e) } } } }} style={{ fontSize: 9, color: '#fca5a5', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', marginBottom: 8, textDecoration: 'underline' }}>Borrar histórico</button>
                        {historico.map((entrada: any) => (
                          <div key={entrada.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', marginBottom: 6 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                              <span style={{ fontSize: 10, color: 'var(--green)', fontFamily: 'var(--mono)', fontWeight: 700 }}>{entrada.fecha}</span>
                              <span style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{entrada.fecha_guardado}</span>
                            </div>
                            <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 6 }}>{entrada.parcela} . {entrada.sup_ha} ha</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6 }}>
                              {entrada.zonas?.map((z: any) => {
                                const zi = ZONAS_NDVI.find(zn => zn.zona === z.zona)!
                                return <div key={z.zona} title={`Z${z.zona}: ${z.sup_ha_real}ha (${z.pct}%)`} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)' }}><div style={{ width: 7, height: 7, borderRadius: 1, background: zi?.color || '#888' }}/><span>{z.pct}%</span></div>
                              })}
                            </div>
                            {entrada.geojson && (
                              <button onClick={async () => {
                                setParcGeojson(entrada.geojson); setParcelaInfo(entrada.parcelaInfo || {})
                                setParcelaSupHa(entrada.sup_ha_num || parseFloat(entrada.sup_ha))
                                setParcelaVistaEnMapa(null); setFincaVistaEnMapa(null)
                                setEstado('calculando_zonas'); setError(''); setMostrarHistorico(false)
                                resetear() // limpia imagen/NDVI/MDT de la parcela anterior antes de cargar la nueva
                                try {
                                  const geom = entrada.geojson.features[0].geometry
                                  const allCoords: number[][] = []
                                  if (geom.type === 'Polygon') allCoords.push(...geom.coordinates[0])
                                  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => allCoords.push(...p[0]))
                                  const lons = allCoords.map((c: number[]) => c[0]); const lats = allCoords.map((c: number[]) => c[1])
                                  const pad = 0.00005
                                  const bbox = `${Math.min(...lons)-pad},${Math.min(...lats)-pad},${Math.max(...lons)+pad},${Math.max(...lats)+pad}`
                                  const gp = encodeURIComponent(JSON.stringify(entrada.geojson))
                                  const r = await fetch(`${BACKEND}/ndvi/zonas?bbox=${bbox}&fecha=${entrada.fecha}&geojson=${gp}`)
                                  if (!r.ok) throw new Error(`Error ${r.status}`)
                                  const data = await r.json(); setZonasData(data.zonas)
                                  const ir = await fetch(`${BACKEND}${data.imagen_url}`); const blob = await ir.blob()
                                  setImagenUrl(URL.createObjectURL(blob)); setModoVista('zonas'); setEstado('done')
                                } catch (e: any) { setEstado('error'); setError('Error recargando: ' + e.message) }
                              }} style={{ width: '100%', padding: '5px', borderRadius: 5, background: 'rgba(61,220,110,0.08)', border: '1px solid rgba(61,220,110,0.2)', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', letterSpacing: '0.04em' }}>
                                ▶ CARGAR ANÁLISIS
                              </button>
                            )}
                          </div>
                        ))}
                      </>
                    }
                  </div>
                )}
              </section>
              ============ FIN histórico de mapas NDVI ============ */}


              {error && <div style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 11, fontFamily: 'var(--mono)' }}>⚠ {error}</div>}

            </div>
            </aside>

            {/* Área mapa */}
            <div style={{ flex: 1, position: 'relative' }}>
              <MapView
                onParcelaClick={onMapaClick}
                onParcelasDibujadas={handleParcelasDibujadas}
                parcGeojson={parcGeojson}
                imagenUrl={(parcelaVistaEnMapa || fincaVistaEnMapa) ? null : imagenUrl}
                indiceColor={(parcelaVistaEnMapa || fincaVistaEnMapa) ? 'transparent' : modoVista === 'rgb' ? '#fbbf24' : '#3ddc6e'}
                parcelaVistaColor={fincaVistaEnMapa ? '#ff3b30' : parcelaVistaEnMapa ? '#888888' : undefined}
                seleccionando={seleccionando || anadiendoRecinto}
                mododibujo={mododibujo}
                onMododibujoCambiado={setMododibujo}
              />
              <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000, fontFamily: 'var(--mono)', fontSize: 11, background: 'rgba(15,26,18,0.92)', border: '1px solid var(--border)', backdropFilter: 'blur(8px)', borderRadius: 6, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                {fincaVistaEnMapa && <span style={{ color: '#ff6b6b', fontWeight: 700 }}>🏡 FINCA: {fincaVistaEnMapa.nombre}</span>}
                {!fincaVistaEnMapa && parcelaVistaEnMapa && <span style={{ color: '#888' }}>📁 PARCELA GUARDADA</span>}
                {!parcelaVistaEnMapa && !fincaVistaEnMapa && modoVista === 'ninguna' && <span style={{ color: 'var(--muted)' }}>SIN OVERLAY</span>}
                {!parcelaVistaEnMapa && !fincaVistaEnMapa && modoVista === 'rgb' && <span style={{ color: 'var(--amber)' }}>🛰 COLOR NATURAL</span>}
                {!parcelaVistaEnMapa && !fincaVistaEnMapa && modoVista === 'zonas' && <span style={{ color: 'var(--green)', fontWeight: 700 }}>🌿 MAPA NDVI</span>}
              </div>
              {estado === 'idle' && !seleccionando && !parcelaVistaEnMapa && !fincaVistaEnMapa && (
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none', zIndex: 500 }}>
                  <div style={{ fontSize: 56, marginBottom: 14, opacity: 0.2 }}>🌾</div>
                  <p style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: '0.08em', lineHeight: 1.8 }}>PULSA "CLIC EN EL MAPA"<br />Y SELECCIONA UNA PARCELA</p>
                </div>
              )}
              {(seleccionando || anadiendoRecinto) && (
                <div style={{ position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, pointerEvents: 'none', background: 'rgba(77,184,255,0.1)', border: '1px solid var(--blue)', backdropFilter: 'blur(8px)', borderRadius: 8, padding: '10px 20px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--blue)', letterSpacing: '0.06em' }}>
                  {anadiendoRecinto ? '👆 PULSA UN RECINTO MÁS PARA AÑADIRLO' : '👆 HAZ CLIC SOBRE UNA PARCELA EN EL MAPA'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* - PESTAÑA MIS PARCELAS - */}
        {pestana === 'mis_parcelas' && (
          <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden' }}>

            {/* Formulario guardar/editar */}
            {formularioVisible && (
              <div style={{ width: isMobile ? '100%' : 480, height: '100%', background: 'var(--surface)', borderRight: isMobile ? 'none' : '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)', letterSpacing: '0.06em' }}>
                    {parcelaEditar ? '✏ EDITAR PARCELA' : '💾 GUARDAR PARCELA'}
                  </div>
                </div>

                <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

                  {/* Preview imagen */}
                  <div style={{ width: '100%', height: 200, borderRadius: 8, overflow: 'hidden', background: 'var(--surface2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {imagenPreviewForm
                      ? <img src={imagenPreviewForm} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="Preview parcela" onError={e => { (e.target as HTMLImageElement).style.display='none' }}/>
                      : <div style={{ textAlign: 'center', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10 }}>
                          <div style={{ fontSize: 32, marginBottom: 8 }}>🌾</div>
                          Sin imagen disponible
                        </div>
                    }
                  </div>

                  {/* Info parcela */}
                  {parcelaInfo && (
                    <div style={{ padding: '8px 12px', borderRadius: 6, background: 'var(--green-dim)', border: '1px solid rgba(61,220,110,0.2)', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                      {parcelaInfo.origen === 'dibujado_mano'
                        ? parcelaInfo.detectandoSigpac
                          ? '✏ Parcela dibujada a mano · 🔎 buscando recintos SIGPAC…'
                          : parcelaInfo.recintos?.length > 0
                            ? <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <div style={{ color: 'var(--text)', marginBottom: 2 }}>✏ Dibujada a mano · {parcelaInfo.recintos.length} recinto{parcelaInfo.recintos.length > 1 ? 's' : ''} SIGPAC detectado{parcelaInfo.recintos.length > 1 ? 's' : ''}:</div>
                                {parcelaInfo.recintos.map((r: RecintoRef, i: number) => (
                                  <div key={i}>{formatRefSigpac(r)}</div>
                                ))}
                              </div>
                            : '✏ Parcela dibujada a mano (sin recintos SIGPAC detectados)'
                        : parcelaInfo.recintos?.length > 1
                          ? <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              <div style={{ color: 'var(--text)', marginBottom: 2 }}>{parcelaInfo.recintos.length} recintos SIGPAC:</div>
                              {parcelaInfo.recintos.map((r: RecintoRef, i: number) => (
                                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                  <span>{formatRefSigpac(r)}</span>
                                  <span>{r.supHa.toFixed(4)} ha</span>
                                </div>
                              ))}
                            </div>
                          : `Mun: ${parcelaInfo.municipio} . Pol: ${parcelaInfo.poligono} . Par: ${parcelaInfo.parcela}`}
                      {parcelaInfo.origen !== 'dibujado_mano' && parcelaInfo.recintos?.length <= 1 && parcelaSupHa > 0 && ` . ${parcelaSupHa.toFixed(4)} ha`}
                    </div>
                  )}

                  {/* Formulario */}
                  {[
                    { label: 'Nombre de la parcela', key: 'nombre', value: formNombre, set: setFormNombre, obligatorio: false, placeholder: 'Ej: Finca El Olivar' },
                    { label: 'Cultivo', key: 'cultivo', value: formCultivo, set: setFormCultivo, obligatorio: true, placeholder: 'Ej: Trigo, Olivo, Viñedo...' },
                    { label: 'Variedad', key: 'variedad', value: formVariedad, set: setFormVariedad, obligatorio: false, placeholder: 'Ej: Duro, Arbequina... (opcional)' },
                  ].map(f => (
                    <div key={f.key}>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {f.label} {f.obligatorio && <span style={{ color: '#ff6b6b' }}>*</span>}
                      </label>
                      <input
                        type="text"
                        value={f.value}
                        onChange={e => f.set(e.target.value)}
                        placeholder={f.placeholder}
                        style={{ width: '100%', background: 'var(--surface2)', border: `1px solid ${f.obligatorio && !f.value.trim() && formError ? '#ff6b6b' : 'var(--border)'}`, borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}
                      />
                    </div>
                  ))}

                  {/* Datos agroambientales para el Cuaderno de Campo (sección 2.1) — opcionales */}
                  {[
                    { label: 'Secano / Regadío', value: formSecanoRegadio, set: setFormSecanoRegadio, opciones: [['SEC', 'Secano (SEC)'], ['ASP', 'Aspersión (ASP)'], ['LOC', 'Goteo / Localizado (LOC)'], ['GRA', 'Gravedad (GRA)']] },
                    { label: 'Aire libre / protegido', value: formTipoCultivoAmbiente, set: setFormTipoCultivoAmbiente, opciones: [['AL', 'Aire libre (AL)'], ['M', 'Malla (M)'], ['BP', 'Cubierta bajo plástico (BP)'], ['INV', 'Invernadero (INV)']] },
                    { label: 'Sist. asesoramiento GIP', value: formSistAsesoramientoGip, set: setFormSistAsesoramientoGip, opciones: [['AE', 'Agricultura Ecológica (AE)'], ['PI', 'Producción Integrada (PI)'], ['CP', 'Certificación Privada (CP)'], ['ATRIAS', 'Agrupación de Tratamiento Integrado en Agricultura (ATRIAs)'], ['AS', 'Asistida de un asesor (AS)'], ['NO', 'Sin obligación de aplicar la GIP (NO)']] },
                  ].map(f => (
                    <div key={f.label}>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{f.label}</label>
                      <select value={f.value} onChange={e => f.set(e.target.value as any)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: f.value ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                        <option value="">Sin especificar</option>
                        {f.opciones.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
                      </select>
                    </div>
                  ))}


                  {/* Finca */}
                  <div>
                    <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Finca</label>
                    {fincas.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: '6px 0' }}>No hay fincas creadas.</div>
                    ) : (
                      <select value={formFincaId} onChange={e => setFormFincaId(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: formFincaId ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                        <option value="">Sin finca asignada</option>
                        {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Campaña <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(opcional, para cultivos anuales)</span></label>
                    {campanas.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: '6px 0' }}>No hay campañas creadas todavía.</div>
                    ) : (
                      <select value={formCampanaId} onChange={e => setFormCampanaId(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: formCampanaId ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                        <option value="">Sin campaña asignada</option>
                        {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}{campanaFinalizada(c) ? ' (finalizada)' : ''}</option>)}
                      </select>
                    )}
                  </div>

                  {parcelaEditar && (formCultivo.trim() !== parcelaEditar.cultivo || formVariedad.trim() !== (parcelaEditar.variedad || '')) && (
                    <div style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(255,180,84,0.08)', border: '1px solid rgba(255,180,84,0.3)' }}>
                      {!cultivoAnteriorGuardado ? (
                        <>
                          <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 8, lineHeight: 1.5 }}>
                            Vas a cambiar el cultivo de <strong style={{ color: 'var(--text)' }}>{formatCultivoVariedad(parcelaEditar.cultivo, parcelaEditar.variedad)}</strong> a <strong style={{ color: 'var(--text)' }}>{formatCultivoVariedad(formCultivo.trim() || '—', formVariedad)}</strong>. Si es por rotación de cultivo (fin de campaña), guarda antes el cultivo anterior para no perder el historial.
                          </div>
                          <button onClick={abrirGuardarCultivoAnterior} style={{ padding: '7px 12px', borderRadius: 6, background: 'transparent', border: '1px solid #ffb454', color: '#ffb454', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                            💾 Guardar cultivo anterior con campaña
                          </button>
                        </>
                      ) : (
                        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)' }}>
                          ✓ Guardado: {formatCultivoVariedad(parcelaEditar.cultivo, parcelaEditar.variedad)}{parcelaEditar.campanaId ? ` — ${campanas.find(c => c.id === parcelaEditar.campanaId)?.nombre || ''}` : ' (sin campaña)'}
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Fecha de plantación</label>
                    <input type="date" value={formFechaPlantacion} onChange={e => setFormFechaPlantacion(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Información adicional</label>
                    <textarea value={formInfoAdicional} onChange={e => setFormInfoAdicional(e.target.value)} placeholder="Notas, observaciones, variedad..." rows={3} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none', resize: 'vertical' }}/>
                  </div>

                  {formError && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)' }}>⚠ {formError}</div>}
                </div>

                {/* Botones */}
                <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
                  <button onClick={guardarParcela} style={{ flex: 1, padding: '12px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer', letterSpacing: '0.06em' }}>
                    💾 GUARDAR
                  </button>
                  <button onClick={cancelarFormulario} style={{ flex: 1, padding: '12px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                    CANCELAR
                  </button>
                </div>
              </div>
            )}

            {/* Lista de parcelas guardadas */}
            <div style={{ flex: 1, height: '100%', overflow: 'auto', padding: 24, background: 'var(--bg)' }}>
              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'stretch' : 'flex-start', justifyContent: 'space-between', marginBottom: 20, gap: 16, flexWrap: isMobile ? 'nowrap' : 'wrap' }}>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>📁 Mis Parcelas</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8 }}>{misParcelas.length} parcela{misParcelas.length !== 1 ? 's' : ''} guardada{misParcelas.length !== 1 ? 's' : ''}</div>
                  {isMobile && <div style={{ marginBottom: 12 }}>{renderRoscosFincas()}</div>}
                  {misPermisos['fincas.crear_editar'] && (
                    <button onClick={() => { setFincaEditar(null); setFNombre(''); setFDescripcion(''); setFError(''); setFormFinca(true) }}
                      style={{ padding: '5px 12px', borderRadius: 6, background: 'rgba(61,220,110,0.1)', border: '1px solid rgba(61,220,110,0.3)', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: 700, marginRight: 8 }}>
                      + Crear finca
                    </button>
                  )}
                  {misPermisos['parcelas.crear_editar'] && (
                    <button onClick={() => setImportarExcelVisible(true)}
                      style={{ padding: '5px 12px', borderRadius: 6, background: 'rgba(77,184,255,0.1)', border: '1px solid rgba(77,184,255,0.3)', color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                      📥 Importar Excel
                    </button>
                  )}
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button onClick={() => { setCampanaEditar(null); setCampNombre(''); setCampFechaInicio(''); setCampFechaFin(''); setCampError(''); setFormCampanaVisible(true) }}
                      style={{ padding: '5px 12px', borderRadius: 6, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)', color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                      + Crear campaña
                    </button>
                    {misParcelas.length > 0 && (
                      <button onClick={() => abrirPopupCambioCampanas()}
                        style={{ padding: '5px 12px', borderRadius: 6, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)', color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                        🔁 Cambiar campaña de parcelas
                      </button>
                    )}
                  </div>
                </div>

                {/* Roscos: % de cultivo por finca (por superficie). En escritorio, arriba a la derecha. */}
                {!isMobile && renderRoscosFincas()}
              </div>

              {/* Gestión de fincas */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Fincas ({fincas.length})</span>
                  {filtroFinca && (
                    <button onClick={() => verFincaEnMapa(filtroFinca)}
                      style={{ padding: '5px 12px', borderRadius: 6, background: 'rgba(255,59,48,0.1)', border: '1px solid rgba(255,59,48,0.35)', color: '#ff6b6b', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}>
                      🗺 Ver finca en mapa
                    </button>
                  )}
                </div>
                {fincas.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => setFiltroFinca('')}
                      style={{ padding: '4px 10px', borderRadius: 20, fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', background: filtroFinca === '' ? 'var(--green)' : 'var(--surface2)', color: filtroFinca === '' ? 'var(--bg)' : 'var(--muted)', border: '1px solid var(--border)', fontWeight: filtroFinca === '' ? 700 : 400 }}>
                      Todas
                    </button>
                    {fincas.map(f => (
                      <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button onClick={() => setFiltroFinca(filtroFinca === f.id ? '' : f.id)}
                          style={{ padding: '4px 10px', borderRadius: 20, fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', background: filtroFinca === f.id ? 'var(--green)' : 'var(--surface2)', color: filtroFinca === f.id ? 'var(--bg)' : 'var(--text)', border: '1px solid var(--border)', fontWeight: filtroFinca === f.id ? 700 : 400 }}>
                          {f.nombre}
                        </button>
                        {misPermisos['fincas.crear_editar'] && (
                          <button onClick={() => { setFincaEditar(f); setFNombre(f.nombre); setFDescripcion(f.descripcion); setFError(''); setFormFinca(true) }}
                            style={{ fontSize: 9, color: 'var(--muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>✏</button>
                        )}
                        {misPermisos['fincas.eliminar'] && (
                          <button onClick={() => eliminarFinca(f.id)}
                            style={{ fontSize: 9, color: '#fca5a5', background: 'transparent', border: 'none', cursor: 'pointer' }}>✕</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Filtro por campaña (persiste hasta que se desmarca) */}
              {campanas.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ marginBottom: 10 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Campañas ({campanas.length})</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => setFiltroCampana('')}
                      style={{ padding: '4px 10px', borderRadius: 20, fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', background: filtroCampana === '' ? 'var(--amber)' : 'var(--surface2)', color: filtroCampana === '' ? 'var(--bg)' : 'var(--muted)', border: '1px solid var(--border)', fontWeight: filtroCampana === '' ? 700 : 400 }}>
                      Todas
                    </button>
                    {campanas.map(c => (
                      <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button onClick={() => setFiltroCampana(filtroCampana === c.id ? '' : c.id)}
                          style={{ padding: '4px 10px', borderRadius: 20, fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', background: filtroCampana === c.id ? 'var(--amber)' : 'var(--surface2)', color: filtroCampana === c.id ? 'var(--bg)' : 'var(--text)', border: '1px solid var(--border)', fontWeight: filtroCampana === c.id ? 700 : 400 }}>
                          {c.nombre}{campanaFinalizada(c) ? ' ⚠' : ''}
                        </button>
                        <button onClick={() => { setCampanaEditar(c); setCampNombre(c.nombre); setCampFechaInicio(c.fechaInicio); setCampFechaFin(c.fechaFin); setCampError(''); setFormCampanaVisible(true) }}
                          style={{ fontSize: 9, color: 'var(--muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>✏</button>
                        <button onClick={() => eliminarCampana(c.id)}
                          style={{ fontSize: 9, color: '#fca5a5', background: 'transparent', border: 'none', cursor: 'pointer' }}>✕</button>
                      </div>
                    ))}
                  </div>
                  {filtroCampana && (
                    <div style={{ marginTop: 6, fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                      Mostrando parcelas de esta campaña + parcelas sin campaña asignada. El filtro se mantiene hasta que pulses "Todas".
                    </div>
                  )}
                </div>
              )}

              {/* Filtro por cultivo */}
              {misParcelas.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ marginBottom: 10 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Cultivos</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => setFiltroCultivoParcelas('')}
                      style={{ padding: '4px 10px', borderRadius: 20, fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', background: filtroCultivoParcelas === '' ? 'var(--blue)' : 'var(--surface2)', color: filtroCultivoParcelas === '' ? 'var(--bg)' : 'var(--muted)', border: '1px solid var(--border)', fontWeight: filtroCultivoParcelas === '' ? 700 : 400 }}>
                      Todos
                    </button>
                    {Array.from(new Set(misParcelas.map(p => p.cultivo))).sort().map(c => (
                      <button key={c} onClick={() => setFiltroCultivoParcelas(filtroCultivoParcelas === c ? '' : c)}
                        style={{ padding: '4px 10px', borderRadius: 20, fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', background: filtroCultivoParcelas === c ? 'var(--blue)' : 'var(--surface2)', color: filtroCultivoParcelas === c ? 'var(--bg)' : 'var(--text)', border: '1px solid var(--border)', fontWeight: filtroCultivoParcelas === c ? 700 : 400 }}>
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Modal crear/editar finca */}
              {formFinca && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 400, padding: 24 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)', marginBottom: 16 }}>{fincaEditar ? 'EDITAR FINCA' : 'CREAR FINCA'}</div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Nombre *</label>
                      <input type="text" value={fNombre} onChange={e => setFNombre(e.target.value)} placeholder="Nombre de la finca..."
                        style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Descripción</label>
                      <textarea value={fDescripcion} onChange={e => setFDescripcion(e.target.value)} rows={2} placeholder="Ubicación, notas..."
                        style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none', resize: 'vertical' }}/>
                    </div>
                    {fError && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)', marginBottom: 12 }}>{fError}</div>}
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={guardarFinca} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>GUARDAR</button>
                      <button onClick={() => { setFormFinca(false); setFincaEditar(null); setFNombre(''); setFDescripcion('') }} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Modal crear campaña */}
              {formCampanaVisible && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 400, padding: 24 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--amber)', marginBottom: 16 }}>{campanaEditar ? 'EDITAR CAMPAÑA' : 'NUEVA CAMPAÑA'}</div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Nombre *</label>
                      <input type="text" value={campNombre} onChange={e => setCampNombre(e.target.value)} placeholder="Ej: Cereal 2025/2026"
                        style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Fecha inicio *</label>
                        <input type="date" value={campFechaInicio} onChange={e => setCampFechaInicio(e.target.value)}
                          style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Fecha fin *</label>
                        <input type="date" value={campFechaFin} onChange={e => setCampFechaFin(e.target.value)}
                          style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      </div>
                    </div>
                    {campError && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)', marginBottom: 12 }}>{campError}</div>}
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={async () => {
                        const eraNueva = !campanaEditar
                        const guardada = await guardarCampana()
                        if (guardada && eraNueva) abrirPopupCambioCampanas(guardada.id)
                      }} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--amber)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>GUARDAR</button>
                      <button onClick={() => { setFormCampanaVisible(false); setCampanaEditar(null); setCampError('') }} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
                    </div>
                  </div>
                </div>
              )}

              {popupCampanaHistorico && parcelaEditar && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                  <div style={{ background: 'var(--surface)', border: '1px solid #ffb454', borderRadius: 12, width: '100%', maxWidth: 400, padding: 24 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: '#ffb454', marginBottom: 8 }}>GUARDAR CULTIVO ANTERIOR</div>
                    <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
                      El cultivo <strong style={{ color: 'var(--text)' }}>{parcelaEditar.cultivo}</strong> no tenía ninguna campaña asociada. Elige a cuál perteneció antes de guardarlo en el histórico.
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Campaña</label>
                      {campanas.length === 0 ? (
                        <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: '6px 0' }}>No hay campañas creadas todavía.</div>
                      ) : (
                        <select value={popupCampanaSeleccionada} onChange={e => setPopupCampanaSeleccionada(e.target.value)}
                          style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                          <option value="">Sin campaña</option>
                          {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => confirmarGuardarCultivoAnterior(popupCampanaSeleccionada)} style={{ flex: 1, padding: 11, borderRadius: 8, background: '#ffb454', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>GUARDAR</button>
                      <button onClick={() => setPopupCampanaHistorico(false)} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
                    </div>
                  </div>
                </div>
              )}

              {/* ---- (dentro del bloque 4/4 de histórico desactivado) ----*/}
              {popupCambioCampanas && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isMobile ? 10 : 20 }}>
                  <div style={{ background: 'var(--surface)', border: '1px solid #ffb454', borderRadius: 12, width: '100%', maxWidth: 900, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: isMobile ? '16px 12px 10px' : '20px 24px 12px' }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: '#ffb454', marginBottom: 6 }}>CAMBIO DE CULTIVO / CAMPAÑA</div>
                      <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)', lineHeight: 1.5 }}>
                        Actualiza el cultivo y/o asigna la campaña nueva de cada parcela. Si cambias el cultivo, el anterior se guarda automáticamente en el histórico junto a su campaña actual. Deja una parcela tal cual si no quieres tocarla.
                      </div>
                    </div>

                    <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '0 12px' : '0 24px' }}>
                      {isMobile ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {filasCambioCampana.map(fila => (
                            <div key={fila.parcelaId} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>{fila.nombre}</div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                                <div>
                                  <label style={{ display: 'block', fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 3 }}>Cultivo</label>
                                  <input value={fila.cultivoNuevo} onChange={e => actualizarFilaCambioCampana(fila.parcelaId, 'cultivoNuevo', e.target.value)}
                                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none' }} />
                                </div>
                                <div>
                                  <label style={{ display: 'block', fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 3 }}>Variedad</label>
                                  <input value={fila.variedadNueva} onChange={e => actualizarFilaCambioCampana(fila.parcelaId, 'variedadNueva', e.target.value)} placeholder="(opcional)"
                                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none' }} />
                                </div>
                              </div>
                              <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 8 }}>
                                Campaña actual: {campanas.find(c => c.id === fila.campanaActualId)?.nombre || 'Sin campaña'}
                              </div>
                              <div>
                                <label style={{ display: 'block', fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 3 }}>Campaña nueva</label>
                                <select value={fila.campanaNuevaId} onChange={e => actualizarFilaCambioCampana(fila.parcelaId, 'campanaNuevaId', e.target.value)}
                                  style={{ width: '100%', background: 'var(--surface)', border: `1px solid ${fila.campanaNuevaId ? 'var(--green)' : 'var(--border)'}`, borderRadius: 5, padding: '7px 8px', color: fila.campanaNuevaId ? 'var(--text)' : 'var(--muted)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none' }}>
                                  <option value="">— Sin cambio —</option>
                                  {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                                </select>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--mono)' }}>
                          <thead>
                            <tr style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
                              {['Parcela', 'Cultivo', 'Variedad', 'Campaña actual', 'Campaña nueva'].map(h => (
                                <th key={h} style={{ padding: '8px 6px', textAlign: 'left', color: 'var(--muted)', borderBottom: '1px solid var(--border)', textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.04em' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {filasCambioCampana.map(fila => (
                              <tr key={fila.parcelaId} style={{ borderBottom: '1px solid var(--border)' }}>
                                <td style={{ padding: '6px', color: 'var(--text)' }}>{fila.nombre}</td>
                                <td style={{ padding: '6px' }}>
                                  <input value={fila.cultivoNuevo} onChange={e => actualizarFilaCambioCampana(fila.parcelaId, 'cultivoNuevo', e.target.value)}
                                    style={{ width: '100%', minWidth: 100, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5, padding: '5px 7px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }} />
                                </td>
                                <td style={{ padding: '6px' }}>
                                  <input value={fila.variedadNueva} onChange={e => actualizarFilaCambioCampana(fila.parcelaId, 'variedadNueva', e.target.value)} placeholder="(opcional)"
                                    style={{ width: '100%', minWidth: 90, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5, padding: '5px 7px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }} />
                                </td>
                                <td style={{ padding: '6px', color: 'var(--muted)' }}>{campanas.find(c => c.id === fila.campanaActualId)?.nombre || 'Sin campaña'}</td>
                                <td style={{ padding: '6px' }}>
                                  <select value={fila.campanaNuevaId} onChange={e => actualizarFilaCambioCampana(fila.parcelaId, 'campanaNuevaId', e.target.value)}
                                    style={{ width: '100%', minWidth: 130, background: 'var(--surface2)', border: `1px solid ${fila.campanaNuevaId ? 'var(--green)' : 'var(--border)'}`, borderRadius: 5, padding: '5px 7px', color: fila.campanaNuevaId ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                                    <option value="">— Sin cambio —</option>
                                    {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                                  </select>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>

                    <div style={{ padding: isMobile ? '12px' : '16px 24px', display: 'flex', gap: 10 }}>
                      <button onClick={guardarCambiosCampana} disabled={guardandoCambioCampanas}
                        style={{ flex: 1, padding: 11, borderRadius: 8, background: '#ffb454', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: guardandoCambioCampanas ? 'default' : 'pointer', opacity: guardandoCambioCampanas ? 0.6 : 1 }}>
                        {guardandoCambioCampanas ? 'GUARDANDO...' : 'GUARDAR CAMBIOS'}
                      </button>
                      <button onClick={() => setPopupCambioCampanas(false)} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CERRAR</button>
                    </div>
                  </div>
                </div>
              )}

              {importarExcelVisible && session && (
                <ImportarParcelasExcel
                  session={session}
                  fincas={fincas}
                  setFincas={setFincas}
                  campanas={campanas}
                  setCampanas={setCampanas}
                  setMisParcelas={setMisParcelas}
                  onClose={() => setImportarExcelVisible(false)}
                />
              )}

            {/* Resumen total parcelas (respeta el filtro de finca activo) */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 20px', flex: 1 }}>
                  <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Total parcelas</div>
                  <div style={{ fontSize: 24, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--green)' }}>{misParcelasVista.length}</div>
                </div>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 20px', flex: 1 }}>
                  <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Superficie total</div>
                  <div style={{ fontSize: 24, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--blue)' }}>{misParcelasVista.reduce((a, p) => a + p.supHa, 0).toFixed(2)} ha</div>
                </div>
              </div>

              {/* Detalle parcela */}
              {parcelaDetalle && (
                <div ref={parcelaDetalleRef} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 20, overflow: 'hidden' }}>
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button onClick={() => setParcelaDetalleId(null)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16 }}>← volver</button>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>{parcelaDetalle.nombre || parcelaDetalle.cultivo}</span>
                    </div>
                    <button onClick={() => abrirFormTrat(parcelaDetalle.id)} style={{ padding: '6px 12px', borderRadius: 6, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>+ AÑADIR TRATAMIENTO</button>
                  </div>
                  <div style={{ padding: 16 }}>
                    {/* Info parcela */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px,1fr))', gap: 8, marginBottom: 16 }}>
                      {[
                        { k: 'Cultivo', v: formatCultivoVariedad(parcelaDetalle.cultivo, parcelaDetalle.variedad) },
                        { k: 'Superficie', v: `${parcelaDetalle.supHa.toFixed(4)} ha` },
                        { k: 'Plantación', v: parcelaDetalle.fechaPlantacion || '—' },
                        { k: 'Tratamientos', v: String(tratamientosDeParcela(parcelaDetalle.id).length) },
                        { k: 'Riego', v: String(riegoDeParcela.length) },
                      ].map(s => (
                        <div key={s.k} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                          <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.k}</div>
                          <div style={{ fontSize: 13, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--green)', marginTop: 2 }}>{s.v}</div>
                        </div>
                      ))}
                    </div>

                    {/* Riego: sistemas y sectores en los que está esta parcela */}
                    {riegoDeParcela.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--blue)', letterSpacing: '0.06em', marginBottom: 8, fontWeight: 700 }}>RIEGO</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {riegoDeParcela.map(({ sector, sistemaNombre }) => (
                            <button key={sector.id} onClick={() => { setRiegoSectorFocus(sector.id); setPestana('riego') }}
                              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 11, fontFamily: 'var(--mono)', cursor: 'pointer', textAlign: 'left' }}>
                              <span style={{ color: 'var(--text)' }}>💧 {sistemaNombre} — {sector.nombre}</span>
                              <span style={{ color: 'var(--blue)' }}>+ Registrar riego →</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {historicoCultivos.filter(h => h.parcelaId === parcelaDetalle.id).length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: '#ffb454', letterSpacing: '0.06em', marginBottom: 8, fontWeight: 700 }}>HISTÓRICO DE CULTIVOS</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(61,220,110,0.08)', border: '1px solid var(--green)', borderRadius: 6, padding: '8px 10px', fontSize: 11, fontFamily: 'var(--mono)' }}>
                            <span style={{ color: 'var(--green)' }}>● Actual: {formatCultivoVariedad(parcelaDetalle.cultivo, parcelaDetalle.variedad)}</span>
                            <span style={{ color: 'var(--muted)' }}>{campanas.find(c => c.id === parcelaDetalle.campanaId)?.nombre || 'Sin campaña'}</span>
                          </div>
                          {historicoCultivos
                            .filter(h => h.parcelaId === parcelaDetalle.id)
                            .sort((a, b) => (campanas.find(c => c.id === b.campanaId)?.fechaInicio || '').localeCompare(campanas.find(c => c.id === a.campanaId)?.fechaInicio || ''))
                            .map(h => (
                              historicoEditarId === h.id ? (
                                <div key={h.id} style={{ background: 'var(--surface2)', border: '1px solid #ffb454', borderRadius: 6, padding: '8px 10px' }}>
                                  <input value={historicoEditCultivo} onChange={e => setHistoricoEditCultivo(e.target.value)} placeholder="Cultivo"
                                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none', marginBottom: 6 }} />
                                  <input value={historicoEditVariedad} onChange={e => setHistoricoEditVariedad(e.target.value)} placeholder="Variedad (opcional)"
                                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none', marginBottom: 6 }} />
                                  <select value={historicoEditCampanaId} onChange={e => setHistoricoEditCampanaId(e.target.value)}
                                    style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none', marginBottom: 8 }}>
                                    <option value="">Sin campaña</option>
                                    {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                                  </select>
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <button onClick={guardarEdicionHistorico} style={{ padding: '5px 10px', borderRadius: 5, background: '#ffb454', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Guardar</button>
                                    <button onClick={() => setHistoricoEditarId(null)} style={{ padding: '5px 10px', borderRadius: 5, background: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>Cancelar</button>
                                  </div>
                                </div>
                              ) : (
                                <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 11, fontFamily: 'var(--mono)' }}>
                                  <span style={{ color: 'var(--text)' }}>{formatCultivoVariedad(h.cultivo, h.variedad)}</span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ color: 'var(--muted)' }}>{campanas.find(c => c.id === h.campanaId)?.nombre || 'Sin campaña'}</span>
                                    <button onClick={() => abrirEditarHistorico(h)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 11 }} title="Editar">✏</button>
                                    <button onClick={() => eliminarHistoricoCultivo(h.id)} style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 11 }} title="Eliminar">✕</button>
                                  </div>
                                </div>
                              )
                            ))}
                        </div>
                      </div>
                    )}

                    {/* Referencias SIGPAC (1 o varios recintos que forman la parcela) */}
                    {parcelaDetalle.parcelaInfo?.recintos?.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', letterSpacing: '0.06em', marginBottom: 8, fontWeight: 700 }}>REFERENCIA SIGPAC</div>
                        {parcelaDetalle.parcelaInfo.recintos.length === 1 ? (
                          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)' }}>
                            {formatRefSigpac(parcelaDetalle.parcelaInfo.recintos[0])}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                            {parcelaDetalle.parcelaInfo.recintos.map((r: RecintoRef, i: number) => (
                              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', fontSize: 11, fontFamily: 'var(--mono)' }}>
                                <span style={{ color: 'var(--text)' }}>{formatRefSigpac(r)}</span>
                                <span style={{ color: 'var(--muted)' }}>{r.supHa.toFixed(4)} ha</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Historial tratamientos */}
                    <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', letterSpacing: '0.06em', marginBottom: 10, fontWeight: 700 }}>HISTORIAL DE TRATAMIENTOS</div>
                    {tratamientosDeParcela(parcelaDetalle.id).length === 0
                      ? <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: '16px 0', textAlign: 'center' }}>Sin tratamientos registrados</div>
                      : tratamientosDeParcela(parcelaDetalle.id).map(t => (
                        <div key={t.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 7, padding: '10px 12px', marginBottom: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 10, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--green)' }}>{t.fecha}</span>
                                <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', background: 'rgba(77,184,255,0.1)', border: '1px solid rgba(77,184,255,0.2)', borderRadius: 4, padding: '1px 6px' }}>{t.tipo}</span>
                              </div>
                              <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600, marginBottom: 2 }}>{t.producto}</div>
                              <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                                {t.dosis} {t.unidadDosis}
                                {t.aplicador && ` . ${t.aplicador}`}
                              </div>
                              {t.observaciones && <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, fontStyle: 'italic' }}>{t.observaciones}</div>}
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 8 }}>
                              <button onClick={() => abrirFormTrat(parcelaDetalle.id, t)} style={{ padding: '4px 8px', borderRadius: 4, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>✏</button>
                              {misPermisos['tratamientos.eliminar'] && (
                                <button onClick={() => eliminarTratamiento(t.id)} style={{ padding: '4px 8px', borderRadius: 4, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>✕</button>
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    }
                  </div>

                  {/* Climatologia */}
                  <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    <button
                      onClick={() => {
                        const abrir = !climaAbierto
                        setClimaAbierto(abrir)
                        if (abrir && parcelaDetalle?.geojson) cargarClima(parcelaDetalle.geojson)
                      }}
                      style={{ width: '100%', padding: '10px 14px', background: 'var(--surface2)', border: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--text)' }}
                    >
                      <span>Estacion climatologica</span>
                      <span>{climaAbierto ? 'v' : '>'}</span>
                    </button>

                    {climaAbierto && (
                      <div style={{ padding: '12px 14px' }}>
                        {climaCargando && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                            <span className="spinner" style={{ width: 14, height: 14 }}/> Obteniendo datos...
                          </div>
                        )}
                        {climaError && <div style={{ fontSize: 11, color: '#fca5a5', fontFamily: 'var(--mono)' }}>{climaError}</div>}
                        {climaDatos && !climaCargando && (
                          <>
                            {climaDatos.estacion && (
                              <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 8, padding: '4px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>Estacion: <span style={{ color: 'var(--text)', fontWeight: 600 }}>{climaDatos.estacion}</span></span>
                                {climaDatos.fuente && (
                                  <span style={{ fontSize: 9, fontFamily: 'var(--mono)', padding: '2px 6px', borderRadius: 4, background: climaDatos.fuente === 'SIAR' ? 'rgba(61,220,110,0.1)' : 'rgba(77,184,255,0.1)', color: climaDatos.fuente === 'SIAR' ? 'var(--green)' : 'var(--blue)', border: `1px solid ${climaDatos.fuente === 'SIAR' ? 'rgba(61,220,110,0.3)' : 'rgba(77,184,255,0.3)'}` }}>
                                    {climaDatos.fuente}
                                  </span>
                                )}
                              </div>
                            )}
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <tbody>
                              {[
                                { label: 'Temperatura actual',                   val: climaDatos.temperatura_actual,          unit: 'C' },
                                { label: 'Temperatura maxima del dia',           val: climaDatos.temperatura_maxima,          unit: 'C' },
                                { label: 'Temperatura minima del dia',           val: climaDatos.temperatura_minima,          unit: 'C' },
                                { label: 'Precipitacion del dia',                val: climaDatos.precipitacion_dia,           unit: 'mm' },
                                { label: 'Precipitacion año agricola (oct-sep)', val: climaDatos.precipitacion_anyo_agricola, unit: 'mm' },
                                { label: 'ETo del dia',                         val: climaDatos.eto_dia,                     unit: 'mm/dia' },
                                { label: 'ETo año agricola (oct-sep)',           val: climaDatos.eto_anyo_agricola,           unit: 'mm' },
                              ].map((r, i) => (
                                <tr key={r.label} style={{ background: i % 2 === 0 ? 'var(--surface2)' : 'transparent' }}>
                                  <td style={{ padding: '7px 10px', fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{r.label}</td>
                                  <td style={{ padding: '7px 10px', fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    {r.val !== null && r.val !== undefined ? `${r.val} ${r.unit}` : '-'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            </table>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {misParcelasVista.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                  <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📁</div>
                  <div style={{ fontSize: 13, letterSpacing: '0.06em', marginBottom: 8 }}>SIN PARCELAS GUARDADAS</div>
                  <div style={{ fontSize: 10, lineHeight: 1.6 }}>Selecciona una parcela en el mapa<br />y pulsa "💾 GUARDAR" para añadirla aquí</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(260px, 1fr))', gap: isMobile ? 10 : 16 }}>
                  {misParcelasVista.map(p => {
                    const campanaDeP = campanas.find(c => c.id === p.campanaId)
                    const campanaTerminada = campanaFinalizada(campanaDeP)
                    return (
                    <div
                      key={p.id}
                      style={{ background: 'var(--surface)', border: campanaTerminada ? '1px solid #ff6b6b' : '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', transition: 'border-color 0.2s' }}
                      onMouseEnter={e => { if (!campanaTerminada) e.currentTarget.style.borderColor = '#2a4a30' }}
                      onMouseLeave={e => { if (!campanaTerminada) e.currentTarget.style.borderColor = 'var(--border)' }}
                      onClick={() => {
                        setParcelaDetalleId(p.id)
                        setClimaAbierto(false)
                        setClimaDatos(null)
                        setClimaError('')
                      }}
                    >
                      {/* Imagen */}
                      <div style={{ height: 140, background: 'var(--surface2)', position: 'relative', overflow: 'hidden' }}>
                        {p.imagenPreview
                          ? <img src={p.imagenPreview} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt={p.nombre || p.cultivo}/>
                          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10 }}>
                              <div style={{ textAlign: 'center' }}><div style={{ fontSize: 28, marginBottom: 4 }}>🌾</div>Sin imagen</div>
                            </div>
                        }
                        {/* Botón ver en mapa */}
                        <button
                          onClick={e => { e.stopPropagation(); verEnMapa(p) }}
                          title="Ver en el mapa"
                          style={{ position: 'absolute', top: 8, right: 8, width: 32, height: 32, borderRadius: '50%', background: 'rgba(15,26,18,0.85)', border: '1px solid var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, backdropFilter: 'blur(4px)', transition: 'background 0.2s' }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(61,220,110,0.2)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(15,26,18,0.85)')}
                        >
                          👁
                        </button>
                      </div>

                      {/* Info */}
                      <div style={{ padding: '12px 14px', position: 'relative' }}>
                        {(p.fincaId && fincas.find(f => f.id === p.fincaId)) || p.parcelaInfo?.recintos?.length === 1 ? (
                          <div style={{ position: 'absolute', top: 12, right: 14, maxWidth: '45%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                            {p.fincaId && fincas.find(f => f.id === p.fincaId) && (
                              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                                {fincas.find(f => f.id === p.fincaId)?.nombre}
                              </div>
                            )}
                            {p.parcelaInfo?.recintos?.length === 1 && (
                              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', opacity: 0.75 }}>
                                SIGPAC {formatRefSigpac(p.parcelaInfo.recintos[0])}
                              </div>
                            )}
                          </div>
                        ) : null}
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--green)', marginBottom: 4, letterSpacing: '0.04em' }}>
                          {formatCultivoVariedad(p.cultivo, p.variedad).toUpperCase()}
                        </div>
                        {p.nombre && <div style={{ fontSize: 11, color: 'var(--text)', marginBottom: 4 }}>{p.nombre}</div>}
                        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
                          {p.supHa > 0 && <div>{p.supHa.toFixed(4)} ha</div>}
                          {p.fechaPlantacion && <div>Plantación: {p.fechaPlantacion}</div>}
                          {campanaDeP && (
                            <div style={{ color: campanaTerminada ? '#ff6b6b' : 'var(--muted)' }}>
                              Campaña: {campanaDeP.nombre}{campanaTerminada ? ' · finalizada' : ''}
                            </div>
                          )}
                          <div style={{ marginTop: 4, opacity: 0.6 }}>Guardada: {p.fechaGuardado}</div>
                        </div>
                      </div>

                      {/* Footer tarjeta */}
                      <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        {misPermisos['parcelas.crear_editar'] && (
                          <button onClick={e => { e.stopPropagation(); abrirEditar(p) }} style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>✏ Editar info</button>
                        )}
                        {misPermisos['parcelas.eliminar'] && (
                          <button onClick={e => { e.stopPropagation(); eliminarParcela(p.id) }} style={{ fontSize: 9, color: '#fca5a5', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Eliminar</button>
                        )}
                      </div>
                    </div>
                  )})}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

        {/* - PESTAÑA TRATAMIENTOS - */}
        {pestana === 'tratamientos' && (
          <div style={{ flex: 1, height: '100%', overflow: 'auto', padding: isMobile ? 12 : 24, background: 'var(--bg)' }}>

            {/* Panel resumen */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: 12, marginBottom: 24 }}>
              {[
                { k: 'Total tratamientos', v: String(tratamientos.length), color: 'var(--green)' },
                { k: 'Ha tratadas', v: totalHaTratadas().toFixed(2), color: 'var(--blue)' },
                { k: 'Parcelas tratadas', v: String(Array.from(new Set(tratamientos.flatMap(t => t.parcelaIds))).length), color: 'var(--amber)' },
                { k: 'Último tratamiento', v: tratamientos.length > 0 ? [...tratamientos].sort((a,b) => b.fecha.localeCompare(a.fecha))[0].fecha : '—', color: 'var(--muted)' },
              ].map(s => (
                <div key={s.k} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px' }}>
                  <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{s.k}</div>
                  <div style={{ fontSize: 20, fontFamily: 'var(--mono)', fontWeight: 700, color: s.color }}>{s.v}</div>
                </div>
              ))}
            </div>

            {/* Cabecera + botón nuevo */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>🧪 Tratamientos</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { setCuadernoFincaIds([]); setCuadernoCampanaId(prev => prev && campanas.some(c => c.id === prev) ? prev : ((campanas.find(c => !campanaFinalizada(c)) || campanas[0])?.id || '')); setCuadernoModalVisible(true) }}
                  style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>📄 CUADERNO DE CAMPO</button>
                {misPermisos['tratamientos.crear_editar'] && (
                  <button onClick={() => abrirFormTrat()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ NUEVO TRATAMIENTO</button>
                )}
              </div>
            </div>

            {/* Navegación subpestañas */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
              {(['realizados', 'estadistica', 'stock'] as const).map(st => (
                <button
                  key={st}
                  onClick={() => setSubTabTrat(st)}
                  style={{
                    padding: '8px 16px', border: 'none', background: 'transparent',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    color: subTabTrat === st ? 'var(--green)' : 'var(--muted)',
                    borderBottom: `2px solid ${subTabTrat === st ? 'var(--green)' : 'transparent'}`,
                    letterSpacing: '0.06em', marginBottom: -1,
                  }}
                >
                  {st === 'realizados' ? '📋 REALIZADOS' : st === 'estadistica' ? '📊 ESTADÍSTICA' : '📦 STOCK'}
                </button>
              ))}
            </div>

            {/* - SUBPESTAÑA REALIZADOS - */}
            {subTabTrat === 'realizados' && (
              <>
            {/* Filtros */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              {campanas.length > 0 && (
                <select value={filtroCampanaTrat} onChange={e => setFiltroCampanaTrat(e.target.value)} style={{ background: 'var(--surface)', border: `1px solid ${filtroCampanaTrat ? 'var(--amber)' : 'var(--border)'}`, borderRadius: 6, padding: '6px 10px', color: filtroCampanaTrat ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                  <option value="">Todas las campañas</option>
                  {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}{campanaFinalizada(c) ? ' (finalizada)' : ''}</option>)}
                </select>
              )}
              {filtroCampanaTrat && (
                <button onClick={() => setFiltroCampanaTrat('')} style={{ padding: '6px 12px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(251,191,36,0.4)', color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>✕ Quitar filtro de campaña</button>
              )}
              <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: filtroTipo ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                <option value="">Todos los tipos</option>
                {TIPOS_TRATAMIENTO.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {fincas.length > 0 && (
                <select value={filtroFincaTrat} onChange={e => setFiltroFincaTrat(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: filtroFincaTrat ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                  <option value="">Todas las fincas</option>
                  {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                </select>
              )}
              <input type="text" placeholder="Filtrar por producto..." value={filtroProducto} onChange={e => setFiltroProducto(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none', minWidth: 160 }}/>
              <select value={filtroCultivoTrat} onChange={e => setFiltroCultivoTrat(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: filtroCultivoTrat ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                <option value="">Todos los cultivos</option>
                {Array.from(new Set(misParcelas.map(p => p.cultivo))).sort().map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {(filtroTipo || filtroProducto || filtroCultivoTrat) && (
                <button onClick={() => { setFiltroTipo(''); setFiltroProducto(''); setFiltroCultivoTrat('') }} style={{ padding: '6px 12px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>✕ Limpiar</button>
              )}
            </div>

            {/* Lista tratamientos */}
            {tratamientosFiltrados.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>🧪</div>
                <div style={{ fontSize: 13, letterSpacing: '0.06em' }}>SIN TRATAMIENTOS REGISTRADOS</div>
                <div style={{ fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>Pulsa "+ NUEVO TRATAMIENTO" o añade uno desde una parcela</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {tratamientosFiltrados.map(t => {
                  const parcelasAfectadas = misParcelas.filter(p => t.parcelaIds.includes(p.id))
                  const supTotal = parcelasAfectadas.reduce((a, p) => a + p.supHa, 0)
                  const expandido = tratExpandido === t.id
                  return (
                    <div key={t.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      {/* Fila principal */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }} onClick={() => setTratExpandido(expandido ? null : t.id)}>
                        <span style={{ fontSize: 16 }}>{expandido ? '▼' : '▶'}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                            <span style={{ fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)' }}>{t.fecha}</span>
                            <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', background: 'rgba(77,184,255,0.1)', border: '1px solid rgba(77,184,255,0.2)', borderRadius: 4, padding: '1px 7px' }}>{t.tipo}</span>
                          </div>
                          <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{t.producto}</div>
                          <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                            {t.fincaId && fincas.find(f => f.id === t.fincaId) && <span style={{ color: 'var(--blue)', marginRight: 4 }}>{fincas.find(f => f.id === t.fincaId)?.nombre} ·</span>}
                            {t.dosis} {t.unidadDosis} . {t.parcelaIds.length} parcela{t.parcelaIds.length !== 1 ? 's' : ''} . {supTotal.toFixed(2)} ha
                            {t.aplicador && ` . ${t.aplicador}`}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={e => { e.stopPropagation(); generarPdfTratamiento(t) }} disabled={generandoPdfId === t.id} style={{ padding: '5px 10px', borderRadius: 5, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 11, cursor: generandoPdfId === t.id ? 'default' : 'pointer', opacity: generandoPdfId === t.id ? 0.5 : 1 }} title="Descargar PDF">
                            {generandoPdfId === t.id ? '⏳' : '📄'}
                          </button>
                          <button onClick={e => { e.stopPropagation(); abrirFormTrat(undefined, t) }} style={{ padding: '5px 10px', borderRadius: 5, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>✏</button>
                          {misPermisos['tratamientos.eliminar'] && (
                            <button onClick={e => { e.stopPropagation(); eliminarTratamiento(t.id) }} style={{ padding: '5px 10px', borderRadius: 5, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>✕</button>
                          )}
                        </div>
                      </div>

                      {/* Detalle expandido */}
                      {expandido && (
                        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', background: 'var(--surface2)' }}>
                          {/* Tabla parcelas */}
                          <div style={{ marginBottom: t.observaciones ? 12 : 0 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 6, marginBottom: 6 }}>
                              {['Parcela','Sup. (ha)','% total','Dosis'].map(h => (
                                <div key={h} style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</div>
                              ))}
                            </div>
                            {parcelasAfectadas.map(p => {
                              const pct = supTotal > 0 ? ((p.supHa / supTotal) * 100).toFixed(1) : '0'
                              return (
                                <div key={p.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 6, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                                  <div style={{ fontSize: 11, color: 'var(--text)', fontWeight: 600 }}>{p.nombre || p.cultivo}</div>
                                  <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', textAlign: 'right' }}>{p.supHa.toFixed(4)}</div>
                                  <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', textAlign: 'right' }}>{pct}%</div>
                                  <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--blue)', textAlign: 'right' }}>{t.dosis} {t.unidadDosis}</div>
                                </div>
                              )
                            })}
                            {/* Total */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 6, padding: '6px 0', marginTop: 2 }}>
                              <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--muted)', fontWeight: 700 }}>TOTAL</div>
                              <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', fontWeight: 700, textAlign: 'right' }}>{supTotal.toFixed(4)}</div>
                              <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', textAlign: 'right' }}>100%</div>
                              <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--blue)', textAlign: 'right' }}>{(Number(t.dosis) * supTotal * ((t.porcentajeAplicado ? Number(t.porcentajeAplicado) : 100) / 100)).toFixed(2)} {t.unidadDosis.replace('/ha','')}</div>
                            </div>
                          </div>
                          {t.observaciones && <div style={{ fontSize: 11, color: 'var(--muted)', fontStyle: 'italic', marginTop: 8 }}>📝 {t.observaciones}</div>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
              </>
            )}

            {/* - SUBPESTAÑA ESTADÍSTICA - */}
            {subTabTrat === 'estadistica' && (
              <div>
                {/* Filtros: la campaña es obligatoria para ver los roscos (la superficie aplicada
                    y los máximos permitidos cambian de una campaña a otra); la finca es opcional */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
                  <select value={filtroCampanaEstadistica} onChange={e => setFiltroCampanaEstadistica(e.target.value)}
                    style={{ background: 'var(--surface)', border: `1px solid ${filtroCampanaEstadistica ? 'var(--green)' : 'var(--border)'}`, borderRadius: 6, padding: '7px 12px', color: filtroCampanaEstadistica ? 'var(--text)' : 'var(--muted)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none' }}>
                    <option value="">Selecciona una campaña...</option>
                    {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}{campanaFinalizada(c) ? ' (finalizada)' : ''}</option>)}
                  </select>
                  {filtroCampanaEstadistica && fincas.length > 0 && (
                    <select value={filtroFincaEstadistica} onChange={e => setFiltroFincaEstadistica(e.target.value)}
                      style={{ background: 'var(--surface)', border: `1px solid ${filtroFincaEstadistica ? 'var(--blue)' : 'var(--border)'}`, borderRadius: 6, padding: '7px 12px', color: filtroFincaEstadistica ? 'var(--text)' : 'var(--muted)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none' }}>
                      <option value="">Todas las fincas</option>
                      {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                    </select>
                  )}
                  {(filtroCampanaEstadistica || filtroFincaEstadistica) && (
                    <button onClick={() => { setFiltroCampanaEstadistica(''); setFiltroFincaEstadistica('') }}
                      style={{ padding: '7px 12px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>✕ Quitar filtros</button>
                  )}
                </div>

                {!filtroCampanaEstadistica ? (
                  <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                    <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📊</div>
                    <div style={{ fontSize: 13, letterSpacing: '0.06em' }}>ELIGE UNA CAMPAÑA</div>
                    <div style={{ fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>La superficie aplicada y los máximos permitidos son distintos en cada campaña — selecciona una arriba para ver las estadísticas</div>
                  </div>
                ) : Object.keys(estadisticasPorCultivo()).length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                    <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📊</div>
                    <div style={{ fontSize: 13, letterSpacing: '0.06em' }}>SIN DATOS ESTADÍSTICOS</div>
                    <div style={{ fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>No hay tratamientos registrados para esta campaña{filtroFincaEstadistica ? ' y finca' : ''}</div>
                  </div>
                ) : (
                  Object.entries(estadisticasPorCultivo()).map(([cultivo, productos]) => (
                    <div key={cultivo} style={{ marginBottom: 28 }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)', letterSpacing: '0.06em', marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>
                        🌾 {cultivo.toUpperCase()}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(auto-fill, minmax(220px,1fr))', gap: isMobile ? 10 : 16 }}>
                        {productos.map(p => {
                          const key = `${cultivo}-${p.producto}`
                          const expandido = statExpandido === key
                          const tieneMax = p.aplicMaxima !== null && p.aplicMaxima > 0
                          const tieneDosisMax = p.dosisMaximaRaw !== null && p.dosisMaximaRaw > 0 && p.unidadDosisMaxima !== null
                          const densidad = p.densidad

                          // Unidad en la que se muestra todo: la de la dosis máxima si existe, si no la unidad canónica
                          const unidadMostrada: UnidadDosis | 'L/ha' | 'Kg/ha' = tieneDosisMax
                            ? (p.unidadDosisMaxima as UnidadDosis)
                            : (p.faseCanon === 'volumen' ? 'L/ha' : 'Kg/ha')

                          const dosisPonderadaConvertida = tieneDosisMax
                            ? canonicoAUnidadPorHa(p.dosisPonderadaCanon, p.faseCanon, p.unidadDosisMaxima as UnidadDosis, densidad)
                            : p.dosisPonderadaCanon
                          const dosisMaximaValor = p.dosisMaximaRaw
                          // Si la unidad de dosis máxima no es convertible como destino (p.ej. %/hL, /kg semilla), no comparamos
                          const noComparable = tieneDosisMax && dosisPonderadaConvertida === null

                          const dosisPonderadaMostrar = dosisPonderadaConvertida !== null ? dosisPonderadaConvertida : p.dosisPonderadaCanon

                          // Datos para el donut: dosis ponderada aplicada vs dosis máxima permitida
                          const usado = (tieneDosisMax && !noComparable) ? Math.min(dosisPonderadaMostrar, dosisMaximaValor as number) : 0
                          const restante = (tieneDosisMax && !noComparable) ? Math.max((dosisMaximaValor as number) - dosisPonderadaMostrar, 0) : 0
                          const excedido = tieneDosisMax && !noComparable && dosisPonderadaMostrar > (dosisMaximaValor as number)

                          const pieData = (tieneDosisMax && !noComparable)
                            ? [
                                { name: 'Usado', value: usado },
                                { name: 'Restante', value: restante },
                              ]
                            : []

                          return (
                            <div key={key} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                              <div
                                onClick={() => setStatExpandido(expandido ? null : key)}
                                style={{ padding: '14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
                              >
                                <div style={{ fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--text)', textAlign: 'center', marginBottom: 8, minHeight: 28, display: 'flex', alignItems: 'center' }}>
                                  {p.producto}
                                  {p.sinConvertir && <span title="Alguna aplicación no se pudo convertir del todo (faltan litros de caldo/ha o kg semilla/ha)" style={{ marginLeft: 4 }}>⚠️</span>}
                                </div>

                                {tieneDosisMax && !noComparable ? (
                                  <div style={{ position: 'relative', width: 130, height: 130 }}>
                                    <DonutChart
                                      slices={[
                                        { value: pieData[0]?.value || 0, color: excedido ? '#ff6b6b' : '#3ddc6e' },
                                        { value: pieData[1]?.value || 0, color: '#2a3a30' },
                                      ]}
                                      innerRadius={42}
                                      outerRadius={60}
                                    />
                                    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                                      <div style={{ fontSize: 16, fontFamily: 'var(--mono)', fontWeight: 700, color: excedido ? '#ff6b6b' : 'var(--text)' }}>
                                        {dosisPonderadaMostrar.toFixed(2)}/{(dosisMaximaValor as number).toFixed(2)}
                                      </div>
                                      <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--muted)', letterSpacing: '0.06em' }}>{unidadMostrada}</div>
                                    </div>
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 130 }}>
                                    <div style={{ fontSize: 22, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--green)' }}>
                                      {dosisPonderadaMostrar.toFixed(2)}
                                    </div>
                                    <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--green)', fontWeight: 700, marginTop: 2 }}>
                                      {unidadMostrada}
                                    </div>
                                    <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 6, letterSpacing: '0.06em' }}>
                                      {noComparable ? 'UNIDAD DE MÁXIMO NO COMPARABLE' : 'DOSIS MEDIA PONDERADA'}
                                    </div>
                                  </div>
                                )}

                                {tieneMax && (
                                  <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 8, textAlign: 'center' }}>
                                    Aplicaciones: <span style={{ color: p.numAplicaciones > (p.aplicMaxima as number) ? '#ff6b6b' : 'var(--text)', fontWeight: 700 }}>{p.numAplicaciones}</span> / {Number.isInteger(p.aplicMaxima) ? p.aplicMaxima : (p.aplicMaxima as number).toFixed(1)}
                                  </div>
                                )}

                                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 6 }}>
                                  {expandido ? '▲ Ocultar detalle' : '▼ Ver detalle por parcela'}
                                </div>
                              </div>

                              {expandido && (
                                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px', background: 'var(--surface2)' }}>
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 6, marginBottom: 4 }}>
                                    {['Parcela','Dosis','Sup.','Total'].map(h => (
                                      <div key={h} style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</div>
                                    ))}
                                  </div>
                                  {p.detalleParcelas.map((d, i) => {
                                    const dosisConv = canonicoAUnidadPorHa(d.dosisCanon, p.faseCanon, unidadMostrada as UnidadDosis, densidad)
                                    return (
                                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 6, padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: 10 }}>
                                        <div style={{ color: 'var(--text)' }}>{d.nombre}</div>
                                        <div style={{ fontFamily: 'var(--mono)', color: 'var(--text)', textAlign: 'right' }}>{dosisConv !== null ? dosisConv.toFixed(2) : d.dosisCanon.toFixed(2)}</div>
                                        <div style={{ fontFamily: 'var(--mono)', color: 'var(--muted)', textAlign: 'right' }}>{d.supHa.toFixed(2)}{d.porcentajeAplicado < 100 ? ` (${d.porcentajeAplicado}%)` : ''}ha</div>
                                        <div style={{ fontFamily: 'var(--mono)', color: 'var(--blue)', textAlign: 'right' }}>{d.totalConsumidoCanon.toFixed(2)} {p.faseCanon === 'volumen' ? 'L' : 'Kg'}</div>
                                      </div>
                                    )
                                  })}
                                  {tieneDosisMax && !noComparable && (
                                    <div style={{ marginTop: 6, fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                                      Restante hasta máx: <span style={{ color: dosisPonderadaMostrar > (dosisMaximaValor as number) ? '#ff6b6b' : 'var(--green)', fontWeight: 700 }}>
                                        {Math.max((dosisMaximaValor as number) - dosisPonderadaMostrar, 0).toFixed(2)} {unidadMostrada}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* - SUBPESTAÑA STOCK - */}
            {subTabTrat === 'stock' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                  {misPermisos['tratamientos.crear_editar'] && (
                    <button onClick={() => setFormStock(true)} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ AÑADIR PRODUCTO</button>
                  )}
                </div>

                {stock.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                    <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📦</div>
                    <div style={{ fontSize: 13, letterSpacing: '0.06em' }}>SIN PRODUCTOS EN STOCK</div>
                    <div style={{ fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>Pulsa "+ AÑADIR PRODUCTO" para empezar a controlar tu inventario</div>
                  </div>
                ) : (
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    {/* Cabecera tabla */}
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 8, padding: '10px 16px', background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                      {['Producto','Comprado','Usado','Existencias',''].map(h => (
                        <div key={h} style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: h === 'Producto' || h === '' ? 'left' : 'right' }}>{h}</div>
                      ))}
                    </div>
                    {stock.map(s => {
                      const comprado = Number(s.comprado) || 0
                      const usado = calcularUsoProducto(s.producto)
                      const existencias = comprado - usado
                      return (
                        <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
                          <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{s.producto}</div>
                          <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', textAlign: 'right' }}>{comprado.toFixed(2)} {s.unidad}</div>
                          <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--blue)', textAlign: 'right' }}>{usado.toFixed(2)} {s.unidad}</div>
                          <div style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 700, textAlign: 'right', color: existencias < 0 ? '#ff6b6b' : 'var(--green)' }}>
                            {existencias.toFixed(2)} {s.unidad}
                          </div>
                          {misPermisos['tratamientos.crear_editar'] && (
                            <button onClick={() => eliminarStockItem(s.id)} style={{ padding: '4px 8px', borderRadius: 4, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer', justifySelf: 'end' }}>✕</button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Modal añadir stock */}
                {formStock && (
                  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 380, overflow: 'auto' }}>
                      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>📦 AÑADIR PRODUCTO A STOCK</span>
                        <button onClick={() => setFormStock(false)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
                      </div>
                      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {/* Buscador MAPA para stock */}
                        <div style={{ position: 'relative' }}>
                          <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Buscar en Registro MAPA</label>
                          <input
                            type="text"
                            value={fitoBusqueda}
                            onChange={e => {
                              const q = e.target.value
                              setFitoBusqueda(q)
                              if (q.length >= 2) {
                                fetch(`${BACKEND}/fito/buscar?q=${encodeURIComponent(q)}`)
                                  .then(r => r.json())
                                  .then(data => setFitoResultados(data.productos || []))
                                  .catch(() => setFitoResultados([]))
                              } else { setFitoResultados([]) }
                            }}
                            placeholder="Buscar en registro MAPA..."
                            style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}
                          />
                          {fitoResultados.length > 0 && (
                            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 3000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', maxHeight: 200, overflowY: 'auto', marginTop: 2 }}>
                              {fitoResultados.map(p => (
                                <div
                                  key={p.id}
                                  onClick={() => { setStockProducto(p.nombre); setFitoBusqueda(p.nombre); setFitoResultados([]) }}
                                  style={{ padding: '8px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', borderLeft: p.eliminado ? '3px solid #ff6b6b' : '3px solid transparent' }}
                                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: p.eliminado ? '#fca5a5' : 'var(--text)' }}>{p.nombre}</span>
                                    {p.eliminado && <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: '#fca5a5', background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)', borderRadius: 3, padding: '1px 4px' }}>NO AUTORIZADO</span>}
                                  </div>
                                  <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{p.num_registro} . {p.formulado?.substring(0, 40)}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Nombre del producto</label>
                          <input type="text" value={stockProducto} onChange={e => setStockProducto(e.target.value)} placeholder="Debe coincidir con el nombre usado en tratamientos" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                          <div>
                            <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Cantidad comprada</label>
                            <input type="number" min="0" step="0.01" value={stockCantidad} onChange={e => setStockCantidad(e.target.value)} placeholder="0.00" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Unidad</label>
                            <select value={stockUnidad} onChange={e => setStockUnidad(e.target.value as 'L' | 'Kg')} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                              <option value="L">L</option>
                              <option value="Kg">Kg</option>
                            </select>
                          </div>
                        </div>
                      </div>
                      <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
                        <button onClick={guardarStockItem} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>💾 GUARDAR</button>
                        <button onClick={() => setFormStock(false)} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        )}



        {/* PESTANA PERSONAL */}
        {pestana === 'personal' && (
          <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: isMobile ? 12 : 24, background: 'var(--bg)' }}>

            {/* Cabecera */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Personal</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                  {personal.filter(p => p.activo).length} activo{personal.filter(p => p.activo).length !== 1 ? 's' : ''} / {personal.filter(p => !p.activo).length} inactivo{personal.filter(p => !p.activo).length !== 1 ? 's' : ''}
                </div>
              </div>
              {misPermisos['personal.crear_editar'] && (
                <button onClick={() => abrirFormPersonal()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ AÑADIR PERSONAL</button>
              )}
            </div>

            {/* Filtros */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <select value={filtroFuncion} onChange={e => setFiltroFuncion(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: filtroFuncion ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                <option value="">Todas las funciones</option>
                {FUNCIONES_PERSONAL.map(f => <option key={f} value={f}>{ICONO_FUNCION[f]} {f}</option>)}
              </select>
              <select value={filtroContrato} onChange={e => setFiltroContrato(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: filtroContrato ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                <option value="">Todos los contratos</option>
                {TIPOS_CONTRATO.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {fincas.length > 0 && (
                <select value={filtroFincaPersonal} onChange={e => setFiltroFincaPersonal(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: filtroFincaPersonal ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                  <option value="">Todas las fincas</option>
                  {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                </select>
              )}
              {(filtroFuncion || filtroContrato || filtroFincaPersonal) && (
                <button onClick={() => { setFiltroFuncion(''); setFiltroContrato(''); setFiltroFincaPersonal('') }} style={{ padding: '6px 12px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Limpiar</button>
              )}
            </div>

            {/* Ficha detalle */}
            {personalDetalle && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 20, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={() => setPersonalDetalleId(null)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, fontFamily: 'var(--mono)' }}>Volver</button>
                    <span style={{ fontSize: 20 }}>{ICONO_FUNCION[personalDetalle.funciones[0]] || '👤'}</span>
                    <div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{personalDetalle.nombre}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{personalDetalle.funciones.join(' / ')} · {personalDetalle.tipoContrato}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {misPermisos['personal.descargar_excel'] && (
                      <>
                        <select value={excelAnioPersonal} onChange={e => setExcelAnioPersonal(Number(e.target.value))}
                          style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none' }}>
                          {[excelAnioPersonal + 1, excelAnioPersonal, excelAnioPersonal - 1, excelAnioPersonal - 2].sort((a, b) => b - a).filter((v, i, arr) => arr.indexOf(v) === i).map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                        <button onClick={() => descargarExcelPersonal(personalDetalle, excelAnioPersonal)}
                          style={{ padding: '6px 12px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>📊 Descargar Excel</button>
                      </>
                    )}
                    {misPermisos['personal.crear_editar'] && (
                      <button onClick={() => abrirFormPersonal(personalDetalle)} style={{ padding: '6px 12px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Editar</button>
                    )}
                  </div>
                </div>
                <div style={{ padding: 16 }}>
                  {/* Datos */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 8, marginBottom: 16 }}>
                    {[
                      { k: 'DNI/CIF', v: personalDetalle.dni || '-' },
                      { k: 'Contacto', v: personalDetalle.telefono || '-' },
                      { k: 'Nro ROPO', v: personalDetalle.nroRopo || '-' },
                      { k: 'Nivel de capacitación', v: personalDetalle.nivelCapacitacion || '-' },
                      { k: 'Contrato', v: personalDetalle.tipoContrato },
                      { k: 'Finca', v: (personalDetalle.fincaId && fincas.find(f => f.id === personalDetalle.fincaId)?.nombre) || 'Sin asignar' },
                      ...(esRecomendador(personalDetalle) ? [{ k: 'Trat. recomendados', v: String(tratamientosDePersonal(personalDetalle.id, 'recomendado').length) }] : []),
                      ...(esAplicador(personalDetalle) ? [{ k: 'Trat. aplicados', v: String(tratamientosDePersonal(personalDetalle.id, 'aplicado').length) }] : []),
                    ].map(s => (
                      <div key={s.k} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                        <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.k}</div>
                        <div style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>{s.v}</div>
                      </div>
                    ))}
                  </div>

                  {/* Predeterminado */}
                  <div style={{ padding: '10px 12px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 7, marginBottom: 16 }}>
                    <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Predeterminado</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {esRecomendador(personalDetalle) && (
                        <button
                          onClick={() => setPredeterminado(personalDetalle.id, 'recomendador', !personalDetalle.predeterminadoRecomendador)}
                          style={{ padding: '6px 12px', borderRadius: 6, background: personalDetalle.predeterminadoRecomendador ? 'rgba(77,184,255,0.15)' : 'var(--surface)', border: `1px solid ${personalDetalle.predeterminadoRecomendador ? 'var(--blue)' : 'var(--border)'}`, color: personalDetalle.predeterminadoRecomendador ? 'var(--blue)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: personalDetalle.predeterminadoRecomendador ? 700 : 400 }}
                        >
                          {personalDetalle.predeterminadoRecomendador ? '⭐ ' : ''}Recomendador predeterminado
                        </button>
                      )}
                      {esAplicador(personalDetalle) && (
                        <button
                          onClick={() => setPredeterminado(personalDetalle.id, 'aplicador', !personalDetalle.predeterminadoAplicador)}
                          style={{ padding: '6px 12px', borderRadius: 6, background: personalDetalle.predeterminadoAplicador ? 'rgba(61,220,110,0.12)' : 'var(--surface)', border: `1px solid ${personalDetalle.predeterminadoAplicador ? 'var(--green)' : 'var(--border)'}`, color: personalDetalle.predeterminadoAplicador ? 'var(--green)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', fontWeight: personalDetalle.predeterminadoAplicador ? 700 : 400 }}
                        >
                          {personalDetalle.predeterminadoAplicador ? '⭐ ' : ''}Aplicador predeterminado
                        </button>
                      )}
                    </div>
                  </div>

                  {personalDetalle.direccion && <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 12 }}>Direccion: {personalDetalle.direccion}</div>}

                  {/* Historial recomendados - solo si es recomendador */}
                  {esRecomendador(personalDetalle) && tratamientosDePersonal(personalDetalle.id, 'recomendado').length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--blue)', fontWeight: 700, marginBottom: 8 }}>TRATAMIENTOS RECOMENDADOS ({tratamientosDePersonal(personalDetalle.id, 'recomendado').length})</div>
                      {tratamientosDePersonal(personalDetalle.id, 'recomendado').map(t => {
                        const parcelas = misParcelas.filter(p => t.parcelaIds.includes(p.id))
                        return (
                          <div key={t.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', marginBottom: 6 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 700 }}>{t.fecha}</span>
                              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', background: 'rgba(77,184,255,0.1)', border: '1px solid rgba(77,184,255,0.2)', borderRadius: 4, padding: '1px 6px' }}>{t.tipo}</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{t.producto}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{parcelas.map(p => p.nombre || p.cultivo).join(', ')}</div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Historial aplicados - solo si es aplicador */}
                  {esAplicador(personalDetalle) && tratamientosDePersonal(personalDetalle.id, 'aplicado').length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', fontWeight: 700, marginBottom: 8 }}>TRATAMIENTOS APLICADOS ({tratamientosDePersonal(personalDetalle.id, 'aplicado').length})</div>
                      {tratamientosDePersonal(personalDetalle.id, 'aplicado').map(t => {
                        const parcelas = misParcelas.filter(p => t.parcelaIds.includes(p.id))
                        return (
                          <div key={t.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', marginBottom: 6 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 700 }}>{t.fecha}</span>
                              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--green)', background: 'rgba(61,220,110,0.08)', border: '1px solid rgba(61,220,110,0.2)', borderRadius: 4, padding: '1px 6px' }}>{t.tipo}</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{t.producto} · {t.dosis} {t.unidadDosis}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{parcelas.map(p => p.nombre || p.cultivo).join(', ')}</div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Lista de personal */}
            {personal.filter(p =>
              (!filtroFuncion || p.funciones.includes(filtroFuncion)) &&
              (!filtroContrato || p.tipoContrato === filtroContrato) &&
              (!filtroFincaPersonal || p.fincaId === filtroFincaPersonal)
            ).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>👷</div>
                <div style={{ fontSize: 13, letterSpacing: '0.06em' }}>SIN PERSONAL REGISTRADO</div>
                <div style={{ fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>Pulsa "+ AÑADIR PERSONAL" para registrar trabajadores y tecnicos</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px,1fr))', gap: isMobile ? 10 : 14 }}>
                {personal
                  .filter(p => (!filtroFuncion || p.funciones.includes(filtroFuncion)) && (!filtroContrato || p.tipoContrato === filtroContrato) && (!filtroFincaPersonal || p.fincaId === filtroFincaPersonal))
                  .map(p => {
                    const nRec = esRecomendador(p) ? tratamientosDePersonal(p.id, 'recomendado').length : null
                    const nApl = esAplicador(p) ? tratamientosDePersonal(p.id, 'aplicado').length : null
                    const ultimoTrat = [
                      ...(esRecomendador(p) ? tratamientosDePersonal(p.id, 'recomendado') : []),
                      ...(esAplicador(p) ? tratamientosDePersonal(p.id, 'aplicado') : []),
                    ].sort((a, b) => b.fecha.localeCompare(a.fecha))[0]
                    return (
                      <div
                        key={p.id}
                        onClick={() => setPersonalDetalleId(p.id)}
                        style={{ background: 'var(--surface)', border: `1px solid ${p.activo ? 'var(--border)' : 'rgba(255,107,107,0.2)'}`, borderRadius: 10, padding: 16, cursor: 'pointer', opacity: p.activo ? 1 : 0.6, transition: 'border-color 0.2s' }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--green)')}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = p.activo ? 'var(--border)' : 'rgba(255,107,107,0.2)')}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                          <div style={{ fontSize: 28, lineHeight: 1 }}>{ICONO_FUNCION[p.funciones[0]] || '👤'}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.nombre}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.4 }}>{p.funciones.join(' / ')}</div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
                            {p.predeterminadoRecomendador && <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--blue)', background: 'rgba(77,184,255,0.1)', borderRadius: 3, padding: '1px 4px' }}>⭐ REC</span>}
                            {p.predeterminadoAplicador && <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--green)', background: 'rgba(61,220,110,0.08)', borderRadius: 3, padding: '1px 4px' }}>⭐ APL</span>}
                            {!p.activo && <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: '#fca5a5', background: 'rgba(255,107,107,0.08)', borderRadius: 3, padding: '1px 4px' }}>INAC.</span>}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--blue)', background: 'rgba(77,184,255,0.08)', border: '1px solid rgba(77,184,255,0.15)', borderRadius: 4, padding: '2px 7px' }}>{p.tipoContrato}</span>
                          {p.nroRopo && <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--green)', background: 'rgba(61,220,110,0.06)', border: '1px solid rgba(61,220,110,0.15)', borderRadius: 4, padding: '2px 7px' }}>ROPO: {p.nroRopo}</span>}
                          {p.fincaId && fincas.find(f => f.id === p.fincaId) && (
                            <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px' }}>🏡 {fincas.find(f => f.id === p.fincaId)?.nombre}</span>
                          )}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: nRec !== null && nApl !== null ? '1fr 1fr' : '1fr', gap: 6, marginBottom: 10 }}>
                          {nRec !== null && (
                            <div style={{ background: 'var(--surface2)', borderRadius: 5, padding: '5px 8px', textAlign: 'center' }}>
                              <div style={{ fontSize: 16, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--blue)' }}>{nRec}</div>
                              <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>RECOMENDADOS</div>
                            </div>
                          )}
                          {nApl !== null && (
                            <div style={{ background: 'var(--surface2)', borderRadius: 5, padding: '5px 8px', textAlign: 'center' }}>
                              <div style={{ fontSize: 16, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--green)' }}>{nApl}</div>
                              <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>APLICADOS</div>
                            </div>
                          )}
                        </div>
                        {ultimoTrat && <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Ultima actividad: {ultimoTrat.fecha}</div>}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                          {misPermisos['personal.crear_editar'] && (
                            <button onClick={e => { e.stopPropagation(); desactivarPersonal(p.id) }} style={{ fontSize: 9, color: '#fca5a5', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                              {p.activo ? 'Desactivar' : 'Eliminar'}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })
                }
              </div>
            )}

            {/* Modal formulario personal */}
            {formPersonal && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 480, maxHeight: '90vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>{personalEditar ? 'EDITAR PERSONAL' : 'AÑADIR PERSONAL'}</span>
                    <button onClick={() => setFormPersonal(false)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18 }}>X</button>
                  </div>
                  <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {[
                      { label: 'Nombre y apellidos *', val: pNombre, set: setPNombre, ph: 'Nombre completo' },
                    ].map(f => (
                      <div key={f.label}>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{f.label}</label>
                        <input type="text" value={f.val} onChange={e => f.set(e.target.value)} placeholder={f.ph} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      </div>
                    ))}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>DNI / CIF / Pasaporte</label>
                        <button type="button" onClick={() => { setVerifRegistro('ropo'); setVerifNif(pDni); setVerifResultado(null); setVerifError(''); setShowVerifRomaRopo(true) }} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                          🔍 ROPO
                        </button>
                      </div>
                      <input type="text" value={pDni} onChange={e => setPDni(e.target.value)} placeholder="12345678A" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                    </div>
                    {[
                      { label: 'Contacto', val: pTelefono, set: setPTelefono, ph: 'Telefono, email...' },
                      { label: 'Direccion', val: pDireccion, set: setPDireccion, ph: 'Calle, localidad...' },
                      { label: 'Nro ROPO', val: pRopo, set: setPRopo, ph: 'Numero registro oficial' },
                      { label: 'Nivel de capacitación', val: pNivelCapacitacion, set: setPNivelCapacitacion, ph: 'Nivel cualificado (caducidad)' },
                    ].map(f => (
                      <div key={f.label}>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{f.label}</label>
                        <input type="text" value={f.val} onChange={e => f.set(e.target.value)} placeholder={f.ph} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      </div>
                    ))}
                    {/* Funciones - seleccion multiple */}
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Funciones * (puede seleccionar varias)</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {FUNCIONES_PERSONAL.map(f => (
                          <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '7px 10px', borderRadius: 6, background: pFunciones.includes(f) ? 'var(--green-dim)' : 'var(--surface2)', border: `1px solid ${pFunciones.includes(f) ? 'rgba(61,220,110,0.3)' : 'var(--border)'}`, transition: 'all 0.15s' }}>
                            <input
                              type="checkbox"
                              checked={pFunciones.includes(f)}
                              onChange={e => setPFunciones(prev => e.target.checked ? [...prev, f] : prev.filter(x => x !== f))}
                              style={{ accentColor: 'var(--green)' }}
                            />
                            <span style={{ fontSize: 16 }}>{ICONO_FUNCION[f]}</span>
                            <span style={{ fontSize: 12, color: 'var(--text)' }}>{f}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    {/* Tipo contrato */}
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Tipo de contrato *</label>
                      <select value={pContrato} onChange={e => setPContrato(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: `1px solid ${!pContrato && pError ? '#ff6b6b' : 'var(--border)'}`, borderRadius: 6, padding: '9px 12px', color: pContrato ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                        <option value="" disabled>Selecciona tipo...</option>
                        {TIPOS_CONTRATO.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    {/* Fincas */}
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Fincas</label>
                      {fincas.length === 0 ? (
                        <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: '6px 0' }}>No hay fincas creadas.</div>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {fincas.map(f => {
                            const sel = pFincaIds.includes(f.id)
                            return (
                              <button key={f.id} type="button"
                                onClick={() => setPFincaIds(sel ? pFincaIds.filter(id => id !== f.id) : [...pFincaIds, f.id])}
                                style={{ padding: '6px 12px', borderRadius: 14, background: sel ? 'rgba(77,184,255,0.15)' : 'var(--surface2)', border: `1px solid ${sel ? 'var(--blue)' : 'var(--border)'}`, color: sel ? 'var(--blue)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>
                                {f.nombre}
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                    {pError && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)' }}>{pError}</div>}
                  </div>
                  <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
                    <button onClick={guardarPersonal} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>GUARDAR</button>
                    <button onClick={() => setFormPersonal(false)} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

{/* - Pestaña EQUIPOS - */}
        {pestana === 'equipos' && (
          <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: isMobile ? 12 : 24, background: 'var(--bg)' }}>

            {/* Cabecera */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Equipos</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                  {equipos.length} equipo{equipos.length !== 1 ? 's' : ''} registrado{equipos.length !== 1 ? 's' : ''}
                </div>
              </div>
              {misPermisos['maquinaria.crear_editar'] && (
                <button onClick={() => abrirFormEquipo()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ AÑADIR EQUIPO</button>
              )}
            </div>

            {/* Filtros */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <select value={filtroTipoEquipo} onChange={e => setFiltroTipoEquipo(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: filtroTipoEquipo ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                <option value="">Todos los tipos</option>
                {TIPOS_MAQUINARIA.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {fincas.length > 0 && (
                <select value={filtroFincaEquipo} onChange={e => setFiltroFincaEquipo(e.target.value)} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: filtroFincaEquipo ? 'var(--text)' : 'var(--muted)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }}>
                  <option value="">Todas las fincas</option>
                  {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                </select>
              )}
              {(filtroTipoEquipo || filtroFincaEquipo) && (
                <button onClick={() => { setFiltroTipoEquipo(''); setFiltroFincaEquipo('') }} style={{ padding: '6px 12px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Limpiar</button>
              )}
            </div>

            {/* Ficha detalle */}
            {equipoDetalle && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 20, overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button onClick={() => setEquipoDetalleId(null)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, fontFamily: 'var(--mono)' }}>Volver</button>
                    <span style={{ fontSize: 20 }}>🚜</span>
                    <div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{equipoDetalle.nombre}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{equipoDetalle.tipo}{equipoDetalle.subtipo ? ` · ${equipoDetalle.subtipo}` : ''}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {misPermisos['maquinaria.crear_editar'] && (
                      <button onClick={() => abrirFormEquipo(equipoDetalle)} style={{ padding: '6px 12px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Editar</button>
                    )}
                    {misPermisos['maquinaria.eliminar'] && (
                      <button onClick={() => eliminarEquipo(equipoDetalle.id)} style={{ padding: '6px 12px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Eliminar</button>
                    )}
                  </div>
                </div>
                <div style={{ padding: 16 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 8, marginBottom: 16 }}>
                    {[
                      { k: 'Tipo', v: equipoDetalle.tipo },
                      ...(equipoDetalle.subtipo ? [{ k: 'Subtipo', v: equipoDetalle.subtipo }] : []),
                      { k: 'DNI/CIF', v: equipoDetalle.dniCif || '-' },
                      { k: 'Nro ROMA', v: equipoDetalle.nroRoma || '-' },
                      { k: 'Titularidad', v: equipoDetalle.titularidad || '-' },
                      ...(equipoDetalle.titularidad === 'Propia' ? [{ k: 'Finca', v: (equipoDetalle.fincaId && fincas.find(f => f.id === equipoDetalle.fincaId)?.nombre) || 'Sin asignar' }] : []),
                      { k: 'Tratamientos', v: String(tratamientosDeEquipo(equipoDetalle.id).length) },
                    ].map(s => (
                      <div key={s.k} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                        <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.k}</div>
                        <div style={{ fontSize: 12, fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>{s.v}</div>
                      </div>
                    ))}
                  </div>

                  {equipoDetalle.observaciones && <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 12 }}>Observaciones: {equipoDetalle.observaciones}</div>}

                  {/* Historial de tratamientos */}
                  {tratamientosDeEquipo(equipoDetalle.id).length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--green)', fontWeight: 700, marginBottom: 8 }}>HISTORIAL DE TRATAMIENTOS ({tratamientosDeEquipo(equipoDetalle.id).length})</div>
                      {tratamientosDeEquipo(equipoDetalle.id).map(t => {
                        const parcelas = misParcelas.filter(p => t.parcelaIds.includes(p.id))
                        const operario = personal.find(p => p.id === t.aplicadoPor || p.id === t.recomendadoPor)
                        return (
                          <div key={t.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', marginBottom: 6 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
                              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text)', fontWeight: 700 }}>{t.fecha}</span>
                              <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--green)', background: 'rgba(61,220,110,0.08)', border: '1px solid rgba(61,220,110,0.2)', borderRadius: 4, padding: '1px 6px' }}>{t.tipo}</span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{t.producto}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{parcelas.map(p => p.nombre || p.cultivo).join(', ')}{operario ? ` · ${operario.nombre}` : ''}</div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Lista de equipos */}
            {equipos.filter(e => (!filtroTipoEquipo || e.tipo === filtroTipoEquipo) && (!filtroFincaEquipo || e.fincaId === filtroFincaEquipo)).length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>🚜</div>
                <div style={{ fontSize: 13, letterSpacing: '0.06em' }}>SIN EQUIPOS REGISTRADOS</div>
                <div style={{ fontSize: 10, marginTop: 8, lineHeight: 1.6 }}>Pulsa "+ AÑADIR EQUIPO" para registrar maquinaria propia o externa</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(240px,1fr))', gap: isMobile ? 10 : 14 }}>
                {equipos
                  .filter(e => (!filtroTipoEquipo || e.tipo === filtroTipoEquipo) && (!filtroFincaEquipo || e.fincaId === filtroFincaEquipo))
                  .map(e => {
                    const nTrat = tratamientosDeEquipo(e.id).length
                    return (
                      <div
                        key={e.id}
                        onClick={() => setEquipoDetalleId(e.id)}
                        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, cursor: 'pointer', transition: 'border-color 0.2s' }}
                        onMouseEnter={ev => (ev.currentTarget.style.borderColor = 'var(--green)')}
                        onMouseLeave={ev => (ev.currentTarget.style.borderColor = 'var(--border)')}
                      >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                          <div style={{ fontSize: 28, lineHeight: 1 }}>🚜</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.nombre}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.4 }}>{e.tipo}{e.subtipo ? ` · ${e.subtipo}` : ''}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                          {e.titularidad && <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--blue)', background: 'rgba(77,184,255,0.08)', border: '1px solid rgba(77,184,255,0.15)', borderRadius: 4, padding: '2px 7px' }}>{e.titularidad}</span>}
                          {e.titularidad === 'Propia' && e.fincaId && fincas.find(f => f.id === e.fincaId) && (
                            <span style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px' }}>🏡 {fincas.find(f => f.id === e.fincaId)?.nombre}</span>
                          )}
                        </div>
                        {nTrat > 0 && (
                          <div style={{ background: 'var(--surface2)', borderRadius: 5, padding: '5px 8px', textAlign: 'center', marginBottom: 8 }}>
                            <div style={{ fontSize: 16, fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--green)' }}>{nTrat}</div>
                            <div style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>TRATAMIENTOS</div>
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          {misPermisos['maquinaria.eliminar'] && (
                            <button onClick={ev => { ev.stopPropagation(); eliminarEquipo(e.id) }} style={{ fontSize: 9, color: '#fca5a5', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                              Eliminar
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })
                }
              </div>
            )}

            {/* Modal formulario equipo */}
            {formEquipo && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 480, maxHeight: '90vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>{equipoEditar ? 'EDITAR EQUIPO' : 'AÑADIR EQUIPO'}</span>
                    <button onClick={() => setFormEquipo(false)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18 }}>X</button>
                  </div>
                  <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Tipo de maquinaria *</label>
                      <select value={eTipo} onChange={e => { setETipo(e.target.value); setESubtipo('') }} style={{ width: '100%', background: 'var(--surface2)', border: `1px solid ${!eTipo && eError ? '#ff6b6b' : 'var(--border)'}`, borderRadius: 6, padding: '9px 12px', color: eTipo ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                        <option value="" disabled>Selecciona tipo...</option>
                        {TIPOS_MAQUINARIA.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    {subtiposPorTipo(eTipo).length > 0 && (
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Subtipo *</label>
                        <select value={eSubtipo} onChange={e => setESubtipo(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: `1px solid ${!eSubtipo && eError ? '#ff6b6b' : 'var(--border)'}`, borderRadius: 6, padding: '9px 12px', color: eSubtipo ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                          <option value="" disabled>Selecciona subtipo...</option>
                          {subtiposPorTipo(eTipo).map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    )}
                    {[
                      { label: 'Nombre *', val: eNombre, set: setENombre, ph: 'Ej: Tractor John Deere 6130' },
                    ].map(f => (
                      <div key={f.label}>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{f.label}</label>
                        <input type="text" value={f.val} onChange={e => f.set(e.target.value)} placeholder={f.ph} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      </div>
                    ))}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>DNI / CIF del propietario</label>
                        <button type="button" onClick={() => { setVerifRegistro('roma'); setVerifNif(eDniCif); setVerifResultado(null); setVerifError(''); setShowVerifRomaRopo(true) }} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                          🔍 ROMA
                        </button>
                      </div>
                      <input type="text" value={eDniCif} onChange={e => setEDniCif(e.target.value)} placeholder="12345678A" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                    </div>
                    {[
                      { label: 'Nro ROMA', val: eRoma, set: setERoma, ph: 'Numero de registro' },
                    ].map(f => (
                      <div key={f.label}>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{f.label}</label>
                        <input type="text" value={f.val} onChange={e => f.set(e.target.value)} placeholder={f.ph} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      </div>
                    ))}
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Titularidad</label>
                      <select value={eTitularidad} onChange={e => setETitularidad(e.target.value as 'Propia' | 'Externa' | '')} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: eTitularidad ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                        <option value="">Sin especificar</option>
                        <option value="Propia">Propia</option>
                        <option value="Externa">Externa</option>
                      </select>
                    </div>
                    {eTitularidad === 'Propia' && (
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Finca</label>
                        {fincas.length === 0 ? (
                          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: '6px 0' }}>No hay fincas creadas.</div>
                        ) : (
                          <select value={eFincaId} onChange={e => setEFincaId(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: eFincaId ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                            <option value="">Sin finca asignada</option>
                            {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                          </select>
                        )}
                      </div>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Fecha de adquisición</label>
                        <input type="date" value={eFechaAdquisicion} onChange={e => setEFechaAdquisicion(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Fecha última inspección</label>
                        <input type="date" value={eFechaUltimaInspeccion} onChange={e => setEFechaUltimaInspeccion(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      </div>
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Observaciones</label>
                      <textarea value={eObs} onChange={e => setEObs(e.target.value)} rows={2} placeholder="Notas adicionales..." style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none', resize: 'vertical' }}/>
                    </div>
                    {eError && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)' }}>{eError}</div>}
                  </div>
                  <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
                    <button onClick={guardarEquipo} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>GUARDAR</button>
                    <button onClick={() => setFormEquipo(false)} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {pestana === 'tareas' && (() => {
          const grupoPrioridad = (t: Tarea): number => t.estado === 'realizada' ? 2 : (diasHastaTarea(t.fechaPrevista) <= 5 ? 0 : 1)
          const tareasFiltradas = tareas
            .filter(t => misPermisos['tareas.ver_todas'] || !miPersonalId || t.ejecutorId === miPersonalId)
            .filter(t => !filtroEstadoTarea || t.estado === filtroEstadoTarea)
            .filter(t => !filtroCampanaTarea || t.campanaId === filtroCampanaTarea)
            .filter(t => !filtroFincaTarea || t.fincaId === filtroFincaTarea)
            .filter(t => !filtroPersonalTarea || t.creadoPor === filtroPersonalTarea || t.ejecutorId === filtroPersonalTarea)
            .filter(t => !filtroTipoTarea || t.tipo === filtroTipoTarea)
            .sort((a, b) => grupoPrioridad(a) - grupoPrioridad(b) || a.fechaPrevista.localeCompare(b.fechaPrevista))
          const tareaSel = tareas.find(t => t.id === tareaSeleccionadaId) || null
          const nombreTarea = (t: Tarea) => t.tipo === 'Otros' ? (t.tipoOtro || 'Otros') : t.tipo
          const nombrePersona = (id?: string) => id ? (personal.find(p => p.id === id)?.nombre || '—') : '—'
          const nombrePersonaConRol = (id?: string) => {
            if (!id) return '—'
            const p = personal.find(x => x.id === id)
            if (!p) return '—'
            const rol = p.funciones && p.funciones.length ? p.funciones.join(', ') : ''
            return rol ? `${p.nombre} (${rol})` : p.nombre
          }
          const nombreParcelaConCultivo = (p: ParcelaGuardada) => p.nombre ? `${p.nombre} (${p.cultivo})` : p.cultivo
          // Cultivo de una parcela para una campaña concreta: el actual si coincide con esa
          // campaña (o la parcela no tiene campaña asignada, cultivos no anuales), si no el
          // histórico guardado para esa campaña, y si tampoco hay histórico, el actual.
          const cultivoParcelaEnCampana = (p: ParcelaGuardada, campanaId: string): string => {
            if (!campanaId || !p.campanaId || p.campanaId === campanaId) return p.cultivo
            const hist = historicoCultivos.find(h => h.parcelaId === p.id && h.campanaId === campanaId)
            return hist ? hist.cultivo : p.cultivo
          }
          const parcelasStrDe = (t: Tarea) => {
            const esFito = t.tipo === 'Tratamiento fitosanitario'
            return t.parcelaIds.map(id => {
              const p = misParcelas.find(x => x.id === id)
              if (!p) return null
              return esFito ? (p.nombre || p.cultivo) : nombreParcelaConCultivo(p)
            }).filter(Boolean).join(', ')
          }
          const personaTareaStr = (t: Tarea, id?: string) => t.tipo === 'Tratamiento fitosanitario' ? nombrePersona(id) : nombrePersonaConRol(id)
          const selectStyle = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none' }

          return (
            <div style={{ display: 'flex', height: 'calc(100vh - 140px)', gap: isMobile ? 0 : 16, flexDirection: isMobile ? 'column' : 'row' }}>
              {/* Panel izquierdo: filtros + listado. En móvil solo se ve si no hay tarea seleccionada. */}
              <div style={{ display: isMobile && tareaSel ? 'none' : 'flex', width: isMobile ? '100%' : '25%', minWidth: isMobile ? undefined : 260, flex: isMobile ? 1 : undefined, height: isMobile ? undefined : '100%', minHeight: 0, flexDirection: 'column', borderRight: isMobile ? 'none' : '1px solid var(--border)', paddingRight: isMobile ? 0 : 12, overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>TAREAS</span>
                  <button onClick={abrirNuevaTarea} style={{ padding: '6px 12px', borderRadius: 6, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>+ NUEVA TAREA</button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  <select value={filtroEstadoTarea} onChange={e => setFiltroEstadoTarea(e.target.value as any)} style={selectStyle}>
                    <option value="">Estado: Todas</option>
                    <option value="pendiente">Pendientes</option>
                    <option value="realizada">Terminadas</option>
                  </select>
                  <select value={filtroCampanaTarea} onChange={e => setFiltroCampanaTarea(e.target.value)} style={selectStyle}>
                    <option value="">Campaña: Todas</option>
                    {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                  <select value={filtroFincaTarea} onChange={e => setFiltroFincaTarea(e.target.value)} style={selectStyle}>
                    <option value="">Finca: Todas</option>
                    {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                  </select>
                  <select value={filtroPersonalTarea} onChange={e => setFiltroPersonalTarea(e.target.value)} style={selectStyle}>
                    <option value="">Personal: Todas</option>
                    {personal.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                  </select>
                  <select value={filtroTipoTarea} onChange={e => setFiltroTipoTarea(e.target.value)} style={selectStyle}>
                    <option value="">Tipo: Todas</option>
                    {TIPOS_TAREA.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>

                <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {tareasFiltradas.length === 0 && (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12, border: '1px dashed var(--border)', borderRadius: 10 }}>
                      No hay tareas con estos filtros.
                    </div>
                  )}
                  {tareasFiltradas.map(t => {
                    const color = colorPrioridadTarea(t)
                    const seleccionada = t.id === tareaSeleccionadaId
                    const finca = fincas.find(f => f.id === t.fincaId)
                    const parcelasStr = parcelasStrDe(t)
                    return (
                      <button key={t.id} onClick={() => setTareaSeleccionadaId(t.id)}
                        style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 8, background: seleccionada ? 'var(--surface2)' : 'var(--surface)', border: `1px solid ${seleccionada ? color : 'var(--border)'}`, borderLeft: `4px solid ${color}`, cursor: 'pointer' }}>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color, marginBottom: 3 }}>
                          {nombreTarea(t).toUpperCase()}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{t.fechaPrevista || '—'}</div>
                        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{finca?.nombre || 'Sin finca'}{parcelasStr ? ` · ${parcelasStr}` : ''}</div>
                        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{personaTareaStr(t, t.ejecutorId)}</div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Panel derecho: detalle. En móvil solo se ve si hay una tarea seleccionada. */}
              <div style={{ display: isMobile && !tareaSel ? 'none' : 'block', flex: 1, minHeight: 0, overflow: 'auto', padding: isMobile ? '12px 0 24px' : '0 4px' }}>
                {isMobile && tareaSel && (
                  <button onClick={() => setTareaSeleccionadaId(null)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, fontFamily: 'var(--mono)', marginBottom: 12, padding: 0 }}>← volver a la lista</button>
                )}
                {!tareaSel ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, textAlign: 'center' }}>
                    Selecciona una tarea para consultar su información
                  </div>
                ) : (() => {
                  const color = colorPrioridadTarea(tareaSel)
                  const finca = fincas.find(f => f.id === tareaSel.fincaId)
                  const campana = campanas.find(c => c.id === tareaSel.campanaId)
                  const parcelasStr = parcelasStrDe(tareaSel) || '—'
                  const equiposStr = tareaSel.equipoIds.map(id => equipos.find(e => e.id === id)?.nombre).filter(Boolean).join(', ') || '—'
                  return (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
                        <div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>{nombreTarea(tareaSel).toUpperCase()}</div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color, marginTop: 4 }}>
                            {tareaSel.estado === 'realizada' ? 'REALIZADA' : 'PENDIENTE'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 4 }}>Prevista: {tareaSel.fechaPrevista || '—'}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {tareaSel.estado !== 'realizada' && (
                            <button onClick={() => iniciarMarcarTareaRealizada(tareaSel)} style={{ padding: '8px 14px', borderRadius: 6, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>✓ MARCAR COMO REALIZADA</button>
                          )}
                          <button onClick={() => tareaSel.tipo === 'Tratamiento fitosanitario' ? abrirEditarTareaTratamiento(tareaSel) : abrirEditarTareaGeneral(tareaSel)} style={{ padding: '8px 14px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>EDITAR</button>
                          <button onClick={() => eliminarTarea(tareaSel.id)} style={{ padding: '8px 14px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>ELIMINAR</button>
                        </div>
                      </div>

                      {[
                        { titulo: 'UBICACIÓN', filas: [['Campaña', campana?.nombre || '—'], ['Finca', finca?.nombre || '—'], ['Parcela/s', parcelasStr]] },
                        { titulo: 'PERSONAL', filas: [['Quién crea', personaTareaStr(tareaSel, tareaSel.creadoPor)], ['Quién ejecuta', personaTareaStr(tareaSel, tareaSel.ejecutorId)]] },
                        { titulo: 'MAQUINARIA', filas: [['Maquinaria', equiposStr]] },
                        { titulo: 'INFORMACIÓN ADICIONAL', filas: [['Comentarios', tareaSel.comentarios || '—']] },
                      ].map(bloque => (
                        <div key={bloque.titulo} style={{ marginBottom: 16 }}>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.06em', marginBottom: 8 }}>{bloque.titulo}</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 8 }}>
                            {bloque.filas.map(([k, v]) => (
                              <div key={k} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
                                <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{v}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}

                      {tareaSel.tipo === 'Tratamiento fitosanitario' && tareaSel.borradorTratamiento && (
                        <div style={{ marginBottom: 16 }}>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--blue)', letterSpacing: '0.06em', marginBottom: 8 }}>DATOS DEL TRATAMIENTO (BORRADOR)</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 8 }}>
                            {[['Producto', tareaSel.borradorTratamiento.producto], ['Dosis', `${tareaSel.borradorTratamiento.dosis} ${tareaSel.borradorTratamiento.unidadDosis}`]].map(([k, v]: any) => (
                              <div key={k} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                                <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
                                <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{v || '—'}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {tareaSel.tratamientoId && (
                        <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--green)' }}>✓ Registrada en TRATAMIENTOS → REALIZADOS</div>
                      )}
                    </div>
                  )
                })()}
              </div>

              {/* Popup: elegir tipo de tarea */}
              {formNuevaTareaVisible && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: 12, width: '100%', maxWidth: 380, padding: 24 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--green)', marginBottom: 14 }}>+ NUEVA TAREA</div>
                    <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase' }}>Tipo de tarea</label>
                    <select value={nuevaTareaTipo} onChange={e => setNuevaTareaTipo(e.target.value)}
                      style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: nuevaTareaTipo ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none', marginBottom: 16 }}>
                      <option value="" disabled>Selecciona tipo...</option>
                      {TIPOS_TAREA.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={continuarNuevaTarea} disabled={!nuevaTareaTipo} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: nuevaTareaTipo ? 'pointer' : 'default', opacity: nuevaTareaTipo ? 1 : 0.5 }}>CONTINUAR</button>
                      <button onClick={() => setFormNuevaTareaVisible(false)} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Formulario general de tarea (todos los tipos salvo Tratamiento fitosanitario) */}
              {tarFormVisible && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: 12, width: '100%', maxWidth: 480, maxHeight: '90vh', overflow: 'auto' }}>
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>{tarEditar ? '✏ EDITAR TAREA' : '+ NUEVA TAREA'}: {tarTipo}</span>
                      <button onClick={() => setTarFormVisible(false)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
                    </div>
                    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {tarTipo === 'Otros' && (
                        <div>
                          <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Tipo de tarea <span style={{ color: '#ff6b6b' }}>*</span></label>
                          <input value={tarTipoOtro} onChange={e => setTarTipoOtro(e.target.value)} placeholder="Ej: Reparar vallado, limpiar balsa..."
                            style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }} />
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <div>
                          <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Campaña</label>
                          <select value={tarCampanaId} onChange={e => { setTarCampanaId(e.target.value); setTarParcelaIds([]) }} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                            <option value="">Sin campaña</option>
                            {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Finca</label>
                          <select value={tarFincaId} onChange={e => { setTarFincaId(e.target.value); setTarParcelaIds([]) }} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                            <option value="">Sin finca</option>
                            {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Parcela/s</label>
                        {!tarCampanaId || !tarFincaId ? (
                          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: '8px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                            Selecciona campaña y finca para ver las parcelas disponibles.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 120, overflow: 'auto', padding: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                            {misParcelas.filter(p => p.fincaId === tarFincaId).map(p => {
                              const sel = tarParcelaIds.includes(p.id)
                              const cultivo = cultivoParcelaEnCampana(p, tarCampanaId)
                              return (
                                <button key={p.id} onClick={() => setTarParcelaIds(sel ? tarParcelaIds.filter(id => id !== p.id) : [...tarParcelaIds, p.id])}
                                  style={{ padding: '5px 10px', borderRadius: 14, background: sel ? 'rgba(61,220,110,0.15)' : 'var(--surface)', border: `1px solid ${sel ? 'var(--green)' : 'var(--border)'}`, color: sel ? 'var(--green)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>
                                  {p.nombre ? `${p.nombre} (${cultivo})` : cultivo}
                                </button>
                              )
                            })}
                            {misParcelas.filter(p => p.fincaId === tarFincaId).length === 0 && <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay parcelas guardadas en esta finca</span>}
                          </div>
                        )}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <div>
                          <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Quién crea</label>
                          <select value={tarCreadoPor} onChange={e => setTarCreadoPor(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                            <option value="">Sin especificar</option>
                            {personal.map(p => <option key={p.id} value={p.id}>{p.funciones?.length ? `${p.nombre} (${p.funciones.join(', ')})` : p.nombre}</option>)}
                          </select>
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Quién ejecuta</label>
                          <select value={tarEjecutorId} onChange={e => setTarEjecutorId(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                            <option value="">Sin especificar</option>
                            {(misPermisos['tareas.crear_asignar'] ? personal : personal.filter(p => p.id === miPersonalId)).map(p => <option key={p.id} value={p.id}>{p.funciones?.length ? `${p.nombre} (${p.funciones.join(', ')})` : p.nombre}</option>)}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Fecha a realizar <span style={{ color: '#ff6b6b' }}>*</span></label>
                        <input type="date" value={tarFechaPrevista} onChange={e => setTarFechaPrevista(e.target.value)}
                          style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Maquinaria necesaria</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 100, overflow: 'auto', padding: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                          {equipos.map(e => {
                            const sel = tarEquipoIds.includes(e.id)
                            return (
                              <button key={e.id} onClick={() => setTarEquipoIds(sel ? tarEquipoIds.filter(id => id !== e.id) : [...tarEquipoIds, e.id])}
                                style={{ padding: '5px 10px', borderRadius: 14, background: sel ? 'rgba(77,184,255,0.15)' : 'var(--surface)', border: `1px solid ${sel ? 'var(--blue)' : 'var(--border)'}`, color: sel ? 'var(--blue)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>
                                {e.nombre}
                              </button>
                            )
                          })}
                          {equipos.length === 0 && <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay maquinaria registrada</span>}
                        </div>
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Comentarios</label>
                        <textarea value={tarComentarios} onChange={e => setTarComentarios(e.target.value)} rows={3}
                          style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none', resize: 'vertical' }} />
                      </div>
                      {tarEditar?.estado === 'realizada' && (
                        <div>
                          <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>
                            Tiempo dedicado {!tarEjecutorId && <span style={{ color: '#f59e0b', textTransform: 'none' }}>(selecciona quién ejecuta para poder imputar horas)</span>}
                          </label>
                          {renderEditorDias(tarHorasTrabajadas, setTarHorasTrabajadas)}
                        </div>
                      )}
                      {tarError && <div style={{ color: '#fca5a5', fontSize: 11, fontFamily: 'var(--mono)' }}>{tarError}</div>}
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button onClick={guardarTareaGeneral} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>GUARDAR</button>
                        <button onClick={() => setTarFormVisible(false)} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })()}

        {pestana === 'riego' && (
          <RiegoTab session={session} fincas={fincas} misParcelas={misParcelas} isMobile={isMobile}
            sectorInicial={riegoSectorFocus} onConsumirSectorInicial={() => setRiegoSectorFocus(null)} misPermisos={misPermisos} />
        )}

        {pestana === 'permisos' && (
          <PermisosTab session={session} personal={personal} setPersonal={setPersonal} isMobile={isMobile} />
        )}

{/* - Modal Cuaderno de campo (selección de año y finca/s) - */}
      {cuadernoModalVisible && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: 12, width: '100%', maxWidth: 460, maxHeight: '90vh', overflow: 'auto' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>📄 CUADERNO DE CAMPO</span>
              <button onClick={() => setCuadernoModalVisible(false)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
                Genera el Cuaderno de Explotación en Word con los tratamientos y parcelas de la campaña y las fincas seleccionadas. Solo se incluyen los cultivos asociados a esa campaña (actuales o históricos).
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Campaña</label>
                {campanas.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay campañas creadas — crea una campaña antes de generar el cuaderno.</div>
                ) : (
                  <select value={cuadernoCampanaId} onChange={e => setCuadernoCampanaId(e.target.value)}
                    style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                    <option value="">— Selecciona una campaña —</option>
                    {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}{campanaFinalizada(c) ? ' (finalizada)' : ''}</option>)}
                  </select>
                )}
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>
                  Fincas {cuadernoFincaIds.length === 0 && <span style={{ color: 'var(--green)', textTransform: 'none' }}>(todas)</span>}
                </label>
                {fincas.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay fincas creadas — se usarán todas las parcelas.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflow: 'auto', padding: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                    {fincas.map(f => {
                      const sel = cuadernoFincaIds.includes(f.id)
                      return (
                        <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--sans)', color: 'var(--text)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={sel} onChange={() => setCuadernoFincaIds(sel ? cuadernoFincaIds.filter(id => id !== f.id) : [...cuadernoFincaIds, f.id])} />
                          {f.nombre}
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
              <button onClick={() => { setCuadernoModalVisible(false); abrirFormDatosExplotacion() }}
                style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--blue)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline', alignSelf: 'flex-start', padding: 0 }}>
                🌾 Editar datos de la explotación (cabecera del documento)
              </button>
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
              <button onClick={generarCuaderno} disabled={generandoCuaderno || !cuadernoCampanaId}
                style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: (generandoCuaderno || !cuadernoCampanaId) ? 'default' : 'pointer', opacity: (generandoCuaderno || !cuadernoCampanaId) ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                {generandoCuaderno ? <><span className="spinner"/> GENERANDO...</> : '⬇ DESCARGAR WORD'}
              </button>
              <button onClick={() => setCuadernoModalVisible(false)} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

{/* - Modal Datos de la explotación (cuaderno de campo, secciones 1.1 y 1.4) - */}
      {formDatosExplotacion && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: 12, width: '100%', maxWidth: 640, maxHeight: '90vh', overflow: 'auto' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>🌾 DATOS DE LA EXPLOTACIÓN</span>
              <button onClick={() => setFormDatosExplotacion(false)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
                Estos datos rellenan automáticamente la cabecera del Cuaderno de Campo descargable (secciones 1.1 y 1.4). Todos los campos son opcionales.
              </div>

              <div>
                <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', fontWeight: 700, letterSpacing: '0.06em', marginBottom: 8 }}>1.1 DATOS GENERALES DE LA EXPLOTACIÓN</div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 8 }}>
                  {campoDE('nombreRazonSocial', 'Nombre y apellidos o razón social')}
                  {campoDE('nif', 'NIF')}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  {campoDE('nroRegExplotNacional', 'Nº Registro Explotaciones Nacional')}
                  {campoDE('nroRegExplotAutonomico', 'Nº Registro Explotaciones Autonómico')}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                  {campoDE('direccion', 'Dirección')}
                  {campoDE('localidad', 'Localidad')}
                  {campoDE('cPostal', 'C. Postal')}
                  {campoDE('provincia', 'Provincia')}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {campoDE('telefonoFijo', 'Teléfono fijo', 'tel')}
                  {campoDE('telefonoMovil', 'Teléfono móvil', 'tel')}
                  {campoDE('email', 'e-mail', 'email')}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', fontWeight: 700, letterSpacing: '0.06em', marginBottom: 8 }}>TITULAR O REPRESENTANTE DE LA EXPLOTACIÓN</div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8, marginBottom: 8 }}>
                  {campoDE('titularNombre', 'Nombre y apellidos')}
                  {campoDE('titularNif', 'NIF')}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
                  {campoDE('titularDireccion', 'Dirección')}
                  {campoDE('titularLocalidad', 'Localidad')}
                  {campoDE('titularCPostal', 'C. Postal')}
                  {campoDE('titularProvincia', 'Provincia')}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {campoDE('titularTipoRepresentacion', 'Tipo de representación')}
                  {campoDE('titularTelefono', 'Teléfono', 'tel')}
                  {campoDE('titularEmail', 'e-mail', 'email')}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--blue)', fontWeight: 700, letterSpacing: '0.06em', marginBottom: 8 }}>1.4 AGRUPACIÓN O ENTIDAD DE ASESORAMIENTO</div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 8 }}>
                  {campoDE('agrupacionNombre', 'Nombre o razón social')}
                  {campoDE('agrupacionNif', 'NIF')}
                  {campoDE('agrupacionNroIdentificacion', 'Nº de identificación')}
                  {campoDE('agrupacionTipoExplotacion', 'Tipo de explotación')}
                </div>
              </div>
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
              <button onClick={guardarDatosExplotacion} disabled={deGuardando}
                style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: deGuardando ? 'default' : 'pointer', opacity: deGuardando ? 0.6 : 1 }}>
                {deGuardando ? 'Guardando...' : '💾 GUARDAR'}
              </button>
              <button onClick={() => setFormDatosExplotacion(false)} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

{/* - Popup de horas de trabajo - */}
      {horasPopupModo && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: 12, width: '100%', maxWidth: 540, maxHeight: '90vh', overflow: 'auto' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>🕒 TIEMPO DE TRABAJO</span>
              <button onClick={() => guardarHorasPopup(true)} disabled={horasPopupGuardando} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
                Indica los días y el horario dedicados a {horasPopupModo.tipo === 'tratamiento_guardado' ? 'este tratamiento' : 'esta tarea'}.
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Trabajador</label>
                {horasPopupPersonalId ? (
                  <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)' }}>
                    👷 {personal.find(p => p.id === horasPopupPersonalId)?.nombre || horasPopupPersonalId}
                  </div>
                ) : (
                  <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 6, padding: '9px 12px', color: '#f59e0b', fontSize: 11, fontFamily: 'var(--mono)' }}>
                    ⚠ No hay ejecutor/aplicador asignado. Asígnalo al editar {horasPopupModo.tipo === 'tratamiento_guardado' ? 'el tratamiento' : 'la tarea'} para poder imputarle las horas.
                  </div>
                )}
              </div>
              {renderEditorDias(horasPopupDias, setHorasPopupDias)}
              {horasPopupError && (
                <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)' }}>
                  ⚠ {horasPopupError}
                </div>
              )}
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => guardarHorasPopup(false)} disabled={horasPopupGuardando}
                style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: horasPopupGuardando ? 'default' : 'pointer', opacity: horasPopupGuardando ? 0.6 : 1 }}>
                {horasPopupGuardando ? 'Guardando...' : (horasPopupModo.tipo === 'tarea_completar' ? '💾 GUARDAR Y COMPLETAR' : '💾 GUARDAR HORAS')}
              </button>
              <button onClick={() => guardarHorasPopup(true)} disabled={horasPopupGuardando}
                style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: horasPopupGuardando ? 'default' : 'pointer' }}>
                {horasPopupModo.tipo === 'tarea_completar' ? 'Completar sin horas' : 'Cerrar sin horas'}
              </button>
            </div>
          </div>
        </div>
      )}

{/* - Modal formulario tratamiento - */}
      {formTrat && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 480, maxHeight: '90vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>{tratEditar ? '✏ EDITAR TRATAMIENTO' : '🧪 NUEVO TRATAMIENTO'}</span>
              <button onClick={() => { setFormTrat(false); setTareaEnCreacionId(null) }} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                <input type="checkbox" id="chk-realizada" checked={tRealizada} onChange={e => setTRealizada(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: 'var(--green)', cursor: 'pointer' }} />
                <label htmlFor="chk-realizada" style={{ fontSize: 12, fontFamily: 'var(--mono)', color: tRealizada ? 'var(--green)' : 'var(--muted)', cursor: 'pointer' }}>
                  {tRealizada ? '✓ Realizada' : '☐ No realizada (se guarda como tarea pendiente)'}
                </label>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Tipo de tratamiento <span style={{ color: '#ff6b6b' }}>*</span></label>
                <select value={tTipo} onChange={e => setTTipo(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: `1px solid ${!tTipo && tError ? '#ff6b6b' : 'var(--border)'}`, borderRadius: 6, padding: '9px 12px', color: tTipo ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                  <option value="" disabled>Selecciona tipo...</option>
                  {TIPOS_TRATAMIENTO.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Campaña <span style={{ color: '#ff6b6b' }}>*</span></label>
                {campanas.length === 0 ? (
                  <div style={{ fontSize: 11, color: '#fca5a5', fontFamily: 'var(--mono)', padding: '6px 0' }}>
                    No hay campañas creadas. Crea una desde "Mis Parcelas" antes de registrar el tratamiento.
                  </div>
                ) : (
                  <select value={tCampanaId} onChange={e => setTCampanaId(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: `1px solid ${!tCampanaId && tError ? '#ff6b6b' : 'var(--border)'}`, borderRadius: 6, padding: '9px 12px', color: tCampanaId ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                    <option value="" disabled>Selecciona campaña...</option>
                    {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}{campanaFinalizada(c) ? ' (finalizada)' : ''}</option>)}
                  </select>
                )}
              </div>
              {/* Buscador fitosanitarios MAPA */}
              <div style={{ position: 'relative' }}>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Buscar en Registro MAPA
                  {fitoSeleccionado && <span style={{ marginLeft: 8, color: 'var(--green)', fontSize: 9 }}>✓ {fitoSeleccionado.num_registro}</span>}
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={fitoBusqueda}
                    onChange={e => buscarFito(e.target.value)}
                    placeholder="Nombre comercial o nº registro..."
                    style={{ flex: 1, background: 'var(--surface2)', border: `1px solid ${fitoSeleccionado ? 'var(--green)' : 'var(--border)'}`, borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}
                  />
                  {fitoBuscando && <span className="spinner" style={{ alignSelf: 'center' }}/>}

                </div>
                {/* Dropdown resultados */}
                {fitoResultados.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 3000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.4)', maxHeight: 220, overflowY: 'auto', marginTop: 2 }}>
                    {fitoResultados.map(p => (
                      <div
                        key={p.id}
                        onClick={() => seleccionarFito(p)}
                        style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)', borderLeft: p.eliminado ? '3px solid #ff6b6b' : '3px solid transparent' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: p.eliminado ? '#fca5a5' : 'var(--text)' }}>{p.nombre}</span>
                          {p.eliminado && <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: '#fca5a5', background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)', borderRadius: 3, padding: '1px 4px' }}>NO AUTORIZADO</span>}
                          {p.tiene_pdf && <span style={{ fontSize: 8, fontFamily: 'var(--mono)', color: 'var(--blue)', background: 'rgba(77,184,255,0.08)', border: '1px solid rgba(77,184,255,0.2)', borderRadius: 3, padding: '1px 4px' }}>PDF</span>}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                          {p.num_registro} · {p.formulado?.substring(0, 50)}
                        </div>
                        <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{p.titular}</div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Info producto seleccionado */}
                {fitoSeleccionado && (
                  <div style={{ marginTop: 6 }}>
                    {fitoSeleccionado.eliminado && (
                      <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)', marginBottom: 6 }}>
                        <div style={{ fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 700, color: '#fca5a5', marginBottom: 3 }}>PRODUCTO NO AUTORIZADO</div>
                        <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: '#fca5a5', lineHeight: 1.5 }}>
                          Este producto ya no esta autorizado a fecha actual.
                          {fitoSeleccionado.fecha_eliminacion && <> Eliminado el {fitoSeleccionado.fecha_eliminacion}.</>}
                          {' '}Verifique con el MAPA antes de aplicar.
                        </div>
                      </div>
                    )}
                    <div style={{ padding: '8px 10px', borderRadius: 6, background: fitoSeleccionado.eliminado ? 'rgba(255,107,107,0.04)' : 'rgba(61,220,110,0.06)', border: `1px solid ${fitoSeleccionado.eliminado ? 'rgba(255,107,107,0.2)' : 'rgba(61,220,110,0.2)'}`, fontSize: 10, fontFamily: 'var(--mono)' }}>
                      <div style={{ color: fitoSeleccionado.eliminado ? '#fca5a5' : 'var(--green)', fontWeight: 700, marginBottom: 3 }}>
                        {fitoSeleccionado.eliminado ? 'ELIMINADO DEL REGISTRO' : 'PRODUCTO OFICIAL VIGENTE'}
                      </div>
                      <div style={{ color: 'var(--muted)', lineHeight: 1.6 }}>
                        <span style={{ color: 'var(--text)' }}>{fitoSeleccionado.formulado}</span><br/>
                        Titular: {fitoSeleccionado.titular}<br/>
                        {fitoSeleccionado.fecha_caducidad && <>Caducidad: {fitoSeleccionado.fecha_caducidad}</>}
                      </div>
                      {fitoSeleccionado.tiene_pdf && fitoSeleccionado.pdf_url && (
                        <button
                          onClick={async () => {
                            setPdfCargando(true)
                            try {
                              const r = await fetch(`${BACKEND}${fitoSeleccionado.pdf_url}`)
                              const blob = await r.blob()
                              const url = URL.createObjectURL(blob)
                              setPdfBlobUrl(url)
                              setFichaVisible(true)
                            } catch { alert('Error cargando el PDF') }
                            finally { setPdfCargando(false) }
                          }}
                          disabled={pdfCargando}
                          style={{ marginTop: 8, padding: '5px 12px', borderRadius: 5, background: 'rgba(77,184,255,0.1)', border: '1px solid rgba(77,184,255,0.3)', color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 10, cursor: pdfCargando ? 'wait' : 'pointer', fontWeight: 700 }}
                        >
                          {pdfCargando ? 'Cargando...' : 'Ver ficha tecnica PDF'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Producto utilizado <span style={{ color: '#ff6b6b' }}>*</span></label>
                <input type="text" value={tProducto} onChange={e => setTProducto(e.target.value)} placeholder="Nombre del producto..." style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
              </div>
              {/* Nº de registro oficial del producto — se autorrellena al elegir un producto del buscador oficial, pero se puede corregir a mano */}
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Nº de registro</label>
                <input type="text" value={tNumRegistro} onChange={e => setTNumRegistro(e.target.value)} placeholder="Ej: 12.345" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
              </div>
              {/* Materia activa + consulta MRL */}
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Materia activa <span style={{ color: '#ff6b6b' }}>*</span></label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type="text" value={tMateriaActiva} onChange={e => { setTMateriaActiva(e.target.value); setMrlResultado(null) }} placeholder="Ej: glifosato, clorpirifos..." style={{ flex: 1, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                </div>
              </div>
              {/* Resultado MRL */}
              {mrlResultado && (
                <div style={{ padding: '10px 12px', borderRadius: 7, background: mrlResultado.encontrado ? 'rgba(61,220,110,0.06)' : 'rgba(251,191,36,0.06)', border: `1px solid ${mrlResultado.encontrado ? 'rgba(61,220,110,0.25)' : 'rgba(251,191,36,0.25)'}` }}>
                  {mrlResultado.encontrado ? (
                    <>
                      <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--green)', fontWeight: 700, marginBottom: 4 }}>
                        ✓ MRL ENCONTRADO {mrlResultado.tipo === 'parcial' ? '(coincidencia parcial)' : ''}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>SUSTANCIA OFICIAL</div>
                          <div style={{ fontSize: 11, color: 'var(--text)', fontWeight: 600 }}>{mrlResultado.sustancia_oficial}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>CULTIVO OFICIAL</div>
                          <div style={{ fontSize: 11, color: 'var(--text)', fontWeight: 600 }}>{mrlResultado.cultivo_oficial}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>MRL MÁXIMO</div>
                          <div style={{ fontSize: 16, color: 'var(--green)', fontWeight: 700 }}>{mrlResultado.mrl} {mrlResultado.unidad}</div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>FUENTE</div>
                          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.4 }}>EU Reg. EC 396/2005</div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--amber)', fontWeight: 700, marginBottom: 4 }}>⚠ {mrlResultado.motivo}</div>
                      {mrlResultado.sugerencias_cultivos && (
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Cultivos disponibles para esta sustancia:</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {mrlResultado.sugerencias_cultivos.slice(0,6).map((s: any, i: number) => (
                              <span key={i} style={{ fontSize: 9, fontFamily: 'var(--mono)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', color: 'var(--text)' }}>{s.cultivo}: {s.mrl} mg/kg</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Dosis <span style={{ color: '#ff6b6b' }}>*</span></label>
                  <input type="number" min="0" step="0.01" value={tDosis} onChange={e => setTDosis(e.target.value)} placeholder="0.00" style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Unidad</label>
                  <select value={tUnidad} onChange={e => setTUnidad(e.target.value as UnidadDosis)} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                    <option value="L/ha">L/ha</option>
                    <option value="Kg/ha">Kg/ha</option>
                    <option value="g/ha">g/ha</option>
                    <option value="mL/hL">mL/hL</option>
                    <option value="L/hL">L/hL</option>
                    <option value="g/hL">g/hL</option>
                    <option value="Kg/hL">Kg/hL</option>
                    <option value="%(v/v)">%(v/v)</option>
                    <option value="%(p/p)">%(p/p)</option>
                    <option value="g/m²">g/m²</option>
                    <option value="g/kg semilla">g/kg semilla</option>
                    <option value="mL/kg semilla">mL/kg semilla</option>
                    <option value="mL/m²">mL/m²</option>
                    <option value="L/m²">L/m²</option>
                    <option value="mg/m²">mg/m²</option>
                  </select>
                </div>
              </div>
              {(unidadNecesitaCaldo(tUnidad) || unidadNecesitaSemilla(tUnidad)) && (
                <div style={{ padding: '10px 12px', borderRadius: 7, background: 'rgba(61,220,110,0.06)', border: '1px solid rgba(61,220,110,0.25)' }}>
                  {unidadNecesitaCaldo(tUnidad) && (
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Litros de caldo aplicados/ha <span style={{ color: '#ff6b6b' }}>*</span></label>
                      <input type="number" min="0" step="1" value={tLitrosCaldoHa} onChange={e => setTLitrosCaldoHa(e.target.value)} placeholder="Ej: 1000" style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>Necesario para convertir "{tUnidad}" a una dosis por hectárea comparable.</div>
                    </div>
                  )}
                  {unidadNecesitaSemilla(tUnidad) && (
                    <div style={{ marginTop: unidadNecesitaCaldo(tUnidad) ? 10 : 0 }}>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Kg de semilla sembrada/ha <span style={{ color: '#ff6b6b' }}>*</span></label>
                      <input type="number" min="0" step="1" value={tKgSemillaHa} onChange={e => setTKgSemillaHa(e.target.value)} placeholder="Ej: 25" style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>Necesario para convertir "{tUnidad}" a una dosis por hectárea comparable.</div>
                    </div>
                  )}
                </div>
              )}
              {/* Dosis máxima y aplicaciones máximas (opcionales, para estadísticas) */}
              <div style={{ padding: '10px 12px', borderRadius: 7, background: 'var(--surface2)', border: '1px solid var(--border)', overflow: 'hidden', boxSizing: 'border-box' }}>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: isMobile ? 12 : 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <label style={{ display: 'block', minHeight: isMobile ? undefined : 26, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, lineHeight: '13px' }}>Dosis máx. permitida</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input type="number" min="0" step="0.01" value={tDosisMaxima} onChange={e => setTDosisMaxima(e.target.value)} placeholder="Ej: 4.0" style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--sans)', outline: 'none' }}/>
                      <select value={tUnidadDosisMaxima} onChange={e => setTUnidadDosisMaxima(e.target.value as UnidadDosis)} style={{ flexShrink: 0, width: isMobile ? 110 : 'auto', boxSizing: 'border-box', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 6px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--sans)', outline: 'none' }}>
                        <option value="L/ha">L/ha</option>
                        <option value="Kg/ha">Kg/ha</option>
                        <option value="g/ha">g/ha</option>
                        <option value="mL/hL">mL/hL</option>
                        <option value="L/hL">L/hL</option>
                        <option value="g/hL">g/hL</option>
                        <option value="Kg/hL">Kg/hL</option>
                        <option value="%(v/v)">%(v/v)</option>
                        <option value="%(p/p)">%(p/p)</option>
                        <option value="g/m²">g/m²</option>
                        <option value="g/kg semilla">g/kg semilla</option>
                        <option value="mL/kg semilla">mL/kg semilla</option>
                        <option value="mL/m²">mL/m²</option>
                        <option value="L/m²">L/m²</option>
                        <option value="mg/m²">mg/m²</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <label style={{ display: 'block', minHeight: isMobile ? undefined : 26, fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, lineHeight: '13px' }}>Nº Aplic.</label>
                    <input type="number" min="0" step="1" value={tAplicMaxima} onChange={e => setTAplicMaxima(e.target.value)} placeholder="Ej: 4" style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--sans)', outline: 'none' }}/>
                  </div>
                </div>
                <div style={{ marginTop: isMobile ? 12 : 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, lineHeight: '13px' }}>% superficie aplicada</label>
                      <input type="number" min="1" max="100" step="1" value={tPorcentajeAplicado} onChange={e => setTPorcentajeAplicado(e.target.value)} placeholder="100" style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--sans)', outline: 'none' }}/>
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, lineHeight: '13px' }}>% máximo permitido — opcional</label>
                      <input type="number" min="1" max="100" step="1" value={tPorcentajeMaximo} onChange={e => setTPorcentajeMaximo(e.target.value)} placeholder="Ej: 33" style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--sans)', outline: 'none' }}/>
                    </div>
                  </div>
                  <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>Para tratamientos que no cubren toda la parcela (p. ej. "aplicar entre líneas y en la base del tronco, máximo el 33% del área cultivada"). El gasto de stock se calcula sobre este % de la superficie, no sobre la parcela entera.</div>
                  {tPorcentajeMaximo.trim() && Number(tPorcentajeAplicado) > Number(tPorcentajeMaximo) && (
                    <div style={{ marginTop: 6, padding: '7px 10px', borderRadius: 6, background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)', fontSize: 10, color: '#fca5a5', fontFamily: 'var(--mono)' }}>
                      ⚠ Superas el % máximo permitido por la etiqueta ({tPorcentajeMaximo}%)
                    </div>
                  )}
                </div>
                <div style={{ marginTop: isMobile ? 12 : 8 }}>
                  <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, lineHeight: '13px' }}>Densidad del producto (Kg/L) — opcional</label>
                  <input type="number" min="0" step="0.01" value={tDensidad} onChange={e => setTDensidad(e.target.value)} placeholder="1.00" style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--sans)', outline: 'none' }}/>
                  <div style={{ fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>Solo necesaria si el producto se dosifica en una unidad (masa o volumen) distinta de la unidad en la que lo tienes en stock. Por defecto 1.</div>
                </div>
                {avisosProductoCultivo.length > 0 && (
                  <div style={{ marginTop: isMobile ? 12 : 8, padding: '7px 10px', borderRadius: 6, background: 'rgba(255,184,77,0.1)', border: '1px solid rgba(255,184,77,0.35)', fontSize: 10, color: '#ffb84d', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
                    {avisosProductoCultivo.map((a, i) => <div key={i}>⚠ {a}</div>)}
                    <div style={{ marginTop: 2, opacity: 0.85 }}>Revisa que sea correcto — un mismo producto en un mismo cultivo debería mantener siempre estos valores. Puedes seguir si es intencionado.</div>
                  </div>
                )}
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Fecha del tratamiento <span style={{ color: '#ff6b6b' }}>*</span></label>
                <input type="date" value={tFecha} onChange={e => setTFecha(e.target.value)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
              </div>
              {/* Recomendado por / Aplicado por (filtrados por finca). Cuando el tratamiento
                  viene desde una parcela concreta ya sabemos la finca, así que se muestran aquí.
                  Si viene del asistente, se muestran más abajo, tras elegir la finca (paso 2). */}
              {tratParcelaCtx && renderSelectoresPersonal()}
              {tratParcelaCtx && renderSelectorMaquinaria()}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Problema fitosanitario</label>
                  <input type="text" value={tProblema} onChange={e => setTProblema(e.target.value)} placeholder="Plaga o enfermedad tratada..." style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}/>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Eficacia</label>
                  <select value={tEficacia} onChange={e => setTEficacia(e.target.value as any)} style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: tEficacia ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                    <option value="">Sin indicar</option>
                    <option value="Buena">Buena</option>
                    <option value="Regular">Regular</option>
                    <option value="Mala">Mala</option>
                  </select>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Observaciones</label>
                <textarea value={tObs} onChange={e => setTObs(e.target.value)} rows={2} placeholder="Notas adicionales..." style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none', resize: 'vertical' }}/>
              </div>
              {!tratParcelaCtx && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Paso 1: Cultivo */}
                  <div>
                    <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{pasoNumCultivo}. Cultivo <span style={{ color: '#ff6b6b' }}>*</span></label>
                    <select value={tCultivoSeleccionado} onChange={e => { setTCultivoSeleccionado(e.target.value); setTFincaSeleccionada(''); setTParcelas([]); setTRecomendadoPor(''); setTAplicadoPor(''); setTEquipoIds([]) }}
                      style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: tCultivoSeleccionado ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                      <option value="">Selecciona cultivo...</option>
                      {cultivosDisponiblesParaTrat.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>

                  {/* Paso 2: Finca (solo si hay mas de 1 finca) */}
                  {tCultivoSeleccionado && pasoFincaVisible && (
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{pasoNumFinca}. Finca <span style={{ color: '#ff6b6b' }}>*</span></label>
                      <select value={tFincaSeleccionada} onChange={e => { setTFincaSeleccionada(e.target.value); setTParcelas([]); setTRecomendadoPor(''); setTAplicadoPor(''); setTEquipoIds([]) }}
                        style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '9px 12px', color: tFincaSeleccionada ? 'var(--text)' : 'var(--muted)', fontSize: 13, fontFamily: 'var(--sans)', outline: 'none' }}>
                        <option value="">Todas las fincas</option>
                        {fincasParaCultivo.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Paso 3: Personal (recomendado/aplicado), filtrado por la finca elegida arriba */}
                  {tCultivoSeleccionado && pasoPersonalVisible && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{pasoNumPersonal}. Personal</div>
                      {renderSelectoresPersonal()}
                    </div>
                  )}

                  {/* Paso: Maquinaria, filtrada por la finca elegida arriba */}
                  {tCultivoSeleccionado && pasoEquipoVisible && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{pasoNumEquipo}. Maquinaria</div>
                      {renderSelectorMaquinaria()}
                    </div>
                  )}

                  {/* Paso 4: Parcelas filtradas */}
                  {tCultivoSeleccionado && (
                    <div>
                      <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {pasoNumParcelas}. Parcelas <span style={{ color: '#ff6b6b' }}>*</span>
                        {parcelasFiltradas.length > 0 && <button onClick={() => setTParcelas(parcelasFiltradas.map(p => p.id))} style={{ marginLeft: 8, fontSize: 9, color: 'var(--green)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Seleccionar todas</button>}
                      </label>
                      {parcelasFiltradas.length === 0 ? (
                        <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: '8px 10px', background: 'var(--surface2)', borderRadius: 6 }}>
                          No hay parcelas con este cultivo{tFincaSeleccionada ? ' en esta finca' : ''}.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 160, overflowY: 'auto' }}>
                          {parcelasFiltradas.map(p => {
                            const finca = fincas.find(f => f.id === p.fincaId)
                            return (
                              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 8px', borderRadius: 5, background: tParcelas.includes(p.id) ? 'var(--green-dim)' : 'var(--surface2)', border: `1px solid ${tParcelas.includes(p.id) ? 'rgba(61,220,110,0.3)' : 'var(--border)'}`, transition: 'all 0.15s' }}>
                                <input type="checkbox" checked={tParcelas.includes(p.id)} onChange={e => setTParcelas(prev => e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id))} style={{ accentColor: 'var(--green)' }}/>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 12, color: 'var(--text)' }}>{p.nombre || p.cultivo}</div>
                                  {finca && <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{finca.nombre}</div>}
                                </div>
                                <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', flexShrink: 0 }}>{p.supHa.toFixed(2)} ha</span>
                              </label>
                            )
                          })}
                        </div>
                      )}
                      {tParcelas.length > 0 && (
                        <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 5, background: 'var(--surface2)', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--green)' }}>
                          {tParcelas.length} parcela{tParcelas.length > 1 ? 's' : ''} · {misParcelas.filter(p => tParcelas.includes(p.id)).reduce((a, p) => a + p.supHa, 0).toFixed(4)} ha total
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {tError && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)' }}>⚠ {tError}</div>}
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
              <button onClick={guardarTratamiento} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>💾 GUARDAR</button>
              <button onClick={() => { setFormTrat(false); setTareaEnCreacionId(null) }} style={{ flex: 1, padding: '11px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>CANCELAR</button>
            </div>
          </div>
        </div>
      )}

      {/* Visor PDF ficha tecnica */}
      {fichaVisible && fitoSeleccionado?.pdf_url && pdfBlobUrl && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.92)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--green)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
              {fitoSeleccionado.nombre}
            </span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              <a
                href={pdfBlobUrl}
                download={`ficha_${fitoSeleccionado.id}.pdf`}
                style={{ padding: '6px 12px', borderRadius: 6, background: 'rgba(61,220,110,0.1)', border: '1px solid rgba(61,220,110,0.3)', color: 'var(--green)', fontFamily: 'var(--mono)', fontSize: 11, textDecoration: 'none', fontWeight: 700 }}
              >
                Descargar
              </a>
              <button
                onClick={() => { setFichaVisible(false); if (pdfBlobUrl) { URL.revokeObjectURL(pdfBlobUrl); setPdfBlobUrl(null) } }}
                style={{ padding: '6px 14px', borderRadius: 6, background: 'rgba(255,107,107,0.15)', border: '1px solid rgba(255,107,107,0.4)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer', fontWeight: 700 }}
              >
                X
              </button>
            </div>
          </div>
          {isMobile ? (
            /* Movil: visor PDF con object tag que funciona en Android/iOS */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, gap: 16 }}>
              <object
                data={pdfBlobUrl}
                type="application/pdf"
                style={{ width: '100%', height: '70vh', border: 'none', borderRadius: 8 }}
              >
                {/* Fallback si object no funciona en el movil */}
                <div style={{ textAlign: 'center', padding: 24 }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)', marginBottom: 20 }}>
                    {fitoSeleccionado.nombre}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 24 }}>
                    Tu navegador no puede mostrar el PDF en pantalla.
                  </div>
                  <a
                    href={pdfBlobUrl}
                    download={`ficha_${fitoSeleccionado.id}.pdf`}
                    style={{ display: 'inline-block', padding: '12px 24px', borderRadius: 8, background: 'var(--green)', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}
                  >
                    Descargar PDF
                  </a>
                </div>
              </object>
            </div>
          ) : (
            /* Desktop: iframe normal */
            <iframe
              src={pdfBlobUrl}
              style={{ flex: 1, border: 'none', width: '100%' }}
              title="Ficha tecnica producto"
            />
          )}
        </div>
      )}
    </div>
  )
}
