import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { api, type AppConfig, type Me } from './api'
import { Shell } from './components/Shell'
import { Spinner } from './components/ui'
import Downloads from './pages/Downloads'
import Landing from './pages/Landing'
import Terms from './pages/Terms'
import { AppProvider, JobsProvider, useApp } from './state'

const Transfers = lazy(() => import('./pages/Transfers'))
const Accounts = lazy(() => import('./pages/Accounts'))

function Loading() {
  return (
    <div className="flex min-h-[50dvh] items-center justify-center">
      <Spinner className="size-6 text-slate-400" />
    </div>
  )
}

function AppRoutes() {
  const { me } = useApp()
  if (!me) {
    return (
      <Routes>
        <Route path="/terms" element={<Terms />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    )
  }
  return (
    <JobsProvider>
      <Routes>
        <Route path="/terms" element={<Terms />} />
        <Route
          path="*"
          element={
            <Shell>
              <Suspense fallback={<Loading />}>
                <Routes>
                  <Route path="/" element={<Downloads />} />
                  <Route path="/transfers" element={<Transfers />} />
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </Shell>
          }
        />
      </Routes>
    </JobsProvider>
  )
}

export default function App() {
  const [boot, setBoot] = useState<{ me: Me | null; config: AppConfig } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api<{ user: Me | null }>('/api/me'), api<AppConfig>('/api/config')])
      .then(([me, config]) => setBoot({ me: me.user, config }))
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <p className="p-8 text-center text-red-600">Couldn't reach the server: {error}</p>
  if (!boot) return <Loading />
  return (
    <AppProvider me={boot.me} config={boot.config}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProvider>
  )
}
