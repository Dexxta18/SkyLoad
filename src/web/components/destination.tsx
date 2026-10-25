import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, Plus } from 'lucide-react'
import { api, type Destination, type Me } from '../api'
import { providerLabel } from '../format'
import { useApp } from '../state'
import { AccountSelect, accountName, FolderListing, rootName, type Crumb } from './browser'
import { Modal, ProviderIcon } from './ui'

function FolderPickerModal({ initial, onClose, onPick }: { initial?: Destination; onClose(): void; onPick(d: Destination, makeDefault: boolean): void }) {
  const { accounts, me } = useApp()
  const [accountId, setAccountId] = useState(initial?.accountId ?? accounts[0]?.id)
  const account = accounts.find((a) => a.id === accountId)
  const startTrail = (): Crumb[] => {
    if (!account) return []
    const root = { id: 'root', name: rootName(account) }
    return initial && initial.accountId === account.id && initial.folderId !== 'root' ? [root, { id: initial.folderId, name: initial.folderName.split(' / ').pop() ?? initial.folderName }] : [root]
  }
  const [trail, setTrail] = useState<Crumb[]>(startTrail)
  const [makeDefault, setMakeDefault] = useState(!me?.settings.defaultDestination)

  const switchAccount = (id: string) => {
    setAccountId(id)
    const a = accounts.find((x) => x.id === id)
    setTrail(a ? [{ id: 'root', name: rootName(a) }] : [])
  }

  const current = trail[trail.length - 1]
  return (
    <Modal
      title="Save to"
      onClose={onClose}
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand-600" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            Use as my default
          </label>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!account || !current}
            onClick={() => account && current && onPick({ accountId: account.id, folderId: current.id, folderName: trail.map((c) => c.name).join(' / ') }, makeDefault)}
          >
            Save here
          </button>
        </>
      }
    >
      <div className="p-4 pb-3">
        <AccountSelect accounts={accounts} value={accountId} onChange={switchAccount} label="Account" />
        {account?.limitedScope && (
          <p className="muted mt-2 text-xs">This server uses limited Google Drive access, so only folders created by Skyload are listed. Create a new folder here if you need one.</p>
        )}
      </div>
      {account && trail.length > 0 && <FolderListing key={account.id} account={account} trail={trail} setTrail={setTrail} mode="folders" />}
    </Modal>
  )
}

/** The "Save to: Google Drive › My Drive / Movies" control. */
export function DestinationPicker({ value, onChange, label = 'Save to' }: { value?: Destination; onChange(d: Destination): void; label?: string }) {
  const { accounts, accountsLoaded, me, reloadMe, toast } = useApp()
  const [open, setOpen] = useState(false)
  const account = accounts.find((a) => a.id === value?.accountId)

  if (accountsLoaded && accounts.length === 0) {
    return (
      <div>
        <span className="label">{label}</span>
        <Link to="/accounts" className="btn-secondary w-full justify-start">
          <Plus className="size-4" /> Connect Google Drive or another cloud
        </Link>
      </div>
    )
  }

  const pick = async (d: Destination, makeDefault: boolean) => {
    onChange(d)
    setOpen(false)
    if (makeDefault) {
      try {
        await api<{ settings: Me['settings'] }>('/api/me/settings', { method: 'PATCH', body: { defaultDestination: d } })
        await reloadMe()
      } catch (e) {
        toast((e as Error).message, 'error')
      }
    }
  }

  return (
    <div>
      <span className="label">{label}</span>
      <button type="button" className="input flex items-center gap-3 text-left hover:border-slate-300 dark:hover:border-white/20" onClick={() => setOpen(true)}>
        {account ? (
          <>
            <ProviderIcon provider={account.provider} className="size-7" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{value!.folderName}</span>
              <span className="muted block truncate text-xs">
                {providerLabel[account.provider]} · {accountName(account)}
              </span>
            </span>
          </>
        ) : (
          <span className="muted flex-1">Choose a folder…</span>
        )}
        <ChevronDown className="size-4 shrink-0 text-slate-400" />
      </button>
      {open && <FolderPickerModal initial={value ?? me?.settings.defaultDestination} onClose={() => setOpen(false)} onPick={pick} />}
    </div>
  )
}
