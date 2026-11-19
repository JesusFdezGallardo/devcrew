# React (Vite): Sentry setup

Verified with Vite 8, React 19, TypeScript, `@sentry/react` **11.14.0**, `@sentry/vite-plugin` **11.14.0** and
Vitest (latest when this was written: check for a newer version and use it if it is still compatible). Use the
package manager the project already uses (look for `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`).

## 1. Install

```bash
npm install @sentry/react
npm install -D @sentry/vite-plugin vitest
```

Skip `vitest` if the project already has a test runner; then write the test in that runner's style. If there is no
`test` script, add `"test": "vitest run"`.

## 2. Masking function

`src/sentry/maskSensitive.ts`: pure functions. The five rules run **in this order**, and the order matters (a JWT
inside a `Bearer` header becomes `Bearer [jwt]`; an IBAN is masked before the card-like rule can see its digits).

The card-like rule also masks other long digit runs, such as numeric ids and epoch-millisecond timestamps. That is
on purpose (privacy over readability): do not narrow it.

`maskEvent` and `maskBreadcrumb` apply the rules to everything free-form an event carries: the message, exception
values, the string values of `event.extra`, and each breadcrumb's message and string `data` values. Their parameter
types are structural, so they accept the SDK's event and breadcrumb types without importing them.

```ts
// Masks personal data in free text before it leaves the browser for Sentry.
// The rules run in a fixed order: an earlier rule can change what a later one sees.
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, '[iban]'],
  [/\b(?:\d[ -]?){12,18}\d\b/g, '[number]'],
]

export function maskSensitive(text: string): string {
  if (!text) return text
  return RULES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text)
}

type MaskableBreadcrumb = { message?: string; data?: Record<string, unknown> }
type MaskableEvent = {
  message?: string
  exception?: { values?: Array<{ value?: string }> }
  extra?: Record<string, unknown>
  breadcrumbs?: MaskableBreadcrumb[]
}

// Masks the string values of an object in place; other values are left as they are.
function maskStringValues(values: Record<string, unknown> | undefined): void {
  if (!values) return
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') values[key] = maskSensitive(value)
  }
}

export function maskBreadcrumb<T extends MaskableBreadcrumb>(breadcrumb: T): T {
  if (breadcrumb.message) breadcrumb.message = maskSensitive(breadcrumb.message)
  maskStringValues(breadcrumb.data)
  return breadcrumb
}

export function maskEvent<T extends MaskableEvent>(event: T): T {
  if (event.message) event.message = maskSensitive(event.message)
  event.exception?.values?.forEach((exception) => {
    if (exception.value) exception.value = maskSensitive(exception.value)
  })
  maskStringValues(event.extra)
  event.breadcrumbs?.forEach(maskBreadcrumb)
  return event
}
```

## 3. Init

`src/sentry/initSentry.ts`. With an empty `VITE_SENTRY_DSN` the SDK stays disabled: nothing is sent in local
development, tests or builds without network. The data region (EU) is decided by the DSN host
(`ingest.de.sentry.io`), not by an option.

```ts
import * as Sentry from '@sentry/react'
import { maskBreadcrumb, maskEvent } from './maskSensitive'

export function initSentry(): void {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN || undefined,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE,
    // VITE_VERCEL_GIT_COMMIT_SHA is exposed to Vite builds by Vercel; elsewhere CI sets VITE_SENTRY_RELEASE.
    release: import.meta.env.VITE_SENTRY_RELEASE || import.meta.env.VITE_VERCEL_GIT_COMMIT_SHA || undefined,
    // @sentry/react 11 replaced sendDefaultPii with dataCollection. Everything personal stays off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    tracesSampleRate: 0.1,
    beforeSend: (event) => maskEvent(event),
    beforeBreadcrumb: (breadcrumb) => maskBreadcrumb(breadcrumb),
  })
}
```

**Version note:** in `@sentry/react` 11 the option `sendDefaultPii` no longer exists (TypeScript rejects it) and
`dataCollection` replaces it. If the project is pinned to `@sentry/react` 10 or older, use `sendDefaultPii: false`
instead of the `dataCollection` block. The project rule is the same either way: no default personal data.

## 4. Entry file and error boundary

In the entry file (`src/main.tsx`), call `initSentry()` before rendering and wrap the root in
`Sentry.ErrorBoundary`. Keep the existing providers and router inside the boundary; change only what is needed:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'
import { initSentry } from './sentry/initSentry'

initSentry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p>Something went wrong.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
```

If the project already has an error boundary, wrap it or report to Sentry from its `componentDidCatch` instead of
adding a second one, and show the user the change.

## 5. Vite config: source maps and release

Edit `vite.config.ts` (or `.js`/`.mts`) without removing existing plugins or options. The plugin is added **only
when `SENTRY_AUTH_TOKEN` is set** (CI), so local builds and builds without network never contact Sentry. Maps are
emitted as hidden and deleted from `dist` after upload, so they are never served.

```ts
import { sentryVitePlugin } from '@sentry/vite-plugin'

// Source maps are uploaded only in CI, where SENTRY_AUTH_TOKEN is set. Locally the plugin is not added.
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN)

