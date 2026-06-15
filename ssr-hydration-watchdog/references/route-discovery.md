# Route Discovery — SSR Hydration Watchdog

Used in full-scan mode to convert filesystem paths to URL routes.
Claude reads this file during Step 2 of the workflow.

---

## Next.js (App Router — `app/` directory)

**Find route files:**
```bash
find app -name "page.tsx" -o -name "page.jsx" -o -name "page.js" | sort
```

**Convert path → URL:**
- Strip `app/` prefix
- Strip trailing `/page.tsx` (or .jsx, .js)
- Strip route group folders: `(auth)/login` → `/login`
- Replace dynamic segments: `[id]` → `_test`, `[...slug]` → `_test`
- Root `app/page.tsx` → `/`

**Example:**
```
app/page.tsx                         → /
app/login/page.tsx                   → /login
app/(auth)/dashboard/page.tsx        → /dashboard
app/posts/[id]/page.tsx              → /posts/_test
app/blog/[...slug]/page.tsx          → /blog/_test
```

---

## Next.js (Pages Router — `pages/` directory)

**Find route files:**
```bash
find pages -name "*.tsx" -o -name "*.jsx" -o -name "*.js" | \
  grep -v "_app\|_document\|_error\|api/" | sort
```

**Convert path → URL:**
- Strip `pages/` prefix
- Strip file extension
- Replace `index` with `/`
- Replace dynamic segments: `[id]` → `_test`

**Example:**
```
pages/index.tsx                      → /
pages/login.tsx                      → /login
pages/dashboard/index.tsx            → /dashboard
pages/posts/[id].tsx                 → /posts/_test
```

---

## Nuxt 3 (`pages/` directory)

**Find route files:**
```bash
find pages -name "*.vue" | sort
```

**Convert path → URL:**
- Strip `pages/` prefix
- Strip `.vue` extension
- Replace `index` with `/` at any level
- Replace dynamic segments: `[id].vue` → `_test`, `[...slug].vue` → `_test`

**Example:**
```
pages/index.vue                      → /
pages/login.vue                      → /login
pages/posts/[id].vue                 → /posts/_test
pages/blog/index.vue                 → /blog
```

---

## Remix (`app/routes/` directory)

**Find route files:**
```bash
find app/routes -name "*.tsx" -o -name "*.jsx" | sort
```

**Convert path → URL (Remix v2 flat routes):**
- Strip `app/routes/` prefix
- Strip extension
- Replace `.` with `/` (flat route convention)
- Replace `_index` with `/`
- Replace dynamic segments: `$id` → `_test`
- Strip layout prefixes: `_auth.login` → `/login`

**Example:**
```
app/routes/_index.tsx                → /
app/routes/login.tsx                 → /login
app/routes/posts.$id.tsx             → /posts/_test
app/routes/_auth.dashboard.tsx       → /dashboard
```

---

## SvelteKit (`src/routes/` directory)

**Find route files:**
```bash
find src/routes -name "+page.svelte" | sort
```

**Convert path → URL:**
- Strip `src/routes/` prefix
- Strip `/+page.svelte`
- Strip layout groups: `(app)/dashboard` → `/dashboard`
- Replace dynamic segments: `[id]` → `_test`, `[...rest]` → `_test`
- Root → `/`

**Example:**
```
src/routes/+page.svelte              → /
src/routes/login/+page.svelte        → /login
src/routes/(app)/dashboard/+page.svelte → /dashboard
src/routes/posts/[id]/+page.svelte   → /posts/_test
```

---

## Deduplication and cap

After building the route list:
1. Deduplicate (dynamic routes with the same `_test` substitution collapse)
2. Sort alphabetically
3. If count exceeds 30, ask the user:
   - "I found N routes. Scan all of them, or filter to a specific directory?"
   - Offer to scan only a subdirectory (e.g. only `/dashboard/...`)

## Routes to always skip

Regardless of framework, skip:
- `/_next/*`, `/__nuxt/*`, `/__sveltekit/*` (framework internals)
- `/api/*` (API routes — no HTML to hydrate)
- `*.map` files
- Any path containing `_error`, `404`, `500` (error pages — render differently by design)

## Routes that need real data

Dynamic routes substituted with `_test` will return 404 if the server can't
find an entity with that ID. In the report, note which routes used substituted
IDs and suggest the user re-run with `CONFIG.routes` overridden to include
real IDs for accurate results on those routes.
