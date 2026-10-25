import { useEffect, type ReactNode } from 'react'
import { Box, Cloud, Folder, HardDrive, Loader2, X } from 'lucide-react'
import type { ProviderId } from '../api'

const providerStyle: Record<ProviderId, { bg: string; icon: ReactNode }> = {
  gdrive: { bg: 'bg-emerald-500', icon: <HardDrive className="size-[60%]" /> },
  dropbox: { bg: 'bg-[#0061FF]', icon: <Box className="size-[60%]" /> },
  onedrive: { bg: 'bg-[#0078D4]', icon: <Cloud className="size-[60%]" /> },
  mega: { bg: 'bg-[#D9272E]', icon: <span className="text-[0.62em] leading-none font-bold">M</span> },
  local: { bg: 'bg-slate-500', icon: <Folder className="size-[60%]" /> },
}

export function ProviderIcon({ provider, className = 'size-8' }: { provider: ProviderId; className?: string }) {
  const style = providerStyle[provider] ?? providerStyle.local
  return <span className={`inline-flex shrink-0 items-center justify-center rounded-lg text-white ${style.bg} ${className}`}>{style.icon}</span>
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} aria-hidden />
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`card flex max-h-[90dvh] w-full flex-col rounded-b-none bg-white sm:rounded-2xl dark:bg-[#111a2e] ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-white/10">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost -mr-2 p-1.5" onClick={onClose} aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-3.5 dark:border-white/10">{footer}</div>}
      </div>
    </div>
  )
}

export function ProgressBar({ value, secondary, tone = 'brand' }: { value: number; secondary?: number; tone?: 'brand' | 'green' | 'red' | 'slate' }) {
  const color = { brand: 'bg-brand-600', green: 'bg-emerald-500', red: 'bg-red-500', slate: 'bg-slate-400' }[tone]
  const pct = (n: number) => `${Math.max(0, Math.min(100, n * 100)).toFixed(2)}%`
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      {secondary !== undefined && <div className="absolute inset-y-0 left-0 rounded-full bg-brand-200 transition-[width] duration-700 dark:bg-brand-500/30" style={{ width: pct(secondary) }} />}
      <div className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ${color}`} style={{ width: pct(value) }} />
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400">{icon}</div>
      <p className="font-medium">{title}</p>
      {children && <div className="muted mt-1 max-w-sm text-sm">{children}</div>}
    </div>
  )
}
