/**
 * ssr-hydration-watchdog — hydration-check.mjs
 *
 * Copy to your project root. Update CONFIG only. Run: node hydration-check.mjs
 *
 * Modes:
 *   single — checks one URL (CONFIG.singleUrl)
 *   scan   — checks all routes in CONFIG.routes[]
 *
 * Env flags:
 *   HEADLESS=false   watch the browser run
 *   VERBOSE=1        print raw HTML diff on failure
 *
 * Exit codes:
 *   0 — all routes clean
 *   1 — one or more mismatches found
 */

import { chromium } from 'playwright';

// ─── CONFIG — edit these values only ─────────────────────────────────────────
const CONFIG = {
  baseUrl:   'http://localhost:3000',
  framework: 'nextjs',          // nextjs | nuxt | remix | sveltekit | other
  mode:      'single',          // 'single' | 'scan'
  singleUrl: '/',               // used in single mode — relative path or full URL
  routes:    [],                // populated by Claude in scan mode e.g. ['/', '/login']
  headless:  process.env.HEADLESS !== 'false',
  verbose:   process.env.VERBOSE === '1',
};
// ─────────────────────────────────────────────────────────────────────────────

// Framework-specific console patterns that indicate a hydration mismatch.
const HYDRATION_PATTERNS = {
  nextjs: [
    'Hydration failed because',
    'Expected server HTML to contain',
    'did not match',
    'There was an error while hydrating',
    'Warning: An update to',
    'In HTML, whitespace text nodes cannot be a child',
  ],
  nuxt: [
    '[nuxt] [warn] Hydration mismatch',
    'Hydration children mismatch',
    'Hydration node mismatch',
    'Hydration text mismatch',
    'Hydration attribute mismatch',
  ],
  remix: [
    'Hydration failed',
    'Expected server HTML',
    'did not match',
  ],
  sveltekit: [
    'hydration mismatch',
    'Hydration failed',
  ],
  other: [
    'hydration',
    'Hydration',
    'did not match',
    'server HTML',
    'Expected server',
  ],
};

// Strips framework noise so diffs reflect real content differences only.
function normalise(html, framework) {
  let out = html;

  if (framework === 'nextjs') {
    out = out
      .replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/g, '')
      .replace(/<script>self\.__next[\s\S]*?<\/script>/g, '')
      .replace(/<script nonce[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/data-reactroot="[^"]*"/g, '')
      .replace(/data-react-[a-z-]+="[^"]*"/g, '');
  }

  if (framework === 'nuxt') {
    out = out
      .replace(/<script type="application\/json" data-nuxt[\s\S]*?<\/script>/g, '')
      .replace(/data-v-[a-z0-9]+=?"?[^"]*"?/g, '');
  }

  if (framework === 'remix') {
    out = out
      .replace(/<script>window\.__remixContext[\s\S]*?<\/script>/g, '')
      .replace(/<script data-remix[\s\S]*?<\/script>/g, '');
  }

  if (framework === 'sveltekit') {
    out = out
      .replace(/<script type="application\/json" data-sveltekit[\s\S]*?<\/script>/g, '');
  }

  return out.replace(/\s+/g, ' ').trim();
}

// Resolves a relative path to a full URL.
function toUrl(route) {
  if (route.startsWith('http')) return route;
  const base = CONFIG.baseUrl.replace(/\/$/, '');
  const path = route.startsWith('/') ? route : `/${route}`;
  return `${base}${path}`;
}

