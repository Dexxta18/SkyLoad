import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { api, type Account, type AppConfig, type JobSummary, type Me } from './api'

interface AppState {
  me: Me | null
  config: AppConfig
  accounts: Account[]
  accountsLoaded: boolean
  reloadMe(): Promise<void>
  reloadAccounts(): Promise<void>
  toast(message: string, kind?: 'success' | 'error'): void
}

const AppContext = createContext<AppState | null>(null)

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp outside provider')
  return ctx
}

interface Toast {
  id: number
  message: string
  kind: 'success' | 'error'
}

export function AppProvider({ me: initialMe, config, children }: { me: Me | null; config: AppConfig; children: ReactNode }) {
  const [me, setMe] = useState(initialMe)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const toast = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, message, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000)
  }, [])

  const reloadMe = useCallback(async () => {
    const res = await api<{ user: Me | null }>('/api/me')
    setMe(res.user)
  }, [])

  const reloadAccounts = useCallback(async () => {
    const res = await api<{ accounts: Account[] }>('/api/accounts')
    setAccounts(res.accounts)
    setAccountsLoaded(true)
  }, [])

  useEffect(() => {
    if (me) reloadAccounts().catch((e) => toast(e.message, 'error'))
  }, [me?.id, reloadAccounts, toast])

  const value = useMemo(() => ({ me, config, accounts, accountsLoaded, reloadMe, reloadAccounts, toast }), [me, config, accounts, accountsLoaded, reloadMe, reloadAccounts, toast])

  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex max-w-md items-start gap-2.5 rounded-xl px-4 py-3 text-sm shadow-lg ring-1 ${
              t.kind === 'error' ? 'bg-red-600 text-white ring-red-700' : 'bg-slate-900 text-white ring-black/10 dark:bg-white dark:text-slate-900'
            }`}
          >
            {t.kind === 'error' ? <XCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  )
}

interface JobsState {
  jobs: JobSummary[]
  loaded: boolean
  upsert(job: JobSummary): void
  remove(id: string): void
  reload(): Promise<void>
}

const JobsContext = createContext<JobsState | null>(null)

export function useJobs(kind?: JobSummary['kind']) {
  const ctx = useContext(JobsContext)
  if (!ctx) throw new Error('useJobs outside provider')
  return { ...ctx, jobs: kind ? ctx.jobs.filter((j) => j.kind === kind) : ctx.jobs }
}

/** Holds the user's jobs and keeps them live via Server-Sent Events. */
export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [loaded, setLoaded] = useState(false)

  const upsert = useCallback((job: JobSummary) => {
    setJobs((list) => {
      const i = list.findIndex((j) => j.id === job.id)
      if (i === -1) return [job, ...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      if (list[i].updatedAt > job.updatedAt) return list
      const next = list.slice()
      next[i] = { ...list[i], ...job }
      return next
    })
  }, [])

  const remove = useCallback((id: string) => setJobs((list) => list.filter((j) => j.id !== id)), [])

  const reload = useCallback(async () => {
    const res = await api<{ jobs: JobSummary[] }>('/api/jobs')
    setJobs(res.jobs)
    setLoaded(true)
  }, [])

  useEffect(() => {
    reload().catch(() => setLoaded(true))
    const source = new EventSource('/api/events')
    source.addEventListener('job', (e) => upsert(JSON.parse((e as MessageEvent).data)))
    // After a reconnect, refetch in case updates were missed while offline.
    let wasDown = false
    source.onerror = () => {
      wasDown = true
    }
    source.onopen = () => {
      if (wasDown) reload().catch(() => {})
      wasDown = false
    }
    return () => source.close()
  }, [reload, upsert])

  const value = useMemo(() => ({ jobs, loaded, upsert, remove, reload }), [jobs, loaded, upsert, remove, reload])
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>
}
