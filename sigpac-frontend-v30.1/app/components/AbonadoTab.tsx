'use client'

import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import type { PermisoClave } from '../lib/permisos'
import { descargarFichaAbonado } from '../lib/fichaAbonado'
import { descargarCuadernoAbonado, NUTRIENTES_ORDEN, type SeccionTabla, type ParcelaAbonadoFicha, type AbonoBloqueFicha } from '../lib/cuadernoAbonado'

// - Tipos mínimos compartidos con page.tsx (duplicados a propósito para no acoplar) -
interface FincaLite { id: string; nombre: string }
interface CampanaLite { id: string; nombre: string; fechaInicio?: string; fechaFin?: string }
interface RecintoLite { referencia: string; supHa: number; provincia?: string; municipio?: string; agregado?: string; zona?: string; poligono?: string; parcela?: string; recinto?: string; usoSigpac?: string }
interface ParcelaLite { id: string; nombre: string; cultivo: string; variedad?: string; fincaId?: string; referenciaSigpac?: string; supHa?: number; recintos?: RecintoLite[]; secanoRegadio?: string; tipoCultivoAmbiente?: string; sistAsesoramientoGip?: string }
interface HistoricoCultivoLite { parcelaId: string; cultivo: string; campanaId?: string }
interface EquipoLite { id: string; tipo: string; subtipo?: string; nombre: string; titularidad?: string; fincaId?: string; nroRoma?: string; dniCif?: string; fechaAdquisicion?: string; fechaUltimaInspeccion?: string }
interface PersonalLite { id: string; nombre: string; activo: boolean; permisos?: Record<string, boolean>; nroRopo?: string; dni?: string; nivelCapacitacion?: string; funciones?: string[]; fincaId?: string; fincaIds?: string[] }

interface DatosExplotacionLite {
  nombreRazonSocial?: string; nif?: string; nroRegExplotNacional?: string; nroRegExplotAutonomico?: string
  direccion?: string; localidad?: string; cPostal?: string; provincia?: string; telefonoFijo?: string; telefonoMovil?: string; email?: string
  titularNombre?: string; titularNif?: string; titularDireccion?: string; titularLocalidad?: string; titularCPostal?: string
  titularProvincia?: string; titularTipoRepresentacion?: string; titularTelefono?: string; titularEmail?: string
  agrupacionNombre?: string; agrupacionNif?: string; agrupacionNroIdentificacion?: string; agrupacionTipoExplotacion?: string
}

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
  datosExplotacionPorFinca: Record<string, DatosExplotacionLite>
  onEditarDatosExplotacion: (fincaIds: string[]) => void
}

// 13 nutrientes con balance. pH y CE se llevan aparte, solo como referencia
// comparativa (un abono no los "aporta" de forma aditiva como a un nutriente).
type BaseNutriente = 'elemental' | 'oxido'
interface Nutrientes {
  n?: number; p?: number; k?: number; ca?: number; mg?: number; s?: number
  fe?: number; zn?: number; mn?: number; b?: number; cu?: number; cl?: number; mo?: number
}
// Mismas funciones/roles que ya se usan en Tratamientos para decidir quién puede
// recomendar y quién puede aplicar — no son exclusivas de fitosanitarios, valen igual para abonado.
const FUNCIONES_RECOMENDADOR = ['Asesor en gestión integrada de plagas', 'Asesor fitosanitario', 'Ingeniero agrónomo / Ingeniero técnico agrícola', 'Gestor']
const FUNCIONES_APLICADOR = ['Aplicador de fitosanitarios', 'Peón', 'Encargado']
const esRecomendador = (p: PersonalLite) => (p.funciones || []).some(f => FUNCIONES_RECOMENDADOR.includes(f))
const esAplicador = (p: PersonalLite) => (p.funciones || []).some(f => FUNCIONES_APLICADOR.includes(f))
// vacío/sin fincaIds = sin restricción (trabaja en cualquier finca, incluida externa)
const trabajaEnFinca = (p: PersonalLite, fincaId: string) => !fincaId || !p.fincaIds || p.fincaIds.length === 0 || p.fincaIds.includes(fincaId)

const NUTRIENTES_LISTA: { clave: keyof Nutrientes; etiqueta: string }[] = [
  { clave: 'n', etiqueta: 'N' }, { clave: 'p', etiqueta: 'P' }, { clave: 'k', etiqueta: 'K' },
  { clave: 'ca', etiqueta: 'Ca' }, { clave: 'mg', etiqueta: 'Mg' }, { clave: 's', etiqueta: 'S' },
  { clave: 'fe', etiqueta: 'Fe' }, { clave: 'zn', etiqueta: 'Zn' }, { clave: 'mn', etiqueta: 'Mn' },
  { clave: 'b', etiqueta: 'B' }, { clave: 'cu', etiqueta: 'Cu' }, { clave: 'cl', etiqueta: 'Cl' }, { clave: 'mo', etiqueta: 'Mo' },
]
const NUTRIENTES_VACIO: Nutrientes = { n:0,p:0,k:0,ca:0,mg:0,s:0,fe:0,zn:0,mn:0,b:0,cu:0,cl:0,mo:0 }
const FACTOR_P2O5 = 2.29
const FACTOR_K2O = 1.205

// Unidad en la que se declara cada nutriente. Hay dos "familias" de unidad
// según de qué dato se trate:
// - Concentración en el ABONO (composición garantizada de un producto): %, g/kg, mg/kg.
// - Cantidad por HECTÁREA (análisis de suelo, necesidades del cultivo, objetivo): kg/ha, g/ha, t/ha.
// Cada nutriente se puede elegir en la unidad que quieras, y aquí dentro se
// recalcula siempre a la unidad base común (g/kg de producto, o kg/ha) antes
// de usarlo en cualquier cálculo.
interface OpcionUnidad { valor: string; etiqueta: string; factor: number } // factor: × para pasar a la unidad base
const OPCIONES_CONCENTRACION: OpcionUnidad[] = [
  { valor: 'pct', etiqueta: '%', factor: 10 },
  { valor: 'g_kg', etiqueta: 'g/kg', factor: 1 },
  { valor: 'mg_kg', etiqueta: 'mg/kg', factor: 0.001 },
]
const OPCIONES_CANTIDAD: OpcionUnidad[] = [
  { valor: 'kg_ha', etiqueta: 'kg/ha', factor: 1 },
  { valor: 'g_ha', etiqueta: 'g/ha', factor: 0.001 },
  { valor: 't_ha', etiqueta: 't/ha', factor: 1000 },
]
type MapaUnidades = Partial<Record<keyof Nutrientes, string>>
const UNIDADES_VACIO: MapaUnidades = {}
const factorDeUnidad = (unidad: string, opciones: OpcionUnidad[]): number => opciones.find(o => o.valor === unidad)?.factor ?? 1
// Formato español: coma como separador decimal (12,5 en vez de 12.5)
const fmt = (n: number, decimales: number = 1): string => n.toFixed(decimales).replace('.', ',')
// Convierte un Nutrientes declarado en unidades variadas (una por nutriente) a la unidad base común de esas opciones.
const normalizarUnidades = (nut: Nutrientes, unidades: MapaUnidades, opciones: OpcionUnidad[], porDefecto: string): Nutrientes =>
  Object.fromEntries(NUTRIENTES_LISTA.map(nu => [nu.clave, (nut[nu.clave] || 0) * factorDeUnidad(unidades[nu.clave] || porDefecto, opciones)])) as Nutrientes

