export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** An error whose message is safe and useful to show to the end user. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'UserError'
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export function isRetryable(err: unknown): boolean {
  if (err instanceof CancelledError) return false
  if (err instanceof HttpError) return err.status === 408 || err.status === 429 || err.status >= 500
  // Network-level failures: fetch throws TypeError("fetch failed"), sockets get reset, etc.
  const code = String((err as NodeJS.ErrnoException)?.code ?? '')
  return err instanceof TypeError || /^(ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR)/.test(code)
}

/** Retries `fn` with exponential backoff while the error looks transient. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: { retries?: number; signal?: AbortSignal; baseMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 5
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      if (attempt >= retries || !isRetryable(err) || opts.signal?.aborted) throw err
      const retryAfter = err instanceof HttpError && typeof err.body === 'object' && err.body && 'retryAfterMs' in err.body ? Number((err.body as { retryAfterMs: number }).retryAfterMs) : 0
      await sleep(Math.max(retryAfter, (opts.baseMs ?? 1000) * 2 ** attempt), opts.signal)
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return text
  }
}

/** Throws HttpError for non-2xx responses, keeping the parsed body for diagnostics. */
export async function ensureOk(res: Response, what: string): Promise<Response> {
  if (res.ok) return res
  const body = await readBody(res)
  const detail = describeApiError(body)
  const retryAfter = Number(res.headers.get('retry-after'))
  const err = new HttpError(`${what} failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000, body } : body)
  throw err
}

export async function fetchJson<T>(url: string, init: RequestInit & { what?: string } = {}): Promise<T> {
  const res = await fetch(url, init)
  await ensureOk(res, init.what ?? `${init.method ?? 'GET'} ${new URL(url).pathname}`)
  return (await readBody(res)) as T
}

function describeApiError(body: unknown): string {
  if (!body) return ''
  if (typeof body === 'string') return body.slice(0, 300)
  const b = body as Record<string, any>
  return (
    b.error_description ??
    b.error?.message ??
    b.error_summary ??
    (typeof b.error === 'string' ? b.error : undefined) ??
    b.message ??
    JSON.stringify(body).slice(0, 300)
  )
}

/** Node Buffers are valid fetch bodies at runtime; this just satisfies the DOM typings. */
export const asBody = (buf: Buffer): BodyInit => buf as unknown as BodyInit
