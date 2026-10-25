import { useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { ArrowDownToLine, ArrowRightLeft, Cloud, LogOut } from 'lucide-react'
import { api } from '../api'
import { useApp, useJobs } from '../state'
import { isActive } from '../format'
import { Logo } from './Logo'

const nav = [
  { to: '/', label: 'Downloads', icon: ArrowDownToLine, kind: 'torrent' as const },
  { to: '/transfers', label: 'Transfers', icon: ArrowRightLeft, kind: 'transfer' as const },
  { to: '/accounts', label: 'Accounts', icon: Cloud },
]

export function Shell({ children }: { children: ReactNode }) {
  const { me, reloadMe } = useApp()
  const { jobs } = useJobs()
  const [menu, setMenu] = useState(false)

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' })
    await reloadMe()
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-slate-50/85 backdrop-blur dark:border-white/10 dark:bg-[#0b1220]/85">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-2 px-4 sm:gap-6 sm:px-6">
          <Link to="/" aria-label="Skyload home">
            <span className="hidden sm:inline">
              <Logo />
            </span>
            <span className="sm:hidden">
              <Logo compact />
            </span>
          </Link>
          <nav className="flex flex-1 items-center gap-1">
            {nav.map(({ to, label, icon: Icon, kind }) => {
              const running = kind ? jobs.filter((j) => j.kind === kind && isActive(j.status)).length : 0
              return (
                <NavLink
                  key={to}
                  to={to}
                  end
                  className={({ isActive: current }) =>
                    `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition sm:px-3 ${
                      current ? 'bg-white text-slate-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                    }`
                  }
                >
                  <Icon className="size-4" />
                  <span className="hidden min-[440px]:inline">{label}</span>
                  {running > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] leading-5 text-white">{running}</span>}
                </NavLink>
              )
            })}
          </nav>
          <div className="relative">
            <button className="flex items-center rounded-full ring-brand-500/40 hover:ring-4" onClick={() => setMenu((m) => !m)} aria-label="Account menu" aria-expanded={menu}>
              {me?.avatarUrl ? (
                <img src={me.avatarUrl} alt="" className="size-8 rounded-full" referrerPolicy="no-referrer" />
              ) : (
                <span className="flex size-8 items-center justify-center rounded-full bg-brand-600 text-sm font-medium text-white">{(me?.name ?? me?.email ?? '?')[0].toUpperCase()}</span>
              )}
            </button>
            {menu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <div className="card absolute right-0 z-20 mt-2 w-60 overflow-hidden bg-white p-1 dark:bg-[#111a2e]">
                  <div className="px-3 py-2">
                    <p className="truncate text-sm font-medium">{me?.name}</p>
                    <p className="muted truncate text-xs">{me?.email}</p>
                  </div>
                  <Link to="/terms" className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-white/10" onClick={() => setMenu(false)}>
                    Terms & acceptable use
                  </Link>
                  <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-white/10" onClick={logout}>
                    <LogOut className="size-4" /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  )
}
