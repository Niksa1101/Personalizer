/**
 * Generates Phase 18 acceptance CSV fixtures.
 * Run: npx tsx scripts/generate-acceptance-fixtures.ts
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const OUT = join(import.meta.dirname, "fixtures", "acceptance")

const RESERVED = new Set([
  "mozilla.org",
  "wikipedia.org",
  "gnu.org",
  "python.org",
  "postgresql.org",
  "rust-lang.org",
  "sqlite.org",
  "curl.se",
  "debian.org",
  "kernel.org",
  "apache.org",
  "freebsd.org",
  "php.net",
  "iana.org",
  "git-scm.com",
  "perl.org",
  "openbsd.org",
])

type Row = {
  website: string
  company: string
  first_name: string
  last_name: string
  email: string
  city: string
  country: string
  industry: string
}

function row(website: string, company: string): Row {
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28)
  return {
    website,
    company,
    first_name: "Accept",
    last_name: "Fixture",
    email: `accept-${slug}@example.com`,
    city: "Portland",
    country: "USA",
    industry: "Software",
  }
}

function toCsv(rows: Row[]): string {
  const header =
    "website,company,first_name,last_name,email,city,country,industry"
  const lines = rows.map((r) =>
    [
      r.website,
      r.company,
      r.first_name,
      r.last_name,
      r.email,
      r.city,
      r.country,
      r.industry,
    ].join(","),
  )
  return [header, ...lines].join("\n") + "\n"
}

function hostFromUrl(url: string): string {
  let value = url.trim().toLowerCase()
  value = value.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:[^/@]*@)?/, "")
  value = value.replace(/[/?#].*$/, "")
  value = value.replace(/:[0-9]+$/, "")
  value = value.replace(/^www\./, "")
  value = value.replace(/\.$/, "")
  return value
}

const used = new Set<string>()

function claim(url: string, label: string): Row {
  const host = hostFromUrl(url)
  if (!host) throw new Error(`unparseable url: ${url}`)
  if (RESERVED.has(host)) throw new Error(`reserved: ${host} (${label})`)
  if (used.has(host)) throw new Error(`collision: ${host} (${label})`)
  used.add(host)
  return row(url, label)
}

const AC1_GOOD: Array<[string, string]> = [
  ["https://www.ruby-lang.org", "Ruby Lang"],
  ["https://www.erlang.org", "Erlang Org"],
  ["https://www.haskell.org", "Haskell Org"],
  ["https://nginx.org", "Nginx"],
  ["https://www.openssl.org", "OpenSSL"],
  ["https://www.typescriptlang.org", "TypeScript"],
  ["https://www.docker.com", "Docker"],
  ["https://kubernetes.io", "Kubernetes"],
  ["https://www.r-project.org", "R Project"],
  ["https://www.w3.org", "W3C"],
  ["https://www.ietf.org", "IETF"],
  ["https://www.unicode.org", "Unicode"],
  ["https://www.eff.org", "EFF"],
  ["https://www.torproject.org", "Tor Project"],
  ["https://www.libreoffice.org", "LibreOffice"],
  ["https://www.blender.org", "Blender"],
  ["https://inkscape.org", "Inkscape"],
  ["https://www.videolan.org", "VideoLAN"],
  ["https://www.mediawiki.org", "MediaWiki"],
  ["https://archlinux.org", "Arch Linux"],
  ["https://www.gentoo.org", "Gentoo"],
  ["https://alpinelinux.org", "Alpine Linux"],
  ["https://ubuntu.com", "Ubuntu"],
  ["https://getfedora.org", "Fedora"],
  ["https://www.vim.org", "Vim"],
  ["https://helix-editor.com", "Helix Editor"],
  ["https://ziglang.org", "Zig"],
  ["https://www.swift.org", "Swift"],
  ["https://kotlinlang.org", "Kotlin"],
  ["https://www.scala-lang.org", "Scala"],
  ["https://clojure.org", "Clojure"],
  ["https://elixir-lang.org", "Elixir"],
  ["https://julialang.org", "Julia"],
  ["https://ocaml.org", "OCaml"],
  ["https://www.electronjs.org", "Electron"],
  ["https://crates.io", "Crates IO"],
  ["https://pypi.org", "PyPI"],
  ["https://www.npmjs.com", "Npm"],
  ["https://pnpm.io", "Pnpm"],
  ["https://deno.com", "Deno"],
  ["https://eslint.org", "Eslint"],
  ["https://prettier.io", "Prettier"],
  ["https://vitejs.dev", "Vite"],
  ["https://react.dev", "React"],
  ["https://vuejs.org", "Vue"],
  ["https://svelte.dev", "Svelte"],
  ["https://astro.build", "Astro"],
  ["https://nextjs.org", "Nextjs"],
  ["https://remix.run", "Remix"],
  ["https://nuxt.com", "Nuxt"],
  ["https://www.gatsbyjs.com", "Gatsby"],
  ["https://gohugo.io", "Hugo"],
  ["https://jquery.com", "Jquery"],
  ["https://lodash.com", "Lodash"],
  ["https://webpack.js.org", "Webpack"],
  ["https://rollupjs.org", "Rollup"],
  ["https://tailwindcss.com", "Tailwind"],
  ["https://getbootstrap.com", "Bootstrap"],
  ["https://d3js.org", "D3 Js"],
  ["https://threejs.org", "Three Js"],
  ["https://socket.io", "Socket IO"],
  ["https://redis.io", "Redis"],
  ["https://www.mongodb.com", "MongoDB"],
  ["https://mariadb.org", "MariaDB"],
  ["https://www.elastic.co", "Elastic"],
  ["https://grafana.com", "Grafana"],
  ["https://prometheus.io", "Prometheus"],
  ["https://traefik.io", "Traefik"],
  ["https://caddyserver.com", "Caddy"],
  ["https://letsencrypt.org", "Lets Encrypt"],
  ["https://matrix.org", "Matrix"],
  ["https://jitsi.org", "Jitsi"],
  ["https://obsproject.com", "OBS"],
  ["https://godotengine.org", "Godot"],
  ["https://llvm.org", "LLVM"],
  ["https://nim-lang.org", "Nim"],
  ["https://crystal-lang.org", "Crystal"],
  ["https://dlang.org", "D Lang"],
  ["https://www.fsharp.org", "Fsharp"],
  ["https://www.eclipse.org", "Eclipse"],
]

const AC1_BAD: Array<[string, string]> = [
  ["https://nonexistent-pz18-dns.invalid", "PZ18 DNS Invalid"],
  ["https://127.0.0.1:9", "PZ18 Conn Refused"],
  ["https://expired.badssl.com", "PZ18 SSL Expired"],
  ["https://httpstat.us/404", "PZ18 HTTP 404"],
  ["https://httpbingo.dev/500", "PZ18 HTTP 500"],
  ["https://example.com", "PZ18 Empty Example"],
  ["https://www.hugedomains.com", "PZ18 Parked"],
  ["https://nowebapp.github.io", "PZ18 Thin Landing"],
  ["https://www.cloudflare.com", "PZ18 Cloudflare"],
  ["https://www.nytimes.com", "PZ18 NYTimes"],
  ["https://www.reddit.com", "PZ18 Reddit"],
  ["https://github.com/login", "PZ18 GitHub Login"],
  ["https://postman-echo.com/status/403", "PZ18 HTTP 403"],
  ["https://httpbin.org/delay/10", "PZ18 Slow Nav"],
  ["https://self-signed.badssl.com", "PZ18 Self Signed"],
  ["https://wrong.host.badssl.com", "PZ18 Wrong Host"],
  ["https://mocky.io", "PZ18 Mocky"],
  ["https://httpforever.com", "PZ18 HTTP Forever"],
  ["https://bot.sannysoft.com", "PZ18 Bot Check"],
  ["https://www.instagram.com/pz18fixture", "PZ18 Instagram"],
]

const REHEARSAL_GOOD: Array<[string, string]> = [
  ["https://www.ansible.com", "Reh Ansible"],
  ["https://www.terraform.io", "Reh Terraform"],
  ["https://www.packer.io", "Reh Packer"],
  ["https://www.vagrantup.com", "Reh Vagrant"],
  ["https://www.consul.io", "Reh Consul"],
  ["https://www.vaultproject.io", "Reh Vault"],
  ["https://www.nomadproject.io", "Reh Nomad"],
  ["https://www.boundaryproject.io", "Reh Boundary"],
  ["https://www.waypointproject.io", "Reh Waypoint"],
  ["https://www.pulumi.com", "Reh Pulumi"],
  ["https://www.crossplane.io", "Reh Crossplane"],
  ["https://www.spinnaker.io", "Reh Spinnaker"],
  ["https://www.argoproj.io", "Reh Argo"],
  ["https://www.fluxcd.io", "Reh Flux"],
  ["https://www.backstage.io", "Reh Backstage"],
  ["https://www.openpolicyagent.org", "Reh OPA"],
]

const REHEARSAL_BAD: Array<[string, string]> = [
  ["https://pz18-reh-dns.invalid", "Reh DNS Invalid"],
  ["https://untrusted-root.badssl.com", "Reh SSL Untrusted"],
  ["https://tls-v1-0.badssl.com", "Reh TLS10"],
  ["https://revoked.badssl.com", "Reh Revoked SSL"],
]

const AC3: Array<[string, string]> = [
  ["https://www.datadoghq.com", "AC3 Force Datadog"],
  ["https://www.sentry.io", "AC3 Force Sentry"],
  ["https://www.launchdarkly.com", "AC3 Force LaunchDarkly"],
  ["https://www.circleci.com", "AC3 Force CircleCI"],
  ["https://www.buildkite.com", "AC3 Force Buildkite"],
  ["https://www.harness.io", "AC3 Force Harness"],
]

const AC7: Array<[string, string]> = [
  ["https://www.vercel.com", "AC7 Vercel"],
  ["https://www.netlify.com", "AC7 Netlify"],
  ["https://www.digitalocean.com", "AC7 DigitalOcean"],
  ["https://www.linode.com", "AC7 Linode"],
  ["https://www.heroku.com", "AC7 Heroku"],
  ["https://www.fly.io", "AC7 Fly"],
  ["https://www.railway.app", "AC7 Railway"],
  ["https://www.render.com", "AC7 Render"],
  ["https://www.supabase.com", "AC7 Supabase"],
  ["https://www.fastly.com", "AC7 Fastly"],
]

function buildAc1(): Row[] {
  const rows: Row[] = []
  for (const [url, name] of AC1_GOOD) rows.push(claim(url, `AC1 Good ${name}`))
  for (const [url, name] of AC1_BAD) rows.push(claim(url, `AC1 Bad ${name}`))
  rows.push(
    claim(
      "https://www.linkedin.com/company/pz18-acceptance-fixture",
      "PZ18 Social Only",
    ),
  )
  for (let i = 0; i < 4; i++) {
    const dup = { ...rows[i]! }
    dup.company = `${dup.company} Dup`
    rows.push(dup)
  }
  if (rows.length !== 105) throw new Error(`ac-1 rows ${rows.length}, want 105`)
  return rows
}

function buildFromPool(pool: Array<[string, string]>, prefix: string): Row[] {
  return pool.map(([url, name]) => claim(url, `${prefix} ${name}`))
}

function main(): void {
  mkdirSync(OUT, { recursive: true })

  const ac1 = buildAc1()
  const rehearsal = [
    ...buildFromPool(REHEARSAL_GOOD, "Rehearsal"),
    ...buildFromPool(REHEARSAL_BAD, "Rehearsal"),
  ]
  const ac3 = buildFromPool(AC3, "AC3")
  const ac7 = buildFromPool(AC7, "AC7")

  writeFileSync(join(OUT, "ac-1.csv"), toCsv(ac1), "utf8")
  writeFileSync(join(OUT, "rehearsal.csv"), toCsv(rehearsal), "utf8")
  writeFileSync(join(OUT, "ac-3-forcing.csv"), toCsv(ac3), "utf8")
  writeFileSync(join(OUT, "ac-7.csv"), toCsv(ac7), "utf8")

  console.log(`Wrote ${used.size} unique domains to ${OUT}/`)
  console.log(`  ac-1.csv          ${ac1.length} rows`)
  console.log(`  rehearsal.csv     ${rehearsal.length} rows`)
  console.log(`  ac-3-forcing.csv  ${ac3.length} rows`)
  console.log(`  ac-7.csv          ${ac7.length} rows`)
}

main()
