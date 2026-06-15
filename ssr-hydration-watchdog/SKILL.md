---
name: live-session-auditor
description: >
  Catches two classes of frontend bugs that are completely invisible in source
  code and can only be observed by running the app in a real browser session.
  Use this skill whenever the user mentions: hydration mismatches, page flashing
  on load, SSR/CSR content differences, "different content on first load",
  Next.js/Nuxt/Remix/SvelteKit hydration errors, white screen flashes, or any
  SSR bug. ALSO use whenever the user asks about GDPR compliance, consent
  auditing, "what fires before consent", cookie compliance, tracking scripts,
  analytics firing too early, pre-consent pixels, or "is my tracking compliant".
  Use proactively if the user's app is SSR-based AND has any analytics/tracking
  scripts — both phases are useful even when the user hasn't explicitly asked.
---

# Live Session Auditor

You are running a two-phase browser audit that catches bugs no linter,
code reviewer, or static analysis tool can find. Both problems only exist
at runtime — in network traffic and DOM state at specific milliseconds.

## What this skill does

**Phase 1 — SSR Hydration Watchdog**
Loads the page, captures React/Vue/Nuxt hydration errors from the browser
console, diffs the server-rendered HTML against the post-hydration DOM, and
traces every mismatch back to its component and root cause (localStorage
read, window access, non-deterministic value like Date.now() called on render).

**Phase 2 — Consent & Tracking Fire Order Auditor**
Loads the page with all consent blocked, intercepts every outbound network
request, categorises each by vendor (GA4, Meta Pixel, HotJar, etc.), then
accepts consent and captures the second wave. Produces a per-vendor GDPR
compliance verdict — fired before consent = violation, fired after = compliant.

Both phases run in one Playwright browser process to share startup cost.

---

## Step 0 — Gather context before touching any files

Ask the user (or infer from the codebase) before proceeding:

1. **Target URL** — default `http://localhost:3000`. Ask if unsure.
2. **Framework** — Next.js, Nuxt, Remix, SvelteKit, or other SSR framework.
   If the app has no SSR (plain CRA, Vite SPA), skip Phase 1 and say why.
3. **Consent banner** — Does the page show a cookie/consent banner?
   If yes: what does the "Accept" button say, or is there a CSS selector for it?
   If no consent banner exists but tracking requests fire, that itself is a
   GDPR violation — Phase 2 still runs and will report it.
4. **Dev server** — Confirm it's running before proceeding. If not, provide
   the start command for their framework:
   - Next.js: `npm run dev`
   - Nuxt: `npm run dev`
   - Remix: `npm run dev`
   - SvelteKit: `npm run dev`

---

## Step 1 — Check and install Playwright

Run this check first:

```bash
npx playwright --version 2>/dev/null || echo "NOT_INSTALLED"
```

If not installed:

```bash
npm install -D playwright
npx playwright install chromium
```

If the user can't modify package.json (e.g. they're on a shared system):

```bash
npm install -g playwright
npx playwright install chromium
```

---

## Step 2 — Write the audit script

Create `live-audit.mjs` in the project root. Populate CONFIG from Step 0.
Read `scripts/audit-runner.mjs` from this skill's directory for the full
script — copy it verbatim, then update only the CONFIG block at the top.

```js
// CONFIG — edit these values only
const CONFIG = {
  url:               'http://localhost:3000',  // target URL
  framework:         'nextjs',                  // nextjs | nuxt | remix | sveltekit | other
  consentButtonText: 'Accept',                  // button text, or null if no banner
  consentSelector:   null,                      // CSS override, e.g. '#accept-all'
  waitAfterConsent:  2000,                      // ms to wait after clicking consent
  headless:          true,                      // set false to watch it run
};
```

See `references/vendor-patterns.md` for the full vendor fingerprint list used
in Phase 2 — add custom vendors there if the user's stack has internal tools.

---

## Step 3 — Run the audit

```bash
node live-audit.mjs
```

The script exits `0` on clean, `1` on any violation — safe to use as a CI gate.

To watch it run in a real browser window:
```bash
HEADLESS=false node live-audit.mjs
```

To see the full HTML diff in Phase 1 (verbose):
```bash
VERBOSE=1 node live-audit.mjs
```

---

