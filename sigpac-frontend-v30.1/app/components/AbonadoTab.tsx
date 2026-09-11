'use client'

import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import type { PermisoClave } from '../lib/permisos'

// - Tipos mínimos compartidos con page.tsx (duplicados a propósito para no acoplar) -
interface FincaLite { id: string; nombre: string }
interface CampanaLite { id: string; nombre: string }
interface ParcelaLite { id: string; nombre: string; cultivo: string; fincaId?: string }
interface HistoricoCultivoLite { parcelaId: string; cultivo: string; campanaId?: string }
interface EquipoLite { id: string; tipo: string; subtipo?: string; nombre: string; titularidad?: string }
interface PersonalLite { id: string; nombre: string; activo: boolean }

interface Props {
  session: Session
  fincas: FincaLite[]
  misParcelas: ParcelaLite[]
  campanas: CampanaLite[]
  historicoCultivos: HistoricoCultivoLite[]
  equipos: EquipoLite[]
  personal: PersonalLite[]
  isMobile: boolean
  misPermisos: Record<PermisoClave, boolean>
}

// 13 nutrientes con balance. pH y CE se llevan aparte, solo como referencia
// comparativa (un abono no los "aporta" de forma aditiva como a un nutriente).
type BaseNutriente = 'elemental' | 'oxido'
interface Nutrientes {
  n?: number; p?: number; k?: number; ca?: number; mg?: number; s?: number
  fe?: number; zn?: number; mn?: number; b?: number; cu?: number; cl?: number; mo?: number
}
const NUTRIENTES_LISTA: { clave: keyof Nutrientes; etiqueta: string }[] = [
  { clave: 'n', etiqueta: 'N' }, { clave: 'p', etiqueta: 'P' }, { clave: 'k', etiqueta: 'K' },
  { clave: 'ca', etiqueta: 'Ca' }, { clave: 'mg', etiqueta: 'Mg' }, { clave: 's', etiqueta: 'S' },
  { clave: 'fe', etiqueta: 'Fe' }, { clave: 'zn', etiqueta: 'Zn' }, { clave: 'mn', etiqueta: 'Mn' },
  { clave: 'b', etiqueta: 'B' }, { clave: 'cu', etiqueta: 'Cu' }, { clave: 'cl', etiqueta: 'Cl' }, { clave: 'mo', etiqueta: 'Mo' },
]
const NUTRIENTES_VACIO: Nutrientes = { n:0,p:0,k:0,ca:0,mg:0,s:0,fe:0,zn:0,mn:0,b:0,cu:0,cl:0,mo:0 }
const FACTOR_P2O5 = 2.29
const FACTOR_K2O = 1.205

interface AnalisisSuelo {
  id: string
  parcelaIds: string[]
  fechaMuestra: string
  laboratorio: string
  archivoUrl?: string
  materiaOrganica?: number
  nutrientes: Nutrientes       // kg/ha
  pBase: BaseNutriente
  kBase: BaseNutriente
  ph?: number
  ce?: number
}

interface NecesidadCultivo {
  id: string
  cultivo: string
  variedad?: string
  objetivoRendimiento?: string
  nutrientes: Nutrientes       // kg/ha
  pBase: BaseNutriente
  kBase: BaseNutriente
}

interface AbonoCatalogo {
  id: string
  nombre: string
  fabricante?: string
  numRegistro?: string
  tipo: 'organico' | 'inorganico' | ''
  estadoFisico: 'solido' | 'liquido' | ''
  densidad?: number
  nutrientes: Nutrientes       // % composición garantizada
  pBase: BaseNutriente
  kBase: BaseNutriente
}

interface PlanAbonado {
  id: string
  campanaId: string
  fincaId: string
  parcelaId: string
  cultivo: string
  fecha: string
  analisisId?: string
  sueloInicial: Nutrientes & { ph?: number; ce?: number }     // fotografía fija
  necesidadCultivoId?: string
  necesidadesCultivo: Nutrientes                              // fotografía fija
  modoObjetivo: 'mantener' | 'manual'
  sueloObjetivo: Nutrientes & { ph?: number; ce?: number }
  abonoId?: string
  abonoNombre: string
  abonoTipo: 'organico' | 'inorganico' | ''
  abonoComposicion: Nutrientes                                // fotografía fija
  dosisKgHa: number
  balance: Nutrientes
  recomienda?: string
  ejecuta?: string
  fechaAplicacion?: string
  equipoIds: string[]
}

const normalizarPK = (nut: Nutrientes, pBase: BaseNutriente, kBase: BaseNutriente): Nutrientes => ({
  ...nut,
  p: nut.p != null ? (pBase === 'elemental' ? nut.p * FACTOR_P2O5 : nut.p) : nut.p,
  k: nut.k != null ? (kBase === 'elemental' ? nut.k * FACTOR_K2O : nut.k) : nut.k,
})

const inputStyle = (soloLectura?: boolean): React.CSSProperties => ({
  width: '100%', background: soloLectura ? 'var(--surface)' : 'var(--surface2)', border: '1px solid var(--border)',
  borderRadius: 5, padding: '6px 8px', color: 'var(--text)', fontSize: 11, fontFamily: 'var(--mono)', outline: 'none',
})

function FilaNutrientes({ valores, onChange, soloLectura }: { valores: Nutrientes; onChange?: (n: Nutrientes) => void; soloLectura?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(68px,1fr))', gap: 6 }}>
      {NUTRIENTES_LISTA.map(nu => (
        <div key={nu.clave}>
          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 2 }}>{nu.etiqueta} (kg/ha)</div>
          <input type="number" step="any" disabled={soloLectura} value={valores[nu.clave] ?? ''}
            onChange={e => onChange && onChange({ ...valores, [nu.clave]: e.target.value === '' ? undefined : Number(e.target.value) })}
            style={inputStyle(soloLectura)} />
        </div>
      ))}
    </div>
  )
}

function FilaNutrientesPct({ valores, onChange, soloLectura }: { valores: Nutrientes; onChange?: (n: Nutrientes) => void; soloLectura?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(68px,1fr))', gap: 6 }}>
      {NUTRIENTES_LISTA.map(nu => (
        <div key={nu.clave}>
          <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 2 }}>{nu.etiqueta} (%)</div>
          <input type="number" step="any" disabled={soloLectura} value={valores[nu.clave] ?? ''}
            onChange={e => onChange && onChange({ ...valores, [nu.clave]: e.target.value === '' ? undefined : Number(e.target.value) })}
            style={inputStyle(soloLectura)} />
        </div>
      ))}
    </div>
  )
}

