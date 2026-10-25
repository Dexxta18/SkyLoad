import type { ProviderId } from '../db/schema.js'
import { UserError } from '../lib/http.js'
import { dropbox } from './dropbox.js'
import { gdrive } from './gdrive.js'
import { local } from './local.js'
import { mega } from './mega.js'
import { onedrive } from './onedrive.js'
import type { ProviderDef } from './types.js'

export const providers: Record<ProviderId, ProviderDef> = { gdrive, dropbox, onedrive, mega, local }

export function getProvider(id: string): ProviderDef {
  const provider = providers[id as ProviderId]
  if (!provider || !provider.enabled()) throw new UserError(`Storage provider "${id}" is not available`, 404)
  return provider
}

export function enabledProviders() {
  return Object.values(providers)
    .filter((p) => p.enabled())
    .map((p) => ({ id: p.id, label: p.label, auth: p.auth }))
}
