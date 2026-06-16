---
name: ssr-hydration-watchdog
description: >
  Detects SSR hydration mismatches by running the app in a real browser and
  comparing the server-rendered HTML against the post-hydration DOM. Use this
  skill whenever the user mentions: hydration mismatch, hydration error, hydration
  failed, page flashing on load, content shifting after load, white screen on first
  render, different content on refresh, "Expected server HTML", Next.js hydration,
  Nuxt hydration, Remix hydration, SvelteKit hydration, SSR bug, server-client
  mismatch, or "my page looks different the first time". Also use proactively when
  the user is debugging a visual flicker or layout shift in an SSR app and cannot
  find the cause in the code — hydration is the likely culprit. Supports two modes:
  single-URL (when the user gives a specific route to check) and full-scan (when
  the user says "scan my app", "check all my routes", "audit my whole site", or
  does not name a specific URL).
---

# SSR Hydration Watchdog

You are detecting bugs that are completely invisible in source code. A hydration
mismatch happens when the HTML your server produces does not match the HTML the
browser produces after JavaScript runs. React, Vue, Nuxt, and other SSR frameworks
try to reuse the server HTML rather than rebuilding the DOM from scratch — if the
two versions disagree, the framework either patches the DOM (causing a visual
flash) or throws a warning that most developers never see.

The only way to catch this is to run the app, capture the HTML at the exact
millisecond before JavaScript executes, then capture it again after hydration
completes, and compare the two.

---

## Step 0 — Understand the request and pick a mode

**Single-URL mode** — the user gives a specific route or URL:
> "check hydration on /dashboard", "audit http://localhost:3000/login"

**Full-scan mode** — the user asks generally:
> "scan my app", "check all my routes", "audit my whole site",
> "find all hydration issues", or gives no specific URL

If the mode is unclear, ask exactly one question: "Do you want to check a
specific URL, or scan all routes in the project?"

In either mode, confirm:
1. **Dev server URL** — default `http://localhost:3000`. Ask if different.
2. **Framework** — Next.js, Nuxt, Remix, SvelteKit, or other. Infer from
   `package.json` if available before asking.

If the dev server is not running, provide the start command and wait for
confirmation before proceeding.

---

## Step 1 — Check Playwright

```bash
npx playwright --version 2>/dev/null || echo "NOT_INSTALLED"
```

If not installed:
```bash
npm install -D playwright && npx playwright install chromium
```

---

## Step 2 — Discover routes (full-scan mode only)

Skip this step entirely in single-URL mode.

Read `references/route-discovery.md` for the exact glob patterns per framework.
Build the route list from the filesystem — do not ask the user to list routes
manually. Use these roots:

| Framework  | Route root            | Pattern                        |
|------------|-----------------------|--------------------------------|
| Next.js    | `app/` or `pages/`   | `**/page.tsx`, `**/page.js`, `**/*.tsx` (pages dir) |
| Nuxt       | `pages/`             | `**/*.vue`                     |
| Remix      | `app/routes/`        | `**/*.tsx`, `**/*.jsx`         |
| SvelteKit  | `src/routes/`        | `**/+page.svelte`              |

Convert file paths to URL paths (strip `page.tsx`, replace `[param]` with
`_test`, replace `(group)` folders with nothing). Cap full-scan at 30 routes —
if more exist, ask the user if they want to proceed or filter by directory.

---

## Step 3 — Write and configure the check script

Copy `scripts/hydration-check.mjs` from this skill to the project root.
Fill in the CONFIG block only — leave everything else untouched:

```js
const CONFIG = {
  baseUrl:    'http://localhost:3000',   // dev server root
  framework:  'nextjs',                  // nextjs | nuxt | remix | sveltekit | other
  mode:       'single',                  // 'single' | 'scan'
  singleUrl:  '/dashboard',             // used in single mode only
  routes:     [],                        // populated by Claude in scan mode
  headless:   true,                      // set false to watch it run
};
```

In scan mode, populate `routes` with the list discovered in Step 2:
```js
routes: ['/', '/login', '/dashboard', '/settings/profile'],
```

---

## Step 4 — Run it

```bash
node hydration-check.mjs
```

To watch the browser:
```bash
HEADLESS=false node hydration-check.mjs
```

To see the raw HTML diff for a specific failure:
```bash
VERBOSE=1 node hydration-check.mjs
```

Script exits `0` when all routes are clean, `1` when any mismatch is found.

