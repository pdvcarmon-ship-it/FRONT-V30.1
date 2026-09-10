// app/api/acceso-trabajador/route.ts
//
// Único punto donde se usa la service role key para gestionar el acceso de
// trabajadores. Recibe (emailEmpresa, dni, password) desde LoginScreen.tsx y:
//
//   - Si es la PRIMERA vez (personal.estado_acceso = 'pendiente'):
//     crea el usuario real de Supabase Auth con un email "sintético" interno
//     (el trabajador nunca lo ve) y la contraseña que acaba de elegir.
//
//   - Si YA tenía acceso ('activo'): no toca nada, solo devuelve el mismo
//     email sintético — la contraseña la valida el propio Supabase Auth
//     cuando el cliente llama a signInWithPassword con ese email, así que
//     este endpoint no necesita comprobar la contraseña en absoluto en ese caso.
//
// El cliente (LoginScreen.tsx) es quien hace el signInWithPassword real,
// usando el syntheticEmail que este endpoint le devuelve.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '../../lib/supabaseAdmin'

interface BodyEsperado {
  emailEmpresa?: string
  dni?: string
  password?: string
}

const normalizarDni = (v: string) => v.trim().toUpperCase()

// El email sintético incluye la cuenta_id, no solo el DNI: así, si la misma
// persona (mismo DNI) trabaja algún día para dos empresas distintas con
// KAMPO, cada una genera un login interno distinto sin colisión.
const emailSinteticoPara = (dni: string, cuentaId: string) =>
  `${normalizarDni(dni).toLowerCase()}@${cuentaId}.kampo.internal`

export async function POST(req: NextRequest) {
  let body: BodyEsperado
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Cuerpo de la petición inválido.' }, { status: 400 })
  }

  const emailEmpresa = (body.emailEmpresa || '').trim()
  const dni = (body.dni || '').trim()
  const password = body.password || ''

  if (!emailEmpresa || !dni || !password) {
    return NextResponse.json({ error: 'Faltan datos: email de empresa, DNI y contraseña son obligatorios.' }, { status: 400 })
  }
  if (password.length < 6) {
    return NextResponse.json({ error: 'La contraseña debe tener al menos 6 caracteres.' }, { status: 400 })
  }

  // 1) Traducir el email de empresa a cuenta_id.
  const { data: cuentaId, error: errCuenta } = await supabaseAdmin.rpc('cuenta_id_por_email_empresa', { p_email: emailEmpresa })
  if (errCuenta) {
    console.error('[acceso-trabajador] Error buscando cuenta:', errCuenta)
    return NextResponse.json({ error: 'No se pudo comprobar la empresa. Inténtalo de nuevo.' }, { status: 500 })
  }
  if (!cuentaId) {
    return NextResponse.json({ error: 'No se encontró ninguna empresa registrada con ese email.' }, { status: 404 })
  }

  // 2) Buscar el personal con ese DNI dentro de esa cuenta (case-insensitive).
  const { data: personalDeLaCuenta, error: errPersonal } = await supabaseAdmin
    .from('personal')
    .select('id, dni, estado_acceso, auth_user_id')
    .eq('cuenta_id', cuentaId)

  if (errPersonal) {
    console.error('[acceso-trabajador] Error buscando personal:', errPersonal)
    return NextResponse.json({ error: 'No se pudo comprobar el DNI. Inténtalo de nuevo.' }, { status: 500 })
  }

  const persona = (personalDeLaCuenta || []).find(p => normalizarDni(p.dni || '') === normalizarDni(dni))
  if (!persona) {
    return NextResponse.json({ error: 'No se ha encontrado ese DNI en esta empresa.' }, { status: 404 })
  }

  if (persona.estado_acceso === 'sin_acceso' || !persona.estado_acceso) {
    return NextResponse.json({ error: 'Esta persona no tiene el acceso habilitado todavía. Contacta con la empresa.' }, { status: 403 })
  }

  const syntheticEmail = emailSinteticoPara(dni, cuentaId)

  // 3) Primera vez: crear el usuario real de Supabase con la contraseña elegida.
  if (persona.estado_acceso === 'pendiente' || !persona.auth_user_id) {
    const { data: nuevoUsuario, error: errCrear } = await supabaseAdmin.auth.admin.createUser({
      email: syntheticEmail,
      password,
      email_confirm: true,
      user_metadata: { tipo_cuenta: 'trabajador' }, // el trigger de altas de empresa ignora esto a propósito
    })
    if (errCrear || !nuevoUsuario?.user) {
      console.error('[acceso-trabajador] Error creando usuario:', errCrear)
      return NextResponse.json({ error: 'No se pudo activar el acceso. Inténtalo de nuevo o contacta con la empresa.' }, { status: 500 })
    }

    const { error: errUpdate } = await supabaseAdmin
      .from('personal')
      .update({ auth_user_id: nuevoUsuario.user.id, estado_acceso: 'activo' })
      .eq('id', persona.id)

    if (errUpdate) {
      console.error('[acceso-trabajador] Usuario creado pero no se pudo vincular a personal:', errUpdate)
      return NextResponse.json({ error: 'Acceso creado pero hubo un problema al vincularlo. Contacta con la empresa.' }, { status: 500 })
    }

    return NextResponse.json({ syntheticEmail })
  }

  // 4) Ya tenía acceso activo: solo devolvemos el email sintético. La
  //    contraseña la valida Supabase Auth en el signInWithPassword del cliente.
  return NextResponse.json({ syntheticEmail })
}
