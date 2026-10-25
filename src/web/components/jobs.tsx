import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowDownToLine, ArrowRightLeft, CheckCircle2, Clock, ExternalLink, ListChecks, Magnet, RotateCcw, Square, Trash2, Users } from 'lucide-react'
import { api, type JobDetail, type JobSummary } from '../api'
import { bytes, duration, isActive, isFinished, providerLabel, speed, statusLabel, timeAgo } from '../format'
import { useApp, useJobs } from '../state'
import { EmptyState, Modal, ProgressBar, ProviderIcon, Spinner } from './ui'

function StatusIcon({ job }: { job: JobSummary }) {
  if (job.status === 'completed') return <CheckCircle2 className="size-5 text-emerald-500" />
  if (job.status === 'failed') return <AlertCircle className="size-5 text-red-500" />
  if (job.status === 'cancelled') return <Square className="size-4.5 text-slate-400" />
  if (job.status === 'awaiting_selection') return <ListChecks className="size-5 text-amber-500" />
  if (job.status === 'queued') return <Clock className="size-5 text-slate-400" />
  return <Spinner className="size-5 text-brand-600 dark:text-brand-400" />
}

function progressText(job: JobSummary): string {
  const parts: string[] = []
  const total = job.totalBytes
  if (job.status === 'downloading') {
    if (total) parts.push(`${bytes(job.downloadedBytes)} of ${bytes(total)}`)
    if (job.downloadSpeed) parts.push(`↓ ${speed(job.downloadSpeed)}`)
    const eta = job.downloadSpeed ? duration((total - job.downloadedBytes) / job.downloadSpeed) : ''
    if (eta) parts.push(`${eta} left`)
  } else if (job.status === 'uploading' || job.status === 'transferring') {
    if (total) parts.push(`${bytes(job.uploadedBytes)} of ${bytes(total)} saved`)
    if (job.uploadSpeed && job.kind === 'transfer') parts.push(speed(job.uploadSpeed))
  } else if (job.status === 'completed') {
    parts.push(`${bytes(total)}${job.fileCount > 1 ? ` · ${job.fileCount} files` : ''}`)
    if (job.finishedAt) parts.push(timeAgo(job.finishedAt))
  } else if (total) {
    parts.push(bytes(total))
  }
  return parts.join(' · ')
}

