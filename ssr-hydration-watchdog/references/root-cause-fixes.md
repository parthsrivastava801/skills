# Root Cause Fixes — SSR Hydration Watchdog

When the hydration-check script finds a mismatch, match the error text to a
row in this table to identify the root cause and exact fix.

---

## Error pattern lookup

### 1. localStorage / sessionStorage

**Error text contains:** `localStorage`, `sessionStorage`, `getItem`, `setItem`

**What's happening:** Code reads from browser storage during the very first
render. The server has no localStorage — it produces one value (usually empty
or undefined). The browser has the stored value. The two renders disagree.

**Fix:**
```tsx
// ❌ Wrong — runs on server too
const name = localStorage.getItem('userName');

// ✅ Correct — only runs after mount, server renders neutral default
const [name, setName] = useState('');
useEffect(() => {
  setName(localStorage.getItem('userName') ?? '');
}, []);
```

**Next.js App Router alternative:** Mark the component as a Client Component
with `'use client'` and wrap it in a parent Server Component that passes the
initial value as a prop from a cookie (readable server-side).

---

### 2. window / document / navigator

**Error text contains:** `window`, `document`, `navigator`, `screen`

**What's happening:** The server doesn't have a browser window. Any code that
reads `window.innerWidth`, `document.title`, `navigator.userAgent`, etc. during
render will produce `undefined` on the server and a real value in the browser.

**Fix:**
```tsx
// ❌ Wrong
const width = window.innerWidth;

// ✅ Correct — guard with typeof check
const width = typeof window !== 'undefined' ? window.innerWidth : 0;

// ✅ Better — move into useEffect
const [width, setWidth] = useState(0);
useEffect(() => { setWidth(window.innerWidth); }, []);
```

**Next.js specific:** Use `next/dynamic` with `{ ssr: false }` to skip
server rendering entirely for components that fundamentally need the browser:
```tsx
const BrowserOnlyChart = dynamic(() => import('./Chart'), { ssr: false });
```

---

### 3. new Date() / Date.now()

**Error text contains:** content mismatch in a timestamp, date, or time element

**What's happening:** The server renders the date at request time. The browser
renders it at hydration time (milliseconds to seconds later). Even a 1ms
difference causes a mismatch. `toLocaleString()` can also differ between
the server's Node.js locale and the browser's locale settings.

**Fix:**
```tsx
// ❌ Wrong — different value each time
const now = new Date().toISOString();

// ✅ Option 1 — generate server-side and pass as prop
// In Next.js page/layout:
export default function Page() {
  const now = new Date().toISOString(); // runs once on server
  return <TimeDisplay timestamp={now} />;
}

// ✅ Option 2 — render after mount only
const [time, setTime] = useState('');
useEffect(() => { setTime(new Date().toISOString()); }, []);
```

---

### 4. Math.random() / crypto.randomUUID()

**Error text contains:** mismatch in a key, id, or value attribute; element
keys that look like UUIDs or random numbers

**What's happening:** Random values generated during render will be different
on the server and client — guaranteed. This also breaks React's reconciliation
if used as element keys.

**Fix:**
```tsx
// ❌ Wrong
const id = Math.random().toString(36);
const items = data.map(item => <div key={Math.random()}>{item}</div>);

// ✅ Correct — stable IDs from data, or generated once after mount
const [id] = useState(() =>
  typeof crypto !== 'undefined' ? crypto.randomUUID() : ''
);
useEffect(() => {
  if (!id) setId(crypto.randomUUID());
}, []);

// For lists, always key on stable data properties
const items = data.map(item => <div key={item.id}>{item.name}</div>);
```

---

### 5. useSearchParams() without Suspense (Next.js App Router)

**Error text contains:** `useSearchParams`, `Suspense`, `missing Suspense boundary`

**What's happening:** Next.js requires `useSearchParams()` to be wrapped in a
`<Suspense>` boundary because the search params are not available during static
server rendering. Without the boundary, Next.js opts the whole page out of
static generation and triggers a hydration error.

