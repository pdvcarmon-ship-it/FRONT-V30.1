'use client'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
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

interface Props {
  session: Session | null
  fincas: FincaLite[]
  misParcelas: ParcelaLite[]
  isMobile: boolean
}

export default function RiegoTab({ session, fincas, misParcelas, isMobile }: Props) {
  const [cargado, setCargado] = useState(false)
  const [sistemas, setSistemas] = useState<SistemaRiego[]>([])
  const [sectores, setSectores] = useState<SectorRiego[]>([])
  const [eventos, setEventos] = useState<RiegoEvento[]>([])

  const [sistemaAbiertoId, setSistemaAbiertoId] = useState<string | null>(null)

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
  const [dibujandoSector, setDibujandoSector] = useState(false)
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

  // - Sistemas: abrir formulario -
  const abrirFormSistema = (s?: SistemaRiego) => {
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
    const secEnSistema = sectores.filter(s => s.sistemaId === id).length
    if (secEnSistema > 0) { alert(`Este sistema tiene ${secEnSistema} sector(es). Elimínalos antes.`); return }
    if (!confirm('¿Eliminar este sistema de riego?')) return
    setSistemas(sistemas.filter(s => s.id !== id))
    try { await supabase.from('sistemas_riego').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // - Sectores: abrir formulario -
  const abrirFormSector = (sistemaId: string, s?: SectorRiego) => {
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
    setSecError(''); setDibujandoSector(false)
  }

  // Al seleccionar una parcela en modo "dibujar en mapa", abre el mapa automáticamente
  useEffect(() => {
    if (formSector && secModo === 'dibujado' && secParcelaIds.length > 0 && !secGeojsonDibujado && !dibujandoSector) {
      setDibujandoSector(true)
    }
  }, [secModo, secParcelaIds, formSector])

  const parcelasDelSistema = (sistemaId: string): ParcelaLite[] => {
    const sis = sistemas.find(s => s.id === sistemaId)
    if (!sis) return []
    return misParcelas.filter(p => sis.parcelaIds.includes(p.id))
  }

  const parcelasSeleccionadasGeojson = (): any => {
    const seleccionadas = misParcelas.filter(p => secParcelaIds.includes(p.id))
    const features = seleccionadas.flatMap(p => p.geojson?.features || [])
    if (!features.length) return null
    return { type: 'FeatureCollection', features }
  }

  // Sectores ya dibujados del mismo sistema (excluyendo el que se está editando ahora mismo),
  // para mostrarlos como referencia mientras se dibuja uno nuevo
  const sectoresDibujadosDeReferencia = (sistemaId: string): any[] => {
    return sectores
      .filter(s => s.sistemaId === sistemaId && s.modoSuperficie === 'dibujado' && s.geojson && s.id !== sectorEditar?.id)
      .map(s => s.geojson)
  }

  const supHaCalculada = (): number => {
    if (secModo === 'dibujado') return secSupHaDibujada
    return misParcelas.filter(p => secParcelaIds.includes(p.id)).reduce((acc, p) => acc + (p.supHa || 0), 0)
  }

  const guardarSector = async () => {
    if (!formSector) return
    if (!secNombre.trim()) { setSecError('El nombre es obligatorio'); return }
    if (secModo === 'completa' && secParcelaIds.length === 0) { setSecError('Selecciona al menos una parcela'); return }
    if (secModo === 'dibujado' && !secGeojsonDibujado) { setSecError('Dibuja el sector en el mapa'); return }
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
    if (!confirm('¿Eliminar este sector de riego? También se borrarán sus riegos registrados.')) return
    setSectores(sectores.filter(s => s.id !== id))
    setEventos(eventos.filter(e => e.sectorId !== id))
    try { await supabase.from('sectores_riego').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // - Registro de riegos -
  const abrirFormRiego = (sectorId: string) => {
    setFormRiego(sectorId); setRFecha(new Date().toISOString().slice(0, 10)); setRHoras(''); setRObs('')
  }

  const guardarRiego = async () => {
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
    if (!confirm('¿Eliminar este riego registrado?')) return
    setEventos(eventos.filter(e => e.id !== id))
    try { await supabase.from('riegos_eventos').delete().eq('id', id) } catch (e) { console.error(e) }
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

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: isMobile ? 12 : 24, background: 'var(--bg)' }}>
      {/* Cabecera */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Riego</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
            {sistemas.length} sistema{sistemas.length !== 1 ? 's' : ''} · {sectores.length} sector{sectores.length !== 1 ? 'es' : ''}
          </div>
        </div>
        <button onClick={() => abrirFormSistema()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--blue)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ NUEVO SISTEMA</button>
      </div>

      {/* Lista de sistemas */}
      {sistemas.length === 0 && !formSistema && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12, border: '1px dashed var(--border)', borderRadius: 10 }}>
          Aún no has creado ningún sistema de riego.
        </div>
      )}

      {sistemas.map(sistema => {
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
                <button onClick={() => abrirFormSistema(sistema)} style={{ padding: '6px 12px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Editar</button>
                <button onClick={() => eliminarSistema(sistema.id)} style={{ padding: '6px 12px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>Eliminar</button>
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

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--blue)' }}>SECTORES DE RIEGO</div>
                  <button onClick={() => abrirFormSector(sistema.id)} style={{ padding: '6px 12px', borderRadius: 6, background: 'rgba(77,184,255,0.1)', border: '1px solid var(--blue)', color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>+ Añadir sector</button>
                </div>

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
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => abrirFormRiego(sector.id)} style={{ padding: '5px 10px', borderRadius: 6, background: 'var(--blue)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>+ Registrar riego</button>
                          <button onClick={() => abrirFormSector(sistema.id, sector)} style={{ padding: '5px 10px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>Editar</button>
                          <button onClick={() => eliminarSector(sector.id)} style={{ padding: '5px 10px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,107,107,0.3)', color: '#fca5a5', fontFamily: 'var(--mono)', fontSize: 10, cursor: 'pointer' }}>Eliminar</button>
                        </div>
                      </div>

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
                              <button onClick={() => eliminarRiego(ev.id)} style={{ background: 'transparent', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 10 }}>✕</button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Formulario de registro de riego */}
                      {formRiego === sector.id && (
                        <div style={{ marginTop: 10, padding: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6 }}>
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

                {/* Formulario de sector */}
                {formSector === sistema.id && (
                  <div style={{ marginTop: 12, padding: 14, background: 'var(--surface2)', border: '1px solid var(--blue)', borderRadius: 8 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--blue)', marginBottom: 10 }}>
                      {sectorEditar ? 'Editar sector' : 'Nuevo sector de riego'}
                    </div>

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
                        opciones={parcelasDelSistema(sistema.id)}
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
                          {!dibujandoSector ? (
                            <button onClick={() => setDibujandoSector(true)} style={{ width: '100%', padding: '8px', borderRadius: 6, background: 'rgba(77,184,255,0.1)', border: '1px solid var(--blue)', color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}>
                              {secGeojsonDibujado ? `✓ Sector dibujado (${secSupHaDibujada.toFixed(2)} ha) — Redibujar` : '🖊 Dibujar sector en el mapa'}
                            </button>
                          ) : (
                            <div style={{ height: 340, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', position: 'relative' }}>
                              {sectoresDibujadosDeReferencia(sistema.id).length > 0 && (
                                <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 1000, background: 'rgba(15,26,18,0.9)', border: '1px solid #ffb454', borderRadius: 6, padding: '4px 8px', fontSize: 9, fontFamily: 'var(--mono)', color: '#ffb454' }}>
                                  ⬤ En naranja: sectores ya dibujados
                                </div>
                              )}
                              <MapView
                                onParcelaClick={() => {}}
                                onParcelasDibujadas={(geojson: any, supHa: number) => {
                                  setSecGeojsonDibujado(geojson); setSecSupHaDibujada(supHa); setDibujandoSector(false)
                                }}
                                parcGeojson={parcelasSeleccionadasGeojson()}
                                extraGeojsons={sectoresDibujadosDeReferencia(sistema.id)}
                                imagenUrl={null}
                                indiceColor="#4db8ff"
                                seleccionando={false}
                                mododibujo={true}
                                onMododibujoCambiado={(activo: boolean) => { if (!activo) setDibujandoSector(false) }}
                              />
                            </div>
                          )}
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
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Formulario de sistema */}
      {formSistema && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--blue)', borderRadius: 10, padding: 16, marginTop: 8 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--blue)', marginBottom: 12 }}>
            {sistemaEditar ? 'Editar sistema de riego' : 'Nuevo sistema de riego'}
          </div>

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
      )}
    </div>
  )
}
