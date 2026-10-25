import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowRightLeft, Plus } from 'lucide-react'
import { api, type Destination, type Entry, type JobSummary } from '../api'
import { AccountSelect, FolderListing, rootName, type Crumb } from '../components/browser'
import { DestinationPicker } from '../components/destination'
import { JobList } from '../components/jobs'
import { EmptyState, Spinner } from '../components/ui'
import { bytes } from '../format'
import { useApp, useJobs } from '../state'

export default function Transfers() {
  const { accounts, accountsLoaded, toast } = useApp()
  const { upsert } = useJobs()
  const [sourceId, setSourceId] = useState<string | undefined>(accounts[0]?.id)
  const source = accounts.find((a) => a.id === (sourceId ?? accounts[0]?.id))
  const [trail, setTrail] = useState<Crumb[] | null>(null)
  const [selected, setSelected] = useState<Map<string, Entry>>(new Map())
  const [destination, setDestination] = useState<Destination>()
  const [mode, setMode] = useState<'copy' | 'move'>('copy')
  const [busy, setBusy] = useState(false)

  const effectiveTrail = trail ?? (source ? [{ id: 'root', name: rootName(source) }] : [])

  const switchSource = (id: string) => {
    setSourceId(id)
    setTrail(null)
    setSelected(new Map())
  }

  const toggle = (e: Entry) =>
    setSelected((s) => {
      const next = new Map(s)
      if (next.has(e.id)) next.delete(e.id)
      else next.set(e.id, e)
      return next
    })

  const start = async () => {
    if (!source || !destination || selected.size === 0) return
    setBusy(true)
    try {
      const items = [...selected.values()].map(({ id, name, isFolder, size }) => ({ id, name, isFolder, size }))
      const res = await api<{ job: JobSummary }>('/api/jobs/transfer', { body: { sourceAccountId: source.id, items, destination, mode } })
      upsert(res.job)
      setSelected(new Map())
      toast(mode === 'move' ? 'Move started' : 'Copy started')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const selectedBytes = [...selected.values()].reduce((s, e) => s + (e.size ?? 0), 0)
  const hasFolders = [...selected.values()].some((e) => e.isFolder)

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Move files between clouds</h1>
        <p className="muted mt-1">Copy or move files between Google Drive, Dropbox, OneDrive and Mega, server to server. Your connection isn't used.</p>
      </header>

      {accountsLoaded && accounts.length === 0 ? (
        <div className="card">
          <EmptyState icon={<ArrowRightLeft className="size-6" />} title="Connect your clouds first">
            <Link to="/accounts" className="btn-primary mt-3">
              <Plus className="size-4" /> Connect an account
            </Link>
          </EmptyState>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_auto_minmax(0,22rem)]">
          <section className="card min-w-0 overflow-hidden">
            <div className="p-4 pb-3">
              <AccountSelect accounts={accounts} value={source?.id} onChange={switchSource} label="From" />
            </div>
            {source && <FolderListing key={source.id} account={source} trail={effectiveTrail} setTrail={setTrail} mode="select" selected={selected} onToggle={toggle} />}
            <div className="muted flex items-center justify-between border-t border-slate-200 px-4 py-2.5 text-xs dark:border-white/10">
              <span>
                {selected.size} selected{selected.size > 0 && ` · ${bytes(selectedBytes)}${hasFolders ? ' + folders' : ''}`}
              </span>
              {selected.size > 0 && (
                <button className="font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => setSelected(new Map())}>
                  Clear
                </button>
              )}
            </div>
          </section>

          <div className="hidden items-center lg:flex">
            <ArrowRight className="size-5 text-slate-400" />
          </div>

          <section className="card flex flex-col gap-4 p-4">
            <DestinationPicker value={destination} onChange={setDestination} label="To" />
            <div>
              <span className="label">Mode</span>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/5">
                {(['copy', 'move'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize ${mode === m ? 'bg-white shadow-sm dark:bg-white/10' : 'muted'}`}
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <p className="muted mt-2 text-xs">{mode === 'move' ? 'Originals go to the trash after everything is copied.' : 'Originals stay where they are.'}</p>
            </div>
            <button className="btn-primary mt-auto" disabled={!destination || selected.size === 0 || busy} onClick={start}>
              {busy ? <Spinner /> : <ArrowRightLeft className="size-4" />}
              {mode === 'move' ? 'Move' : 'Copy'} {selected.size || ''} {selected.size === 1 ? 'item' : 'items'}
            </button>
          </section>
        </div>
      )}

      <JobList kind="transfer" />
    </div>
  )
}
