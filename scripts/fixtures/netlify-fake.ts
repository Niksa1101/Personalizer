import { createHash, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { URL } from "node:url"

type SiteFile = {
  path: string
  sha: string
  bytes: Buffer
}

type DeployRecord = {
  id: string
  title: string
  manifest: Record<string, string>
  required: string[]
  /** The digests asked for at create time — `required` shrinks as they land. */
  requestedDigests: Set<string>
  uploads: Map<string, Buffer>
  state: "new" | "uploading" | "ready" | "error"
  errorMessage?: string
}

export type NetlifyFakeOptions = {
  siteId?: string
  sslUrl?: string
  malformedFilesResponse?: boolean
  failFirstDeployGet?: boolean
}

export type NetlifyFakeServer = {
  url: string
  siteId: string
  sslUrl: string
  putCount: number
  requestCount: number
  resetPutCount: () => void
  resetRequestCount: () => void
  setMalformedFilesResponse: (value: boolean) => void
  setFailFirstDeployGet: (value: boolean) => void
  getSiteFiles: () => SiteFile[]
  close: () => Promise<void>
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function sha1Hex(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex")
}

function finalizeDeploy(siteFiles: Map<string, SiteFile>, deploy: DeployRecord): void {
  deploy.state = "ready"
  const manifestPaths = new Set(Object.keys(deploy.manifest))
  for (const path of [...siteFiles.keys()]) {
    if (!manifestPaths.has(path)) {
      siteFiles.delete(path)
    }
  }
}

export async function startNetlifyFake(
  options: NetlifyFakeOptions = {},
): Promise<NetlifyFakeServer> {
  const siteId = options.siteId ?? "fake-site-id"
  const siteFiles = new Map<string, SiteFile>()
  const deploys = new Map<string, DeployRecord>()
  let putCount = 0
  let requestCount = 0
  let malformedFilesResponse = options.malformedFilesResponse ?? false
  let failFirstDeployGet = options.failFirstDeployGet ?? false
  let deployGetAttempts = 0

  let sslUrl = options.sslUrl ?? ""
  let server: Server

  await new Promise<void>((resolve) => {
    server = createServer(async (req, res) => {
      requestCount += 1
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
        const pathname = url.pathname

        if (req.method === "GET" && pathname === `/api/v1/sites/${siteId}`) {
          if (!sslUrl) {
            sslUrl = `http://${req.headers.host}`
          }
          sendJson(res, 200, { ssl_url: sslUrl })
          return
        }

        if (req.method === "GET" && pathname === `/api/v1/sites/${siteId}/files`) {
          if (malformedFilesResponse) {
            sendJson(res, 200, { paths: [] })
            return
          }
          sendJson(
            res,
            200,
            [...siteFiles.values()].map((file) => ({
              id: randomUUID(),
              path: file.path,
              sha: file.sha,
            })),
          )
          return
        }

        if (req.method === "POST" && pathname === `/api/v1/sites/${siteId}/deploys`) {
          const raw = await readBody(req)
          const body = JSON.parse(raw.toString("utf8")) as {
            files?: Record<string, string>
            title?: string
          }
          const manifest = body.files ?? {}
          const knownShas = new Set([...siteFiles.values()].map((file) => file.sha))
          const required = [...new Set(Object.values(manifest))].filter(
            (sha) => !knownShas.has(sha),
          )
          const deployId = randomUUID()
          const deploy: DeployRecord = {
            id: deployId,
            title: body.title ?? "",
            manifest,
            required,
            requestedDigests: new Set(required),
            uploads: new Map(),
            state: required.length === 0 ? "ready" : "uploading",
          }
          if (required.length === 0) {
            finalizeDeploy(siteFiles, deploy)
          }
          deploys.set(deployId, deploy)
          sendJson(res, 200, { id: deployId, required })
          return
        }

        const deployMatch = pathname.match(/^\/api\/v1\/deploys\/([^/]+)(?:\/files\/(.+))?$/)
        if (deployMatch) {
          const deployId = decodeURIComponent(deployMatch[1]!)
          const fileSuffix = deployMatch[2]

          if (req.method === "GET" && !fileSuffix) {
            deployGetAttempts += 1
            if (failFirstDeployGet && deployGetAttempts === 1) {
              sendJson(res, 404, { message: "not found yet" })
              return
            }
            const deploy = deploys.get(deployId)
            if (!deploy) {
              sendJson(res, 404, { message: "deploy not found" })
              return
            }
            sendJson(res, 200, {
              id: deploy.id,
              state: deploy.state,
              error_message: deploy.errorMessage,
            })
            return
          }

          if (req.method === "PUT" && fileSuffix) {
            putCount += 1
            const deploy = deploys.get(deployId)
            if (!deploy) {
              sendJson(res, 404, { message: "deploy not found" })
              return
            }

            const decodedPath = decodeURIComponent(fileSuffix)
            const normalizedPath = decodedPath.startsWith("/")
              ? decodedPath
              : `/${decodedPath}`
            const bytes = await readBody(req)
            const digest = sha1Hex(bytes)

            if (deploy.uploads.has(normalizedPath)) {
              sendJson(res, 409, { message: "duplicate upload" })
              return
            }

            // Real Netlify only accepts digests it asked for. Enforcing this is
            // what makes "100 pages / 1 change → one PUT" testable at all.
            if (!deploy.requestedDigests.has(digest)) {
              sendJson(res, 422, {
                message: `digest ${digest} was not required by deploy ${deploy.id}`,
              })
              return
            }

            deploy.uploads.set(normalizedPath, bytes)
            siteFiles.set(normalizedPath, {
              path: normalizedPath,
              sha: digest,
              bytes,
            })

            const remaining = deploy.required.filter(
              (sha) =>
                !Object.entries(deploy.manifest).some(([path, expectedSha]) => {
                  const uploaded = siteFiles.get(path)
                  return expectedSha === sha && uploaded?.sha === sha
                }),
            )
            deploy.required = remaining
            if (remaining.length === 0) {
              finalizeDeploy(siteFiles, deploy)
            }

            sendJson(res, 200, { path: normalizedPath })
            return
          }
        }

        sendJson(res, 404, { message: "not found" })
      } catch (error) {
        sendJson(res, 500, {
          message: error instanceof Error ? error.message : "internal error",
        })
      }
    })

    server.listen(0, "127.0.0.1", () => resolve())
  })

  const address = server!.address()
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind Netlify fake server")
  }

  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`
  if (!sslUrl) {
    sslUrl = `http://127.0.0.1:${address.port}`
  }

  return {
    url: baseUrl,
    siteId,
    sslUrl,
    get putCount() {
      return putCount
    },
    get requestCount() {
      return requestCount
    },
    resetPutCount() {
      putCount = 0
    },
    resetRequestCount() {
      requestCount = 0
    },
    setMalformedFilesResponse(value: boolean) {
      malformedFilesResponse = value
    },
    setFailFirstDeployGet(value: boolean) {
      failFirstDeployGet = value
      deployGetAttempts = 0
    },
    getSiteFiles() {
      return [...siteFiles.values()]
    },
    close() {
      return new Promise((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