## Step 4 — Interpret Phase 1 results (Hydration)

**No errors reported → clean.** Nothing to fix.

**Hydration error from console** — React/Vue/Nuxt log the mismatch component
in the error message. Open that component and look for these root causes:

| Root cause | Fix |
|---|---|
| `localStorage` / `sessionStorage` read on render | Move into `useEffect`, or use `useLayoutEffect` with a mounted guard |
| `window`, `document`, `navigator` accessed directly | Wrap in `typeof window !== 'undefined'` check, or use dynamic import with `ssr: false` |
| `Date.now()`, `new Date()`, `Math.random()` on render | Move to `useEffect` or generate server-side and pass as prop |
| `crypto.randomUUID()` on render | Same as above |
| `useSearchParams()` without Suspense boundary (Next.js) | Wrap the component in `<Suspense>` |
| Browser extension injecting DOM nodes | Not your bug — note it in the report |

**Structural DOM diff without console error** — the diff shows what changed.
Look at which element's text or attribute differs between server and client HTML.
The cause is almost always one of the above — trace it to the component that
owns that element.

---

## Step 5 — Interpret Phase 2 results (Consent)

**No consent banner + no tracking requests → clean.**

**No consent banner + tracking requests present:**
This is a GDPR violation. The user is firing tracking without any consent
mechanism at all. Recommend adding a consent management platform (CMP).

**Vendors listed as violations (fired before consent):**
For each violating vendor, find where its script loads:
- `<Script>` tags in `_app.tsx` / `layout.tsx` / `<head>`
- Google Tag Manager container (check if GTM fires tags without consent triggers)
- Third-party components that auto-initialise

Apply the appropriate fix:

| Vendor type | Fix |
|---|---|
| `<script>` tag | Wrap load in consent callback: only append to DOM after consent event fires |
| Next.js `<Script>` | Add `strategy="lazyOnload"` + consent gate |
| Google Tag Manager | Add consent mode v2 triggers; set default state to `denied` |
| React component with auto-init | Accept `enabled` prop, pass `consentGiven` state |

**Vendors listed as compliant (fired after consent):** No action needed.
Confirm with the user that all expected vendors appear in this list.

---

## Step 6 — Deliver the report

After interpreting results, always output this structured summary:

```
═══════════════════════════════════════════════
  LIVE SESSION AUDIT — [URL] — [timestamp]
═══════════════════════════════════════════════

PHASE 1 · SSR HYDRATION
  Status : ✅ Clean  |  ❌ [N] issue(s) found

  [If issues:]
  Issue 1 · Component: [name]
            Cause    : [root cause from table above]
            Fix      : [specific fix for their code]

PHASE 2 · CONSENT & TRACKING
  Status : ✅ Compliant  |  ❌ [N] violation(s)

  Violations (fired BEFORE consent):
    🔴  [Vendor name] — [URL pattern that triggered it]

  Compliant (fired AFTER consent):
    🟢  [Vendor name]

  No consent mechanism detected: [yes / no]

NEXT STEPS (priority order)
  1. [Most severe fix first]
  2. ...
═══════════════════════════════════════════════
```

---

## CI integration

Once the app is clean, suggest adding this to their CI pipeline:

```yaml
# .github/workflows/live-audit.yml
- name: Start dev server
  run: npm run dev &
- name: Wait for server
  run: npx wait-on http://localhost:3000
- name: Run live session audit
  run: node live-audit.mjs
```

The `1` exit code on failure will block PRs automatically.

---

## Edge cases

| Situation | Action |
|---|---|
| App requires login to reach audit target | Ask user for a public route, or offer to add `storageState` cookie injection |
| Playwright browser crashes | Try `headless: false` to diagnose; check if app throws uncaught errors on load |
| Timeout on `networkidle` | App may have long-polling or WebSocket — add `timeout: 30000` to `waitForLoadState` |
| SPA with no SSR (Vite, CRA) | Skip Phase 1, explain hydration only applies to SSR. Run Phase 2 only. |
| Nuxt 3 hydration errors look different | Use `[nuxt] [warn] Hydration mismatch` pattern — already in the script |
| User is on Windows | Script uses ES modules — Node 18+ required. Check with `node --version` |
| Consent button not found | Log a warning but continue; report "consent UI not detected" in output |
