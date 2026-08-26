// lib/permisosSesion.ts
//
// Fase 4: traduce "quién ha iniciado sesión" en "qué puede ver/hacer".
//
// Regla: si el usuario logueado NO aparece como fila en `personal` (con
// auth_user_id = su id), es el dueño de la cuenta (Empresa) → acceso total.
// Si SÍ aparece en `personal`, usa sus permisos individuales (personal.permisos).

import { CATALOGO_PERMISOS, PermisoClave } from './permisos'

const TODOS_TRUE = (): Record<PermisoClave, boolean> =>
  Object.fromEntries(CATALOGO_PERMISOS.map(p => [p.clave, true])) as Record<PermisoClave, boolean>

const TODOS_FALSE = (): Record<PermisoClave, boolean> =>
  Object.fromEntries(CATALOGO_PERMISOS.map(p => [p.clave, false])) as Record<PermisoClave, boolean>

interface PersonalMinimo {
  authUserId?: string
  permisos?: Record<string, boolean>
}

export function calcularMisPermisos(
  userId: string | undefined,
  personal: PersonalMinimo[]
): Record<PermisoClave, boolean> {
  if (!userId) return TODOS_FALSE()

  const miFila = personal.find(p => p.authUserId === userId)
  if (!miFila) return TODOS_TRUE() // no está en `personal` -> es el dueño (Empresa)

  const base = TODOS_FALSE()
  return { ...base, ...(miFila.permisos || {}) }
}

// Qué permiso hace falta para ver cada pestaña. 'mapa' y 'tareas' no están
// aquí a propósito: el mapa es visible para todos, y tareas se filtra por
// asignación (Fase 5), no se oculta la pestaña entera.
export const PERMISO_POR_PESTANA: Partial<Record<string, PermisoClave>> = {
  mis_parcelas: 'parcelas.ver',
  tratamientos: 'tratamientos.ver',
  personal: 'personal.ver',
  equipos: 'maquinaria.ver',
  riego: 'riego.ver',
  permisos: 'permisos.gestionar',
}

export function puedeVerPestana(pestana: string, misPermisos: Record<PermisoClave, boolean>): boolean {
  const requerido = PERMISO_POR_PESTANA[pestana]
  if (!requerido) return true // sin restricción registrada (mapa, tareas...)
  return !!misPermisos[requerido]
}
