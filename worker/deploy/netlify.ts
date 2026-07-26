import { createHash } from "node:crypto"

import { assertEnv } from "@/lib/env"

const DEFAULT_API_BASE = "https://api.netlify.com/api/v1"
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 1_000

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

/** Keyed by site — an unkeyed memo hands one site's URL to a client for another. */
const cachedSiteUrls = new Map<string, string>()

export class NetlifyError extends Error {
  readonly status: number
  readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = "NetlifyError"
    this.status = status
    this.body = body
  }
}

export type CreateDeployResult = {
  id: string
  required: string[]
}

export type NetlifyClientOptions = {
  signal?: AbortSignal
  apiBase?: string
  siteId?: string
  token?: string
}

export type NetlifyClient = {
  createDeploy: (
    files: Record<string, string>,
    title: string,
  ) => Promise<CreateDeployResult>
  uploadFile: (
    deployId: string,
    path: string,
    bytes: Buffer | Uint8Array,
    satisfiedDigests: Set<string>,
  ) => Promise<void>
  waitForReady: (deployId: string, budgetMs: number) => Promise<void>
  getSiteUrl: () => Promise<string>
  listSiteFiles: () => Promise<string[] | null>
  resetSiteUrlCache: () => void
}

function resolveApiBase(override?: string): string {
  const raw = (override ?? process.env.NETLIFY_API_BASE ?? DEFAULT_API_BASE).trim()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new NetlifyError(`Invalid NETLIFY_API_BASE: ${raw}`, 0, "")
  }

  const isHttps = parsed.protocol === "https:"
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname)
  if (!isHttps && !isLoopback) {
    throw new NetlifyError(
      `NETLIFY_API_BASE must be https or loopback, got ${parsed.protocol}//${parsed.hostname}`,
      0,
      "",
    )
  }

  return raw.replace(/\/$/, "")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error("Aborted"))
      },
      { once: true },
    )
  })
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after")
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000
    }
    const date = Date.parse(header)
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now())
    }
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1)
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

async function netlifyFetch(
  url: string,
  init: RequestInit,
  options: {
    signal?: AbortSignal
    token: string
    retry404?: boolean
  },
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${options.token}`)

  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Aborted")
    }

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal

    try {
      const response = await fetch(url, { ...init, headers, signal: combined })

      if (response.ok) return response

      const retry404 = options.retry404 && response.status === 404
      if (retry404 || isRetryableStatus(response.status)) {
        if (attempt < MAX_RETRIES) {
          await sleep(retryAfterMs(response, attempt), options.signal)
          continue
        }
      }

      const body = await response.text()
      throw new NetlifyError(
        `Netlify request failed: ${init.method ?? "GET"} ${url} → ${response.status}`,
        response.status,
        body,
      )
    } catch (error) {
      if (error instanceof NetlifyError) throw error
      lastError = error
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1), options.signal)
        continue
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Netlify request failed after retries")
}

function sha1Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex")
}

/**
 * The removal guard diffs this listing against manifest keys, which always
 * carry a leading slash. If Netlify ever reports `campaign/lead/index.html`
 * instead of `/campaign/lead/index.html`, an unnormalized compare reads every
 * path as removed and fails every lead after a cache loss. Normalize on the way
 * in so the two sets are always comparable.
 */
export function normalizeSiteFilePath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`
}