// inside defineConfig({ ... }):
//   plugins: [
//     react(),
//     ...(uploadSourceMaps
//       ? [
//           sentryVitePlugin({
//             org: process.env.SENTRY_ORG,
//             project: process.env.SENTRY_PROJECT,
//             authToken: process.env.SENTRY_AUTH_TOKEN,
//             // EU data region. Override with SENTRY_URL for another region.
//             url: process.env.SENTRY_URL ?? 'https://de.sentry.io',
//             release: { name: process.env.VITE_SENTRY_RELEASE || process.env.VITE_VERCEL_GIT_COMMIT_SHA },
//             sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
//             telemetry: false,
//           }),
//         ]
//       : []),
//   ],
//   build: {
//     // 'hidden' emits .map files without a sourceMappingURL comment in the bundles.
//     sourcemap: uploadSourceMaps ? 'hidden' : false,
//   },
```

The release is read from `VITE_SENTRY_RELEASE`, falling back to `VITE_VERCEL_GIT_COMMIT_SHA` (which Vercel exposes
to Vite builds), both by the app (`initSentry`) and by the plugin, so the uploaded maps and the runtime events carry
the same release. On Vercel nothing has to be mapped by hand. If the config already sets `build.sourcemap`, keep the
existing value when the token is absent.

GitHub Actions (only if a workflow already builds the frontend): add the release and the secret to the build step
and show it to the user; do not create a workflow:

```yaml
env:
  VITE_SENTRY_RELEASE: ${{ github.sha }}
  SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
  SENTRY_ORG: <org-slug>
  SENTRY_PROJECT: <project-slug>
```

If the secret does not exist, the variable is empty, `uploadSourceMaps` is false and the build still passes.

## 6. Tests (Vitest)

`src/sentry/maskSensitive.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { maskBreadcrumb, maskEvent, maskSensitive } from './maskSensitive'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl'

describe('maskSensitive', () => {
  it('masks a JWT', () => {
    expect(maskSensitive(`token=${JWT} end`)).toBe('token=[jwt] end')
  })

  it('masks a bearer token', () => {
    expect(maskSensitive('Authorization: Bearer abc123.def-456_ghi')).toBe('Authorization: Bearer [token]')
  })

  it('masks a JWT inside a Bearer header with the JWT rule, which runs first', () => {
    // "[jwt]" does not match the Bearer rule afterwards.
    expect(maskSensitive(`Authorization: Bearer ${JWT}`)).toBe('Authorization: Bearer [jwt]')
  })

  it('masks an email', () => {
    expect(maskSensitive('user jane.doe+tag@example.co.uk failed')).toBe('user [email] failed')
  })

  it('masks an IBAN with and without spaces', () => {
    expect(maskSensitive('to ES9121000418450200051332')).toBe('to [iban]')
    expect(maskSensitive('to DE89 3704 0044 0532 0130 00')).toBe('to [iban]')
  })

  it('runs the IBAN rule before the card rule', () => {
    // The spaced digit groups of this IBAN also match the card rule: in the wrong order the result
    // would be 'DE89 [number]'.
    expect(maskSensitive('DE89 3704 0044 0532 0130 00')).toBe('[iban]')
  })

  it('masks card-like numbers', () => {
    expect(maskSensitive('card 4111 1111 1111 1111')).toBe('card [number]')
    expect(maskSensitive('card 4111-1111-1111-1111')).toBe('card [number]')
    expect(maskSensitive('card 4111111111111111')).toBe('card [number]')
  })

  it('masks every occurrence', () => {
    expect(maskSensitive('a@b.io and c@d.io')).toBe('[email] and [email]')
  })

  it('leaves short numbers and plain text alone', () => {
    expect(maskSensitive('order 12345 in 2026')).toBe('order 12345 in 2026')
  })

  it('handles an empty string', () => {
    expect(maskSensitive('')).toBe('')
  })
})

describe('maskEvent and maskBreadcrumb', () => {
  it('masks the message, exception values, extra strings and breadcrumbs of an event', () => {
    const event = maskEvent({
      message: 'login failed for jane@example.com',
      exception: { values: [{ value: 'bad iban ES9121000418450200051332' }] },
      extra: { account: 'DE89 3704 0044 0532 0130 00', attempts: 3 },
      breadcrumbs: [{ message: 'card 4111 1111 1111 1111', data: { url: '/users?email=jane@example.com', status: 200 } }],
    })
    expect(event.message).toBe('login failed for [email]')
    expect(event.exception?.values?.[0].value).toBe('bad iban [iban]')
    expect(event.extra).toEqual({ account: '[iban]', attempts: 3 })
    expect(event.breadcrumbs?.[0]).toEqual({ message: 'card [number]', data: { url: '/users?email=[email]', status: 200 } })
  })

  it('masks a breadcrumb message and its string data values', () => {
    const breadcrumb = maskBreadcrumb({ message: 'Authorization: Bearer abc123', data: { to: 'jane@example.com', n: 1 } })
    expect(breadcrumb).toEqual({ message: 'Authorization: Bearer [token]', data: { to: '[email]', n: 1 } })
  })

  it('accepts events without optional parts', () => {
    expect(maskEvent({})).toEqual({})
    expect(maskBreadcrumb({})).toEqual({})
  })
})
```

## 7. `.env.example` names

`VITE_SENTRY_DSN=`, `VITE_SENTRY_ENVIRONMENT=`, `VITE_SENTRY_RELEASE=`. `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
`SENTRY_PROJECT` are CI-only: list them in `.env.example` only as a comment (`# CI only: SENTRY_AUTH_TOKEN`), never
as a variable to fill in locally.
