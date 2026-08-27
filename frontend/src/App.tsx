import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'
import './App.css'

/* ---------------------------------------------------------------
   AlertManager — now backed by Supabase
   Flow: real email/password auth via Supabase Auth -> alerts read
   from and written to a Postgres 'alerts' table (RLS-scoped to the
   logged-in user) -> a mock live feed still ticks every 2s locally
   and flips an alert's status to 'triggered' in the DB when hit.
----------------------------------------------------------------*/

type Asset = 'gold' | 'silver'
type Condition = 'above' | 'below'
type AlertStatus = 'watching' | 'triggered'

interface PriceAlert {
  id: string
  asset: Asset
  condition: Condition
  target: number
  status: AlertStatus
  created_at: string
}

interface Toast {
  id: string
  message: string
  tone: 'signal' | 'trigger'
}

const ASSET_META: Record<Asset, { label: string; unit: string; base: number; volatility: number }> = {
  gold: { label: 'Gold', unit: '$/oz', base: 2438, volatility: 3.2 },
  silver: { label: 'Silver', unit: '$/oz', base: 29.4, volatility: 0.18 },
}

function randomWalk(current: number, volatility: number) {
  const delta = (Math.random() - 0.5) * 2 * volatility
  return Math.round((current + delta) * 100) / 100
}

