import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, FileUp, Link2, X } from 'lucide-react'
import { api, type Destination, type JobSummary } from '../api'
import { DestinationPicker } from '../components/destination'
import { JobList } from '../components/jobs'
import { Spinner } from '../components/ui'
import { bytes } from '../format'
import { useApp, useJobs } from '../state'

export default function Downloads() {
  const { me, config, toast } = useApp()
  const { upsert } = useJobs()
  const [tab, setTab] = useState<'magnet' | 'file'>('magnet')
  const [magnet, setMagnet] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [destination, setDestination] = useState<Destination | undefined>(me?.settings.defaultDestination)
  const [chooseFiles, setChooseFiles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!destination && me?.settings.defaultDestination) setDestination(me.settings.defaultDestination)
  }, [me?.settings.defaultDestination, destination])

  const ready = destination && (tab === 'magnet' ? magnet.trim().length > 0 : file !== null)

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    try {
      let res: { job: JobSummary }
      if (tab === 'file' && file) {
        const form = new FormData()
        form.set('destination', JSON.stringify(destination))
        form.set('chooseFiles', String(chooseFiles))
        form.set('torrent', file)
        res = await api('/api/jobs/torrent', { form })
      } else {
        res = await api('/api/jobs/torrent', { body: { magnet: magnet.trim(), destination, chooseFiles } })
      }
      upsert(res.job)
      setMagnet('')
      setFile(null)
      toast(chooseFiles ? 'Added. Pick your files once the details load.' : 'Download started')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const acceptFile = (f: File | undefined) => {
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.torrent')) return toast('Choose a .torrent file', 'error')
    setFile(f)
    setTab('file')
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Download a torrent</h1>
        <p className="muted mt-1">We download it on our servers and save it straight to your cloud. Nothing touches your device.</p>
      </header>

      <form
        className="card p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          acceptFile(e.dataTransfer.files[0])
        }}
      >
        <div className="mb-4 inline-flex rounded-xl bg-slate-100 p-1 dark:bg-white/5" role="tablist">
          {(
            [
              ['magnet', 'Magnet link', Link2],
              ['file', '.torrent file', FileUp],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${tab === id ? 'bg-white shadow-sm dark:bg-white/10' : 'muted hover:text-slate-700 dark:hover:text-slate-200'}`}
              onClick={() => setTab(id)}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>

        {tab === 'magnet' ? (
          <textarea
            className="input min-h-24 resize-y font-mono text-[13px]"
            placeholder="magnet:?xt=urn:btih:…"
            value={magnet}
            onChange={(e) => setMagnet(e.target.value)}
            spellCheck={false}
            aria-label="Magnet link"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
          />
        ) : (
          <div
            className={`flex min-h-24 flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm transition ${
              dragging ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-slate-200 dark:border-white/10'
            }`}
          >
            {file ? (
              <div className="flex items-center gap-2">
                <FileUp className="size-4 text-brand-600" />
                <span className="font-medium">{file.name}</span>
                <button type="button" className="btn-ghost p-1" onClick={() => setFile(null)} aria-label="Remove file">
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <>
                <p>Drop a .torrent file here</p>
                <button type="button" className="mt-1 font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => fileInput.current?.click()}>
                  or browse
                </button>
              </>
            )}
            <input ref={fileInput} type="file" accept=".torrent,application/x-bittorrent" className="hidden" onChange={(e) => acceptFile(e.target.files?.[0])} />
          </div>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <DestinationPicker value={destination} onChange={setDestination} />
          <button className="btn-primary h-[46px] px-6" disabled={!ready || busy}>
            {busy ? <Spinner /> : <ArrowDownToLine className="size-4" />}
            Start download
          </button>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand-600" checked={chooseFiles} onChange={(e) => setChooseFiles(e.target.checked)} />
          Let me choose which files to download
        </label>
        <p className="muted mt-3 text-xs">Up to {bytes(config.limits.maxTorrentBytes)} per torrent. Only download content you have the right to share.</p>
      </form>

      <JobList kind="torrent" />
    </div>
  )
}
