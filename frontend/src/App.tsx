import { useEffect, useRef, useState } from 'react'
import './App.css'

/* ---------------------------------------------------------------
   AlertManager — frontend simulation
   Flow: log in -> pick an asset (Gold/Silver) + a target price ->
   a mock live feed ticks every 2s -> crossing the target fires an
   in-app "alert sent" toast. No backend yet — everything (session,
   prices, alerts) lives in component state / localStorage.
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
  createdAt: number
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

const SESSION_KEY = 'am_session_email'

function randomWalk(current: number, volatility: number) {
  const delta = (Math.random() - 0.5) * 2 * volatility
  return Math.round((current + delta) * 100) / 100
}

function formatPrice(asset: Asset, value: number) {
  return `${ASSET_META[asset].unit === '$/oz' ? '$' : ''}${value.toFixed(2)}`
}

function App() {
  const [email, setEmail] = useState<string | null>(null)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')

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

  // restore a fake session
  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY)
    if (saved) setEmail(saved)
  }, [])

  // mock live price feed
  useEffect(() => {
    if (!email) return
    const interval = setInterval(() => {
      setPrices((prev) => {
        const next: Record<Asset, number> = {
          gold: randomWalk(prev.gold, ASSET_META.gold.volatility),
          silver: randomWalk(prev.silver, ASSET_META.silver.volatility),
        }
        setPrevPrices(prev)

        // evaluate watching alerts against the new tick
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
            setAlerts((current) =>
              current.map((a) =>
                toTrigger.some((t) => t.id === a.id) ? { ...a, status: 'triggered' } : a
              )
            )
            const newToasts: Toast[] = toTrigger.map((a) => ({
              id: `${a.id}-${Date.now()}`,
              tone: 'trigger',
              message: `${ASSET_META[a.asset].label} ${a.condition === 'above' ? 'rose above' : 'fell below'} ${formatPrice(
                a.asset,
                a.target
              )} — alert sent to ${email}`,
            }))
            setToasts((current) => [...current, ...newToasts])
            newToasts.forEach((t) => {
              setTimeout(() => {
                setToasts((current) => current.filter((x) => x.id !== t.id))
              }, 5000)
            })
          }
        }

        return next
      })
    }, 2000)
    return () => clearInterval(interval)
  }, [email])

  function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    if (!loginEmail.trim() || !loginPassword.trim()) {
      setLoginError('Enter both an email and a password to continue.')
      return
    }
    localStorage.setItem(SESSION_KEY, loginEmail.trim())
    setEmail(loginEmail.trim())
    setLoginError('')
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY)
    setEmail(null)
    setAlerts([])
    setToasts([])
  }

  function handleAddAlert(e: React.FormEvent) {
    e.preventDefault()
    const target = parseFloat(formTarget)
    if (!formTarget || Number.isNaN(target) || target <= 0) {
      setFormError('Enter a target price greater than 0.')
      return
    }
    const alert: PriceAlert = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      asset: formAsset,
      condition: formCondition,
      target,
      status: 'watching',
      createdAt: Date.now(),
    }
    setAlerts((current) => [alert, ...current])
    setFormTarget('')
    setFormError('')
  }

  function removeAlert(id: string) {
    setAlerts((current) => current.filter((a) => a.id !== id))
  }

  if (!email) {
    return (
      <div className="am-root">
        <div className="am-login-wrap">
          <div className="am-login-card">
            <div className="am-dot-row">
              <span className="am-dot" />
              <span className="am-nav-name am-display">AlertManager</span>
            </div>
            <h1 className="am-h2 am-display" style={{ marginTop: 24 }}>
              Sign in to manage your alerts
            </h1>
            <p className="am-h2-sub" style={{ marginBottom: 28 }}>
              Watch gold and silver, and get notified the moment your price is hit.
            </p>
            <form onSubmit={handleLogin} className="am-form">
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
              <button className="am-btn am-btn-primary am-btn-block" type="submit">
                Sign in
              </button>
            </form>
            <p className="am-login-note">
              This is a frontend simulation — any email and password will work for now.
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

//changes