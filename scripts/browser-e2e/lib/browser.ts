import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

/**
 * playwright-core is intentionally NOT a repo dependency. Install it outside the repo and point PW_CORE at the
 * folder that contains node_modules/playwright-core (e.g. `mkdir ~/pw && cd ~/pw && npm i playwright-core`),
 * or install it globally / anywhere resolvable. Browsers: PLAYWRIGHT_BROWSERS_PATH, or CHROMIUM_PATH to a binary.
 */
export async function loadPlaywright(): Promise<typeof import('playwright-core')> {
  const root = process.env.PW_CORE;
  if (root) {
    const req = createRequire(path.join(path.resolve(root), 'package.json'));
    return req('playwright-core');
  }
  return await import('playwright-core');
}

export function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined; // let Playwright use its own default install (a Mac user who ran `npx playwright install chromium`)
}
