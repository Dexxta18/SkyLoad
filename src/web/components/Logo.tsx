export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
      <img src="/favicon.svg" alt="" className="size-7" />
      {!compact && <span className="text-lg">Skyload</span>}
    </span>
  )
}
