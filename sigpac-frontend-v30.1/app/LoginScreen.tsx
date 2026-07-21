'use client'

import { useState } from 'react'
import { supabase } from './lib/supabaseClient'

interface Props {
  onLogin: () => void
}

export default function LoginScreen({ onLogin }: Props) {
  const [modo, setModo] = useState<'login' | 'registro'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [cargando, setCargando] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setInfo('')
    if (!email.trim() || !password.trim()) {
      setError('Introduce email y contraseña')
      return
    }
    if (password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres')
      return
    }
    setCargando(true)
    try {
      if (modo === 'login') {
        const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (err) throw err
        onLogin()
      } else {
        const { error: err, data } = await supabase.auth.signUp({ email: email.trim(), password })
        if (err) throw err
        if (data.session) {
          onLogin()
        } else {
          setInfo('Cuenta creada. Revisa tu email para confirmar y luego inicia sesión.')
          setModo('login')
        }
      }
    } catch (e: any) {
      const msg = e.message || 'Error desconocido'
      if (msg.includes('Invalid login credentials')) setError('Email o contraseña incorrectos')
      else if (msg.includes('User already registered')) setError('Ya existe una cuenta con ese email')
      else setError(msg)
    } finally {
      setCargando(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }}>
      <div style={{ width: '100%', maxWidth: 380, padding: 32, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🌱</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, letterSpacing: '0.06em' }}>
            <span style={{ color: 'var(--green)' }}>K</span>
            <span style={{ color: '#fff' }}>AMPO</span>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            {modo === 'login' ? 'Inicia sesión en tu cuenta' : 'Crea una cuenta nueva'}
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="tu@email.com"
              autoComplete="email"
              style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--sans)', outline: 'none' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--muted)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              autoComplete={modo === 'login' ? 'current-password' : 'new-password'}
              style={{ width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--sans)', outline: 'none' }}
            />
          </div>

          {error && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)', color: '#fca5a5', fontSize: 12, fontFamily: 'var(--mono)' }}>⚠ {error}</div>}
          {info && <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(61,220,110,0.08)', border: '1px solid rgba(61,220,110,0.2)', color: 'var(--green)', fontSize: 12, fontFamily: 'var(--mono)' }}>✓ {info}</div>}

          <button
            type="submit"
            disabled={cargando}
            style={{ padding: '12px', borderRadius: 8, background: 'var(--green)', border: 'none', color: 'var(--bg)', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: cargando ? 'wait' : 'pointer', letterSpacing: '0.06em' }}
          >
            {cargando ? '...' : modo === 'login' ? 'INICIAR SESIÓN' : 'CREAR CUENTA'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button
            onClick={() => { setModo(modo === 'login' ? 'registro' : 'login'); setError(''); setInfo('') }}
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
          >
            {modo === 'login' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}
          </button>
        </div>
      </div>
    </div>
  )
}