---

## Step 5 — Interpret results and identify root causes

For each route flagged, read the error text and match it to a root cause.
Read `references/root-cause-fixes.md` for the full lookup table — it maps
every known error pattern to a root cause and an exact fix.

**Quick reference for the most common causes:**

| What the error says | Root cause | Fix |
|---|---|---|
| `localStorage` / `sessionStorage` | Browser-only API read on render | Move into `useEffect` with mounted guard |
| `window` / `document` / `navigator` | Browser-only global on render | Wrap in `typeof window !== 'undefined'` check |
| `new Date()` / `Date.now()` | Non-deterministic value differs between server and client | Generate server-side and pass as prop, or move to `useEffect` |
| `Math.random()` | Non-deterministic | Move to `useEffect` or generate in server component |
| `crypto.randomUUID()` | Non-deterministic | Same as Math.random() |
| `useSearchParams()` without Suspense | Next.js App Router constraint | Wrap component in `<Suspense>` |
| No console error but DOM diff exists | Silent mismatch — browser extension or conditional render | Check for `typeof window` conditionals that render different JSX |
| Nuxt: `[nuxt] [warn] Hydration mismatch` | Same root causes, different logger | Same fixes apply |

For anything not in the quick reference, read `references/root-cause-fixes.md`.

---

## Step 6 — Deliver the report

**Single-URL mode:**

```
SSR HYDRATION WATCHDOG
══════════════════════════════════════════════
Route   : /dashboard
Status  : ❌  1 mismatch found

  Issue 1
  ───────
  Cause   : localStorage read on render (UserGreeting component)
  Evidence: "Warning: Prop `children` did not match. Server: "Welcome"
             Client: "Welcome, Parth""
  Fix     : Move localStorage.getItem('name') into useEffect with
             a mounted state guard. Render "Welcome" on server,
             update to "Welcome, [name]" after mount.

  Code change needed in: components/UserGreeting.tsx
══════════════════════════════════════════════
```

**Full-scan mode:**

```
SSR HYDRATION WATCHDOG — FULL SCAN
══════════════════════════════════════════════
Routes scanned : 12
Clean          : 10  ✅
Issues found   :  2  ❌

❌  /dashboard     — localStorage read (UserGreeting)
❌  /profile       — window.innerWidth read on render (ResponsivePanel)
✅  /login
✅  /settings
✅  /settings/profile
... (remaining clean routes)

Fix 1 — /dashboard
  [same detail format as single-URL]

Fix 2 — /profile
  [same detail format]
══════════════════════════════════════════════
```

Always end the report with the list of clean routes so the user can confirm
coverage, not just failures.

---

## CI integration

After the app is clean, suggest adding to CI:

```yaml
# .github/workflows/hydration.yml
- name: Start dev server
  run: npm run dev &
- name: Wait for server
  run: npx wait-on http://localhost:3000
- name: Hydration check
  run: node hydration-check.mjs
```

---

## Edge cases

| Situation | Action |
|---|---|
| Framework is a plain SPA (Vite, CRA) | Tell the user hydration mismatches cannot exist without SSR. Offer to run the live-session-auditor consent check instead. |
| Route requires auth | Skip it in scan mode and list it as "skipped — requires login". Offer to add cookie injection if the user wants it audited. |
| Route has a dynamic segment e.g. `/post/[id]` | Substitute a real ID if the user can provide one; otherwise substitute `1` and note the assumption in the report. |
| No hydration errors but visual flash reported | Run with `VERBOSE=1` — silent mismatches show in the DOM diff even without a console error. Also check for `suppressHydrationWarning` prop hiding errors. |
| `suppressHydrationWarning` found in codebase | Flag every instance in the report. This prop hides mismatches rather than fixing them — each use should be reviewed. **Note: React never logs this string at runtime — when suppression works, the console is completely silent. The script detects it by scanning source files before the browser launches, not by watching console output.** |
| Browser extension modifies DOM | The diff will show changes not attributable to any component. Note in the report that extensions can cause false positives and suggest running in an Incognito window. |
| Nuxt 3 routes use file-based layout groups | Strip layout folders (e.g. `(auth)/`) from path conversion the same way Next.js route groups are handled. |
| Scan finds 0 hydration errors across all routes | Report clean with route count. Note that dynamic data (authenticated content, real-time data) may behave differently in production and suggest testing with `HEADLESS=false` and real session cookies if confidence is needed. |