function formatPrice(asset: Asset, value: number) {
  return `${ASSET_META[asset].unit === '$/oz' ? '$' : ''}${value.toFixed(2)}`
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authLoading, setAuthLoading] = useState(true)

  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')
  const [authBusy, setAuthBusy] = useState(false)

  const [prices, setPrices] = useState<Record<Asset, number>>({
    gold: ASSET_META.gold.base,
    silver: ASSET_META.silver.base,
  })
  const [prevPrices, setPrevPrices] = useState<Record<Asset, number>>(prices)

  const [alerts, setAlerts] = useState<PriceAlert[]>([])
  const [formAsset, setFormAsset] = useState<Asset>('gold')
  const [formCondition, setFormCondition] = useState<Condition>('above')
  const [formTarget, setFormTarget] = useState('')
  const [formError, setFormError] = useState('')

  const [toasts, setToasts] = useState<Toast[]>([])
  const alertsRef = useRef<PriceAlert[]>(alerts)
  alertsRef.current = alerts

  const email = session?.user?.email ?? null
  const userId = session?.user?.id ?? null

  // pick up the current session on load, and keep it in sync
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthLoading(false)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  // load this user's alerts whenever they log in, and keep them live
  useEffect(() => {
    if (!userId) {
      setAlerts([])
      return
    }

    let cancelled = false
    supabase
      .from('alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!cancelled && !error && data) setAlerts(data as PriceAlert[])
      })

    // keep the list in sync if the row changes from another tab/device
    const channel = supabase
      .channel('alerts-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'alerts', filter: `user_id=eq.${userId}` },
        (payload) => {
          setAlerts((current) => {
            if (payload.eventType === 'INSERT') {
              const row = payload.new as PriceAlert
              return current.some((a) => a.id === row.id) ? current : [row, ...current]
            }
            if (payload.eventType === 'UPDATE') {
              const row = payload.new as PriceAlert
              return current.map((a) => (a.id === row.id ? row : a))
            }
            if (payload.eventType === 'DELETE') {
              const row = payload.old as PriceAlert
              return current.filter((a) => a.id !== row.id)
            }
            return current
          })
        }
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [userId])

  // mock live price feed
  useEffect(() => {
    if (!userId) return
    const interval = setInterval(() => {
      setPrices((prev) => {
        const next: Record<Asset, number> = {
          gold: randomWalk(prev.gold, ASSET_META.gold.volatility),
          silver: randomWalk(prev.silver, ASSET_META.silver.volatility),
        }
        setPrevPrices(prev)

        const stillWatching = alertsRef.current.filter((a) => a.status === 'watching')
        if (stillWatching.length) {
          const toTrigger: PriceAlert[] = []
          for (const a of stillWatching) {
            const price = next[a.asset]
            const hit =
              (a.condition === 'above' && price >= a.target) ||
              (a.condition === 'below' && price <= a.target)
            if (hit) toTrigger.push(a)
          }
          if (toTrigger.length) {
            toTrigger.forEach(async (a) => {
              // Atomic one-time transition. The database webhook should send
              // the email only when status changes from watching -> triggered.
              const { data, error } = await supabase
                .from('alerts')
                .update({ status: 'triggered' })
                .eq('id', a.id)
                .eq('status', 'watching')
                .select('id')
                .maybeSingle()

              // No row means this alert was already triggered by another tick/tab.
              if (error) {
                console.error('Failed to trigger alert:', error)
                return
              }
              if (!data) return

              // Update this tab immediately; Realtime will keep other tabs/devices synced.
              setAlerts((current) =>
                current.map((item) =>
                  item.id === a.id ? { ...item, status: 'triggered' as AlertStatus } : item
                )
              )

              const toast: Toast = {
                id: `${a.id}-${Date.now()}`,
                tone: 'trigger',
                message: `${ASSET_META[a.asset].label} ${
                  a.condition === 'above' ? 'rose above' : 'fell below'
                } ${formatPrice(a.asset, a.target)} — alert triggered`,
              }

              setToasts((current) => [...current, toast])
              setTimeout(() => {
                setToasts((current) => current.filter((x) => x.id !== toast.id))
              }, 5000)
            })
          }
        }

        return next
      })
    }, 2000)
    return () => clearInterval(interval)
  }, [userId])

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault()
    if (!loginEmail.trim() || !loginPassword.trim()) {
      setLoginError('Enter both an email and a password to continue.')
      return
    }
    setAuthBusy(true)
    setLoginError('')

    const { error } =
      authMode === 'signup'
        ? await supabase.auth.signUp({ email: loginEmail.trim(), password: loginPassword })
        : await supabase.auth.signInWithPassword({ email: loginEmail.trim(), password: loginPassword })

    setAuthBusy(false)
    if (error) setLoginError(error.message)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    setAlerts([])
    setToasts([])
  }

  async function handleAddAlert(e: React.FormEvent) {
    e.preventDefault()
    const target = parseFloat(formTarget)
    if (!formTarget || Number.isNaN(target) || target <= 0) {
      setFormError('Enter a target price greater than 0.')
      return
    }
    if (!userId) return

    const { error } = await supabase.from('alerts').insert({
      user_id: userId,
      asset: formAsset,
      condition: formCondition,
      target,
      status: 'watching',
    })

    if (error) {
      setFormError(error.message)
      return
    }
    setFormTarget('')
    setFormError('')
  }

  async function removeAlert(id: string) {
    await supabase.from('alerts').delete().eq('id', id)
  }

  if (authLoading) {
    return <div className="am-root" />
  }

  if (!session) {
    return (
      <div className="am-root">
        <div className="am-login-wrap">
          <div className="am-login-card">
            <div className="am-dot-row">
              <span className="am-dot" />
              <span className="am-nav-name am-display">AlertManager</span>
            </div>
            <h1 className="am-h2 am-display" style={{ marginTop: 24 }}>
              {authMode === 'signup' ? 'Create your account' : 'Sign in to manage your alerts'}
            </h1>
            <p className="am-h2-sub" style={{ marginBottom: 28 }}>
              Watch gold and silver, and get notified the moment your price is hit.
            </p>
            <form onSubmit={handleAuth} className="am-form">
              <label className="am-field">
                <span>Email</span>
                <input
                  className="am-input"
                  type="email"
                  placeholder="you@example.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                />
              </label>
              <label className="am-field">
                <span>Password</span>
                <input
                  className="am-input"
                  type="password"
                  placeholder="••••••••"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                />
              </label>
              {loginError && <p className="am-form-error">{loginError}</p>}
              <button className="am-btn am-btn-primary am-btn-block" type="submit" disabled={authBusy}>
                {authBusy ? 'Please wait…' : authMode === 'signup' ? 'Sign up' : 'Sign in'}
              </button>
            </form>
            <p className="am-login-note">
              {authMode === 'signup' ? 'Already have an account? ' : "Don't have an account? "}
              <button
                type="button"
                className="am-btn am-btn-ghost am-btn-small"
                onClick={() => {
                  setAuthMode(authMode === 'signup' ? 'signin' : 'signup')
                  setLoginError('')
                }}
              >
                {authMode === 'signup' ? 'Sign in' : 'Sign up'}
              </button>
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="am-root">
      {/* NAV */}
      <nav className="am-nav">
        <div className="am-nav-brand">
          <span className="am-dot" />
          <span className="am-nav-name am-display">AlertManager</span>
        </div>
        <div className="am-nav-user">
          <span className="am-nav-email am-mono">{email}</span>
          <button className="am-btn am-btn-ghost am-btn-small" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </nav>

      <main className="am-shell am-dashboard">
        {/* LIVE PRICES */}
        <section className="am-price-grid">
          {(Object.keys(ASSET_META) as Asset[]).map((asset) => {
            const meta = ASSET_META[asset]
            const price = prices[asset]
            const prev = prevPrices[asset]
            const up = price >= prev
            return (
              <div className="am-price-card" key={asset}>
                <div className="am-price-top">
                  <span className="am-price-label">{meta.label}</span>
                  <span className={`am-status-chip ${up ? 'firing' : ''}`} />
                </div>
                <div className="am-price-value am-display">{formatPrice(asset, price)}</div>
                <div className={`am-price-delta ${up ? 'am-ticker-up' : 'am-ticker-down'} am-mono`}>
                  {up ? '▲' : '▼'} {Math.abs(price - prev).toFixed(2)} since last tick
                </div>
              </div>
            )
          })}
        </section>

        {/* CREATE ALERT */}
        <section className="am-card am-alert-form-card">
          <div className="am-kicker">New alert</div>
          <h2 className="am-h2 am-display" style={{ fontSize: 22, marginBottom: 18 }}>
            Tell us what price to watch for
          </h2>
          <form onSubmit={handleAddAlert} className="am-alert-form">
            <label className="am-field">
              <span>Asset</span>
              <select
                className="am-input am-select"
                value={formAsset}
                onChange={(e) => setFormAsset(e.target.value as Asset)}
              >
                <option value="gold">Gold</option>
                <option value="silver">Silver</option>
              </select>
            </label>
            <label className="am-field">
              <span>Condition</span>
              <select
                className="am-input am-select"
                value={formCondition}
                onChange={(e) => setFormCondition(e.target.value as Condition)}
              >
                <option value="above">Rises above</option>
                <option value="below">Falls below</option>
              </select>
            </label>
            <label className="am-field">
              <span>Target price ({ASSET_META[formAsset].unit})</span>
              <input
                className="am-input"
                type="number"
                step="0.01"
                placeholder={ASSET_META[formAsset].base.toString()}
                value={formTarget}
                onChange={(e) => setFormTarget(e.target.value)}
              />
            </label>
            <button className="am-btn am-btn-primary" type="submit">
              Add alert
            </button>
          </form>
          {formError && <p className="am-form-error">{formError}</p>}
        </section>

        {/* ALERT LIST */}
        <section className="am-card">
          <div className="am-kicker">Your alerts</div>
          <h2 className="am-h2 am-display" style={{ fontSize: 22, marginBottom: 18 }}>
            {alerts.length ? `${alerts.length} alert${alerts.length > 1 ? 's' : ''}` : 'No alerts yet'}
          </h2>
          {alerts.length === 0 ? (
            <p className="am-h2-sub" style={{ marginBottom: 0 }}>
              Add one above — as soon as gold or silver crosses your target, you'll see it here
              and get a notification.
            </p>
          ) : (
            <div className="am-alert-table">
              {alerts.map((a) => (
                <div className="am-alert-row" key={a.id}>
                  <div className="am-alert-row-main">
                    <span className="am-alert-asset am-display">{ASSET_META[a.asset].label}</span>
                    <span className="am-alert-cond am-mono">
                      {a.condition === 'above' ? 'rises above' : 'falls below'}{' '}
                      {formatPrice(a.asset, a.target)}
                    </span>
                  </div>
                  <div className="am-alert-row-side">
                    <span className={`am-badge ${a.status === 'triggered' ? 'am-badge-triggered' : ''}`}>
                      {a.status === 'triggered' ? 'Triggered' : 'Watching'}
                    </span>
                    <button className="am-alert-remove" onClick={() => removeAlert(a.id)} aria-label="Remove alert">
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* TOASTS */}
      <div className="am-toast-stack">
        {toasts.map((t) => (
          <div className={`am-toast am-toast-${t.tone}`} key={t.id}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}

export default App