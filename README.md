# Amit Kathuria

A personal blog and website built by Amit Kathuria.

[amitkathuria.com](https://amitkathuria.com)

## Publishing Flow

Posts are pulled from Mastodon and published as flat HTML pages.

- Source account: `https://mastodon.social/@amitkathuria`
- Local post URLs: flat status-id pages like `/116307055352835030.html`
- Static pages are built from `pages/*.md`
- Replies and boosts are excluded by fetching Mastodon's public statuses API with `exclude_replies=true` and `exclude_reblogs=true`
- Media attachments are cached locally during builds and served from the generated site

The build keeps a local Mastodon status cache in `.cache/`.

- Normal builds reuse the cached Mastodon statuses for up to 24 hours.
- Set `MASTODON_FORCE_REFRESH=1` to force a live refresh.
- If Mastodon is temporarily unavailable, the build falls back to the last successful cached response.

GitHub Actions runs the refresh/deploy check every day at true `3:00 AM` Eastern using a DST-aware schedule.
Scheduled runs force a live Mastodon refresh before hashing and deployment checks, while other builds continue to use the 24-hour status cache.
If the generated site is unchanged, the workflow stays green and skips Pages deployment.

## Local Development

```bash
# Build the site
bun build.ts

# Serve locally (opens in browser)
bun serve.ts

# Force a fresh Mastodon fetch
MASTODON_FORCE_REFRESH=1 bun build.ts
```

---
