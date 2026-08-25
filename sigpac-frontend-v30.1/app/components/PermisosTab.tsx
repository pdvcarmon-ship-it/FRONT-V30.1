'use client'

// components/PermisosTab.tsx
//
// Fase 2 del sistema de cuentas y roles: pestaña PERMISOS.
//
// Permite ver y editar el checklist de permisos de CADA trabajador de forma
// independiente (personal.permisos, jsonb) — el rol solo sirve para precargar
// una plantilla de partida (lib/permisos.ts → PLANTILLAS_ROL), a partir de ahí
// los permisos de cada persona son suyos y no afectan a nadie más.
//
// Objetivo pendiente (Fase 4, no implementado aquí): que esta pestaña solo sea
// visible/accesible para roles con permisos.gestionar = true. Por ahora es
// visible para cualquiera que entre a la app, igual que el resto de pestañas —
// no hay todavía ningún control de acceso por rol en el frontend.
//
// Lo que esta pestaña NO toca: estado_acceso ni auth_user_id (eso es la Fase 3,
// alta de personal + login con DNI). Aquí solo se edita `rol` y `permisos`.

import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabaseClient'
import { CATALOGO_PERMISOS, PLANTILLAS_ROL, ROLES_PREDEFINIDOS, PermisoClave, RolPredefinido } from '../lib/permisos'
import type { Session } from '@supabase/supabase-js'

// Tipo mínimo, estructuralmente compatible con `Personal` de page.tsx.
interface PersonalMinimo {
  id: string
  nombre: string
  dni: string
  activo: boolean
  rol?: string
  permisos?: Record<string, boolean>
}

interface Props {
  session: Session | null
  personal: PersonalMinimo[]
  setPersonal: React.Dispatch<React.SetStateAction<any[]>>
  isMobile: boolean
}

const ETIQUETA_ROL: Record<string, string> = {
  empresa: 'Empresa', encargado: 'Encargado', ingeniero: 'Ingeniero', tecnico: 'Técnico', peon: 'Peón',
}

// Agrupa el catálogo de permisos por módulo, en el orden en que aparecen.
const MODULOS = (() => {
  const orden: string[] = []
  const porModulo: Record<string, typeof CATALOGO_PERMISOS> = {}
  CATALOGO_PERMISOS.forEach(p => {
    if (!porModulo[p.modulo]) { porModulo[p.modulo] = []; orden.push(p.modulo) }
    porModulo[p.modulo].push(p)
  })
  return orden.map(m => ({ modulo: m, permisos: porModulo[m] }))
})()

