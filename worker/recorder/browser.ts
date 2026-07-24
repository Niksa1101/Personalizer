import { chromium, type Browser } from "playwright"

export const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--mute-audio",
  "--disable-dev-shm-usage",
  "--no-sandbox",
] as const

let sharedBrowser: Browser | null = null
let launching: Promise<Browser> | null = null

export async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) {
    return sharedBrowser
  }

  if (!launching) {
    launching = chromium
      .launch({
        headless: true,
        args: [...LAUNCH_ARGS],
      })
      .then((browser) => {
        sharedBrowser = browser
        launching = null
        return browser
      })
      .catch((error) => {
        launching = null
        throw error
      })
  }

  return launching
}

export async function closeSharedBrowser(): Promise<void> {
  if (!sharedBrowser) return
  const browser = sharedBrowser
  sharedBrowser = null
  await browser.close()
}

export async function createRecordingContext(input: {
  tmpDirAbs: string
  viewportWidth: number
  viewportHeight: number
}) {
  const browser = await getSharedBrowser()
  const context = await browser.newContext({
    viewport: {
      width: input.viewportWidth,
      height: input.viewportHeight,
    },
    userAgent: DESKTOP_CHROME_UA,
    locale: "en-US",
    deviceScaleFactor: 1,
    recordVideo: {
      dir: input.tmpDirAbs,
      size: {
        width: input.viewportWidth,
        height: input.viewportHeight,
      },
    },
  })

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    })
  })

  return context
}
