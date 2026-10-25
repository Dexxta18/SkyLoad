import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowRightLeft, CloudUpload, Magnet, ShieldCheck, Zap } from 'lucide-react'
import { api } from '../api'
import { Logo } from '../components/Logo'
import { Spinner } from '../components/ui'
import { useApp } from '../state'

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  )
}

export default function Landing() {
  const { config, reloadMe, toast } = useApp()
  const [params, setParams] = useSearchParams()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const error = params.get('error')
    if (error) {
      toast(error, 'error')
      setParams({}, { replace: true })
    }
  }, [params, setParams, toast])

  const devLogin = async () => {
    setBusy(true)
    try {
      await api('/api/auth/dev-login', { body: { email } })
      await reloadMe()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[32rem] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(37,99,235,0.18),transparent)] dark:bg-[radial-gradient(60%_60%_at_50%_0%,rgba(59,130,246,0.22),transparent)]" />
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <Link to="/terms" className="muted text-sm hover:text-slate-700 dark:hover:text-slate-200">
          Terms
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-4 pt-12 pb-20 sm:px-6 sm:pt-20">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Torrents, straight to your Google Drive.</h1>
          <p className="muted mx-auto mt-5 max-w-xl text-lg text-pretty">
            Paste a magnet link. Skyload downloads it on fast servers and saves it to your Drive, so nothing touches your phone or laptop. Move files between Google Drive, Dropbox, OneDrive and
            Mega too.
          </p>

          <div className="mx-auto mt-9 flex max-w-sm flex-col gap-3">
            {config.googleLogin && (
              <a href="/api/auth/login" className="btn-primary py-3 text-base">
                <span className="flex size-6 items-center justify-center rounded-full bg-white">
                  <GoogleMark />
                </span>
                Continue with Google
              </a>
            )}
            {config.devLogin && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void devLogin()
                }}
              >
                <input className="input" type="email" placeholder="you@example.com (dev sign-in)" value={email} onChange={(e) => setEmail(e.target.value)} required />
                <button className="btn-secondary shrink-0" disabled={busy}>
                  {busy ? <Spinner /> : 'Sign in'}
                </button>
              </form>
            )}
            {!config.googleLogin && !config.devLogin && <p className="text-sm text-red-600">Sign-in isn't configured on this server yet (missing GOOGLE_CLIENT_ID).</p>}
            <p className="muted text-xs">Signing in with Google also connects your Drive, so you can start right away.</p>
          </div>
        </div>

        <ol className="mx-auto mt-20 grid max-w-4xl gap-4 sm:grid-cols-3">
          {[
            { icon: <Magnet className="size-5" />, title: 'Paste a magnet', text: 'Or drop a .torrent file. Pick only the files you want if you like.' },
            { icon: <Zap className="size-5" />, title: 'We fetch it', text: 'Our servers download it at datacenter speed while you close the tab.' },
            { icon: <CloudUpload className="size-5" />, title: "It's in your Drive", text: 'Files land in the folder you chose, folders and all, as soon as each one finishes.' },
          ].map((s, i) => (
            <li key={s.title} className="card p-5">
              <div className="mb-3 flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">{s.icon}</span>
                <span className="muted text-xs font-medium">Step {i + 1}</span>
              </div>
              <h3 className="font-medium">{s.title}</h3>
              <p className="muted mt-1 text-sm">{s.text}</p>
            </li>
          ))}
        </ol>

        <div className="mx-auto mt-4 grid max-w-4xl gap-4 sm:grid-cols-2">
          <div className="card flex gap-4 p-5">
            <ArrowRightLeft className="mt-0.5 size-5 shrink-0 text-brand-600 dark:text-brand-400" />
            <div>
              <h3 className="font-medium">Cloud to cloud</h3>
              <p className="muted mt-1 text-sm">Copy or move whole folders between Google Drive, Dropbox, OneDrive, Mega and between your own Google accounts.</p>
            </div>
          </div>
          <div className="card flex gap-4 p-5">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-600 dark:text-brand-400" />
            <div>
              <h3 className="font-medium">Your keys stay locked</h3>
              <p className="muted mt-1 text-sm">Access tokens are encrypted at rest, downloads are deleted from our servers once they're in your cloud, and you can disconnect anytime.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