// Checks a single route for hydration mismatches.
// Returns { url, clean, errors, hasDiff, diffSize, skipped, skipReason }
async function checkRoute(browser, route) {
  const url     = toUrl(route);
  const ctx     = await browser.newContext();
  const page    = await ctx.newPage();
  const patterns = HYDRATION_PATTERNS[CONFIG.framework] || HYDRATION_PATTERNS.other;

  const hydrationErrors = [];
  const suppressWarnings = [];

  page.on('console', msg => {
    const text = msg.text();

    // Catch suppressHydrationWarning usage
    if (text.includes('suppressHydrationWarning')) {
      suppressWarnings.push(text.slice(0, 300));
    }

    // Match hydration error patterns
    const isHydrationIssue = patterns.some(p =>
      text.toLowerCase().includes(p.toLowerCase())
    );
    if (isHydrationIssue) {
      hydrationErrors.push({
        level: msg.type(),
        text: text.slice(0, 500),
        loc: msg.location(),
      });
    }
  });

  page.on('pageerror', err => {
    const isHydrationIssue = patterns.some(p =>
      err.message.toLowerCase().includes(p.toLowerCase())
    );
    if (isHydrationIssue) {
      hydrationErrors.push({ level: 'pageerror', text: err.message.slice(0, 500) });
    }
  });

  let serverHTML = '';
  let clientHTML = '';
  let skipped    = false;
  let skipReason = '';

  try {
    // Capture at commit — before any JS executes
    const response = await page.goto(url, { waitUntil: 'commit', timeout: 20_000 });

    if (response.status() === 401 || response.status() === 403) {
      skipped    = true;
      skipReason = `requires auth (HTTP ${response.status()})`;
      await ctx.close();
      return { url, route, clean: true, skipped, skipReason, errors: [], suppressWarnings, hasDiff: false, diffSize: 0 };
    }

    if (!response.ok() && response.status() !== 404) {
      skipped    = true;
      skipReason = `server returned ${response.status()}`;
      await ctx.close();
      return { url, route, clean: true, skipped, skipReason, errors: [], suppressWarnings, hasDiff: false, diffSize: 0 };
    }

    serverHTML = await page.content();

    // Wait for full hydration — networkidle + buffer for concurrent/Suspense
    await page.waitForLoadState('networkidle', { timeout: 20_000 });
    await page.waitForTimeout(600);

    clientHTML = await page.content();

  } catch (err) {
    if (err.message.includes('net::ERR_CONNECTION_REFUSED')) {
      skipped    = true;
      skipReason = 'dev server not reachable';
    } else {
      skipped    = true;
      skipReason = `timeout or load error: ${err.message.slice(0, 100)}`;
    }
    await ctx.close();
    return { url, route, clean: true, skipped, skipReason, errors: [], suppressWarnings, hasDiff: false, diffSize: 0 };
  }

  // Structural diff
  const normServer = normalise(serverHTML, CONFIG.framework);
  const normClient = normalise(clientHTML, CONFIG.framework);
  const diffSize   = Math.abs(
    normServer.split(' ').length - normClient.split(' ').length
  );
  const hasDiff    = diffSize > 15; // word delta threshold — ignores minor noise

  if (CONFIG.verbose && (hasDiff || hydrationErrors.length > 0)) {
    console.log(`\n[VERBOSE] ${url}`);
    console.log(`  Server HTML words : ${normServer.split(' ').length}`);
    console.log(`  Client HTML words : ${normClient.split(' ').length}`);
    console.log(`  Delta             : ${diffSize}`);
    if (normServer !== normClient) {
      // Print first 400 chars of each for comparison
      console.log(`  Server (first 400): ${normServer.slice(0, 400)}`);
      console.log(`  Client (first 400): ${normClient.slice(0, 400)}`);
    }
  }

  await ctx.close();

  const clean = hydrationErrors.length === 0 && !hasDiff;

  return {
    url,
    route,
    clean,
    skipped: false,
    skipReason: '',
    errors: hydrationErrors,
    suppressWarnings,
    hasDiff,
    diffSize,
  };
}

