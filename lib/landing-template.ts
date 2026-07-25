import type { Database } from "@/lib/database.types"

type LeadRow = Database["public"]["Tables"]["leads"]["Row"]

/** Public sample video used in template preview when no real video exists yet. */
export const SAMPLE_VIDEO_URL =
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"

/** Tiny inline JPEG for template preview — no third-party fetch (D30). */
export const SAMPLE_POSTER_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGfAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//Z"

/** Every placeholder token from DB.md §5.1.1. */
export const TEMPLATE_PLACEHOLDERS = [
  "first_name",
  "last_name",
  "full_name",
  "company",
  "city",
  "state",
  "country",
  "email",
  "phone",
  "website_url",
  "industry",
  "ref",
  "video_url",
  "poster_url",
  "cta_url",
  "cta_label",
] as const

export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number]

export type TemplateValues = Partial<Record<TemplatePlaceholder, string>>

export type SampleLead = Pick<
  LeadRow,
  | "id"
  | "ref"
  | "first_name"
  | "last_name"
  | "full_name"
  | "company"
  | "email"
  | "phone"
  | "website_url"
  | "city"
  | "state"
  | "country"
  | "industry"
  | "updated_at"
>

/** Synthetic lead with every field populated — used when a campaign has no leads. */
export const SAMPLE_LEAD: SampleLead = {
  id: "00000000-0000-0000-0000-000000000001",
  ref: "LD-0001",
  first_name: "Alex",
  last_name: "Rivera",
  full_name: "Alex Rivera",
  company: "Acme Plumbing",
  email: "alex@acmeplumbing.example",
  phone: "+1 (555) 123-4567",
  website_url: "https://www.acmeplumbing.example",
  city: "Portland",
  state: "OR",
  country: "US",
  industry: "Home Services",
  updated_at: "2026-01-01T00:00:00.000Z",
}

export const DEFAULT_LANDING_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>A quick look at {{company}}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px 16px 40px;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #fafaf9;
    color: #1c1917;
  }
  main { max-width: 640px; margin: 0 auto; }
  .eyebrow {
    margin: 0 0 6px;
    font-size: 12px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #78716c;
  }
  h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.25; font-weight: 650; }
  .lede { margin: 0 0 20px; font-size: 16px; color: #44403c; }
  .meta { margin: 0 0 18px; font-size: 13px; color: #78716c; }
  .player {
    margin: 0 0 24px;
    border-radius: 12px;
    overflow: hidden;
    background: #1c1917;
    box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.10);
  }
  video { display: block; width: 100%; height: auto; background: #1c1917; }
  .cta {
    display: block;
    min-height: 48px;
    padding: 14px 20px;
    border-radius: 10px;
    background: #1c1917;
    color: #fafaf9;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.25;
    text-align: center;
    text-decoration: none;
  }
  .cta:hover { background: #292524; }
  footer { margin: 28px 0 0; font-size: 13px; color: #78716c; }
  @media (min-width: 640px) {
    body { padding: 56px 24px; font-size: 16px; }
    h1 { font-size: 34px; }
    .lede { font-size: 17px; }
    .meta, footer { font-size: 14px; }
    .cta { min-height: 52px; padding: 16px 24px; font-size: 17px; }
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #fafaf9; }
    .lede, .meta { color: #d6d3d1; }
    .eyebrow, footer { color: #a8a29e; }
    .cta { background: #fafaf9; color: #1c1917; }
    .cta:hover { background: #e7e5e4; }
  }
</style>
</head>
<body>
<main>
  <p class="eyebrow">{{ref}}</p>
  <h1>Hi {{first_name}}, a quick look at {{company}}</h1>
  <p class="lede">I recorded a short walk-through of {{website_url}} with a note from me over the top. About a minute, no sign-up.</p>
  <p class="meta">{{full_name}} · {{city}}, {{state}} {{country}} · {{industry}} · {{email}} · {{phone}}</p>

  <div class="player">
    <video controls playsinline preload="none" poster="{{poster_url}}">
      <source src="{{video_url}}" type="video/mp4">
      Your browser cannot play this video.
    </video>
  </div>

  <a class="cta" href="{{cta_url}}">{{cta_label}}</a>

  <footer>
    <p>Made for {{company}} — {{city}} {{state}}</p>
  </footer>
</main>
</body>
</html>`

const PLACEHOLDER_PATTERN = /\{\{([a-z_]+)\}\}/g

function stringOrEmpty(value: string | null | undefined): string {
  return value ?? ""
}

export function leadToTemplateValues(
  lead: SampleLead,
  extras?: Pick<TemplateValues, "video_url" | "poster_url" | "cta_url" | "cta_label">,
): TemplateValues {
  return {
    first_name: stringOrEmpty(lead.first_name),
    last_name: stringOrEmpty(lead.last_name),
    full_name: stringOrEmpty(lead.full_name),
    company: stringOrEmpty(lead.company),
    city: stringOrEmpty(lead.city),
    state: stringOrEmpty(lead.state),
    country: stringOrEmpty(lead.country),
    email: stringOrEmpty(lead.email),
    phone: stringOrEmpty(lead.phone),
    website_url: stringOrEmpty(lead.website_url),
    industry: stringOrEmpty(lead.industry),
    ref: stringOrEmpty(lead.ref),
    video_url: extras?.video_url ?? SAMPLE_VIDEO_URL,
    poster_url: extras?.poster_url ?? SAMPLE_POSTER_URL,
    cta_url: extras?.cta_url ?? "",
    cta_label: extras?.cta_label ?? "",
  }
}

export function sampleValuesFor(
  lead: SampleLead,
  extras?: Pick<TemplateValues, "video_url" | "poster_url" | "cta_url" | "cta_label">,
): TemplateValues {
  return leadToTemplateValues(lead, extras)
}

/** Replace {{token}} placeholders. Unknown or missing tokens render empty.
 *  Values are expected to be pre-processed by renderLandingHtml for public output. */
export function substituteTemplate(
  html: string,
  values: TemplateValues,
): string {
  return html.replace(PLACEHOLDER_PATTERN, (_match, token: string) => {
    const value = values[token as TemplatePlaceholder]
    return value ?? ""
  })
}