export function JobCard({ job, onChooseFiles }: { job: JobSummary; onChooseFiles(job: JobSummary): void }) {
  const { accounts, toast } = useApp()
  const { upsert, remove } = useJobs()
  const [busy, setBusy] = useState(false)
  const account = accounts.find((a) => a.id === job.destination.accountId)
  const total = job.totalBytes || 1
  const active = isActive(job.status)

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const post = (action: string) => act(async () => upsert((await api<{ job: JobSummary }>(`/api/jobs/${job.id}/${action}`, { method: 'POST' })).job))

  const showProgress = active || job.status === 'queued'
  const uploadedFraction = job.uploadedBytes / total
  const downloadedFraction = job.kind === 'torrent' ? job.downloadedBytes / total : uploadedFraction

  return (
    <li className="card p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <StatusIcon job={job} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="min-w-0 truncate font-medium" title={job.name}>
              {job.name}
            </h3>
            <span className={`text-xs font-medium ${job.status === 'failed' ? 'text-red-600 dark:text-red-400' : job.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'muted'}`}>
              {job.kind === 'transfer' && job.mode === 'move' && job.status === 'transferring' ? 'Moving' : statusLabel[job.status]}
              {job.status === 'downloading' || job.status === 'uploading' || job.status === 'transferring' ? ` ${Math.floor((job.status === 'downloading' ? downloadedFraction : uploadedFraction) * 100)}%` : ''}
            </span>
          </div>

          <div className="muted mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            {account && <ProviderIcon provider={account.provider} className="size-3.5 rounded" />}
            <span className="truncate">
              {account ? providerLabel[account.provider] : 'Disconnected account'} › {job.destination.folderName}
            </span>
          </div>

          {showProgress && job.totalBytes > 0 && (
            <div className="mt-3">
              <ProgressBar value={uploadedFraction} secondary={job.kind === 'torrent' ? downloadedFraction : undefined} />
            </div>
          )}

          <div className="muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {progressText(job) && <span>{progressText(job)}</span>}
            {job.kind === 'torrent' && (job.status === 'downloading' || job.status === 'metadata') && (
              <span className="inline-flex items-center gap-1">
                <Users className="size-3" /> {job.peers} {job.peers === 1 ? 'peer' : 'peers'}
              </span>
            )}
            {job.note && <span className="text-amber-700 dark:text-amber-400">{job.note}</span>}
            {job.status === 'awaiting_selection' && <span className="text-amber-700 dark:text-amber-400">Pick the files you want, then the download starts.</span>}
          </div>

          {job.error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{job.error}</p>}

          <div className="mt-3 flex flex-wrap gap-1.5">
            {job.status === 'completed' && job.result?.url && (
              <a className="btn-secondary px-3 py-1.5" href={job.result.url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> Open in {account ? providerLabel[account.provider] : 'cloud'}
              </a>
            )}
            {job.status === 'awaiting_selection' && (
              <button className="btn-primary px-3 py-1.5" onClick={() => onChooseFiles(job)}>
                <ListChecks className="size-4" /> Choose files
              </button>
            )}
            {!isFinished(job.status) && (
              <button className="btn-ghost px-3 py-1.5" disabled={busy || job.cancelRequested} onClick={() => post('cancel')}>
                <Square className="size-3.5" /> {job.cancelRequested ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
            {(job.status === 'failed' || job.status === 'cancelled') && (
              <button className="btn-ghost px-3 py-1.5" disabled={busy} onClick={() => post('retry')}>
                <RotateCcw className="size-4" /> Retry
              </button>
            )}
            {isFinished(job.status) && (
              <button
                className="btn-ghost px-3 py-1.5"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api(`/api/jobs/${job.id}`, { method: 'DELETE' })
                    remove(job.id)
                  })
                }
              >
                <Trash2 className="size-4" /> Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

export function FileSelectModal({ jobId, onClose }: { jobId: string; onClose(): void }) {
  const { toast, config } = useApp()
  const { upsert } = useJobs()
  const [job, setJob] = useState<JobDetail | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ job: JobDetail }>(`/api/jobs/${jobId}`)
      .then(({ job }) => {
        setJob(job)
        setChosen(new Set(job.files.map((f) => f.index)))
      })
      .catch((e) => toast(e.message, 'error'))
  }, [jobId, toast])

  const shown = useMemo(() => (job?.files ?? []).filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())), [job, filter])
  const chosenBytes = (job?.files ?? []).filter((f) => chosen.has(f.index)).reduce((s, f) => s + (f.size ?? 0), 0)
  const tooBig = chosenBytes > config.limits.maxTorrentBytes

  const toggle = (index: number) =>
    setChosen((s) => {
      const next = new Set(s)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  const setAll = (on: boolean) =>
    setChosen((s) => {
      const next = new Set(s)
      for (const f of shown) {
        if (on) next.add(f.index)
        else next.delete(f.index)
      }
      return next
    })

  const start = async () => {
    setBusy(true)
    try {
      const res = await api<{ job: JobSummary }>(`/api/jobs/${jobId}/select`, { body: { fileIndexes: [...chosen] } })
      upsert(res.job)
      onClose()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      wide
      title={job ? job.name : 'Choose files'}
      onClose={onClose}
      footer={
        <>
          <span className={`mr-auto text-sm ${tooBig ? 'text-red-600 dark:text-red-400' : 'muted'}`}>
            {chosen.size} selected · {bytes(chosenBytes)}
            {tooBig && ` (limit ${bytes(config.limits.maxTorrentBytes)})`}
          </span>
          <button className="btn-secondary" onClick={onClose}>
            Later
          </button>
          <button className="btn-primary" disabled={!chosen.size || busy || tooBig} onClick={start}>
            {busy ? <Spinner /> : <ArrowDownToLine className="size-4" />} Download
          </button>
        </>
      }
    >
      {!job ? (
        <div className="flex justify-center p-10">
          <Spinner className="size-6 text-slate-400" />
        </div>
      ) : (
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3 dark:border-white/10">
            <input className="input max-w-xs flex-1 py-2" placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className="btn-ghost" onClick={() => setAll(true)}>
              Select all
            </button>
            <button className="btn-ghost" onClick={() => setAll(false)}>
              Select none
            </button>
          </div>
          <ul>
            {shown.map((f) => (
              <li key={f.index} className="border-b border-slate-100 last:border-0 dark:border-white/5">
                <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-white/5">
                  <input type="checkbox" className="size-4 shrink-0 accent-brand-600" checked={chosen.has(f.index)} onChange={() => toggle(f.index)} />
                  <span className="min-w-0 flex-1 truncate" title={f.path}>
                    {f.path.split('/').slice(1).join('/') || f.path}
                  </span>
                  <span className="muted shrink-0 text-xs">{bytes(f.size)}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

export function JobList({ kind }: { kind: JobSummary['kind'] }) {
  const { jobs, loaded, reload } = useJobs(kind)
  const { toast } = useApp()
  const [choosing, setChoosing] = useState<string | null>(null)
  const finished = jobs.filter((j) => isFinished(j.status))

  const clearFinished = async () => {
    try {
      await api(`/api/jobs?kind=${kind}`, { method: 'DELETE' })
      await reload()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{kind === 'torrent' ? 'Your downloads' : 'Your transfers'}</h2>
        {finished.length > 0 && (
          <button className="btn-ghost text-xs" onClick={clearFinished}>
            Clear finished
          </button>
        )}
      </div>
      {!loaded ? (
        <div className="flex justify-center p-10">
          <Spinner className="size-6 text-slate-400" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="card">
          {kind === 'torrent' ? (
            <EmptyState icon={<Magnet className="size-6" />} title="No downloads yet">
              Paste a magnet link above. It downloads on our servers and appears in your cloud.
            </EmptyState>
          ) : (
            <EmptyState icon={<ArrowRightLeft className="size-6" />} title="No transfers yet">
              Pick files on the left and a destination on the right.
            </EmptyState>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} onChooseFiles={(j) => setChoosing(j.id)} />
          ))}
        </ul>
      )}
      {choosing && <FileSelectModal jobId={choosing} onClose={() => setChoosing(null)} />}
    </section>
  )
}
