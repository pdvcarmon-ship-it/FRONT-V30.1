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

export type PermisoClave =
  | 'parcelas.ver' | 'parcelas.crear_editar' | 'parcelas.eliminar'
  | 'fincas.ver' | 'fincas.crear_editar' | 'fincas.eliminar'
  | 'tratamientos.ver' | 'tratamientos.crear_editar' | 'tratamientos.eliminar'
  | 'riego.ver' | 'riego.crear_editar' | 'riego.eliminar'
  | 'maquinaria.ver' | 'maquinaria.crear_editar' | 'maquinaria.eliminar'
  | 'stock.ver' | 'stock.crear_editar'
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

  { clave: 'fincas.ver', modulo: 'Fincas', etiqueta: 'Ver fincas' },
  { clave: 'fincas.crear_editar', modulo: 'Fincas', etiqueta: 'Crear / editar fincas' },
  { clave: 'fincas.eliminar', modulo: 'Fincas', etiqueta: 'Eliminar fincas' },

  { clave: 'tratamientos.ver', modulo: 'Tratamientos fitosanitarios', etiqueta: 'Ver tratamientos' },
  { clave: 'tratamientos.crear_editar', modulo: 'Tratamientos fitosanitarios', etiqueta: 'Crear / editar tratamientos' },
  { clave: 'tratamientos.eliminar', modulo: 'Tratamientos fitosanitarios', etiqueta: 'Eliminar tratamientos' },

  { clave: 'riego.ver', modulo: 'Riego', etiqueta: 'Ver sistemas / sectores de riego' },
  { clave: 'riego.crear_editar', modulo: 'Riego', etiqueta: 'Crear / editar riego' },
  { clave: 'riego.eliminar', modulo: 'Riego', etiqueta: 'Eliminar riego' },

  { clave: 'maquinaria.ver', modulo: 'Maquinaria', etiqueta: 'Ver maquinaria' },
  { clave: 'maquinaria.crear_editar', modulo: 'Maquinaria', etiqueta: 'Crear / editar maquinaria' },
  { clave: 'maquinaria.eliminar', modulo: 'Maquinaria', etiqueta: 'Eliminar maquinaria' },

  { clave: 'stock.ver', modulo: 'Stock', etiqueta: 'Ver stock' },
  { clave: 'stock.crear_editar', modulo: 'Stock', etiqueta: 'Crear / editar stock' },

  { clave: 'personal.ver', modulo: 'Personal', etiqueta: 'Ver personal' },
  { clave: 'personal.crear_editar', modulo: 'Personal', etiqueta: 'Crear / editar personal' },

  { clave: 'permisos.gestionar', modulo: 'Permisos', etiqueta: 'Gestionar permisos de otros trabajadores' },

  { clave: 'tareas.ver_todas', modulo: 'Tareas', etiqueta: 'Ver todas las tareas (no solo las propias)' },
  { clave: 'tareas.crear_asignar', modulo: 'Tareas', etiqueta: 'Crear y asignar tareas a otros' },
]

// Construye un objeto de permisos con todas las claves del catálogo a `valor`.
const todosA = (valor: boolean): Record<PermisoClave, boolean> =>
  Object.fromEntries(CATALOGO_PERMISOS.map(p => [p.clave, valor])) as Record<PermisoClave, boolean>

// Plantillas de partida por rol (ver doc §4: precargan el checklist al dar de
// alta a alguien; a partir de ahí son independientes por trabajador).
export const PLANTILLAS_ROL: Record<string, Record<PermisoClave, boolean>> = {
  empresa: todosA(true),
  encargado: todosA(true),
  ingeniero: {
    ...todosA(true),
    'parcelas.eliminar': false, 'fincas.eliminar': false,
    'personal.crear_editar': false, 'permisos.gestionar': false,
  },
  tecnico: {
    ...todosA(false),
    'parcelas.ver': true, 'fincas.ver': true, 'riego.ver': true, 'maquinaria.ver': true,
    'tratamientos.ver': true, 'tratamientos.crear_editar': true,
    'riego.crear_editar': true, 'stock.ver': true,
  },
  peon: {
    ...todosA(false),
    'parcelas.ver': true, 'riego.ver': true, 'maquinaria.ver': true,
  },
}

export const ROLES_PREDEFINIDOS = ['empresa', 'encargado', 'ingeniero', 'tecnico', 'peon'] as const
export type RolPredefinido = typeof ROLES_PREDEFINIDOS[number]
