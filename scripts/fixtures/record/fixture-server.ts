import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import path from "node:path"

const FIXTURE_DIR = path.resolve(import.meta.dirname)

export type FixtureServer = {
  baseUrl: string
  close: () => Promise<void>
}

export function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (url.pathname === "/slow") {
        res.writeHead(200, { "Content-Type": "text/html" })
        res.write("<html><body>Slow</body></html>")
        const timer = setInterval(() => {
          res.write("<!-- keep-alive -->")
        }, 1000)
        req.on("close", () => clearInterval(timer))
        return
      }

      const fileName =
        url.pathname === "/" ? "tall.html" : `${url.pathname.slice(1)}.html`
      const filePath = path.join(FIXTURE_DIR, fileName)

      try {
        const body = readFileSync(filePath)
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end("not found")
      }
    })

    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Fixture server failed to bind"))
        return
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error)
              else closeResolve()
            })
          }),
      })
    })
  })
}
