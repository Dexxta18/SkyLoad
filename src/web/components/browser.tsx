import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronRight, File, Folder, FolderPlus, RefreshCw } from 'lucide-react'
import { api, type Account, type Entry } from '../api'
import { bytes, providerLabel } from '../format'
import { useApp } from '../state'
import { ProviderIcon, Spinner } from './ui'

export interface Crumb {
  id: string
  name: string
}

export function accountName(a: Account) {
  return a.email ?? a.displayName ?? providerLabel[a.provider]
}

export function rootName(a: Account) {
  return a.provider === 'gdrive' ? 'My Drive' : providerLabel[a.provider]
}

export function useFolder(accountId: string | undefined, folderId: string) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setEntries(null)
    setError(null)
    api<{ entries: Entry[] }>(`/api/accounts/${accountId}/files?folderId=${encodeURIComponent(folderId)}`)
      .then((r) => !cancelled && setEntries(r.entries))
      .catch((e) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [accountId, folderId, version])

  return { entries, error, refresh: useCallback(() => setVersion((v) => v + 1), []) }
}

export function AccountSelect({ accounts, value, onChange, label }: { accounts: Account[]; value?: string; onChange(id: string): void; label: string }) {
  const current = accounts.find((a) => a.id === value)
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="relative">
        {current && <ProviderIcon provider={current.provider} className="pointer-events-none absolute top-1/2 left-2.5 size-6 -translate-y-1/2" />}
        <select className={`input appearance-none ${current ? 'pl-11' : ''}`} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {!current && <option value="">Choose an account…</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {providerLabel[a.provider]} · {accountName(a)}
            </option>
          ))}
        </select>
        <ChevronRight className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 rotate-90 text-slate-400" />
      </div>
    </label>
  )
}

export function Breadcrumbs({ trail, onNavigate }: { trail: Crumb[]; onNavigate(index: number): void }) {
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm" aria-label="Folder path">
      {trail.map((c, i) => (
        <span key={`${c.id}-${i}`} className="flex min-w-0 items-center gap-0.5">
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-slate-400" />}
          <button
            className={`max-w-[12rem] truncate rounded-md px-1.5 py-0.5 hover:bg-slate-100 dark:hover:bg-white/10 ${i === trail.length - 1 ? 'font-medium' : 'muted'}`}
            onClick={() => onNavigate(i)}
            disabled={i === trail.length - 1}
          >
            {c.name}
          </button>
        </span>
      ))}
    </nav>
  )
}

/**
 * Lists a folder. In "folders" mode only folders are shown (for picking a
 * destination); in "select" mode files and folders get checkboxes.
 */
export function FolderListing({
  account,
  trail,
  setTrail,
  mode,
  selected,
  onToggle,
}: {
  account: Account
  trail: Crumb[]
  setTrail(t: Crumb[]): void
  mode: 'folders' | 'select'
  selected?: Map<string, Entry>
  onToggle?(entry: Entry): void
}) {
  const { toast } = useApp()
  const current = trail[trail.length - 1]
  const { entries, error, refresh } = useFolder(account.id, current.id)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const visible = entries?.filter((e) => mode === 'select' || e.isFolder)

  const createFolder = async () => {
    if (!newName.trim()) return
    setBusy(true)
    try {
      const { folder } = await api<{ folder: Entry }>(`/api/accounts/${account.id}/folders`, { body: { parentId: current.id, name: newName.trim() } })
      setCreating(false)
      setNewName('')
      setTrail([...trail, { id: folder.id, name: folder.name }])
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-white/10">
        <Breadcrumbs trail={trail} onNavigate={(i) => setTrail(trail.slice(0, i + 1))} />
        <div className="flex shrink-0 items-center">
          <button className="btn-ghost p-2" onClick={refresh} title="Refresh" aria-label="Refresh">
            <RefreshCw className="size-4" />
          </button>
          {mode === 'folders' && (
            <button className="btn-ghost p-2" onClick={() => setCreating(true)} title="New folder" aria-label="New folder">
              <FolderPlus className="size-4" />
            </button>
          )}
        </div>
      </div>

      {creating && (
        <form
          className="flex gap-2 border-b border-slate-200 p-3 dark:border-white/10"
          onSubmit={(e) => {
            e.preventDefault()
            void createFolder()
          }}
        >
          <input className="input py-2" autoFocus placeholder="Folder name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={255} />
          <button className="btn-primary py-2" disabled={busy || !newName.trim()}>
            {busy ? <Spinner /> : 'Create'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      )}

      <div className="max-h-[45dvh] min-h-48 overflow-y-auto">
        {error && <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!error && !visible && (
          <div className="flex justify-center p-8">
            <Spinner className="size-5 text-slate-400" />
          </div>
        )}
        {visible?.length === 0 && <p className="muted p-6 text-center text-sm">{mode === 'folders' ? 'No folders here' : 'This folder is empty'}</p>}
        <ul>
          {visible?.map((e) => {
            const isSelected = selected?.has(e.id)
            return (
              <li key={e.id} className="flex items-center gap-1 border-b border-slate-100 last:border-0 dark:border-white/5">
                {mode === 'select' && (
                  <button
                    className={`ml-3 flex size-5 shrink-0 items-center justify-center rounded-md border ${isSelected ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 dark:border-white/20'}`}
                    onClick={() => onToggle?.(e)}
                    aria-label={`${isSelected ? 'Unselect' : 'Select'} ${e.name}`}
                    aria-pressed={isSelected}
                  >
                    {isSelected && <Check className="size-3.5" />}
                  </button>
                )}
                <button
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-white/5"
                  onClick={() => (e.isFolder ? setTrail([...trail, { id: e.id, name: e.name }]) : onToggle?.(e))}
                >
                  {e.isFolder ? <Folder className="size-4 shrink-0 fill-amber-300/60 text-amber-500" /> : <File className="size-4 shrink-0 text-slate-400" />}
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  {!e.isFolder && <span className="muted shrink-0 text-xs">{bytes(e.size)}</span>}
                  {e.isFolder && <ChevronRight className="size-4 shrink-0 text-slate-400" />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
