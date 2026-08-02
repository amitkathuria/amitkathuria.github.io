# Copilot Instructions

## Build, test, and lint commands

```bash
# Install dependencies
bun install --frozen-lockfile

# Build the static site into ./_site
bun build.ts

# Build with a forced live Mastodon refresh (no stale-cache fallback on failure)
MASTODON_FORCE_REFRESH=1 bun build.ts

# Serve the generated site locally at http://localhost:3456
bun serve.ts
```

This repository currently has no dedicated test or lint scripts/configuration.

Copilot cloud agent setup lives in `.github/workflows/copilot-setup-steps.yml` and preinstalls Playwright (Chromium) runtime for browser automation tasks.

## High-level architecture

- `build.ts` is the single static-site build pipeline. It fetches Mastodon statuses, normalizes them into internal `Post` objects, renders HTML pages, and writes all output to `_site/`.
- Post content source is Mastodon (`/api/v1/accounts/.../statuses`) filtered to public, non-reply, non-reblog statuses. Post pages are generated as flat files named by status ID (for example, `116307055352835030.html`).
- Mastodon API data and downloaded media are cached under `.cache/`:
  - `mastodon-statuses.json` + `mastodon-statuses.meta.json` for status payloads with a 24-hour TTL.
  - `.cache/mastodon-media/` for media files, which are emitted to `_site/media/` during build.
- The build creates:
  - Per-post pages (`/<status-id>.html`)
  - Paginated home pages (`index.html`, `page-N.html`, 10 posts per page)
  - Paginated archive pages (`archive.html`, `archive-N.html`)
  - RSS feed (`feed.xml`)
  - Markdown pages from `pages/*.md` (for example `pages/about.md` -> `about.html`)
- `serve.ts` is a simple Bun static server that serves files from `_site` during local development.
- GitHub Actions deployment (`.github/workflows/deploy.yml`) always builds for push/manual/schedule events, but only deploys Pages when the generated `_site` hash changes. Scheduled runs force live Mastodon refresh and are gated to run at true 3 AM America/New_York.

## Key conventions for this codebase

- Keep this site as a **single-script generator** centered in `build.ts`; shared behavior is implemented as local helpers rather than split frameworks.
- Treat post HTML as untrusted input: sanitize with `sanitizePostHtml` and escape attributes/text with `escapeHtml` when rendering interpolated values.
- Preserve media-localization behavior: prefer cached/downloaded media rewritten to `/media/...`; only fall back to remote URLs if caching fails.
- `pages/*.md` frontmatter uses a minimal parser (`key: value` lines between `---` blocks). Avoid nested YAML structures or complex frontmatter syntax.
- Canonical URL resolution depends on `CNAME` when present; otherwise default site URL is `https://amitkathuria.github.io`. Keep this behavior intact when changing URL logic.
