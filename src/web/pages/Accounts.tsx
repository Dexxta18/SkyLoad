import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, Plus, Star, Unplug } from 'lucide-react'
import { api, type Account, type ProviderId } from '../api'
import { accountName, rootName } from '../components/browser'
import { Modal, ProgressBar, ProviderIcon, Spinner } from '../components/ui'
import { bytes, providerLabel } from '../format'
import { useApp } from '../state'

const blurbs: Record<ProviderId, string> = {
  gdrive: 'Save torrents to Drive and move files in or out.',
  dropbox: 'Copy files to and from Dropbox.',
  onedrive: 'Personal or work OneDrive.',
  mega: 'Sign in with your Mega email and password.',
  local: 'Development only.',
}

function Quota({ account }: { account: Account }) {
  const [quota, setQuota] = useState<{ used: number; total: number | null } | null | undefined>()
  useEffect(() => {
    if (account.needsReauth) return
    api<{ quota: { used: number; total: number | null } | null }>(`/api/accounts/${account.id}/quota`)
      .then((r) => setQuota(r.quota))
      .catch(() => setQuota(null))
  }, [account.id, account.needsReauth])
  if (quota === undefined) return <div className="h-2 w-full animate-pulse rounded-full bg-slate-100 dark:bg-white/10" />
  if (!quota) return null
  if (!quota.total) return <p className="muted text-xs">{bytes(quota.used)} used</p>
  const fraction = quota.used / quota.total
  return (
    <div>
      <ProgressBar value={fraction} tone={fraction > 0.9 ? 'red' : 'brand'} />
      <p className="muted mt-1 text-xs">
        {bytes(quota.total - quota.used)} free of {bytes(quota.total)}
      </p>
    </div>
  )
}

function MegaModal({ onClose }: { onClose(): void }) {
  const { reloadAccounts, reloadMe, toast } = useApp()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needsCode, setNeedsCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api('/api/accounts/mega', { body: { email, password, code } })
      await Promise.all([reloadAccounts(), reloadMe()])
      toast('Mega connected')
      onClose()
    } catch (e) {
      const message = (e as Error).message
      if (/two-factor/i.test(message)) setNeedsCode(true)
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Connect Mega"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" form="mega-form" disabled={busy || !email || !password}>
            {busy && <Spinner />} Connect
          </button>
        </>
      }
    >
      <form
        id="mega-form"
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="block">
          <span className="label">Email</span>
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {needsCode && (
          <label className="block">
            <span className="label">Two-factor code</span>
            <input className="input" inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </label>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <p className="muted text-xs">Mega has no "Sign in with Mega" option, so we sign in once and keep only the resulting session (encrypted). Your password is never stored.</p>
      </form>
    </Modal>
  )
}

export default function Accounts() {
  const { accounts, accountsLoaded, config, me, reloadAccounts, reloadMe, toast } = useApp()
  const [params, setParams] = useSearchParams()
  const [megaOpen, setMegaOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    const connected = params.get('connected') as ProviderId | null
    const error = params.get('error')
    if (connected) toast(`${providerLabel[connected] ?? 'Account'} connected`)
    if (error) toast(error, 'error')
    if (connected || error) setParams({}, { replace: true })
  }, [params, setParams, toast])

  const connect = (provider: ProviderId) => {
    if (provider === 'mega') return setMegaOpen(true)
    if (provider === 'local') {
      api('/api/accounts/local', { method: 'POST' })
        .then(() => Promise.all([reloadAccounts(), reloadMe()]))
        .catch((e) => toast(e.message, 'error'))
      return
    }
    window.location.href = `/api/auth/connect/${provider}`
  }

  const disconnect = async (a: Account) => {
    if (!confirm(`Disconnect ${providerLabel[a.provider]} (${accountName(a)})? Running jobs that use it will fail.`)) return
    setBusyId(a.id)
    try {
      await api(`/api/accounts/${a.id}`, { method: 'DELETE' })
      await Promise.all([reloadAccounts(), reloadMe()])
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const makeDefault = async (a: Account) => {
    setBusyId(a.id)
    try {
      await api('/api/me/settings', { method: 'PATCH', body: { defaultDestination: { accountId: a.id, folderId: 'root', folderName: rootName(a) } } })
      await reloadMe()
      toast(`New downloads will go to ${providerLabel[a.provider]} › ${rootName(a)}`)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const defaultId = me?.settings.defaultDestination?.accountId

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Cloud accounts</h1>
        <p className="muted mt-1">Connect the places you want files to go. You can connect several accounts of the same kind.</p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">Connected</h2>
        {!accountsLoaded ? (
          <div className="flex justify-center p-8">
            <Spinner className="size-6 text-slate-400" />
          </div>
        ) : accounts.length === 0 ? (
          <p className="card muted p-5 text-sm">Nothing connected yet. Start with Google Drive below.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {accounts.map((a) => (
              <li key={a.id} className="card flex flex-col gap-3 p-4">
                <div className="flex items-center gap-3">
                  <ProviderIcon provider={a.provider} className="size-10" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{accountName(a)}</p>
                    <p className="muted text-xs">
                      {providerLabel[a.provider]}
                      {a.id === defaultId && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                          <Star className="size-3" /> Default
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                {a.needsReauth ? (
                  <div className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                    <AlertTriangle className="size-4 shrink-0" /> Access expired.
                    <button className="ml-auto font-medium underline" onClick={() => connect(a.provider)}>
                      Reconnect
                    </button>
                  </div>
                ) : (
                  <Quota account={a} />
                )}
                <div className="mt-auto flex flex-wrap gap-1.5">
                  {a.id !== defaultId && (
                    <button className="btn-ghost px-3 py-1.5" disabled={busyId === a.id} onClick={() => makeDefault(a)}>
                      <Star className="size-4" /> Make default
                    </button>
                  )}
                  <button className="btn-danger ml-auto px-3 py-1.5" disabled={busyId === a.id} onClick={() => disconnect(a)}>
                    <Unplug className="size-4" /> Disconnect
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">Add an account</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {(['gdrive', 'dropbox', 'onedrive', 'mega', 'local'] as ProviderId[]).map((id) => {
            const available = config.providers.some((p) => p.id === id)
            if (id === 'local' && !available) return null
            return (
              <li key={id} className="card flex items-center gap-3 p-4">
                <ProviderIcon provider={id} className="size-10" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{providerLabel[id]}</p>
                  <p className="muted text-xs">{available ? blurbs[id] : 'Not set up on this server yet.'}</p>
                </div>
                <button className="btn-secondary px-3 py-1.5" disabled={!available} onClick={() => connect(id)}>
                  <Plus className="size-4" /> Connect
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      {megaOpen && <MegaModal onClose={() => setMegaOpen(false)} />}
    </div>
  )
}