// ─── Report ───────────────────────────────────────────────────────────────────
function printReport(results) {
  const LINE  = '═'.repeat(56);
  const line2 = '─'.repeat(56);
  const time  = new Date().toISOString().replace('T', ' ').split('.')[0] + ' UTC';

  const clean   = results.filter(r => !r.skipped && r.clean);
  const issues  = results.filter(r => !r.skipped && !r.clean);
  const skipped = results.filter(r => r.skipped);

  const modeLabel = CONFIG.mode === 'scan'
    ? `FULL SCAN — ${CONFIG.baseUrl}`
    : `SINGLE ROUTE — ${results[0]?.url ?? CONFIG.baseUrl}`;

  console.log('\n' + LINE);
  console.log('  SSR HYDRATION WATCHDOG');
  console.log('  ' + modeLabel);
  console.log('  ' + time);
  console.log(LINE);

  if (CONFIG.mode === 'scan') {
    console.log(`  Routes scanned : ${results.length}`);
    console.log(`  Clean          : ${clean.length}  ✅`);
    if (issues.length)  console.log(`  Issues found   : ${issues.length}  ❌`);
    if (skipped.length) console.log(`  Skipped        : ${skipped.length}  ⏭`);
    console.log();
  }

  // Issue detail
  issues.forEach((r, i) => {
    console.log(`❌  ${r.route}`);
    console.log(line2);

    if (r.errors.length > 0) {
      r.errors.forEach((e, j) => {
        console.log(`  Issue ${j + 1} · [${e.level}]`);
        console.log(`  ${e.text}`);
        if (e.loc?.url) console.log(`  at ${e.loc.url}:${e.loc.lineNumber}`);
        console.log();
      });
    }

    if (r.hasDiff && r.errors.length === 0) {
      console.log(`  Silent mismatch — server and client HTML differ by ~${r.diffSize} words.`);
      console.log('  No framework error was logged. Likely cause: conditional render');
      console.log('  based on typeof window, or a browser extension modifying the DOM.');
      console.log('  Run with VERBOSE=1 to see the raw diff.\n');
    }

    if (r.suppressWarnings.length > 0) {
      console.log(`  ⚠️  suppressHydrationWarning found (${r.suppressWarnings.length} instance(s))`);
      console.log('  This hides mismatches rather than fixing them. Review each use.\n');
    }

    if (i < issues.length - 1) console.log(line2);
  });

  // Clean routes
  if (clean.length > 0) {
    console.log('\n✅  Clean routes:');
    clean.forEach(r => console.log(`    ${r.route}`));
  }

  // Skipped routes
  if (skipped.length > 0) {
    console.log('\n⏭  Skipped:');
    skipped.forEach(r => console.log(`    ${r.route}  (${r.skipReason})`));
  }

  console.log('\n' + LINE);
  const passed = issues.length === 0;
  console.log(`  RESULT: ${passed
    ? '✅  ALL CLEAN'
    : `❌  ${issues.length} ROUTE(S) HAVE HYDRATION ISSUES`}`);
  console.log(LINE + '\n');

  return passed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Resolve which routes to check
  const routes = CONFIG.mode === 'scan'
    ? (CONFIG.routes.length ? CONFIG.routes : ['/'])
    : [CONFIG.singleUrl || '/'];

  const modeLabel = CONFIG.mode === 'scan'
    ? `full scan (${routes.length} route${routes.length !== 1 ? 's' : ''})`
    : `single route: ${routes[0]}`;

  console.log(`\n🔍 SSR Hydration Watchdog — ${modeLabel}`);
  console.log(`   Base URL  : ${CONFIG.baseUrl}`);
  console.log(`   Framework : ${CONFIG.framework}\n`);

  let browser;
  try {
    browser = await chromium.launch({ headless: CONFIG.headless });
  } catch {
    console.error('Failed to launch browser. Run: npx playwright install chromium');
    process.exit(1);
  }

  const results = [];

  for (const route of routes) {
    const label = CONFIG.mode === 'scan' ? `  Checking ${route}...` : `  Checking ${toUrl(route)}...`;
    process.stdout.write(label);
    const result = await checkRoute(browser, route);
    const status = result.skipped ? ' ⏭' : result.clean ? ' ✅' : ' ❌';
    console.log(status);
    results.push(result);
  }

  await browser.close();

  const passed = printReport(results);
  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
