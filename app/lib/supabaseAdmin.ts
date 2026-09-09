// lib/supabaseAdmin.ts
//
// ⚠️ SOLO PARA USO EN SERVIDOR (Route Handlers de app/api/**/route.ts).
// Usa la SERVICE ROLE KEY, que se salta todas las políticas RLS — si esto
// se importara desde un componente de cliente ('use client'), la clave
// terminaría en el bundle de JS que descarga el navegador. Next.js ya evita
// esto en la práctica porque las variables sin NEXT_PUBLIC_ no se exponen al
// cliente (serían `undefined` en el navegador), pero aun así: no importar
// este fichero desde ningún componente 'use client'.
//
// Requiere la variable de entorno SUPABASE_SERVICE_ROLE_KEY (sin el
// prefijo NEXT_PUBLIC_, para que Next.js no la incluya en el bundle del
// cliente) — añádela en Vercel: Project Settings → Environment Variables.
// El valor se copia de Supabase Dashboard → Project Settings → API →
// "service_role" (o "secret key", sb_secret_..., en proyectos más recientes).

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!serviceRoleKey) {
  // No lanzamos error en tiempo de import (rompería el build), pero cualquier
  // Route Handler que use este cliente fallará de forma clara si falta la key.
  console.error('[supabaseAdmin] Falta la variable de entorno SUPABASE_SERVICE_ROLE_KEY')
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