**Fix:**
```tsx
// ❌ Wrong — no Suspense boundary
export default function Page() {
  const params = useSearchParams();
  return <div>{params.get('q')}</div>;
}

// ✅ Correct — wrap the component that uses useSearchParams
function SearchResults() {
  const params = useSearchParams();
  return <div>{params.get('q')}</div>;
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SearchResults />
    </Suspense>
  );
}
```

---

### 6. Conditional render based on typeof window

**Error text:** No console error, but DOM diff exists. Verbose output shows
different element trees between server and client.

**What's happening:** Code renders different JSX depending on whether `window`
exists. The server always takes the `typeof window === 'undefined'` branch.
The browser always takes the other branch. No error is logged because the
mismatch is intentional — but it still causes a visual flash.

**Fix:**
```tsx
// ❌ Wrong — server and client render completely different trees
if (typeof window === 'undefined') {
  return <ServerPlaceholder />;
}
return <BrowserComponent />;

// ✅ Correct — use a mounted state so both renders start the same
const [mounted, setMounted] = useState(false);
useEffect(() => { setMounted(true); }, []);

if (!mounted) return <Placeholder />; // both server and client render this first
return <BrowserComponent />;          // client upgrades after mount
```

---

### 7. suppressHydrationWarning found

**Error text:** Not an error — the script flags this proactively.

**What's happening:** `suppressHydrationWarning={true}` on an element tells
React to silently ignore any mismatch on that element's children. This is
sometimes legitimate (e.g., a timestamp that intentionally differs), but is
frequently used to hide a real mismatch that should be fixed instead.

**Action:** Review every instance. If the mismatch is intentional and harmless
(e.g., a relative time like "2 minutes ago"), the suppress is fine — add a
comment explaining why. If it's hiding a real content difference, fix the
underlying cause using one of the patterns above.

---

### 8. Silent mismatch — browser extension

**Error text:** No console error. DOM diff exists. `VERBOSE=1` output shows
changes in elements outside your app's root (e.g., in `<head>` or as extra
`<div>` wrappers around your app root).

**What's happening:** A browser extension (ad blocker, password manager, 
translation tool, accessibility tool) modified the DOM after the page loaded.
This is not a bug in your code.

**Action:** Re-run with `HEADLESS=false` in an Incognito/Private window to
confirm. If the diff disappears, it's an extension — not a real issue. Add a
note to your team's dev docs that this false positive can occur.

---

### 9. Nuxt 3 hydration mismatches

Nuxt 3 logs hydration errors differently from React. The patterns the script
listens for:

- `[nuxt] [warn] Hydration mismatch` — general mismatch
- `Hydration children mismatch` — server had child elements, client didn't
- `Hydration node mismatch` — element type differs between server and client
- `Hydration text mismatch` — text content differs
- `Hydration attribute mismatch` — attribute value differs

All the root causes above apply equally to Nuxt 3. The fixes are Vue-flavoured
equivalents:

```vue
<!-- ❌ Wrong in Nuxt -->
<template>
  <div>{{ $nuxt.isClient ? window.innerWidth : '' }}</div>
</template>

<!-- ✅ Correct — use ClientOnly built-in -->
<template>
  <ClientOnly>
    <div>{{ windowWidth }}</div>
  </ClientOnly>
</template>
```

Nuxt's built-in `<ClientOnly>` component is the idiomatic fix for any component
that needs browser-only APIs.

---

### 10. SvelteKit hydration mismatches

SvelteKit mismatches are rarer because Svelte's reactivity model handles most
browser-vs-server differences automatically. When they do occur:

- **`onMount`** is the correct place for browser-only code (equivalent of `useEffect`)
- **`browser`** from `'$app/environment'` replaces `typeof window !== 'undefined'`

```svelte
<!-- ❌ Wrong -->
<script>
  const width = window.innerWidth;
</script>

<!-- ✅ Correct -->
<script>
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';

  let width = 0;
  onMount(() => { width = window.innerWidth; });
</script>
```

---

## Quick decision tree

```
Error in console?
├── Yes → match text to sections 1–5 above
│         → apply the exact fix shown
└── No  → run with VERBOSE=1
          ├── Diff is in <head> or outside app root → section 8 (extension)
          ├── Diff shows two different component trees → section 6 (typeof window)
          └── suppressHydrationWarning present → section 7 (review each instance)
```