export default function PermisosTab({ session, personal, setPersonal, isMobile }: Props) {
  const [seleccionadoId, setSeleccionadoId] = useState<string | null>(null)
  const [rolLocal, setRolLocal] = useState<string>('')
  const [permisosLocal, setPermisosLocal] = useState<Record<string, boolean>>({})
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const [guardadoOk, setGuardadoOk] = useState(false)

  const trabajadores = useMemo(() => personal.filter(p => p.activo !== false), [personal])
  const seleccionado = trabajadores.find(p => p.id === seleccionadoId) || null

  const seleccionar = (p: PersonalMinimo) => {
    setSeleccionadoId(p.id)
    setRolLocal(p.rol || '')
    setPermisosLocal(p.permisos && Object.keys(p.permisos).length > 0 ? p.permisos : {})
    setError(''); setGuardadoOk(false)
  }

  const cargarPlantilla = (rol: string) => {
    const plantilla = PLANTILLAS_ROL[rol]
    if (!plantilla) return
    if (Object.keys(permisosLocal).length > 0) {
      if (!confirm(`Esto reemplaza el checklist actual por la plantilla de "${ETIQUETA_ROL[rol] || rol}". ¿Continuar?`)) return
    }
    setPermisosLocal({ ...plantilla })
  }

  const toggle = (clave: PermisoClave) => {
    setPermisosLocal(prev => ({ ...prev, [clave]: !prev[clave] }))
    setGuardadoOk(false)
  }

  const guardar = async () => {
    if (!seleccionado || !session) return
    setGuardando(true); setError(''); setGuardadoOk(false)
    try {
      const { error: err } = await supabase.from('personal').update({
        rol: rolLocal || null,
        permisos: permisosLocal,
      }).eq('id', seleccionado.id)
      if (err) { setError('No se pudo guardar: ' + err.message); return }

      setPersonal(prev => prev.map(p => p.id === seleccionado.id ? { ...p, rol: rolLocal || undefined, permisos: permisosLocal } : p))
      setGuardadoOk(true)
    } catch (e: any) {
      setError('No se pudo guardar: ' + (e.message || 'error desconocido'))
    } finally {
      setGuardando(false)
    }
  }

  const inputStyle: React.CSSProperties = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--mono)', outline: 'none' }
  const labelStyle: React.CSSProperties = { fontSize: 9, fontFamily: 'var(--mono)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, display: 'block' }

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: isMobile ? 12 : 24, background: 'var(--bg)' }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 16, fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>Permisos</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
          {trabajadores.length} trabajador{trabajadores.length !== 1 ? 'es' : ''} · permisos independientes por persona
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '260px 1fr', gap: 16 }}>

        {/* Lista de trabajadores */}
        <div style={{ display: 'flex', flexDirection: isMobile ? 'row' : 'column', flexWrap: 'wrap', gap: 6, maxHeight: isMobile ? 160 : undefined, overflow: isMobile ? 'auto' : undefined }}>
          {trabajadores.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)', padding: 10, border: '1px dashed var(--border)', borderRadius: 8 }}>
              Aún no hay personal dado de alta.
            </div>
          )}
          {trabajadores.map(p => {
            const activo = p.id === seleccionadoId
            return (
              <button key={p.id} onClick={() => seleccionar(p)}
                style={{
                  textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                  background: activo ? 'rgba(61,220,110,0.1)' : 'var(--surface)',
                  border: `1px solid ${activo ? 'var(--green)' : 'var(--border)'}`,
                }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: activo ? 'var(--green)' : 'var(--text)' }}>{p.nombre}</div>
                <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                  {p.rol ? (ETIQUETA_ROL[p.rol] || p.rol) : 'Sin rol asignado'}
                </div>
              </button>
            )
          })}
        </div>

        {/* Checklist del trabajador seleccionado */}
        <div>
          {!seleccionado ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12, border: '1px dashed var(--border)', borderRadius: 10 }}>
              Selecciona un trabajador de la lista para ver y editar sus permisos.
            </div>
          ) : (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 18 }}>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{seleccionado.nombre}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{seleccionado.dni}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                  <div>
                    <label style={labelStyle}>Rol</label>
                    <select value={rolLocal} onChange={e => setRolLocal(e.target.value)} style={inputStyle}>
                      <option value="">Sin rol</option>
                      {ROLES_PREDEFINIDOS.map(r => <option key={r} value={r}>{ETIQUETA_ROL[r]}</option>)}
                    </select>
                  </div>
                  <button onClick={() => rolLocal && cargarPlantilla(rolLocal)} disabled={!rolLocal}
                    style={{ padding: '7px 12px', borderRadius: 6, background: 'var(--surface2)', border: '1px solid var(--border)', color: rolLocal ? 'var(--text)' : 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: rolLocal ? 'pointer' : 'default', opacity: rolLocal ? 1 : 0.5 }}>
                    Cargar plantilla
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
                {MODULOS.map(({ modulo, permisos }) => (
                  <div key={modulo}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--blue)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                      {modulo}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 6 }}>
                      {permisos.map(p => (
                        <label key={p.clave} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!permisosLocal[p.clave]} onChange={() => toggle(p.clave)} />
                          {p.etiqueta}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {error && <div style={{ color: '#fca5a5', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 10 }}>{error}</div>}
              {guardadoOk && <div style={{ color: 'var(--green)', fontSize: 11, fontFamily: 'var(--mono)', marginBottom: 10 }}>✓ Guardado</div>}

              <button onClick={guardar} disabled={guardando}
                style={{ padding: '9px 18px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, cursor: guardando ? 'default' : 'pointer', opacity: guardando ? 0.6 : 1 }}>
                {guardando ? 'Guardando...' : 'Guardar permisos'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
