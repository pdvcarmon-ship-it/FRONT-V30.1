// lib/permisos.ts
//
// Catálogo FIJO de permisos por módulo (Fase 0 del documento de estrategia).
// La empresa activa/desactiva casillas de esta lista — nunca se inventan
// capacidades nuevas desde la UI. Si mañana se añade un módulo a KAMPO,
// se añade aquí su clave y aparece automáticamente en la pestaña PERMISOS.
//
// Los permisos viven por TRABAJADOR (en personal.permisos, jsonb), no por rol.
// `PLANTILLAS_ROL` de aquí abajo solo se usa para PRECARGAR el checklist al dar
// de alta a alguien — a partir de ese momento son independientes por persona.
//
// Cambios tras pruebas reales (ver conversación):
// - Se elimina 'fincas.ver': no tenía sentido como permiso independiente,
//   ver una finca sin poder ver sus parcelas no es un caso de uso real.
// - 'fincas.crear_editar' / 'fincas.eliminar' pasan al módulo "Parcelas"
//   (misma sección en la pestaña PERMISOS), en vez de tener su propio módulo.
// - 'stock.*' desaparece como claves propias: el stock se gestiona ahora con
//   los mismos permisos que los tratamientos fitosanitarios (ver = ver la
//   pestaña, que ya incluye stock; crear_editar = dar de alta/quitar stock).

export type PermisoClave =
  | 'parcelas.ver' | 'parcelas.crear_editar' | 'parcelas.eliminar'
  | 'parcelas.solo_fincas_asignadas'
  | 'fincas.crear_editar' | 'fincas.eliminar'
  | 'tratamientos.ver' | 'tratamientos.crear_editar' | 'tratamientos.eliminar'
  | 'riego.ver' | 'riego.crear_editar' | 'riego.eliminar'
  | 'maquinaria.ver' | 'maquinaria.crear_editar' | 'maquinaria.eliminar'
  | 'personal.ver' | 'personal.crear_editar'
  | 'permisos.gestionar'
  | 'tareas.ver_todas' | 'tareas.crear_asignar'

export interface PermisoDescriptor {
  clave: PermisoClave
  modulo: string       // agrupación para pintar la pestaña PERMISOS por secciones
  etiqueta: string      // texto corto junto al checkbox
}

export const CATALOGO_PERMISOS: PermisoDescriptor[] = [
  { clave: 'parcelas.ver', modulo: 'Parcelas', etiqueta: 'Ver parcelas' },
  { clave: 'parcelas.crear_editar', modulo: 'Parcelas', etiqueta: 'Crear / editar parcelas' },
  { clave: 'parcelas.eliminar', modulo: 'Parcelas', etiqueta: 'Eliminar parcelas' },
  { clave: 'parcelas.solo_fincas_asignadas', modulo: 'Parcelas', etiqueta: 'Restringir a solo las fincas asignadas (se asignan en Personal)' },
  { clave: 'fincas.crear_editar', modulo: 'Parcelas', etiqueta: 'Crear / editar fincas' },
  { clave: 'fincas.eliminar', modulo: 'Parcelas', etiqueta: 'Eliminar fincas' },

  { clave: 'tratamientos.ver', modulo: 'Tratamientos fitosanitarios', etiqueta: 'Ver tratamientos y stock' },
  { clave: 'tratamientos.crear_editar', modulo: 'Tratamientos fitosanitarios', etiqueta: 'Crear / editar tratamientos y stock' },
  { clave: 'tratamientos.eliminar', modulo: 'Tratamientos fitosanitarios', etiqueta: 'Eliminar tratamientos' },

  { clave: 'riego.ver', modulo: 'Riego', etiqueta: 'Ver sistemas / sectores de riego' },
  { clave: 'riego.crear_editar', modulo: 'Riego', etiqueta: 'Crear / editar riego' },
  { clave: 'riego.eliminar', modulo: 'Riego', etiqueta: 'Eliminar riego' },

  { clave: 'maquinaria.ver', modulo: 'Maquinaria', etiqueta: 'Ver maquinaria' },
  { clave: 'maquinaria.crear_editar', modulo: 'Maquinaria', etiqueta: 'Crear / editar maquinaria' },
  { clave: 'maquinaria.eliminar', modulo: 'Maquinaria', etiqueta: 'Eliminar maquinaria' },

  { clave: 'personal.ver', modulo: 'Personal', etiqueta: 'Ver personal' },
  { clave: 'personal.crear_editar', modulo: 'Personal', etiqueta: 'Crear / editar personal' },

  { clave: 'permisos.gestionar', modulo: 'Permisos', etiqueta: 'Gestionar permisos de otros trabajadores' },

  { clave: 'tareas.ver_todas', modulo: 'Tareas', etiqueta: 'Ver todas las tareas (no solo las propias)' },
  { clave: 'tareas.crear_asignar', modulo: 'Tareas', etiqueta: 'Crear, asignar y eliminar tareas' },
]

// Construye un objeto de permisos con todas las claves del catálogo a `valor`.
const todosA = (valor: boolean): Record<PermisoClave, boolean> =>
  Object.fromEntries(CATALOGO_PERMISOS.map(p => [p.clave, valor])) as Record<PermisoClave, boolean>

// Plantillas de partida por rol (ver doc §4: precargan el checklist al dar de
// alta a alguien; a partir de ahí son independientes por trabajador).
export const PLANTILLAS_ROL: Record<string, Record<PermisoClave, boolean>> = {
  empresa: { ...todosA(true), 'parcelas.solo_fincas_asignadas': false },
  encargado: { ...todosA(true), 'parcelas.solo_fincas_asignadas': false },
  ingeniero: {
    ...todosA(true),
    'parcelas.eliminar': false, 'fincas.eliminar': false,
    'personal.crear_editar': false, 'permisos.gestionar': false,
    'parcelas.solo_fincas_asignadas': false,
  },
  tecnico: {
    ...todosA(false),
    'parcelas.ver': true, 'riego.ver': true, 'maquinaria.ver': true,
    'tratamientos.ver': true, 'tratamientos.crear_editar': true,
    'riego.crear_editar': true,
  },
  peon: {
    ...todosA(false),
    'parcelas.ver': true, 'riego.ver': true, 'maquinaria.ver': true,
    'parcelas.solo_fincas_asignadas': true,
  },
}

export const ROLES_PREDEFINIDOS = ['empresa', 'encargado', 'ingeniero', 'tecnico', 'peon'] as const
export type RolPredefinido = typeof ROLES_PREDEFINIDOS[number]
