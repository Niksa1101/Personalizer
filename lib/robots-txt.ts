/** Site-level robots.txt body — Phase 11 includes this in the Netlify manifest (D58). */
export function robotsTxtBody(): string {
  return "User-agent: *\nDisallow: /\n"
}
