# Amit Kathuria

A personal blog and website built by Amit Kathuria.

[amitkathuria.com](https://amitkathuria.com)

## Publishing Flow

The site is a native Jekyll site, built and deployed automatically by
GitHub Pages on every push to `main` — no local build step or CI workflow
required.

- Posts live in `_posts/`, named `YYYY-MM-DD-HHMM.md` (no title required).
- Post URLs are `/YYYY-MM-DD-HHMM.html` (see `permalink` in `_config.yml`).
- `about.html`, `archive.html`, and `index.html` are the site's static pages.
- `_layouts/default.html` and `_layouts/post.html` hold the page templates.

## Local Development

There's no required local build step — GitHub Pages builds the site on
push. To preview locally, install Jekyll and run:

```bash
bundle exec jekyll serve
```
