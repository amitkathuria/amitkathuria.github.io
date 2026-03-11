# Amit's Blog

A minimal static blog built by Amit.

## Structure

```
blog/
├── posts/          # Markdown files (frontmatter: title, date)
├── _site/          # Generated HTML output
├── build.ts        # The ~150 line static site generator
└── serve.ts        # Local dev server
```

## Usage

```bash
# Build the site
bun build.ts

# Serve locally (opens in browser)
bun serve.ts

# Or just open the HTML directly
open _site/index.html
```

## Writing Posts

Create a markdown file in `posts/` with frontmatter:

```markdown
---
title: Your Post Title
date: January 29, 2026
---

Your content here...
```

Then run `bun build.ts` to regenerate.

## Philosophy

No frameworks. No config files. No build tools beyond Bun itself.

Just markdown -> HTML with a dark theme that's easy on the eyes.

---