export function createNetlifyClient(
  options: NetlifyClientOptions = {},
): NetlifyClient {
  const env = assertEnv()
  const apiBase = resolveApiBase(options.apiBase)
  const siteId = options.siteId ?? env.NETLIFY_SITE_ID
  const token = options.token ?? env.NETLIFY_TOKEN
  const signal = options.signal

  async function createDeploy(
    files: Record<string, string>,
    title: string,
  ): Promise<CreateDeployResult> {
    const response = await netlifyFetch(
      `${apiBase}/sites/${siteId}/deploys`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files,
          draft: false,
          async: false,
          title,
        }),
      },
      { signal, token },
    )

    const body = (await response.json()) as {
      id?: string
      required?: string[]
    }
    if (!body.id || !Array.isArray(body.required)) {
      throw new NetlifyError(
        "Unexpected createDeploy response shape",
        response.status,
        JSON.stringify(body),
      )
    }

    return { id: body.id, required: body.required }
  }

  async function uploadFile(
    deployId: string,
    path: string,
    bytes: Buffer | Uint8Array,
    satisfiedDigests: Set<string>,
  ): Promise<void> {
    const digest = sha1Hex(bytes)
    const encodedPath = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/")

    const payload =
      bytes instanceof Buffer ? new Uint8Array(bytes) : Uint8Array.from(bytes)

    try {
      await netlifyFetch(
        `${apiBase}/deploys/${deployId}/files/${encodedPath}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: payload,
        },
        { signal, token },
      )
      satisfiedDigests.add(digest)
    } catch (error) {
      if (
        error instanceof NetlifyError &&
        (error.status === 409 || error.status === 422) &&
        satisfiedDigests.has(digest)
      ) {
        return
      }
      throw error
    }
  }

  async function waitForReady(deployId: string, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs
    let delayMs = 1_000

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Aborted")
      }

      let response: Response
      try {
        response = await netlifyFetch(
          `${apiBase}/deploys/${deployId}`,
          { method: "GET" },
          { signal, token, retry404: true },
        )
      } catch (error) {
        if (error instanceof NetlifyError && error.status === 404) {
          await sleep(Math.min(delayMs, deadline - Date.now()), signal)
          delayMs = Math.min(Math.floor(delayMs * 1.5), 5_000)
          continue
        }
        throw error
      }

      const body = (await response.json()) as {
        state?: string
        error_message?: string
      }

      if (body.state === "ready") return
      if (body.state === "error") {
        throw new NetlifyError(
          body.error_message ?? "Netlify deploy entered error state",
          response.status,
          JSON.stringify(body),
        )
      }

      await sleep(Math.min(delayMs, deadline - Date.now()), signal)
      delayMs = Math.min(Math.floor(delayMs * 1.5), 5_000)
    }

    throw new NetlifyError(
      `Netlify deploy ${deployId} did not become ready within ${budgetMs}ms`,
      0,
      "",
    )
  }

  async function getSiteUrl(): Promise<string> {
    const cached = cachedSiteUrls.get(siteId)
    if (cached) return cached

    const response = await netlifyFetch(
      `${apiBase}/sites/${siteId}`,
      { method: "GET" },
      { signal, token },
    )
    const body = (await response.json()) as { ssl_url?: string }
    if (!body.ssl_url) {
      throw new NetlifyError(
        "Unexpected getSite response shape",
        response.status,
        JSON.stringify(body),
      )
    }

    const siteUrl = body.ssl_url.replace(/\/$/, "")
    cachedSiteUrls.set(siteId, siteUrl)
    return siteUrl
  }

  async function listSiteFiles(): Promise<string[] | null> {
    try {
      const response = await netlifyFetch(
        `${apiBase}/sites/${siteId}/files`,
        { method: "GET" },
        { signal, token },
      )
      const body: unknown = await response.json()
      if (!Array.isArray(body)) return null

      const paths: string[] = []
      for (const entry of body) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          typeof (entry as { path?: unknown }).path !== "string"
        ) {
          return null
        }
        paths.push(normalizeSiteFilePath((entry as { path: string }).path))
      }
      return paths
    } catch {
      return null
    }
  }

  function resetSiteUrlCache(): void {
    cachedSiteUrls.delete(siteId)
  }

  return {
    createDeploy,
    uploadFile,
    waitForReady,
    getSiteUrl,
    listSiteFiles,
    resetSiteUrlCache,
  }
}

/** Test-only: clears the site URL memo for every site. */
export function resetNetlifySiteUrlCache(): void {
  cachedSiteUrls.clear()
}

/** Test-only: validates NETLIFY_API_BASE without constructing a client. */
export function validateNetlifyApiBase(base?: string): string {
  return resolveApiBase(base)
}