function SelectorBase({ valor, onChange, soloLectura }: { valor: BaseNutriente; onChange?: (b: BaseNutriente) => void; soloLectura?: boolean }) {
  return (
    <select disabled={soloLectura} value={valor} onChange={e => onChange && onChange(e.target.value as BaseNutriente)} style={inputStyle(soloLectura)}>
      <option value="elemental">P/K elemental</option>
      <option value="oxido">P₂O₅ / K₂O (óxido)</option>
    </select>
  )
}

export default function AbonadoTab({ session, fincas, misParcelas, campanas, historicoCultivos, equipos, personal, isMobile, misPermisos }: Props) {
  const [subTab, setSubTab] = useState<'plan' | 'analisis' | 'necesidades' | 'catalogo'>('plan')
  const [analisis, setAnalisis] = useState<AnalisisSuelo[]>([])
  const [necesidades, setNecesidades] = useState<NecesidadCultivo[]>([])
  const [abonos, setAbonos] = useState<AbonoCatalogo[]>([])
  const [planes, setPlanes] = useState<PlanAbonado[]>([])
  const [cargado, setCargado] = useState(false)

  const puedeEditar = !!misPermisos['abonado.crear_editar']
  const puedeEliminar = !!misPermisos['abonado.eliminar']

  useEffect(() => {
    if (!session || cargado) return
    (async () => {
      const [aRes, nRes, abRes, pRes] = await Promise.all([
        supabase.from('analisis_suelo').select('*').order('fecha_muestra', { ascending: false }),
        supabase.from('necesidades_cultivo').select('*').order('cultivo', { ascending: true }),
        supabase.from('catalogo_abonos').select('*').order('nombre', { ascending: true }),
        supabase.from('planes_abonado').select('*').order('fecha', { ascending: false }),
      ])
      if (aRes.data) setAnalisis(aRes.data.map((a: any) => ({
        id: a.id, parcelaIds: Array.isArray(a.parcela_ids) ? a.parcela_ids : [],
        fechaMuestra: a.fecha_muestra, laboratorio: a.laboratorio || '', archivoUrl: a.archivo_url || undefined,
        materiaOrganica: a.materia_organica != null ? Number(a.materia_organica) : undefined,
        nutrientes: { ...NUTRIENTES_VACIO, ...(a.nutrientes || {}) },
        pBase: a.p_base || 'elemental', kBase: a.k_base || 'elemental',
        ph: a.ph != null ? Number(a.ph) : undefined, ce: a.ce != null ? Number(a.ce) : undefined,
      })))
      if (nRes.data) setNecesidades(nRes.data.map((n: any) => ({
        id: n.id, cultivo: n.cultivo, variedad: n.variedad || undefined, objetivoRendimiento: n.objetivo_rendimiento || undefined,
        nutrientes: { ...NUTRIENTES_VACIO, ...(n.nutrientes || {}) }, pBase: n.p_base || 'elemental', kBase: n.k_base || 'elemental',
      })))
      if (abRes.data) setAbonos(abRes.data.map((ab: any) => ({
        id: ab.id, nombre: ab.nombre, fabricante: ab.fabricante || undefined, numRegistro: ab.num_registro || undefined,
        tipo: ab.tipo || '', estadoFisico: ab.estado_fisico || '', densidad: ab.densidad != null ? Number(ab.densidad) : undefined,
        nutrientes: { ...NUTRIENTES_VACIO, ...(ab.nutrientes || {}) }, pBase: ab.p_base || 'elemental', kBase: ab.k_base || 'elemental',
      })))
      if (pRes.data) setPlanes(pRes.data.map((pl: any) => ({
        id: pl.id, campanaId: pl.campana_id || '', fincaId: pl.finca_id || '', parcelaId: pl.parcela_id || '',
        cultivo: pl.cultivo || '', fecha: pl.fecha, analisisId: pl.analisis_id || undefined,
        sueloInicial: { ...NUTRIENTES_VACIO, ...(pl.suelo_inicial || {}) },
        necesidadCultivoId: pl.necesidad_cultivo_id || undefined,
        necesidadesCultivo: { ...NUTRIENTES_VACIO, ...(pl.necesidades_cultivo || {}) },
        modoObjetivo: pl.modo_objetivo || 'mantener',
        sueloObjetivo: { ...NUTRIENTES_VACIO, ...(pl.suelo_objetivo || {}) },
        abonoId: pl.abono_id || undefined, abonoNombre: pl.abono_nombre || '', abonoTipo: pl.abono_tipo || '',
        abonoComposicion: { ...NUTRIENTES_VACIO, ...(pl.abono_composicion || {}) }, dosisKgHa: Number(pl.dosis_kg_ha) || 0,
        balance: { ...NUTRIENTES_VACIO, ...(pl.balance || {}) },
        recomienda: pl.recomienda || undefined, ejecuta: pl.ejecuta || undefined, fechaAplicacion: pl.fecha_aplicacion || undefined,
        equipoIds: Array.isArray(pl.equipo_ids) ? pl.equipo_ids : [],
      })))
      setCargado(true)
    })()
  }, [session, cargado])

  // ---------- Análisis de suelo ----------
  const [formAnalisis, setFormAnalisis] = useState(false)
  const [analisisEditar, setAnalisisEditar] = useState<AnalisisSuelo | null>(null)
  const [aParcelaIds, setAParcelaIds] = useState<string[]>([])
  const [aFecha, setAFecha] = useState('')
  const [aLab, setALab] = useState('')
  const [aMO, setAMO] = useState<number | undefined>(undefined)
  const [aNut, setANut] = useState<Nutrientes>({ ...NUTRIENTES_VACIO })
  const [aPBase, setAPBase] = useState<BaseNutriente>('elemental')
  const [aKBase, setAKBase] = useState<BaseNutriente>('elemental')
  const [aPh, setAPh] = useState<number | undefined>(undefined)
  const [aCe, setACe] = useState<number | undefined>(undefined)
  const [aError, setAError] = useState('')

  const abrirFormAnalisis = (a?: AnalisisSuelo) => {
    setAnalisisEditar(a || null)
    setAParcelaIds(a?.parcelaIds || []); setAFecha(a?.fechaMuestra || new Date().toISOString().slice(0, 10))
    setALab(a?.laboratorio || ''); setAMO(a?.materiaOrganica)
    setANut(a?.nutrientes ? { ...a.nutrientes } : { ...NUTRIENTES_VACIO })
    setAPBase(a?.pBase || 'elemental'); setAKBase(a?.kBase || 'elemental')
    setAPh(a?.ph); setACe(a?.ce); setAError(''); setFormAnalisis(true)
  }

  const guardarAnalisis = async () => {
    if (aParcelaIds.length === 0) { setAError('Selecciona al menos una parcela'); return }
    if (!aFecha) { setAError('La fecha de muestra es obligatoria'); return }
    const nuevo: AnalisisSuelo = {
      id: analisisEditar?.id || String(Date.now()), parcelaIds: aParcelaIds, fechaMuestra: aFecha, laboratorio: aLab.trim(),
      materiaOrganica: aMO, nutrientes: aNut, pBase: aPBase, kBase: aKBase, ph: aPh, ce: aCe,
    }
    const lista = analisisEditar ? analisis.map(a => a.id === analisisEditar.id ? nuevo : a) : [nuevo, ...analisis]
    setAnalisis(lista)
    try {
      const { error } = await supabase.from('analisis_suelo').upsert({
        id: nuevo.id, user_id: session.user.id, parcela_ids: nuevo.parcelaIds, fecha_muestra: nuevo.fechaMuestra,
        laboratorio: nuevo.laboratorio || null, materia_organica: nuevo.materiaOrganica ?? null,
        nutrientes: nuevo.nutrientes, p_base: nuevo.pBase, k_base: nuevo.kBase, ph: nuevo.ph ?? null, ce: nuevo.ce ?? null,
      })
      if (error) { setAError('No se pudo guardar: ' + error.message); return }
    } catch (e) { setAError('No se pudo guardar en la base de datos.'); return }
    setFormAnalisis(false); setAnalisisEditar(null)
  }

  const eliminarAnalisis = async (id: string) => {
    if (!confirm('¿Eliminar este análisis de suelo?')) return
    setAnalisis(analisis.filter(a => a.id !== id))
    try { await supabase.from('analisis_suelo').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // ---------- Necesidades por cultivo ----------
  const [formNec, setFormNec] = useState(false)
  const [necEditar, setNecEditar] = useState<NecesidadCultivo | null>(null)
  const [nCultivo, setNCultivo] = useState('')
  const [nVariedad, setNVariedad] = useState('')
  const [nObjetivo, setNObjetivo] = useState('')
  const [nNut, setNNut] = useState<Nutrientes>({ ...NUTRIENTES_VACIO })
  const [nPBase, setNPBase] = useState<BaseNutriente>('elemental')
  const [nKBase, setNKBase] = useState<BaseNutriente>('elemental')
  const [nError, setNError] = useState('')

  const abrirFormNec = (n?: NecesidadCultivo, cultivoPrefill?: string) => {
    setNecEditar(n || null)
    setNCultivo(n?.cultivo || cultivoPrefill || ''); setNVariedad(n?.variedad || ''); setNObjetivo(n?.objetivoRendimiento || '')
    setNNut(n?.nutrientes ? { ...n.nutrientes } : { ...NUTRIENTES_VACIO })
    setNPBase(n?.pBase || 'elemental'); setNKBase(n?.kBase || 'elemental'); setNError(''); setFormNec(true)
  }

  const guardarNecesidad = async (): Promise<NecesidadCultivo | null> => {
    if (!nCultivo.trim()) { setNError('El nombre del cultivo es obligatorio'); return null }
    const nuevo: NecesidadCultivo = {
      id: necEditar?.id || String(Date.now()), cultivo: nCultivo.trim(), variedad: nVariedad.trim() || undefined,
      objetivoRendimiento: nObjetivo.trim() || undefined, nutrientes: nNut, pBase: nPBase, kBase: nKBase,
    }
    const lista = necEditar ? necesidades.map(n => n.id === necEditar.id ? nuevo : n) : [nuevo, ...necesidades]
    setNecesidades(lista)
    try {
      const { error } = await supabase.from('necesidades_cultivo').upsert({
        id: nuevo.id, user_id: session.user.id, cultivo: nuevo.cultivo, variedad: nuevo.variedad || null,
        objetivo_rendimiento: nuevo.objetivoRendimiento || null, nutrientes: nuevo.nutrientes, p_base: nuevo.pBase, k_base: nuevo.kBase,
      })
      if (error) { setNError('No se pudo guardar: ' + error.message); return null }
    } catch (e) { setNError('No se pudo guardar en la base de datos.'); return null }
    setFormNec(false); setNecEditar(null)
    return nuevo
  }

  const eliminarNecesidad = async (id: string) => {
    if (!confirm('¿Eliminar esta ficha de necesidades?')) return
    setNecesidades(necesidades.filter(n => n.id !== id))
    try { await supabase.from('necesidades_cultivo').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // ---------- Catálogo de abonos ----------
  const [formAbono, setFormAbono] = useState(false)
  const [abonoEditar, setAbonoEditar] = useState<AbonoCatalogo | null>(null)
  const [abNombre, setAbNombre] = useState('')
  const [abFabricante, setAbFabricante] = useState('')
  const [abRegistro, setAbRegistro] = useState('')
  const [abTipo, setAbTipo] = useState<'organico' | 'inorganico' | ''>('')
  const [abEstado, setAbEstado] = useState<'solido' | 'liquido' | ''>('')
  const [abDensidad, setAbDensidad] = useState<number | undefined>(undefined)
  const [abNut, setAbNut] = useState<Nutrientes>({ ...NUTRIENTES_VACIO })
  const [abPBase, setAbPBase] = useState<BaseNutriente>('elemental')
  const [abKBase, setAbKBase] = useState<BaseNutriente>('elemental')
  const [abError, setAbError] = useState('')

  const abrirFormAbono = (ab?: AbonoCatalogo, nombrePrefill?: string) => {
    setAbonoEditar(ab || null)
    setAbNombre(ab?.nombre || nombrePrefill || ''); setAbFabricante(ab?.fabricante || ''); setAbRegistro(ab?.numRegistro || '')
    setAbTipo(ab?.tipo || ''); setAbEstado(ab?.estadoFisico || ''); setAbDensidad(ab?.densidad)
    setAbNut(ab?.nutrientes ? { ...ab.nutrientes } : { ...NUTRIENTES_VACIO })
    setAbPBase(ab?.pBase || 'elemental'); setAbKBase(ab?.kBase || 'elemental'); setAbError(''); setFormAbono(true)
  }

  const guardarAbono = async (): Promise<AbonoCatalogo | null> => {
    if (!abNombre.trim()) { setAbError('El nombre / marca comercial es obligatorio'); return null }
    if (!abTipo) { setAbError('Indica si es orgánico o inorgánico'); return null }
    const nuevo: AbonoCatalogo = {
      id: abonoEditar?.id || String(Date.now()), nombre: abNombre.trim(), fabricante: abFabricante.trim() || undefined,
      numRegistro: abRegistro.trim() || undefined, tipo: abTipo, estadoFisico: abEstado, densidad: abDensidad,
      nutrientes: abNut, pBase: abPBase, kBase: abKBase,
    }
    const lista = abonoEditar ? abonos.map(a => a.id === abonoEditar.id ? nuevo : a) : [nuevo, ...abonos]
    setAbonos(lista)
    try {
      const { error } = await supabase.from('catalogo_abonos').upsert({
        id: nuevo.id, user_id: session.user.id, nombre: nuevo.nombre, fabricante: nuevo.fabricante || null,
        num_registro: nuevo.numRegistro || null, tipo: nuevo.tipo, estado_fisico: nuevo.estadoFisico || null,
        densidad: nuevo.densidad ?? null, nutrientes: nuevo.nutrientes, p_base: nuevo.pBase, k_base: nuevo.kBase,
      })
      if (error) { setAbError('No se pudo guardar: ' + error.message); return null }
    } catch (e) { setAbError('No se pudo guardar en la base de datos.'); return null }
    setFormAbono(false); setAbonoEditar(null)
    return nuevo
  }

  const eliminarAbono = async (id: string) => {
    if (!confirm('¿Eliminar este abono del catálogo?')) return
    setAbonos(abonos.filter(a => a.id !== id))
    try { await supabase.from('catalogo_abonos').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // ---------- Plan de abonado (4.0 - 4.6) ----------
  const [pCampanaId, setPCampanaId] = useState('')
  const [pFincaId, setPFincaId] = useState('')
  const [pParcelaId, setPParcelaId] = useState('')
  const [pModoObjetivo, setPModoObjetivo] = useState<'mantener' | 'manual'>('mantener')
  const [pSueloObjetivo, setPSueloObjetivo] = useState<Nutrientes & { ph?: number; ce?: number }>({ ...NUTRIENTES_VACIO })
  const [pAbonoId, setPAbonoId] = useState('')
  const [pDosis, setPDosis] = useState<number>(0)
  const [pRecomienda, setPRecomienda] = useState('')
  const [pEjecuta, setPEjecuta] = useState('')
  const [pFechaAplicacion, setPFechaAplicacion] = useState('')
  const [pEquipoIds, setPEquipoIds] = useState<string[]>([])
  const [pError, setPError] = useState('')
  // Borrador de necesidad "al vuelo" cuando el cultivo no tiene ficha
  const [necNuevaDraft, setNecNuevaDraft] = useState<Nutrientes>({ ...NUTRIENTES_VACIO })
  // Borrador de abono "de alta rápida" cuando no existe en el catálogo
  const [abonoNuevoNombre, setAbonoNuevoNombre] = useState('')
  const [abonoNuevoTipo, setAbonoNuevoTipo] = useState<'organico' | 'inorganico' | ''>('')
  const [abonoNuevoNut, setAbonoNuevoNut] = useState<Nutrientes>({ ...NUTRIENTES_VACIO })

  const cultivoDeParcelaEnCampana = (parcelaId: string, campanaId: string): string => {
    const hist = historicoCultivos.find(h => h.parcelaId === parcelaId && h.campanaId === campanaId)
    if (hist) return hist.cultivo
    return misParcelas.find(p => p.id === parcelaId)?.cultivo || ''
  }

  const parcelasDeFinca = misParcelas.filter(p => !pFincaId || p.fincaId === pFincaId)
  const cultivoActual = pParcelaId && pCampanaId ? cultivoDeParcelaEnCampana(pParcelaId, pCampanaId) : ''
  const analisisVigente = pParcelaId ? analisis.find(a => a.parcelaIds.includes(pParcelaId)) : undefined
  const necesidadExistente = cultivoActual ? necesidades.find(n => n.cultivo.toLowerCase() === cultivoActual.toLowerCase()) : undefined
  const abonoSel = pAbonoId ? abonos.find(a => a.id === pAbonoId) : undefined

  // Base común para combinar en el balance: siempre óxido para P/K
  const sueloInicialNorm: Nutrientes & { ph?: number; ce?: number } = analisisVigente
    ? { ...normalizarPK(analisisVigente.nutrientes, analisisVigente.pBase, analisisVigente.kBase), ph: analisisVigente.ph, ce: analisisVigente.ce }
    : { ...NUTRIENTES_VACIO }
  const necesidadesNorm: Nutrientes = necesidadExistente
    ? normalizarPK(necesidadExistente.nutrientes, necesidadExistente.pBase, necesidadExistente.kBase)
    : normalizarPK(necNuevaDraft, 'elemental', 'elemental')
  const sueloObjetivoNorm: Nutrientes & { ph?: number; ce?: number } = pModoObjetivo === 'mantener'
    ? sueloInicialNorm
    : { ...normalizarPK(pSueloObjetivo, 'elemental', 'elemental'), ph: pSueloObjetivo.ph, ce: pSueloObjetivo.ce }

  const composicionAbonoActiva: Nutrientes = pAbonoId
    ? (abonoSel ? abonoSel.nutrientes : { ...NUTRIENTES_VACIO })
    : abonoNuevoNut
  const composicionAbonoBase: { p: BaseNutriente; k: BaseNutriente } = pAbonoId
    ? { p: abonoSel?.pBase || 'elemental', k: abonoSel?.kBase || 'elemental' }
    : { p: 'elemental', k: 'elemental' }

  // "Aporte real" (4.4): composición tal cual está declarada × dosis. Si pones el
  // mismo % en todos los nutrientes, el aporte sale igual en todos — sin sorpresas.
  const aporteAbono: Nutrientes = Object.fromEntries(
    NUTRIENTES_LISTA.map(nu => [nu.clave, ((composicionAbonoActiva[nu.clave] || 0) / 100) * (pDosis || 0)])
  ) as Nutrientes

  // Balance (4.5): aquí sí se normaliza P/K de los 4 términos a equivalente óxido
  // (P₂O₅ / K₂O) antes de sumar/restar, porque si no, un P "elemental" y un P
  // "óxido" no son la misma cantidad y el balance mentiría. Por eso el aporte de
  // abono usado en el balance no es igual al "aporte real" de arriba si el abono
  // está declarado en base elemental: ese es el único sitio donde se aplica el
  // factor (×2,29 en P, ×1,205 en K), y se avisa junto a esos dos números.
  const aporteAbonoNormalizado: Nutrientes = normalizarPK(aporteAbono, composicionAbonoBase.p, composicionAbonoBase.k)

  const balance: Nutrientes = Object.fromEntries(
    NUTRIENTES_LISTA.map(nu => [nu.clave,
      (sueloInicialNorm[nu.clave] || 0) + (aporteAbonoNormalizado[nu.clave] || 0) - (necesidadesNorm[nu.clave] || 0) - (sueloObjetivoNorm[nu.clave] || 0)
    ])
  ) as Nutrientes

  const resetearFormularioPlan = () => {
    setPCampanaId(''); setPFincaId(''); setPParcelaId(''); setPModoObjetivo('mantener')
    setPSueloObjetivo({ ...NUTRIENTES_VACIO }); setPAbonoId(''); setPDosis(0)
    setPRecomienda(''); setPEjecuta(''); setPFechaAplicacion(''); setPEquipoIds([])
    setNecNuevaDraft({ ...NUTRIENTES_VACIO }); setAbonoNuevoNombre(''); setAbonoNuevoTipo(''); setAbonoNuevoNut({ ...NUTRIENTES_VACIO })
    setPError('')
  }

  const guardarPlan = async () => {
    if (!pCampanaId || !pFincaId || !pParcelaId) { setPError('Selecciona campaña, finca y parcela'); return }
    if (!analisisVigente) { setPError('Esta parcela no tiene un análisis de suelo vigente. Cárgalo antes en "Análisis de suelo".'); return }
    if (!pAbonoId && !abonoNuevoNombre.trim()) { setPError('Selecciona un abono del catálogo o da uno de alta rápida'); return }
    if (!pDosis || pDosis <= 0) { setPError('Indica la dosis de abono a aplicar (kg/ha)'); return }

    let necesidadUsadaId = necesidadExistente?.id
    if (!necesidadExistente) {
      // No existía ficha para este cultivo: se crea ahora en subpestaña 2, con lo introducido aquí
      setNCultivo(cultivoActual); setNVariedad(''); setNObjetivo(''); setNNut(necNuevaDraft)
      setNPBase('elemental'); setNKBase('elemental'); setNecEditar(null)
      const creada = await new Promise<NecesidadCultivo | null>(resolve => {
        // Reutiliza guardarNecesidad() con el estado que acabamos de fijar arriba
        setTimeout(async () => resolve(await guardarNecesidad()), 0)
      })
      necesidadUsadaId = creada?.id
    }

    let abonoUsadoId = pAbonoId
    let abonoNombreFinal = abonoSel?.nombre || ''
    let abonoTipoFinal: 'organico' | 'inorganico' | '' = abonoSel?.tipo || ''
    if (!pAbonoId && abonoNuevoNombre.trim()) {
      setAbNombre(abonoNuevoNombre); setAbFabricante(''); setAbRegistro(''); setAbTipo(abonoNuevoTipo || 'inorganico')
      setAbEstado(''); setAbDensidad(undefined); setAbNut(abonoNuevoNut); setAbPBase('elemental'); setAbKBase('elemental'); setAbonoEditar(null)
      const creado = await new Promise<AbonoCatalogo | null>(resolve => {
        setTimeout(async () => resolve(await guardarAbono()), 0)
      })
      abonoUsadoId = creado?.id || ''
      abonoNombreFinal = creado?.nombre || abonoNuevoNombre
      abonoTipoFinal = creado?.tipo || abonoNuevoTipo || ''
    }

    const nuevo: PlanAbonado = {
      id: String(Date.now()), campanaId: pCampanaId, fincaId: pFincaId, parcelaId: pParcelaId, cultivo: cultivoActual,
      fecha: new Date().toISOString().slice(0, 10), analisisId: analisisVigente.id,
      sueloInicial: sueloInicialNorm, necesidadCultivoId: necesidadUsadaId, necesidadesCultivo: necesidadesNorm,
      modoObjetivo: pModoObjetivo, sueloObjetivo: sueloObjetivoNorm,
      abonoId: abonoUsadoId || undefined, abonoNombre: abonoNombreFinal, abonoTipo: abonoTipoFinal,
      abonoComposicion: composicionAbonoActiva, dosisKgHa: pDosis, balance,
      recomienda: pRecomienda.trim() || undefined, ejecuta: pEjecuta.trim() || undefined,
      fechaAplicacion: pFechaAplicacion || undefined, equipoIds: pEquipoIds,
    }
    setPlanes([nuevo, ...planes])
    try {
      const { error } = await supabase.from('planes_abonado').insert({
        id: nuevo.id, user_id: session.user.id, campana_id: nuevo.campanaId, finca_id: nuevo.fincaId, parcela_id: nuevo.parcelaId,
        cultivo: nuevo.cultivo, fecha: nuevo.fecha, analisis_id: nuevo.analisisId,
        suelo_inicial: nuevo.sueloInicial, necesidad_cultivo_id: nuevo.necesidadCultivoId || null, necesidades_cultivo: nuevo.necesidadesCultivo,
        modo_objetivo: nuevo.modoObjetivo, suelo_objetivo: nuevo.sueloObjetivo,
        abono_id: nuevo.abonoId || null, abono_nombre: nuevo.abonoNombre, abono_tipo: nuevo.abonoTipo,
        abono_composicion: nuevo.abonoComposicion, dosis_kg_ha: nuevo.dosisKgHa, balance: nuevo.balance,
        recomienda: nuevo.recomienda || null, ejecuta: nuevo.ejecuta || null, fecha_aplicacion: nuevo.fechaAplicacion || null,
        equipo_ids: nuevo.equipoIds,
      })
      if (error) { setPError('No se pudo guardar el plan: ' + error.message); return }
    } catch (e) { setPError('No se pudo guardar el plan en la base de datos.'); return }
    resetearFormularioPlan()
  }

  const eliminarPlan = async (id: string) => {
    if (!puedeEliminar) return
    if (!confirm('¿Eliminar este plan de abonado ya guardado?')) return
    setPlanes(planes.filter(p => p.id !== id))
    try { await supabase.from('planes_abonado').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  const balanceColor = (v: number) => v > 0.01 ? 'var(--blue)' : v < -0.01 ? 'var(--red)' : 'var(--green)'

  return (
    <div style={{ flex: 1, height: '100%', overflow: 'auto', padding: isMobile ? 12 : 24, background: 'var(--bg)' }}>

      {/* Cabecera */}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 16 }}>🌱 Plan de abonado</div>

      {/* Navegación subpestañas */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {(['plan', 'analisis', 'necesidades', 'catalogo'] as const).map(st => (
          <button key={st} onClick={() => setSubTab(st)}
            style={{ padding: '8px 16px', border: 'none', background: 'transparent', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer', color: 'var(--text)', borderBottom: `2px solid ${subTab === st ? 'var(--green)' : 'transparent'}`, letterSpacing: '0.06em', marginBottom: -1, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {st === 'plan' ? '🧮 PLAN DE ABONADO' : st === 'analisis' ? '🧪 ANÁLISIS DE SUELO' : st === 'necesidades' ? '🌾 NECESIDADES POR CULTIVO' : '📦 CATÁLOGO DE ABONOS'}
          </button>
        ))}
      </div>

      {/* ---------------- SUBPESTAÑA: ANÁLISIS DE SUELO ---------------- */}
      {subTab === 'analisis' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {puedeEditar && (
              <button onClick={() => abrirFormAnalisis()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ NUEVO ANÁLISIS</button>
            )}
          </div>
          {formAnalisis && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>{analisisEditar ? 'Editar análisis' : 'Nuevo análisis de suelo'}</div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Parcelas asociadas</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {misParcelas.map(p => (
                  <button key={p.id} onClick={() => setAParcelaIds(ids => ids.includes(p.id) ? ids.filter(i => i !== p.id) : [...ids, p.id])}
                    style={{ padding: '4px 10px', borderRadius: 14, fontSize: 10, fontFamily: 'var(--mono)', cursor: 'pointer', background: aParcelaIds.includes(p.id) ? 'var(--green)' : 'var(--surface2)', color: aParcelaIds.includes(p.id) ? 'var(--bg)' : 'var(--text)', border: '1px solid var(--border)' }}>
                    {p.nombre}
                  </button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Fecha de muestra</div>
                  <input type="date" value={aFecha} onChange={e => setAFecha(e.target.value)} style={inputStyle()} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Laboratorio</div>
                  <input value={aLab} onChange={e => setALab(e.target.value)} style={inputStyle()} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Materia orgánica (%)</div>
                  <input type="number" step="any" value={aMO ?? ''} onChange={e => setAMO(e.target.value === '' ? undefined : Number(e.target.value))} style={inputStyle()} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>pH</div>
                  <input type="number" step="any" value={aPh ?? ''} onChange={e => setAPh(e.target.value === '' ? undefined : Number(e.target.value))} style={inputStyle()} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>CE (dS/m)</div>
                  <input type="number" step="any" value={aCe ?? ''} onChange={e => setACe(e.target.value === '' ? undefined : Number(e.target.value))} style={inputStyle()} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Base P</div><SelectorBase valor={aPBase} onChange={setAPBase} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Base K</div><SelectorBase valor={aKBase} onChange={setAKBase} /></div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 4 }}>Nutrientes (kg/ha)</div>
              <FilaNutrientes valores={aNut} onChange={setANut} />
              {aError && <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)' }}>{aError}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={guardarAnalisis} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>GUARDAR</button>
                <button onClick={() => { setFormAnalisis(false); setAnalisisEditar(null) }} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>CANCELAR</button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {analisis.length === 0 && <div style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>Sin análisis registrados.</div>}
            {analisis.map(a => (
              <div key={a.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{a.fechaMuestra} · {a.laboratorio || 'Sin laboratorio'}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{a.parcelaIds.map(id => misParcelas.find(p => p.id === id)?.nombre || id).join(', ')}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {puedeEditar && <button onClick={() => abrirFormAnalisis(a)} style={{ fontSize: 9, color: 'var(--text)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Editar</button>}
                    {puedeEliminar && <button onClick={() => eliminarAnalisis(a.id)} style={{ fontSize: 9, color: 'var(--red)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Eliminar</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- SUBPESTAÑA: NECESIDADES POR CULTIVO ---------------- */}
      {subTab === 'necesidades' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {puedeEditar && (
              <button onClick={() => abrirFormNec()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ NUEVA FICHA</button>
            )}
          </div>
          {formNec && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>{necEditar ? 'Editar necesidades' : 'Nueva ficha de necesidades'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Cultivo</div>
                  <input value={nCultivo} onChange={e => setNCultivo(e.target.value)} style={inputStyle()} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Variedad (opcional)</div>
                  <input value={nVariedad} onChange={e => setNVariedad(e.target.value)} style={inputStyle()} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Objetivo de rendimiento (opcional)</div>
                  <input value={nObjetivo} onChange={e => setNObjetivo(e.target.value)} style={inputStyle()} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Base P</div><SelectorBase valor={nPBase} onChange={setNPBase} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Base K</div><SelectorBase valor={nKBase} onChange={setNKBase} /></div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 4 }}>Necesidades (kg/ha)</div>
              <FilaNutrientes valores={nNut} onChange={setNNut} />
              {nError && <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)' }}>{nError}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={guardarNecesidad} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>GUARDAR</button>
                <button onClick={() => { setFormNec(false); setNecEditar(null) }} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>CANCELAR</button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {necesidades.length === 0 && <div style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>Sin fichas de cultivo registradas.</div>}
            {necesidades.map(n => (
              <div key={n.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{n.cultivo}{n.variedad ? ` (${n.variedad})` : ''}</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {puedeEditar && <button onClick={() => abrirFormNec(n)} style={{ fontSize: 9, color: 'var(--text)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Editar</button>}
                    {puedeEliminar && <button onClick={() => eliminarNecesidad(n.id)} style={{ fontSize: 9, color: 'var(--red)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Eliminar</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- SUBPESTAÑA: CATÁLOGO DE ABONOS ---------------- */}
      {subTab === 'catalogo' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {puedeEditar && (
              <button onClick={() => abrirFormAbono()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ NUEVO ABONO</button>
            )}
          </div>
          {formAbono && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>{abonoEditar ? 'Editar abono' : 'Nuevo abono'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Nombre / marca comercial</div>
                  <input value={abNombre} onChange={e => setAbNombre(e.target.value)} style={inputStyle()} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Fabricante</div>
                  <input value={abFabricante} onChange={e => setAbFabricante(e.target.value)} style={inputStyle()} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Nº registro (REGFER)</div>
                  <input value={abRegistro} onChange={e => setAbRegistro(e.target.value)} style={inputStyle()} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Orgánico / Inorgánico</div>
                  <select value={abTipo} onChange={e => setAbTipo(e.target.value as any)} style={inputStyle()}>
                    <option value="">Selecciona...</option><option value="organico">Orgánico</option><option value="inorganico">Inorgánico</option>
                  </select></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Estado físico</div>
                  <select value={abEstado} onChange={e => setAbEstado(e.target.value as any)} style={inputStyle()}>
                    <option value="">—</option><option value="solido">Sólido</option><option value="liquido">Líquido</option>
                  </select></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Densidad (si líquido)</div>
                  <input type="number" step="any" value={abDensidad ?? ''} onChange={e => setAbDensidad(e.target.value === '' ? undefined : Number(e.target.value))} style={inputStyle()} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Base P</div><SelectorBase valor={abPBase} onChange={setAbPBase} /></div>
                <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Base K</div><SelectorBase valor={abKBase} onChange={setAbKBase} /></div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 4 }}>Composición garantizada (%)</div>
              <FilaNutrientesPct valores={abNut} onChange={setAbNut} />
              {abError && <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)' }}>{abError}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={guardarAbono} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>GUARDAR</button>
                <button onClick={() => { setFormAbono(false); setAbonoEditar(null) }} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>CANCELAR</button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {abonos.length === 0 && <div style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>Sin abonos registrados.</div>}
            {abonos.map(ab => (
              <div key={ab.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{ab.nombre}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{ab.tipo === 'organico' ? 'Orgánico' : ab.tipo === 'inorganico' ? 'Inorgánico' : '—'} · {ab.fabricante || 'sin fabricante'}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {puedeEditar && <button onClick={() => abrirFormAbono(ab)} style={{ fontSize: 9, color: 'var(--text)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Editar</button>}
                    {puedeEliminar && <button onClick={() => eliminarAbono(ab.id)} style={{ fontSize: 9, color: 'var(--red)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Eliminar</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- SUBPESTAÑA: PLAN DE ABONADO (cálculo) ---------------- */}
      {subTab === 'plan' && (
        <div>
          {/* 4.0 Selección de contexto */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>4.0 — Contexto</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Campaña</div>
                <select value={pCampanaId} onChange={e => { setPCampanaId(e.target.value); setPParcelaId('') }} style={inputStyle()}>
                  <option value="">Selecciona...</option>{campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                </select></div>
              <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Finca</div>
                <select value={pFincaId} onChange={e => { setPFincaId(e.target.value); setPParcelaId('') }} style={inputStyle()}>
                  <option value="">Selecciona...</option>{fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
                </select></div>
              <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Parcela</div>
                <select value={pParcelaId} onChange={e => setPParcelaId(e.target.value)} disabled={!pCampanaId} style={inputStyle(!pCampanaId)}>
                  <option value="">Selecciona...</option>
                  {parcelasDeFinca.map(p => <option key={p.id} value={p.id}>{p.nombre} ({cultivoDeParcelaEnCampana(p.id, pCampanaId) || 'sin cultivo'})</option>)}
                </select></div>
            </div>
            {pParcelaId && !analisisVigente && (
              <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                ⚠ Esta parcela no tiene un análisis de suelo vigente. Ve a "Análisis de suelo" y añade uno antes de continuar.
              </div>
            )}
          </div>

          {pParcelaId && analisisVigente && (
            <>
              {/* 4.1 Composición inicial del suelo */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)', marginBottom: 8 }}>4.1 — Composición inicial del suelo (solo lectura, del análisis del {analisisVigente.fechaMuestra})</div>
                <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                  <span>pH: {analisisVigente.ph ?? '—'}</span><span>CE: {analisisVigente.ce ?? '—'} dS/m</span>
                </div>
                <FilaNutrientes valores={sueloInicialNorm} soloLectura />
              </div>

              {/* 4.2 Necesidades del cultivo */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                  4.2 — Necesidades del cultivo ({cultivoActual || 'sin cultivo asignado'})
                </div>
                {necesidadExistente ? (
                  <>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 6 }}>Ya existe ficha para este cultivo — solo lectura (edítala en "Necesidades por cultivo").</div>
                    <FilaNutrientes valores={necesidadesNorm} soloLectura />
                  </>
                ) : cultivoActual ? (
                  <>
                    <div style={{ fontSize: 10, color: 'var(--amber)', fontFamily: 'var(--mono)', marginBottom: 6 }}>No existe ficha para "{cultivoActual}" — introdúcela aquí; se creará automáticamente en "Necesidades por cultivo" al guardar el plan.</div>
                    <FilaNutrientes valores={necNuevaDraft} onChange={setNecNuevaDraft} />
                  </>
                ) : (
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Selecciona una parcela con cultivo asignado en la campaña.</div>
                )}
              </div>

              {/* 4.3 Composición del suelo objetivo */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)', marginBottom: 8 }}>4.3 — Composición del suelo objetivo</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <button onClick={() => setPModoObjetivo('mantener')} style={{ padding: '6px 12px', borderRadius: 6, background: pModoObjetivo === 'mantener' ? 'var(--green)' : 'var(--surface2)', color: pModoObjetivo === 'mantener' ? 'var(--bg)' : 'var(--text)', border: '1px solid var(--border)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Mantener el suelo</button>
                  <button onClick={() => setPModoObjetivo('manual')} style={{ padding: '6px 12px', borderRadius: 6, background: pModoObjetivo === 'manual' ? 'var(--green)' : 'var(--surface2)', color: pModoObjetivo === 'manual' ? 'var(--bg)' : 'var(--text)', border: '1px solid var(--border)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Manual</button>
                </div>
                {pModoObjetivo === 'manual' && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>pH objetivo</div>
                      <input type="number" step="any" value={pSueloObjetivo.ph ?? ''} onChange={e => setPSueloObjetivo(s => ({ ...s, ph: e.target.value === '' ? undefined : Number(e.target.value) }))} style={inputStyle()} /></div>
                    <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>CE objetivo</div>
                      <input type="number" step="any" value={pSueloObjetivo.ce ?? ''} onChange={e => setPSueloObjetivo(s => ({ ...s, ce: e.target.value === '' ? undefined : Number(e.target.value) }))} style={inputStyle()} /></div>
                  </div>
                )}
                <FilaNutrientes valores={sueloObjetivoNorm} onChange={pModoObjetivo === 'manual' ? (n => setPSueloObjetivo(s => ({ ...s, ...n }))) : undefined} soloLectura={pModoObjetivo === 'mantener'} />
              </div>

              {/* 4.4 Composición del abono elegido */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)', marginBottom: 8 }}>4.4 — Abono a aplicar</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Abono del catálogo</div>
                    <select value={pAbonoId} onChange={e => setPAbonoId(e.target.value)} style={inputStyle()}>
                      <option value="">— Ninguno (alta rápida abajo) —</option>
                      {abonos.map(ab => <option key={ab.id} value={ab.id}>{ab.nombre} ({ab.tipo === 'organico' ? 'Orgánico' : 'Inorgánico'})</option>)}
                    </select></div>
                  <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Dosis a aplicar (kg/ha)</div>
                    <input type="number" step="any" value={pDosis || ''} onChange={e => setPDosis(Number(e.target.value) || 0)} style={inputStyle()} /></div>
                </div>
                {!pAbonoId && (
                  <div style={{ border: '1px dashed var(--border)', borderRadius: 6, padding: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 10, color: 'var(--amber)', fontFamily: 'var(--mono)', marginBottom: 6 }}>Alta rápida — se guardará también en "Catálogo de abonos"</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                      <input placeholder="Nombre" value={abonoNuevoNombre} onChange={e => setAbonoNuevoNombre(e.target.value)} style={inputStyle()} />
                      <select value={abonoNuevoTipo} onChange={e => setAbonoNuevoTipo(e.target.value as any)} style={inputStyle()}>
                        <option value="">Orgánico / Inorgánico...</option><option value="organico">Orgánico</option><option value="inorganico">Inorgánico</option>
                      </select>
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Composición (%)</div>
                    <FilaNutrientesPct valores={abonoNuevoNut} onChange={setAbonoNuevoNut} />
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Aporte real (kg/ha) = composición × dosis</div>
                <FilaNutrientes valores={aporteAbono} soloLectura />
              </div>

              {/* 4.5 Balance */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)', marginBottom: 4 }}>4.5 — Balance por nutriente</div>
                <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
                  Balance = suelo inicial + aporte abono − necesidades cultivo − suelo objetivo. Azul = de más, rojo = de menos, verde = ajustado. (P/K en equivalente óxido).
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(68px,1fr))', gap: 6 }}>
                  {NUTRIENTES_LISTA.map(nu => (
                    <div key={nu.clave} style={{ textAlign: 'center', background: 'var(--surface2)', borderRadius: 5, padding: '6px 4px' }}>
                      <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{nu.etiqueta}{(nu.clave === 'p' || nu.clave === 'k') ? ' ⓘ' : ''}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)', color: balanceColor(balance[nu.clave] || 0) }}>{(balance[nu.clave] || 0).toFixed(1)}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 6 }}>
                  ⓘ P y K del balance van en equivalente óxido (P₂O₅ / K₂O). Si el abono, el análisis o la ficha del cultivo están declarados en base elemental, aquí se les aplica ×2,29 (P) o ×1,205 (K) antes de sumar — por eso pueden no coincidir con el "aporte real" de arriba, que sí muestra la cifra tal cual la declaraste.
                </div>
              </div>

              {/* 4.6 Datos de ejecución */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--mono)' }}>4.6 — Datos de ejecución</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Quién recomienda</div>
                    <select value={pRecomienda} onChange={e => setPRecomienda(e.target.value)} style={inputStyle()}>
                      <option value="">Sin asignar</option>
                      {personal.filter(p => p.activo).map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                    </select></div>
                  <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Quién ejecuta</div>
                    <select value={pEjecuta} onChange={e => setPEjecuta(e.target.value)} style={inputStyle()}>
                      <option value="">Sin asignar</option>
                      {personal.filter(p => p.activo).map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                    </select></div>
                  <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Fecha de aplicación</div>
                    <input type="date" value={pFechaAplicacion} onChange={e => setPFechaAplicacion(e.target.value)} style={inputStyle()} /></div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Maquinaria (máx. 2) — opcional</div>
                  {equipos.length === 0 ? (
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay equipos dados de alta en "Equipos".</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                      {equipos.map(eq => {
                        const marcado = pEquipoIds.includes(eq.id)
                        const deshabilitado = !marcado && pEquipoIds.length >= 2
                        return (
                          <label key={eq.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 4, cursor: deshabilitado ? 'not-allowed' : 'pointer', opacity: deshabilitado ? 0.4 : 1 }}>
                            <input type="checkbox" checked={marcado} disabled={deshabilitado}
                              onChange={() => setPEquipoIds(prev => prev.includes(eq.id) ? prev.filter(x => x !== eq.id) : prev.length >= 2 ? prev : [...prev, eq.id])} />
                            <span style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--sans)' }}>
                              {eq.nombre} <span style={{ color: 'var(--muted)', fontSize: 10 }}>({eq.tipo}{eq.subtipo ? ` · ${eq.subtipo}` : ''}{eq.titularidad === 'Externa' ? ' · externa' : ''})</span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              {pError && <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 8 }}>{pError}</div>}
              {puedeEditar && (
                <button onClick={guardarPlan} style={{ padding: '10px 20px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer', letterSpacing: '0.06em', marginBottom: 24 }}>💾 GUARDAR PLAN DE ABONADO</button>
              )}
            </>
          )}

          {/* Historial de planes guardados (inmutables) */}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Planes guardados</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {planes.length === 0 && <div style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>Todavía no hay planes de abonado guardados.</div>}
            {planes.map(pl => (
              <div key={pl.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                      {pl.fecha} · {fincas.find(f => f.id === pl.fincaId)?.nombre || '—'} · {misParcelas.find(p => p.id === pl.parcelaId)?.nombre || '—'} · {pl.cultivo}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{pl.abonoNombre} · {pl.dosisKgHa} kg/ha</div>
                  </div>
                  {puedeEliminar && <button onClick={() => eliminarPlan(pl.id)} style={{ fontSize: 9, color: 'var(--red)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Eliminar</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