interface AnalisisSuelo {
  id: string
  parcelaIds: string[]
  fechaMuestra: string
  laboratorio: string
  archivoUrl?: string
  materiaOrganica?: number
  nutrientes: Nutrientes       // valor declarado, en la unidad de "unidades" (por defecto kg/ha)
  unidades: MapaUnidades
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
  nutrientes: Nutrientes       // valor declarado, en la unidad de "unidades" (por defecto kg/ha)
  unidades: MapaUnidades
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
  nutrientes: Nutrientes       // valor declarado, en la unidad de "unidades" (por defecto %)
  unidades: MapaUnidades
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
  sueloInicial: Nutrientes & { ph?: number; ce?: number; materiaOrganica?: number }     // fotografía fija
  necesidadCultivoId?: string
  necesidadesCultivo: Nutrientes                              // fotografía fija
  modoObjetivo: 'mantener' | 'manual'
  sueloObjetivo: Nutrientes & { ph?: number; ce?: number }
  abonoId?: string
  abonoNombre: string
  abonoFabricante?: string
  abonoNumRegistro?: string
  abonoTipo: 'organico' | 'inorganico' | ''
  abonoComposicion: Nutrientes                                // fotografía fija
  abonoUnidades: MapaUnidades
  dosisKgHa: number
  aporteReal: Nutrientes                                      // fotografía fija — lo realmente aplicado (kg/ha)
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

function FilaNutrientesUnidad({ valores, unidades, opciones, unidadPorDefecto, baseEtiqueta, onChangeValor, onChangeUnidad, soloLectura }: {
  valores: Nutrientes
  unidades: MapaUnidades
  opciones: OpcionUnidad[]
  unidadPorDefecto: string
  baseEtiqueta: string
  onChangeValor?: (n: Nutrientes) => void
  onChangeUnidad?: (u: MapaUnidades) => void
  soloLectura?: boolean
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(105px,1fr))', gap: 6 }}>
      {NUTRIENTES_LISTA.map(nu => {
        const unidad = unidades[nu.clave] || unidadPorDefecto
        return (
          <div key={nu.clave}>
            <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 2 }}>{nu.etiqueta}</div>
            <div style={{ display: 'flex', gap: 3 }}>
              <input type="number" step="any" disabled={soloLectura} value={valores[nu.clave] ?? ''}
                onChange={e => onChangeValor && onChangeValor({ ...valores, [nu.clave]: e.target.value === '' ? undefined : Number(e.target.value) })}
                style={{ ...inputStyle(soloLectura), width: '58%', padding: '6px 4px' }} />
              <select disabled={soloLectura} value={unidad}
                onChange={e => onChangeUnidad && onChangeUnidad({ ...unidades, [nu.clave]: e.target.value })}
                style={{ ...inputStyle(soloLectura), width: '42%', padding: '6px 1px', fontSize: 9 }}>
                {opciones.map(o => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
              </select>
            </div>
            <div style={{ fontSize: 8, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
              = {fmt((valores[nu.clave] || 0) * factorDeUnidad(unidad, opciones), 3)} {baseEtiqueta}
            </div>
          </div>
        )
      })}
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

function ModalForm({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, width: '100%', maxWidth: 680, maxHeight: '90vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>{titulo}</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

export default function AbonadoTab({ session, fincas, misParcelas, campanas, historicoCultivos, equipos, personal, isMobile, misPermisos, datosExplotacionPorFinca, onEditarDatosExplotacion }: Props) {
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
        nutrientes: { ...NUTRIENTES_VACIO, ...(a.nutrientes || {}) }, unidades: a.unidades || {},
        pBase: a.p_base || 'elemental', kBase: a.k_base || 'elemental',
        ph: a.ph != null ? Number(a.ph) : undefined, ce: a.ce != null ? Number(a.ce) : undefined,
      })))
      if (nRes.data) setNecesidades(nRes.data.map((n: any) => ({
        id: n.id, cultivo: n.cultivo, variedad: n.variedad || undefined, objetivoRendimiento: n.objetivo_rendimiento || undefined,
        nutrientes: { ...NUTRIENTES_VACIO, ...(n.nutrientes || {}) }, unidades: n.unidades || {},
        pBase: n.p_base || 'elemental', kBase: n.k_base || 'elemental',
      })))
      if (abRes.data) setAbonos(abRes.data.map((ab: any) => ({
        id: ab.id, nombre: ab.nombre, fabricante: ab.fabricante || undefined, numRegistro: ab.num_registro || undefined,
        tipo: ab.tipo || '', estadoFisico: ab.estado_fisico || '', densidad: ab.densidad != null ? Number(ab.densidad) : undefined,
        nutrientes: { ...NUTRIENTES_VACIO, ...(ab.nutrientes || {}) }, unidades: ab.unidades || {},
        pBase: ab.p_base || 'elemental', kBase: ab.k_base || 'elemental',
      })))
      if (pRes.data) setPlanes(pRes.data.map((pl: any) => ({
        id: pl.id, campanaId: pl.campana_id || '', fincaId: pl.finca_id || '', parcelaId: pl.parcela_id || '',
        cultivo: pl.cultivo || '', fecha: pl.fecha, analisisId: pl.analisis_id || undefined,
        sueloInicial: { ...NUTRIENTES_VACIO, ...(pl.suelo_inicial || {}) },
        necesidadCultivoId: pl.necesidad_cultivo_id || undefined,
        necesidadesCultivo: { ...NUTRIENTES_VACIO, ...(pl.necesidades_cultivo || {}) },
        modoObjetivo: pl.modo_objetivo || 'mantener',
        sueloObjetivo: { ...NUTRIENTES_VACIO, ...(pl.suelo_objetivo || {}) },
        abonoId: pl.abono_id || undefined, abonoNombre: pl.abono_nombre || '', abonoFabricante: pl.abono_fabricante || undefined,
        abonoNumRegistro: pl.abono_num_registro || undefined, abonoTipo: pl.abono_tipo || '',
        abonoComposicion: { ...NUTRIENTES_VACIO, ...(pl.abono_composicion || {}) }, abonoUnidades: pl.abono_unidades || {},
        dosisKgHa: Number(pl.dosis_kg_ha) || 0,
        aporteReal: { ...NUTRIENTES_VACIO, ...(pl.aporte_real || {}) },
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
  const [aFincaId, setAFincaId] = useState('')
  const [aFecha, setAFecha] = useState('')
  const [aLab, setALab] = useState('')
  const [aMO, setAMO] = useState<number | undefined>(undefined)
  const [aNut, setANut] = useState<Nutrientes>({ ...NUTRIENTES_VACIO })
  const [aUnidades, setAUnidades] = useState<MapaUnidades>({ ...UNIDADES_VACIO })
  const [aPBase, setAPBase] = useState<BaseNutriente>('elemental')
  const [aKBase, setAKBase] = useState<BaseNutriente>('elemental')
  const [aPh, setAPh] = useState<number | undefined>(undefined)
  const [aCe, setACe] = useState<number | undefined>(undefined)
  const [aError, setAError] = useState('')

  const abrirFormAnalisis = (a?: AnalisisSuelo) => {
    setAnalisisEditar(a || null)
    setAParcelaIds(a?.parcelaIds || [])
    setAFincaId(a?.parcelaIds?.[0] ? (misParcelas.find(p => p.id === a.parcelaIds[0])?.fincaId || '') : '')
    setAFecha(a?.fechaMuestra || new Date().toISOString().slice(0, 10))
    setALab(a?.laboratorio || ''); setAMO(a?.materiaOrganica)
    setANut(a?.nutrientes ? { ...a.nutrientes } : { ...NUTRIENTES_VACIO })
    setAUnidades(a?.unidades ? { ...a.unidades } : { ...UNIDADES_VACIO })
    setAPBase(a?.pBase || 'elemental'); setAKBase(a?.kBase || 'elemental')
    setAPh(a?.ph); setACe(a?.ce); setAError(''); setFormAnalisis(true)
  }

  const guardarAnalisis = async () => {
    if (aParcelaIds.length === 0) { setAError('Selecciona al menos una parcela'); return }
    if (!aFecha) { setAError('La fecha de muestra es obligatoria'); return }
    const nuevo: AnalisisSuelo = {
      id: analisisEditar?.id || String(Date.now()), parcelaIds: aParcelaIds, fechaMuestra: aFecha, laboratorio: aLab.trim(),
      materiaOrganica: aMO, nutrientes: aNut, unidades: aUnidades, pBase: aPBase, kBase: aKBase, ph: aPh, ce: aCe,
    }
    const lista = analisisEditar ? analisis.map(a => a.id === analisisEditar.id ? nuevo : a) : [nuevo, ...analisis]
    setAnalisis(lista)
    try {
      const { error } = await supabase.from('analisis_suelo').upsert({
        id: nuevo.id, user_id: session.user.id, parcela_ids: nuevo.parcelaIds, fecha_muestra: nuevo.fechaMuestra,
        laboratorio: nuevo.laboratorio || null, materia_organica: nuevo.materiaOrganica ?? null,
        nutrientes: nuevo.nutrientes, unidades: nuevo.unidades, p_base: nuevo.pBase, k_base: nuevo.kBase, ph: nuevo.ph ?? null, ce: nuevo.ce ?? null,
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
  const [nUnidades, setNUnidades] = useState<MapaUnidades>({ ...UNIDADES_VACIO })
  const [nPBase, setNPBase] = useState<BaseNutriente>('elemental')
  const [nKBase, setNKBase] = useState<BaseNutriente>('elemental')
  const [nError, setNError] = useState('')

  const abrirFormNec = (n?: NecesidadCultivo, cultivoPrefill?: string) => {
    setNecEditar(n || null)
    setNCultivo(n?.cultivo || cultivoPrefill || ''); setNVariedad(n?.variedad || ''); setNObjetivo(n?.objetivoRendimiento || '')
    setNNut(n?.nutrientes ? { ...n.nutrientes } : { ...NUTRIENTES_VACIO })
    setNUnidades(n?.unidades ? { ...n.unidades } : { ...UNIDADES_VACIO })
    setNPBase(n?.pBase || 'elemental'); setNKBase(n?.kBase || 'elemental'); setNError(''); setFormNec(true)
  }

  const guardarNecesidad = async (override?: { cultivo: string; nutrientes: Nutrientes; unidades?: MapaUnidades }): Promise<NecesidadCultivo | null> => {
    const cultivo = override?.cultivo ?? nCultivo
    const nutrientes = override?.nutrientes ?? nNut
    const unidades = override?.unidades ?? nUnidades
    if (!cultivo.trim()) { setNError('El nombre del cultivo es obligatorio'); return null }
    const nuevo: NecesidadCultivo = {
      id: necEditar?.id || String(Date.now()), cultivo: cultivo.trim(),
      variedad: override ? undefined : (nVariedad.trim() || undefined),
      objetivoRendimiento: override ? undefined : (nObjetivo.trim() || undefined),
      nutrientes, unidades, pBase: override ? 'elemental' : nPBase, kBase: override ? 'elemental' : nKBase,
    }
    const lista = necEditar ? necesidades.map(n => n.id === necEditar.id ? nuevo : n) : [nuevo, ...necesidades]
    setNecesidades(lista)
    try {
      const { error } = await supabase.from('necesidades_cultivo').upsert({
        id: nuevo.id, user_id: session.user.id, cultivo: nuevo.cultivo, variedad: nuevo.variedad || null,
        objetivo_rendimiento: nuevo.objetivoRendimiento || null, nutrientes: nuevo.nutrientes, unidades: nuevo.unidades, p_base: nuevo.pBase, k_base: nuevo.kBase,
      })
      if (error) { setNError('No se pudo guardar: ' + error.message); return null }
    } catch (e) { setNError('No se pudo guardar en la base de datos.'); return null }
    if (!override) { setFormNec(false); setNecEditar(null) }
    return nuevo
  }

  const abrirFormPlan = () => { resetearFormularioPlan(); setFormPlan(true) }

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
  const [abUnidades, setAbUnidades] = useState<MapaUnidades>({ ...UNIDADES_VACIO })
  const [abPBase, setAbPBase] = useState<BaseNutriente>('elemental')
  const [abKBase, setAbKBase] = useState<BaseNutriente>('elemental')
  const [abError, setAbError] = useState('')

  const abrirFormAbono = (ab?: AbonoCatalogo, nombrePrefill?: string) => {
    setAbonoEditar(ab || null)
    setAbNombre(ab?.nombre || nombrePrefill || ''); setAbFabricante(ab?.fabricante || ''); setAbRegistro(ab?.numRegistro || '')
    setAbTipo(ab?.tipo || ''); setAbEstado(ab?.estadoFisico || ''); setAbDensidad(ab?.densidad)
    setAbNut(ab?.nutrientes ? { ...ab.nutrientes } : { ...NUTRIENTES_VACIO })
    setAbUnidades(ab?.unidades ? { ...ab.unidades } : { ...UNIDADES_VACIO })
    setAbPBase(ab?.pBase || 'elemental'); setAbKBase(ab?.kBase || 'elemental'); setAbError(''); setFormAbono(true)
  }

  const guardarAbono = async (override?: { nombre: string; tipo: 'organico' | 'inorganico'; nutrientes: Nutrientes; unidades: MapaUnidades }): Promise<AbonoCatalogo | null> => {
    const nombre = override?.nombre ?? abNombre
    const tipo = override?.tipo ?? abTipo
    const nutrientes = override?.nutrientes ?? abNut
    const unidades = override?.unidades ?? abUnidades
    if (!nombre.trim()) { setAbError('El nombre / marca comercial es obligatorio'); return null }
    if (!tipo) { setAbError('Indica si es orgánico o inorgánico'); return null }
    const nuevo: AbonoCatalogo = {
      id: abonoEditar?.id || String(Date.now()), nombre: nombre.trim(),
      fabricante: override ? undefined : (abFabricante.trim() || undefined),
      numRegistro: override ? undefined : (abRegistro.trim() || undefined),
      tipo, estadoFisico: override ? '' : abEstado, densidad: override ? undefined : abDensidad,
      nutrientes, unidades, pBase: override ? 'elemental' : abPBase, kBase: override ? 'elemental' : abKBase,
    }
    const lista = abonoEditar ? abonos.map(a => a.id === abonoEditar.id ? nuevo : a) : [nuevo, ...abonos]
    setAbonos(lista)
    try {
      const { error } = await supabase.from('catalogo_abonos').upsert({
        id: nuevo.id, user_id: session.user.id, nombre: nuevo.nombre, fabricante: nuevo.fabricante || null,
        num_registro: nuevo.numRegistro || null, tipo: nuevo.tipo, estado_fisico: nuevo.estadoFisico || null,
        densidad: nuevo.densidad ?? null, nutrientes: nuevo.nutrientes, unidades: nuevo.unidades, p_base: nuevo.pBase, k_base: nuevo.kBase,
      })
      if (error) { setAbError('No se pudo guardar: ' + error.message); return null }
    } catch (e) { setAbError('No se pudo guardar en la base de datos.'); return null }
    if (!override) { setFormAbono(false); setAbonoEditar(null) }
    return nuevo
  }

  const eliminarAbono = async (id: string) => {
    if (!confirm('¿Eliminar este abono del catálogo?')) return
    setAbonos(abonos.filter(a => a.id !== id))
    try { await supabase.from('catalogo_abonos').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  // ---------- Plan de abonado (4.0 - 4.6) ----------
  const [formPlan, setFormPlan] = useState(false)
  const [pCampanaId, setPCampanaId] = useState('')
  const [pFincaId, setPFincaId] = useState('')
  const [pParcelaId, setPParcelaId] = useState('')
  const [pModoObjetivo, setPModoObjetivo] = useState<'mantener' | 'manual'>('mantener')
  const [pSueloObjetivo, setPSueloObjetivo] = useState<Nutrientes & { ph?: number; ce?: number }>({ ...NUTRIENTES_VACIO })
  const [pSueloObjetivoUnidades, setPSueloObjetivoUnidades] = useState<MapaUnidades>({ ...UNIDADES_VACIO })
  const [pAbonoId, setPAbonoId] = useState('')
  const [pDosis, setPDosis] = useState<number>(0)
  const [pRecomienda, setPRecomienda] = useState('')
  const [pEjecuta, setPEjecuta] = useState('')
  const [pFechaAplicacion, setPFechaAplicacion] = useState('')
  const [pEquipoIds, setPEquipoIds] = useState<string[]>([])
  const [pError, setPError] = useState('')
  // Borrador de necesidad "al vuelo" cuando el cultivo no tiene ficha
  const [necNuevaDraft, setNecNuevaDraft] = useState<Nutrientes>({ ...NUTRIENTES_VACIO })
  const [necNuevaDraftUnidades, setNecNuevaDraftUnidades] = useState<MapaUnidades>({ ...UNIDADES_VACIO })
  // Borrador de abono "de alta rápida" cuando no existe en el catálogo
  const [abonoNuevoNombre, setAbonoNuevoNombre] = useState('')
  const [abonoNuevoTipo, setAbonoNuevoTipo] = useState<'organico' | 'inorganico' | ''>('')
  const [abonoNuevoNut, setAbonoNuevoNut] = useState<Nutrientes>({ ...NUTRIENTES_VACIO })
  const [abonoNuevoUnidades, setAbonoNuevoUnidades] = useState<MapaUnidades>({ ...UNIDADES_VACIO })

  const cultivoDeParcelaEnCampana = (parcelaId: string, campanaId: string): string => {
    const hist = historicoCultivos.find(h => h.parcelaId === parcelaId && h.campanaId === campanaId)
    if (hist) return hist.cultivo
    return misParcelas.find(p => p.id === parcelaId)?.cultivo || ''
  }

  const parcelasDeFinca = misParcelas.filter(p => !pFincaId || p.fincaId === pFincaId)
  const cultivoActual = pParcelaId && pCampanaId ? cultivoDeParcelaEnCampana(pParcelaId, pCampanaId) : ''
  const campanaSel = pCampanaId ? campanas.find(c => c.id === pCampanaId) : undefined
  const analisisVigente = pParcelaId ? analisis.find(a => a.parcelaIds.includes(pParcelaId)) : undefined
  const necesidadExistente = cultivoActual ? necesidades.find(n => n.cultivo.toLowerCase() === cultivoActual.toLowerCase()) : undefined
  const abonoSel = pAbonoId ? abonos.find(a => a.id === pAbonoId) : undefined
  // Si nadie tiene marcada explícitamente esa función (ficha de Personal sin funciones
  // asignadas, o con etiquetas distintas a las de fitosanitarios), no se bloquea el
  // formulario: se cae a mostrar todo el personal activo de esa finca.
  const personalActivoDeFinca = personal.filter(p => p.activo && trabajaEnFinca(p, pFincaId))
  const personalRecomendadoresPorRol = personalActivoDeFinca.filter(esRecomendador)
  const personalAplicadoresPorRol = personalActivoDeFinca.filter(esAplicador)
  const personalRecomendadores = personalRecomendadoresPorRol.length > 0 ? personalRecomendadoresPorRol : personalActivoDeFinca
  const personalAplicadores = personalAplicadoresPorRol.length > 0 ? personalAplicadoresPorRol : personalActivoDeFinca
  const equiposDisponibles = equipos.filter(eq => !pFincaId || eq.fincaId === pFincaId || eq.titularidad === 'Externa')

  // Base común para combinar en el balance: primero se pasa cada nutriente a
  // kg/ha (según la unidad elegida), y luego, solo P y K, a equivalente óxido.
  const sueloInicialNorm: Nutrientes & { ph?: number; ce?: number; materiaOrganica?: number } = analisisVigente
    ? { ...normalizarPK(normalizarUnidades(analisisVigente.nutrientes, analisisVigente.unidades, OPCIONES_CANTIDAD, 'kg_ha'), analisisVigente.pBase, analisisVigente.kBase), ph: analisisVigente.ph, ce: analisisVigente.ce, materiaOrganica: analisisVigente.materiaOrganica }
    : { ...NUTRIENTES_VACIO }
  const necesidadesNorm: Nutrientes = necesidadExistente
    ? normalizarPK(normalizarUnidades(necesidadExistente.nutrientes, necesidadExistente.unidades, OPCIONES_CANTIDAD, 'kg_ha'), necesidadExistente.pBase, necesidadExistente.kBase)
    : normalizarPK(normalizarUnidades(necNuevaDraft, necNuevaDraftUnidades, OPCIONES_CANTIDAD, 'kg_ha'), 'elemental', 'elemental')
  const sueloObjetivoNorm: Nutrientes & { ph?: number; ce?: number } = pModoObjetivo === 'mantener'
    ? sueloInicialNorm
    : { ...normalizarPK(normalizarUnidades(pSueloObjetivo, pSueloObjetivoUnidades, OPCIONES_CANTIDAD, 'kg_ha'), 'elemental', 'elemental'), ph: pSueloObjetivo.ph, ce: pSueloObjetivo.ce }

  const composicionAbonoActiva: Nutrientes = pAbonoId
    ? (abonoSel ? abonoSel.nutrientes : { ...NUTRIENTES_VACIO })
    : abonoNuevoNut
  const composicionAbonoUnidades: MapaUnidades = pAbonoId
    ? (abonoSel?.unidades || {})
    : abonoNuevoUnidades
  const composicionAbonoBase: { p: BaseNutriente; k: BaseNutriente } = pAbonoId
    ? { p: abonoSel?.pBase || 'elemental', k: abonoSel?.kBase || 'elemental' }
    : { p: 'elemental', k: 'elemental' }

  // "Aporte real" (4.4): gramos de nutriente por kg de producto (según la unidad
  // elegida para cada uno: %, g/kg o mg/kg) × dosis, pasado a kg/ha. Si pones el
  // mismo valor y unidad en todos los nutrientes, el aporte sale igual en todos.
  const aporteAbono: Nutrientes = Object.fromEntries(
    NUTRIENTES_LISTA.map(nu => {
      const unidad = composicionAbonoUnidades[nu.clave] || 'pct'
      const gKg = (composicionAbonoActiva[nu.clave] || 0) * factorDeUnidad(unidad, OPCIONES_CONCENTRACION)
      return [nu.clave, (gKg / 1000) * (pDosis || 0)]
    })
  ) as Nutrientes

  // Balance (4.5): aquí sí se normaliza P/K de los 4 términos a equivalente óxido
  // (P₂O₅ / K₂O) antes de sumar/restar, porque si no, un P "elemental" y un P
  // "óxido" no son la misma cantidad y el balance mentiría. Por eso el aporte de
  // abono usado en el balance no es igual al "aporte real" de arriba si el abono
  // está declarado en base elemental: ese es el único sitio donde se aplica el
  // factor (×2,29 en P, ×1,205 en K), y se avisa junto a esos dos números.
  const aporteAbonoNormalizado: Nutrientes = normalizarPK(aporteAbono, composicionAbonoBase.p, composicionAbonoBase.k)

  // Recalcula el aporte a partir de una composición+unidades+dosis ya guardadas
  // (se usa para "Ver" y "Descargar ficha" de un plan ya guardado, para que no
  // dependa de si el campo aporte_real llegó a guardarse bien en su momento).
  const calcularAporte = (composicion: Nutrientes, unidades: MapaUnidades, dosisKgHa: number): Nutrientes =>
    Object.fromEntries(NUTRIENTES_LISTA.map(nu => {
      const unidad = unidades[nu.clave] || 'pct'
      const gKg = (composicion[nu.clave] || 0) * factorDeUnidad(unidad, OPCIONES_CONCENTRACION)
      return [nu.clave, (gKg / 1000) * (dosisKgHa || 0)]
    })) as Nutrientes

  const balance: Nutrientes = Object.fromEntries(
    NUTRIENTES_LISTA.map(nu => [nu.clave,
      (sueloInicialNorm[nu.clave] || 0) + (aporteAbonoNormalizado[nu.clave] || 0) - (necesidadesNorm[nu.clave] || 0) - (sueloObjetivoNorm[nu.clave] || 0)
    ])
  ) as Nutrientes

  const resetearFormularioPlan = () => {
    setPCampanaId(''); setPFincaId(''); setPParcelaId(''); setPModoObjetivo('mantener')
    setPSueloObjetivo({ ...NUTRIENTES_VACIO }); setPSueloObjetivoUnidades({ ...UNIDADES_VACIO }); setPAbonoId(''); setPDosis(0)
    setPRecomienda(''); setPEjecuta(''); setPFechaAplicacion(''); setPEquipoIds([])
    setNecNuevaDraft({ ...NUTRIENTES_VACIO }); setNecNuevaDraftUnidades({ ...UNIDADES_VACIO })
    setAbonoNuevoNombre(''); setAbonoNuevoTipo(''); setAbonoNuevoNut({ ...NUTRIENTES_VACIO }); setAbonoNuevoUnidades({ ...UNIDADES_VACIO })
    setPError('')
  }

  const guardarPlan = async () => {
    if (!pCampanaId || !pFincaId || !pParcelaId) { setPError('Selecciona campaña, finca y parcela'); return }
    if (!analisisVigente) { setPError('Esta parcela no tiene un análisis de suelo vigente. Cárgalo antes en "Análisis de suelo".'); return }
    if (!pAbonoId && !abonoNuevoNombre.trim()) { setPError('Selecciona un abono del catálogo o da uno de alta rápida'); return }
    if (!pDosis || pDosis <= 0) { setPError('Indica la dosis de abono a aplicar (kg/ha)'); return }
    if (pFechaAplicacion && campanaSel?.fechaInicio && campanaSel?.fechaFin && (pFechaAplicacion < campanaSel.fechaInicio || pFechaAplicacion > campanaSel.fechaFin)) {
      setPError(`La fecha de aplicación debe estar dentro de la campaña (${campanaSel.fechaInicio} a ${campanaSel.fechaFin})`); return
    }

    let necesidadUsadaId = necesidadExistente?.id
    if (!necesidadExistente) {
      // No existía ficha para este cultivo: se crea ahora en subpestaña 2, con lo introducido aquí
      const creada = await guardarNecesidad({ cultivo: cultivoActual, nutrientes: necNuevaDraft, unidades: necNuevaDraftUnidades })
      necesidadUsadaId = creada?.id
    }

    let abonoUsadoId = pAbonoId
    let abonoNombreFinal = abonoSel?.nombre || ''
    let abonoFabricanteFinal = abonoSel?.fabricante || ''
    let abonoNumRegistroFinal = abonoSel?.numRegistro || ''
    let abonoTipoFinal: 'organico' | 'inorganico' | '' = abonoSel?.tipo || ''
    if (!pAbonoId && abonoNuevoNombre.trim()) {
      const creado = await guardarAbono({ nombre: abonoNuevoNombre, tipo: (abonoNuevoTipo || 'inorganico'), nutrientes: abonoNuevoNut, unidades: abonoNuevoUnidades })
      abonoUsadoId = creado?.id || ''
      abonoNombreFinal = creado?.nombre || abonoNuevoNombre
      abonoFabricanteFinal = creado?.fabricante || ''
      abonoNumRegistroFinal = creado?.numRegistro || ''
      abonoTipoFinal = creado?.tipo || abonoNuevoTipo || ''
    }

    const nuevo: PlanAbonado = {
      id: String(Date.now()), campanaId: pCampanaId, fincaId: pFincaId, parcelaId: pParcelaId, cultivo: cultivoActual,
      fecha: new Date().toISOString().slice(0, 10), analisisId: analisisVigente.id,
      sueloInicial: sueloInicialNorm, necesidadCultivoId: necesidadUsadaId, necesidadesCultivo: necesidadesNorm,
      modoObjetivo: pModoObjetivo, sueloObjetivo: sueloObjetivoNorm,
      abonoId: abonoUsadoId || undefined, abonoNombre: abonoNombreFinal, abonoFabricante: abonoFabricanteFinal || undefined,
      abonoNumRegistro: abonoNumRegistroFinal || undefined, abonoTipo: abonoTipoFinal,
      abonoComposicion: composicionAbonoActiva, abonoUnidades: composicionAbonoUnidades, dosisKgHa: pDosis, aporteReal: aporteAbono, balance,
      recomienda: pRecomienda || undefined, ejecuta: pEjecuta || undefined,
      fechaAplicacion: pFechaAplicacion || undefined, equipoIds: pEquipoIds,
    }
    setPlanes([nuevo, ...planes])
    try {
      const { error } = await supabase.from('planes_abonado').insert({
        id: nuevo.id, user_id: session.user.id, campana_id: nuevo.campanaId, finca_id: nuevo.fincaId, parcela_id: nuevo.parcelaId,
        cultivo: nuevo.cultivo, fecha: nuevo.fecha, analisis_id: nuevo.analisisId,
        suelo_inicial: nuevo.sueloInicial, necesidad_cultivo_id: nuevo.necesidadCultivoId || null, necesidades_cultivo: nuevo.necesidadesCultivo,
        modo_objetivo: nuevo.modoObjetivo, suelo_objetivo: nuevo.sueloObjetivo,
        abono_id: nuevo.abonoId || null, abono_nombre: nuevo.abonoNombre, abono_fabricante: nuevo.abonoFabricante || null,
        abono_num_registro: nuevo.abonoNumRegistro || null, abono_tipo: nuevo.abonoTipo,
        abono_composicion: nuevo.abonoComposicion, abono_unidades: nuevo.abonoUnidades, dosis_kg_ha: nuevo.dosisKgHa,
        aporte_real: nuevo.aporteReal, balance: nuevo.balance,
        recomienda: nuevo.recomienda || null, ejecuta: nuevo.ejecuta || null, fecha_aplicacion: nuevo.fechaAplicacion || null,
        equipo_ids: nuevo.equipoIds,
      })
      if (error) { setPError('No se pudo guardar el plan: ' + error.message); return }
    } catch (e) { setPError('No se pudo guardar el plan en la base de datos.'); return }
    resetearFormularioPlan(); setFormPlan(false)
  }

  const eliminarPlan = async (id: string) => {
    if (!puedeEliminar) return
    if (!confirm('¿Eliminar este plan de abonado ya guardado?')) return
    setPlanes(planes.filter(p => p.id !== id))
    try { await supabase.from('planes_abonado').delete().eq('id', id) } catch (e) { console.error(e) }
  }

  const [planVer, setPlanVer] = useState<PlanAbonado | null>(null)
  const [descargandoId, setDescargandoId] = useState<string | null>(null)

  const etiquetaUnidad = (unidad: string | undefined, opciones: OpcionUnidad[]) => opciones.find(o => o.valor === unidad)?.etiqueta || opciones[0].etiqueta

  const descargarFicha = async (pl: PlanAbonado) => {
    setDescargandoId(pl.id)
    try {
      const parcela = misParcelas.find(p => p.id === pl.parcelaId)
      const equiposDelPlan = pl.equipoIds.map(id => equipos.find(e => e.id === id)).filter(Boolean) as EquipoLite[]
      const recomienda = personal.find(p => p.id === pl.recomienda)
      const ejecuta = personal.find(p => p.id === pl.ejecuta)
      const aporte = calcularAporte(pl.abonoComposicion, pl.abonoUnidades, pl.dosisKgHa)
      await descargarFichaAbonado({
        nombreComercial: pl.abonoNombre, fabricante: pl.abonoFabricante, dosisKgHa: pl.dosisKgHa, cultivo: pl.cultivo,
        superficieTotalHa: parcela?.supHa,
        parcelas: (parcela?.recintos && parcela.recintos.length > 0)
          ? parcela.recintos.map(r => ({ referencia: r.referencia, superficieHa: r.supHa }))
          : [{ referencia: parcela?.referenciaSigpac || parcela?.nombre || '—', superficieHa: parcela?.supHa }],
        nutrientes: NUTRIENTES_LISTA.map(nu => ({
          etiqueta: nu.etiqueta,
          analisis: `${fmt(pl.sueloInicial[nu.clave] || 0)} kg/ha`,
          necesidades: `${fmt(pl.necesidadesCultivo[nu.clave] || 0)} kg/ha`,
          composicion: `${fmt(pl.abonoComposicion[nu.clave] || 0)} ${etiquetaUnidad(pl.abonoUnidades[nu.clave], OPCIONES_CONCENTRACION)}`,
          aplicado: `${fmt(aporte[nu.clave] || 0)} kg/ha`,
        })),
        materiaOrganica: {
          analisis: pl.sueloInicial.materiaOrganica != null ? `${fmt(pl.sueloInicial.materiaOrganica)} %` : '—',
          necesidades: '—', composicion: '—', aplicado: '—',
        },
        ph: pl.sueloInicial.ph != null ? fmt(pl.sueloInicial.ph) : undefined,
        ce: pl.sueloInicial.ce != null ? fmt(pl.sueloInicial.ce) : undefined,
        fecha: pl.fechaAplicacion || pl.fecha,
        maquinaria: equiposDelPlan.map(eq => `${eq.nombre}${eq.nroRoma ? ` (${eq.nroRoma})` : ''}`),
        recomendadoPor: recomienda ? `${recomienda.nombre}${recomienda.nroRopo ? ` (${recomienda.nroRopo})` : ''}` : undefined,
        aplicadoPor: ejecuta ? `${ejecuta.nombre}${ejecuta.nroRopo ? ` (${ejecuta.nroRopo})` : ''}` : undefined,
      }, `ficha-abonado-${pl.fecha}-${(parcela?.nombre || pl.parcelaId).replace(/\s+/g, '_')}.pdf`)
    } catch (e) {
      alert('No se pudo generar la ficha.')
    } finally {
      setDescargandoId(null)
    }
  }

  const balanceColor = (v: number) => v > 0.01 ? 'var(--blue)' : v < -0.01 ? 'var(--red)' : 'var(--green)'

  // ---------- Cuaderno de Abonado (documento completo de campaña) ----------
  const [cuadernoModalVisible, setCuadernoModalVisible] = useState(false)
  const [cuadFincaIds, setCuadFincaIds] = useState<string[]>([])
  const [cuadCampanaId, setCuadCampanaId] = useState('')
  const [generandoCuaderno, setGenerandoCuaderno] = useState(false)

  const formatearFilaNutrientes = (nut: Nutrientes, materiaOrganica?: number): string[] => [
    ...NUTRIENTES_LISTA.map(n => fmt(nut[n.clave] || 0)),
    materiaOrganica != null ? fmt(materiaOrganica) : '—',
  ]
  const formatearComposicionAbono = (comp: Nutrientes, unidades: MapaUnidades): string[] => [
    ...NUTRIENTES_LISTA.map(n => `${fmt(comp[n.clave] || 0)} ${etiquetaUnidad(unidades[n.clave], OPCIONES_CONCENTRACION)}`),
    '—',
  ]

  const generarCuaderno = async () => {
    const campana = campanas.find(c => c.id === cuadCampanaId)
    if (!campana) { alert('Selecciona una campaña para generar el cuaderno.'); return }
    if (fincas.length > 0 && cuadFincaIds.length === 0) { alert('Selecciona al menos una finca — los datos de la explotación (1.1, Titular, 1.5) se guardan y se cargan por finca.'); return }
    setGenerandoCuaderno(true)
    try {
      const idsFincaSel = cuadFincaIds.length > 0 ? new Set(cuadFincaIds) : null
      const fincasSeleccionadas = idsFincaSel ? fincas.filter(f => idsFincaSel.has(f.id)) : fincas

      // Igual que en el Cuaderno de Campo: si varias fincas tienen datos de explotación
      // distintos, se usan los de la primera que los tenga.
      const de = fincasSeleccionadas.map(f => datosExplotacionPorFinca[f.id]).find(Boolean) || {}

      const datosGenerales: { label: string; value: string }[][] = [
        [{ label: 'Nombre y apellidos o razón social', value: de.nombreRazonSocial || '' }],
        [{ label: 'NIF', value: de.nif || '' }],
        [{ label: 'Nº Reg. Explotaciones Nacional', value: de.nroRegExplotNacional || '' }],
        [{ label: 'Nº Reg. Explotaciones Autonómico', value: de.nroRegExplotAutonomico || '' }],
        [{ label: 'Dirección', value: de.direccion || '' }],
        [{ label: 'Localidad', value: de.localidad || '' }],
        [{ label: 'C. Postal / Provincia', value: [de.cPostal, de.provincia].filter(Boolean).join(' / ') }],
        [{ label: 'Teléfono fijo / móvil', value: [de.telefonoFijo, de.telefonoMovil].filter(Boolean).join(' / ') }],
        [{ label: 'e-mail', value: de.email || '' }],
      ]
      const titular: { label: string; value: string }[][] = [
        [{ label: 'Nombre y apellidos', value: de.titularNombre || '' }],
        [{ label: 'NIF', value: de.titularNif || '' }],
        [{ label: 'Dirección', value: de.titularDireccion || '' }],
        [{ label: 'Localidad', value: de.titularLocalidad || '' }],
        [{ label: 'C. Postal / Provincia', value: [de.titularCPostal, de.titularProvincia].filter(Boolean).join(' / ') }],
        [{ label: 'Tipo de representación', value: de.titularTipoRepresentacion || '' }],
        [{ label: 'Teléfono / e-mail', value: [de.titularTelefono, de.titularEmail].filter(Boolean).join(' / ') }],
      ]

      // --- Planes de abonado de la campaña, en las fincas elegidas ---
      const planesFiltrados = planes.filter(pl => pl.campanaId === cuadCampanaId && (!idsFincaSel || idsFincaSel.has(pl.fincaId)))
      if (planesFiltrados.length === 0) { alert('No hay ningún abonado guardado para esa campaña y esas fincas.'); setGenerandoCuaderno(false); return }

      // --- 1.2 / 1.3 / 1.4: solo personal y equipos realmente usados en estos abonados ---
      const idsPersonalUsado = new Set(planesFiltrados.flatMap(pl => [pl.recomienda, pl.ejecuta].filter(Boolean) as string[]))
      const personalUsado = personal.filter(p => idsPersonalUsado.has(p.id))
      const filas12 = personalUsado.map((p, i) => [
        String(i + 1), p.nombre, p.dni || '', p.nroRopo || '', p.nivelCapacitacion || '',
        (p.funciones || []).some(f => f.toLowerCase().includes('asesor')) ? 'X' : '',
      ])
      const idsEquiposUsados = new Set(planesFiltrados.flatMap(pl => pl.equipoIds))
      const equiposUsados = equipos.filter(e => idsEquiposUsados.has(e.id))
      const filas13 = equiposUsados.filter(e => e.titularidad !== 'Externa').map((e, i) => [
        String(i + 1), `${e.tipo}${e.subtipo ? ' ' + e.subtipo : ''} — ${e.nombre}`, e.nroRoma || '', e.fechaAdquisicion || '', e.fechaUltimaInspeccion || '',
      ])
      const filas14 = equiposUsados.filter(e => e.titularidad === 'Externa').map((e, i) => [
        String(i + 1), `${e.tipo}${e.subtipo ? ' ' + e.subtipo : ''} — ${e.nombre}`, e.nroRoma || '', e.dniCif || '',
      ])
      const filas15 = (de.agrupacionNombre || de.agrupacionNif) ? [[de.agrupacionNombre || '', de.agrupacionNif || '', de.agrupacionNroIdentificacion || '', de.agrupacionTipoExplotacion || '']] : []

      // --- 2.1: solo las parcelas de las fincas elegidas que tengan algún abonado en esta campaña ---
      const idsParcelasConAbonado = new Set(planesFiltrados.map(pl => pl.parcelaId))
      const parcelasSel = misParcelas.filter(p => (!idsFincaSel || (p.fincaId && idsFincaSel.has(p.fincaId))) && idsParcelasConAbonado.has(p.id))
      const ordenPorParcela: Record<string, number> = {}
      const filasParcelas: string[][] = []
      parcelasSel.forEach((p, ip) => {
        ordenPorParcela[p.id] = ip + 1
        ;(p.recintos && p.recintos.length > 0 ? p.recintos : [{ referencia: p.referenciaSigpac || '', supHa: p.supHa || 0 }]).forEach(r => {
          filasParcelas.push([
            String(ip + 1), r.provincia || '', r.municipio || '', r.agregado || '', r.zona || '', r.poligono || '', r.parcela || '', r.recinto || '',
            r.usoSigpac || '', r.supHa != null ? fmt(r.supHa, 2) : '', p.supHa != null ? fmt(p.supHa, 2) : '',
            p.cultivo || '', p.variedad || '', p.secanoRegadio || '', p.tipoCultivoAmbiente || '', p.sistAsesoramientoGip || '',
          ])
        })
      })

      const NOTA_SIN_DATOS = 'Sección sin datos disponibles en la aplicación — a rellenar manualmente si procede.'
      const seccionesPrevias: SeccionTabla[] = [
        { numero: '1.2', titulo: 'PERSONAS O EMPRESAS QUE INTERVIENEN', headers: ['Nº orden', 'Nombre y apellidos / Empresas de servicios', 'NIF', 'Nº Inscripción ROPO', 'Tipo de carné', 'Asesor'], colWidths: [1, 3.2, 1.4, 1.6, 1.6, 1], rows: filas12, filasVaciasMin: 4, notas: ['Se marca "Asesor" cuando la persona tiene asignada una función de asesoramiento.'], saltoPaginaAntes: true },
        { numero: '1.3', titulo: 'EQUIPOS DE APLICACIÓN PROPIOS DE LA EXPLOTACIÓN', headers: ['Nº orden', 'Descripción del equipo', 'Nº inscrip. ROMA', 'Fecha de adquisición', 'Fecha de la última inspección'], colWidths: [1, 3, 1.4, 1.6, 1.8], rows: filas13, filasVaciasMin: 3 },
        ...(filas14.length > 0 ? [{ numero: '1.4', titulo: 'EQUIPOS DE APLICACIÓN EXTERNOS DE LA EXPLOTACIÓN', headers: ['Nº orden', 'Descripción del equipo', 'Nº inscrip. ROMA', 'Titular (NIF/CIF)'], colWidths: [1, 3, 1.4, 1.6], rows: filas14, filasVaciasMin: 2 }] : []),
        { numero: '1.5', titulo: 'AGRUPACIÓN O ENTIDAD DE ASESORAMIENTO', headers: ['Nombre o razón social', 'NIF', 'Nº de identificación', 'Tipo de explotación'], colWidths: [3, 1.4, 1.6, 1.6], rows: filas15, filasVaciasMin: 1 },
        { numero: '2.1', titulo: 'DATOS IDENTIFICATIVOS Y AGRONÓMICOS DE LAS PARCELAS', headers: ['Nº orden', 'Cod. Provincia', 'Término municipal', 'Cod. Agregado', 'Zona', 'Nº Polígono', 'Nº Parcela', 'Nº Recinto', 'Uso SIGPAC', 'Sup. SIGPAC (ha)', 'Sup. Cultivada (ha)', 'Especie', 'Variedad', 'Secano/Regadío', 'Aire libre/protegido', 'Sist. asesoramiento GIP'], colWidths: [0.8, 1, 2, 1, 0.8, 1, 1, 1, 1.4, 1.2, 1.2, 1.4, 1.2, 1.3, 1.6, 1.4], rows: filasParcelas, filasVaciasMin: 4, saltoPaginaAntes: true },
        { numero: '2.2', titulo: 'DATOS IDENTIFICATIVOS MEDIOAMBIENTALES DE LAS PARCELAS', headers: ['Id. parcelas', 'Especie', 'Variedad', 'Incluido en la parcela (SI/NO)', 'Distancia (m)', 'Coordenadas UTM', 'Denominación', 'Totalmente (SI/NO)', 'Parcialmente (SI/NO)'], colWidths: [1, 1.4, 1.4, 1.6, 1.2, 1.6, 1.8, 1.4, 1.4], rows: [], filasVaciasMin: 6, notas: [NOTA_SIN_DATOS], saltoPaginaAntes: true },
      ]

      // --- Sección 3.1: los planes filtrados, agrupados por parcela ---
      const porParcela = new Map<string, PlanAbonado[]>()
      planesFiltrados.forEach(pl => {
        if (!porParcela.has(pl.parcelaId)) porParcela.set(pl.parcelaId, [])
        porParcela.get(pl.parcelaId)!.push(pl)
      })

      const parcelasFicha: ParcelaAbonadoFicha[] = Array.from(porParcela.entries()).map(([parcelaId, planesParcela]) => {
        const ordenados = [...planesParcela].sort((a, b) => a.fecha.localeCompare(b.fecha))
        const primero = ordenados[0]
        const parcela = misParcelas.find(p => p.id === parcelaId)
        const abonos: AbonoBloqueFicha[] = ordenados.map(pl => {
          const aporte = calcularAporte(pl.abonoComposicion, pl.abonoUnidades, pl.dosisKgHa)
          const equiposDelPlan = pl.equipoIds.map(id => equipos.find(e => e.id === id)).filter(Boolean) as EquipoLite[]
          const recomienda = personal.find(p => p.id === pl.recomienda)
          const ejecuta = personal.find(p => p.id === pl.ejecuta)
          return {
            nombre: pl.abonoNombre, fabricante: pl.abonoFabricante, numRegistro: pl.abonoNumRegistro, organico: pl.abonoTipo === 'organico',
            composicion: formatearComposicionAbono(pl.abonoComposicion, pl.abonoUnidades),
            aplicado: formatearFilaNutrientes(aporte),
            fecha: pl.fechaAplicacion || pl.fecha, cultivo: pl.cultivo,
            recomendadoPor: recomienda ? `${recomienda.nombre}${recomienda.nroRopo ? ` (${recomienda.nroRopo})` : ''}` : undefined,
            aplicadoPor: ejecuta ? `${ejecuta.nombre}${ejecuta.nroRopo ? ` (${ejecuta.nroRopo})` : ''}` : undefined,
            maquinaria: equiposDelPlan.map(eq => `${eq.nombre}${eq.nroRoma ? ` (${eq.nroRoma})` : ''}`),
          }
        })
        return {
          idParcela: parcela?.nombre || parcelaId,
          analisisSuelo: formatearFilaNutrientes(primero.sueloInicial, primero.sueloInicial.materiaOrganica),
          necesidadCultivo: formatearFilaNutrientes(primero.necesidadesCultivo),
          abonos,
        }
      })

      const nombreCabecera = de.nombreRazonSocial || fincasSeleccionadas.map(f => f.nombre).join(', ') || ''
      await descargarCuadernoAbonado({
        campanaNombre: campana.nombre, campanaFechaInicio: campana.fechaInicio, campanaFechaFin: campana.fechaFin,
        cabecera: nombreCabecera, datosGenerales, titular, seccionesPrevias, parcelas: parcelasFicha,
      }, `cuaderno-abonado-${fincasSeleccionadas.map(f => f.nombre).join('_') || 'fincas'}-${campana.nombre}.docx`.replace(/\s+/g, '_'))
      setCuadernoModalVisible(false)
    } catch (e) {
      alert('No se pudo generar el cuaderno de abonado.')
    } finally {
      setGenerandoCuaderno(false)
    }
  }

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
            <ModalForm titulo={analisisEditar ? '✏ EDITAR ANÁLISIS' : '🧪 NUEVO ANÁLISIS DE SUELO'} onClose={() => { setFormAnalisis(false); setAnalisisEditar(null) }}>
              <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Finca</div>
              <select value={aFincaId} onChange={e => { setAFincaId(e.target.value); setAParcelaIds([]) }} style={inputStyle()}>
                <option value="">Todas las fincas</option>
                {fincas.map(f => <option key={f.id} value={f.id}>{f.nombre}</option>)}
              </select>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Parcelas asociadas</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {misParcelas.filter(p => !aFincaId || p.fincaId === aFincaId).map(p => (
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
              <FilaNutrientesUnidad valores={aNut} unidades={aUnidades} opciones={OPCIONES_CANTIDAD} unidadPorDefecto="kg_ha" baseEtiqueta="kg/ha" onChangeValor={setANut} onChangeUnidad={setAUnidades} />
              {aError && <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)' }}>{aError}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={guardarAnalisis} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>GUARDAR</button>
                <button onClick={() => { setFormAnalisis(false); setAnalisisEditar(null) }} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>CANCELAR</button>
              </div>
            </ModalForm>
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
            <ModalForm titulo={necEditar ? '✏ EDITAR NECESIDADES' : '🌾 NUEVA FICHA DE NECESIDADES'} onClose={() => { setFormNec(false); setNecEditar(null) }}>
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
              <FilaNutrientesUnidad valores={nNut} unidades={nUnidades} opciones={OPCIONES_CANTIDAD} unidadPorDefecto="kg_ha" baseEtiqueta="kg/ha" onChangeValor={setNNut} onChangeUnidad={setNUnidades} />
              {nError && <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)' }}>{nError}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={() => guardarNecesidad()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>GUARDAR</button>
                <button onClick={() => { setFormNec(false); setNecEditar(null) }} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>CANCELAR</button>
              </div>
            </ModalForm>
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
            <ModalForm titulo={abonoEditar ? '✏ EDITAR ABONO' : '📦 NUEVO ABONO'} onClose={() => { setFormAbono(false); setAbonoEditar(null) }}>
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
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 4 }}>Composición garantizada (elige la unidad de cada nutriente)</div>
              <FilaNutrientesUnidad valores={abNut} unidades={abUnidades} opciones={OPCIONES_CONCENTRACION} unidadPorDefecto="pct" baseEtiqueta="g/kg de producto" onChangeValor={setAbNut} onChangeUnidad={setAbUnidades} />
              {abError && <div style={{ color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)' }}>{abError}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button onClick={() => guardarAbono()} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>GUARDAR</button>
                <button onClick={() => { setFormAbono(false); setAbonoEditar(null) }} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>CANCELAR</button>
              </div>
            </ModalForm>
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {puedeEditar && (
              <button onClick={abrirFormPlan} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' }}>+ AÑADIR ABONADO</button>
            )}
          </div>
          {formPlan && (
          <ModalForm titulo="🧮 NUEVO ABONADO" onClose={() => setFormPlan(false)}>
          {/* 4.0 Selección de contexto */}
          <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                    <FilaNutrientesUnidad valores={necNuevaDraft} unidades={necNuevaDraftUnidades} opciones={OPCIONES_CANTIDAD} unidadPorDefecto="kg_ha" baseEtiqueta="kg/ha" onChangeValor={setNecNuevaDraft} onChangeUnidad={setNecNuevaDraftUnidades} />
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
                {pModoObjetivo === 'manual' ? (
                  <FilaNutrientesUnidad valores={pSueloObjetivo} unidades={pSueloObjetivoUnidades} opciones={OPCIONES_CANTIDAD} unidadPorDefecto="kg_ha" baseEtiqueta="kg/ha" onChangeValor={setPSueloObjetivo} onChangeUnidad={setPSueloObjetivoUnidades} />
                ) : (
                  <FilaNutrientes valores={sueloObjetivoNorm} soloLectura />
                )}
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
                    <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Composición (elige la unidad de cada nutriente)</div>
                    <FilaNutrientesUnidad valores={abonoNuevoNut} unidades={abonoNuevoUnidades} opciones={OPCIONES_CONCENTRACION} unidadPorDefecto="pct" baseEtiqueta="g/kg de producto" onChangeValor={setAbonoNuevoNut} onChangeUnidad={setAbonoNuevoUnidades} />
                  </div>
                )}
                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Aporte real (kg/ha), calculado a partir de g/kg de producto × dosis</div>
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
                      <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--mono)', color: balanceColor(balance[nu.clave] || 0) }}>{fmt(balance[nu.clave] || 0)}</div>
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
                      {personalRecomendadores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                    </select></div>
                  <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Quién ejecuta</div>
                    <select value={pEjecuta} onChange={e => setPEjecuta(e.target.value)} style={inputStyle()}>
                      <option value="">Sin asignar</option>
                      {personalAplicadores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                    </select></div>
                  <div><div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>Fecha de aplicación {campanaSel && <span style={{ color: 'var(--muted)' }}>({campanaSel.fechaInicio} a {campanaSel.fechaFin})</span>}</div>
                    <input type="date" value={pFechaAplicacion} min={campanaSel?.fechaInicio} max={campanaSel?.fechaFin} onChange={e => setPFechaAplicacion(e.target.value)} style={inputStyle()} /></div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--mono)', marginBottom: 4 }}>Maquinaria (máx. 2) — de la finca o externa</div>
                  {equiposDisponibles.length === 0 ? (
                    <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay equipos de esta finca ni externos dados de alta en "Equipos".</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                      {equiposDisponibles.map(eq => {
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
                <button onClick={guardarPlan} style={{ padding: '10px 20px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer', letterSpacing: '0.06em' }}>💾 GUARDAR PLAN DE ABONADO</button>
              )}
            </>
          )}
          </ModalForm>
          )}

          {/* Cuaderno de Abonado (documento completo de campaña) */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
            <button onClick={() => setCuadernoModalVisible(true)} style={{ padding: '8px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
              📓 CUADERNO DE ABONADO
            </button>
          </div>

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
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
                    <button onClick={() => setPlanVer(pl)} style={{ fontSize: 9, color: 'var(--text)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Ver</button>
                    <button onClick={() => descargarFicha(pl)} disabled={descargandoId === pl.id} style={{ fontSize: 9, color: 'var(--green)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: descargandoId === pl.id ? 'wait' : 'pointer', textDecoration: 'underline' }}>
                      {descargandoId === pl.id ? 'Generando...' : '⬇ Descargar ficha'}
                    </button>
                    {puedeEliminar && <button onClick={() => eliminarPlan(pl.id)} style={{ fontSize: 9, color: 'var(--red)', fontFamily: 'var(--mono)', background: 'transparent', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Eliminar</button>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {planVer && (
            <ModalForm titulo={`🧮 ABONADO — ${planVer.fecha}`} onClose={() => setPlanVer(null)}>
              <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--mono)', lineHeight: 1.8 }}>
                <div><b>Finca:</b> {fincas.find(f => f.id === planVer.fincaId)?.nombre || '—'} &nbsp; <b>Parcela:</b> {misParcelas.find(p => p.id === planVer.parcelaId)?.nombre || '—'} &nbsp; <b>Cultivo:</b> {planVer.cultivo}</div>
                <div><b>Abono:</b> {planVer.abonoNombre}{planVer.abonoFabricante ? ` (${planVer.abonoFabricante})` : ''} · <b>Dosis:</b> {planVer.dosisKgHa} kg/ha</div>
                <div><b>Recomienda:</b> {personal.find(p => p.id === planVer.recomienda)?.nombre || '—'} &nbsp; <b>Ejecuta:</b> {personal.find(p => p.id === planVer.ejecuta)?.nombre || '—'}</div>
                <div><b>Fecha de aplicación:</b> {planVer.fechaAplicacion || '—'}</div>
                <div><b>Maquinaria:</b><br />{planVer.equipoIds.map(id => equipos.find(e => e.id === id)?.nombre).filter(Boolean).map((n, i) => <span key={i}>{n}<br /></span>) || '—'}</div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 10 }}>
                Lo que había en el suelo, lo aplicado con este abono, y el resultado esperado en la finca (suelo inicial + aplicado) frente al objetivo (kg/ha; P y K en equivalente óxido).
              </div>
              <div style={{ overflowX: 'auto', marginTop: 6 }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--mono)', fontSize: 10 }}>
                  <thead>
                    <tr style={{ background: 'var(--surface2)' }}>
                      {['Nutriente', 'Análisis suelo', 'Necesidades', 'Aplicado', 'Resultado esperado', 'Objetivo', 'Balance'].map(h => (
                        <th key={h} style={{ border: '1px solid var(--border)', padding: '4px 6px', textAlign: 'center', color: 'var(--text)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {NUTRIENTES_LISTA.map(nu => {
                      const aporte = calcularAporte(planVer.abonoComposicion, planVer.abonoUnidades, planVer.dosisKgHa)
                      const resultadoEsperado = (planVer.sueloInicial[nu.clave] || 0) + (aporte[nu.clave] || 0)
                      return (
                        <tr key={nu.clave}>
                          <td style={{ border: '1px solid var(--border)', padding: '4px 6px', fontWeight: 700, color: 'var(--text)' }}>{nu.etiqueta}</td>
                          <td style={{ border: '1px solid var(--border)', padding: '4px 6px', textAlign: 'center', color: 'var(--text)' }}>{fmt(planVer.sueloInicial[nu.clave] || 0)}</td>
                          <td style={{ border: '1px solid var(--border)', padding: '4px 6px', textAlign: 'center', color: 'var(--text)' }}>{fmt(planVer.necesidadesCultivo[nu.clave] || 0)}</td>
                          <td style={{ border: '1px solid var(--border)', padding: '4px 6px', textAlign: 'center', color: 'var(--green)', fontWeight: 700 }}>{fmt(aporte[nu.clave] || 0)}</td>
                          <td style={{ border: '1px solid var(--border)', padding: '4px 6px', textAlign: 'center', color: 'var(--text)', fontWeight: 700 }}>{fmt(resultadoEsperado)}</td>
                          <td style={{ border: '1px solid var(--border)', padding: '4px 6px', textAlign: 'center', color: 'var(--text)' }}>{fmt(planVer.sueloObjetivo[nu.clave] || 0)}</td>
                          <td style={{ border: '1px solid var(--border)', padding: '4px 6px', textAlign: 'center', color: balanceColor(planVer.balance[nu.clave] || 0), fontWeight: 700 }}>{fmt(planVer.balance[nu.clave] || 0)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <button onClick={() => descargarFicha(planVer)} disabled={descargandoId === planVer.id} style={{ marginTop: 12, padding: '8px 16px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                {descargandoId === planVer.id ? 'Generando...' : '⬇ Descargar ficha'}
              </button>
            </ModalForm>
          )}

          {/* Modal Cuaderno de Abonado (selección de campaña y finca/s) */}
          {cuadernoModalVisible && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 3500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--green)', borderRadius: 12, width: '100%', maxWidth: 460, maxHeight: '90vh', overflow: 'auto' }}>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>📄 CUADERNO DE ABONADO</span>
                  <button onClick={() => setCuadernoModalVisible(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
                </div>
                <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
                    Genera el Cuaderno de Abonado en Word con los planes de abonado y parcelas de la campaña y las fincas seleccionadas. Solo se incluyen las parcelas con algún abonado registrado en esa campaña.
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>Campaña</label>
                    {campanas.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay campañas creadas — crea una campaña antes de generar el cuaderno.</div>
                    ) : (
                      <select value={cuadCampanaId} onChange={e => setCuadCampanaId(e.target.value)} style={inputStyle()}>
                        <option value="">— Selecciona una campaña —</option>
                        {campanas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                      </select>
                    )}
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase' }}>
                      Fincas {fincas.length > 0 && <span style={{ color: 'var(--red)', textTransform: 'none' }}>*</span>}
                    </label>
                    {fincas.length === 0 ? (
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>No hay fincas creadas — se usarán todas las parcelas.</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflow: 'auto', padding: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6 }}>
                        {fincas.map(f => {
                          const sel = cuadFincaIds.includes(f.id)
                          return (
                            <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--sans)', color: 'var(--text)', cursor: 'pointer' }}>
                              <input type="checkbox" checked={sel} onChange={() => setCuadFincaIds(sel ? cuadFincaIds.filter(id => id !== f.id) : [...cuadFincaIds, f.id])} />
                              {f.nombre}
                            </label>
                          )
                        })}
                      </div>
                    )}
                    {fincas.length > 0 && cuadFincaIds.length === 0 && (
                      <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginTop: 6 }}>Elige al menos una finca — de ella se cargan los datos de la explotación (1.1, Titular, 1.5).</div>
                    )}
                  </div>
                  {(() => {
                    if (cuadFincaIds.length === 0) return null
                    const fincasSel = fincas.filter(f => cuadFincaIds.includes(f.id))
                    const datasets = fincasSel.map(f => datosExplotacionPorFinca[f.id]).filter(Boolean)
                    const todasIguales = datasets.length === fincasSel.length && datasets.every(d => JSON.stringify(d) === JSON.stringify(datasets[0]))
                    if (datasets.length === 0) {
                      return (
                        <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(15, 74, 112,0.08)', border: '1px solid rgba(15, 74, 112,0.25)', color: 'var(--blue)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                          ℹ Ninguna de las fincas seleccionadas tiene datos de la explotación guardados todavía.
                        </div>
                      )
                    }
                    if (!todasIguales) {
                      return (
                        <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(110, 36, 23,0.08)', border: '1px solid rgba(110, 36, 23,0.2)', color: 'var(--red)', fontSize: 11, fontFamily: 'var(--mono)', lineHeight: 1.5 }}>
                          ⚠ Los datos de la explotación no coinciden entre las fincas seleccionadas. El cuaderno usará los de <strong>{fincasSel.find(f => datosExplotacionPorFinca[f.id])?.nombre}</strong>. Revísalo o genera cuadernos por separado.
                        </div>
                      )
                    }
                    return (
                      <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(31, 74, 40,0.08)', border: '1px solid rgba(31, 74, 40,0.25)', color: 'var(--green)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                        ✓ Datos de la explotación cargados{fincasSel.length > 1 ? ' (coinciden en todas las fincas seleccionadas)' : ''}.
                      </div>
                    )
                  })()}
                  <button onClick={() => onEditarDatosExplotacion(cuadFincaIds)} disabled={cuadFincaIds.length === 0}
                    style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', background: 'transparent', border: 'none', cursor: cuadFincaIds.length === 0 ? 'default' : 'pointer', textDecoration: cuadFincaIds.length === 0 ? 'none' : 'underline', alignSelf: 'flex-start', padding: 0 }}>
                    🌾 {cuadFincaIds.length === 0 ? 'Elige una finca para editar sus datos de la explotación' : `Editar datos de la explotación (${cuadFincaIds.length === 1 ? fincas.find(f => f.id === cuadFincaIds[0])?.nombre : `${cuadFincaIds.length} fincas`})`}
                  </button>
                </div>
                <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
                  <button onClick={generarCuaderno} disabled={generandoCuaderno || !cuadCampanaId || (fincas.length > 0 && cuadFincaIds.length === 0)}
                    style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: (generandoCuaderno || !cuadCampanaId || (fincas.length > 0 && cuadFincaIds.length === 0)) ? 'default' : 'pointer', opacity: (generandoCuaderno || !cuadCampanaId || (fincas.length > 0 && cuadFincaIds.length === 0)) ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                    {generandoCuaderno ? 'GENERANDO...' : '⬇ DESCARGAR WORD'}
                  </button>
                  <button onClick={() => setCuadernoModalVisible(false)} style={{ flex: 1, padding: 11, borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 13, cursor: 'pointer' }}>Cancelar</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
