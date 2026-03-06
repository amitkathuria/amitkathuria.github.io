#!/usr/bin/env bun
/**
 * Amit's Blog Builder
 * A minimal static site generator for Amit's musings.
 * 
 * Usage: bun build.ts
 */

import { readdir, readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { join, basename, relative, dirname } from 'path';
import { marked } from 'marked';
import { existsSync } from 'fs';

const POSTS_DIR = './posts';
const PAGES_DIR = './pages';
const OUTPUT_DIR = './_site';
const CNAME_FILE = './CNAME';
const DEFAULT_SITE_URL = 'https://amitkathuria.github.io';
const SITE_DESCRIPTION = 'A personal blog where I share thoughts and reflections on technology, philosophy, art, and everyday life.';

interface Post {
  slug: string;
  date: string;
  displayDate: string;
  datetime: string;
  sortTime: number;
  blurb: string;
  content: string;
  html: string;
}

function formatDateDisplay(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

function parseDateFromMetaOrPath(metaDate: string | undefined, relativePostPath: string): Date | null {
  if (metaDate) {
    const parsed = new Date(metaDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const pathMatch = relativePostPath.match(/^(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!pathMatch) return null;

  const year = parseInt(pathMatch[1], 10);
  const month = parseInt(pathMatch[2], 10) - 1;
  const day = parseInt(pathMatch[3], 10);

  // Use noon UTC to avoid timezone edge cases around midnight.
  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&hellip;/g, '...');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildArchiveSummary(post: Post, baseMaxLength = 88): string {
  const source = decodeHtmlEntities(post.blurb || plainTextFromHtml(post.html))
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // Best-effort match for microblog summaries: entries that start with
  // a lead-in clause (often ending with ':') are clipped a bit sooner.
  const maxLength = source.includes(':') ? baseMaxLength : baseMaxLength + 13;
  if (source.length <= maxLength) return source;

  // Trim near the target length at a word boundary for a natural microblog-style summary.
  const candidate = source.slice(0, maxLength + 1);
  const lastSpaceIndex = candidate.lastIndexOf(' ');
  let truncated = lastSpaceIndex > maxLength * 0.6
    ? candidate.slice(0, lastSpaceIndex)
    : source.slice(0, maxLength);

  if (!source.includes(':')) {
    truncated = truncated.replace(/, a\s+\S+$/, ', a');
  }

  return `${truncated.trimEnd()} ...`;
}

function getRootPathFromSlug(slug: string): string {
  const depth = slug.split('/').length - 1;
  return depth === 0 ? '.' : new Array(depth).fill('..').join('/');
}

async function getMarkdownFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await getMarkdownFilesRecursive(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeSiteUrl(urlOrHost: string): string {
  const trimmed = urlOrHost.trim().replace(/\/$/, '');
  if (!trimmed) return DEFAULT_SITE_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function resolveSiteUrl(): Promise<string> {
  if (!existsSync(CNAME_FILE)) return DEFAULT_SITE_URL;

  const cnameValue = (await readFile(CNAME_FILE, 'utf-8')).trim();
  return normalizeSiteUrl(cnameValue);
}

// Simple frontmatter parser
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  
  const meta: Record<string, string> = {};
  match[1].split('\n').forEach(line => {
    const [key, ...val] = line.split(':');
    if (key && val.length) meta[key.trim()] = val.join(':').trim();
  });
  
  return { meta, body: match[2] };
}

// HTML template
const template = (
  title: string,
  content: string,
  siteUrl: string,
  isIndex = false,
  blurb = '',
  image = '',
  canonicalPath = '/',
  rootPath = '.',
  showBackToPostsLink = true
) => {
  const siteTitle = "Amit Kathuria";
  const fullTitle = isIndex ? siteTitle : `${title} - ${siteTitle}`;
  const description = blurb || SITE_DESCRIPTION;
  const shareImage = image || `${siteUrl}/share.png`;
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="${rootPath}/favicon.png">
  <title>${fullTitle}</title>
  <meta name="description" content="${description}">
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="${fullTitle}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${shareImage}">
  <meta property="og:url" content="${siteUrl}${canonicalPath}">
  <meta property="og:site_name" content="${siteTitle}">
  
  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${fullTitle}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${shareImage}">
  
  <link rel="alternate" type="application/rss+xml" title="${siteTitle} RSS" href="${rootPath}/feed.xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Abril+Fatface&family=PT+Sans:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --sidebar-bg: #202020;
      --sidebar-fg: rgba(255, 255, 255, 0.72);
      --sidebar-link: #ffffff;
      --text: #515151;
      --heading: #313131;
      --accent: #268bd2;
      --quote: #7a7a7a;
      --quote-border: #e5e5e5;
      --soft-bg: #f9f9f9;
      --rule: #e5e5e5;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
    }

    html {
      font-family: "PT Sans", Helvetica, Arial, sans-serif;
      font-size: 16px;
      line-height: 1.5;
    }

    @media (min-width: 38em) {
      html {
        font-size: 20px;
      }
    }

    @media (min-width: 48em) {
      html {
        font-size: 16px;
      }
    }

    @media (min-width: 58em) {
      html {
        font-size: 20px;
      }
    }

    body {
      color: var(--text);
      background: #ffffff;
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
    }

    a {
      color: var(--accent);
      text-decoration: none;
    }

    a:hover,
    a:focus {
      text-decoration: underline;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      margin-bottom: 0.5rem;
      font-weight: 700;
      line-height: 1.25;
      color: var(--heading);
      text-rendering: optimizeLegibility;
    }

    h1 {
      font-size: 2rem;
    }

    h2 {
      margin-top: 1rem;
      font-size: 1.5rem;
    }

    h3 {
      margin-top: 1.5rem;
      font-size: 1.25rem;
    }

    p,
    ul,
    ol,
    dl {
      margin-top: 0;
      margin-bottom: 1rem;
    }

    strong {
      color: #303030;
    }

    hr {
      margin: 1.5rem 0;
      border: 0;
      border-top: 1px solid #eee;
    }

    code,
    pre {
      font-family: Menlo, Monaco, "Courier New", monospace;
    }

    code {
      padding: 0.25em 0.5em;
      font-size: 85%;
      color: #bf616a;
      background: var(--soft-bg);
      border-radius: 3px;
    }

    pre {
      display: block;
      margin-top: 0;
      margin-bottom: 1rem;
      padding: 1rem;
      font-size: 0.8rem;
      line-height: 1.4;
      overflow-x: auto;
      background: var(--soft-bg);
      border-radius: 4px;
    }

    pre code {
      padding: 0;
      color: inherit;
      background: transparent;
    }

    blockquote {
      padding: 0.5rem 1rem;
      margin: 0.8rem 0;
      color: var(--quote);
      border-left: 0.25rem solid var(--quote-border);
    }

    blockquote p:last-child {
      margin-bottom: 0;
    }

    img,
    video {
      display: block;
      max-width: 100%;
      height: auto;
      margin: 0 0 1rem;
      border-radius: 5px;
    }

    .sidebar {
      text-align: center;
      padding: 2rem 1rem;
      color: var(--sidebar-fg);
      background: var(--sidebar-bg);
    }

    @media (min-width: 48em) {
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 18rem;
        text-align: left;
      }
    }

    .sidebar a {
      color: var(--sidebar-link);
    }

    .sidebar-about h1 {
      margin-top: 0;
      color: #ffffff;
      font-family: "Abril Fatface", serif;
      font-size: 3.25rem;
      line-height: 1.05;
    }

    .sidebar-about p {
      font-size: 0.95rem;
    }

    .sidebar-nav {
      margin-bottom: 1rem;
    }

    .sidebar-nav-item {
      display: block;
      line-height: 1.75;
    }

    @media (min-width: 48em) {
      .sidebar-sticky {
        position: absolute;
        right: 1rem;
        bottom: 1rem;
        left: 1rem;
      }
    }

    .content {
      padding-top: 2rem;
      padding-bottom: 4rem;
      padding-left: 1rem;
      padding-right: 1rem;
    }

    @media (min-width: 48em) {
      .content {
        max-width: 38rem;
        margin-left: 20rem;
        margin-right: 2rem;
        padding-top: 4rem;
      }
    }

    @media (min-width: 64em) {
      .content {
        margin-left: 22rem;
        margin-right: 4rem;
      }
    }

    article {
      margin: 0 0 2rem;
    }

    article .meta {
      margin-top: -0.25rem;
      margin-bottom: 1.25rem;
      color: #9a9a9a;
      font-size: 0.9rem;
    }

    .post-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .post-list li {
      margin: 0 0 1.75rem;
      padding: 0;
      background: transparent;
      border-radius: 0;
    }

    .post-list .date {
      margin: 0.35rem 0 0;
      color: #9a9a9a;
      font-size: 0.9rem;
    }

    .post-list .blurb {
      margin: 0.5rem 0 0;
      font-size: 0.95rem;
    }

    .post {
      margin: 0 0 2rem;
      padding: 0;
      border: 0;
    }

    .post-date {
      display: inline-block;
      margin: 0 0 0.6rem;
      color: #9a9a9a;
      font-size: 0.9rem;
    }

    .post-date time {
      color: inherit;
    }

    .post .e-content > :last-child {
      margin-bottom: 0;
    }

    .post.with-title h2 {
      margin: 0;
      font-size: 1.3rem;
    }

    .post.with-title .post-date {
      margin-top: 0.2rem;
    }

    .h-feed {
      margin-top: 1rem;
    }

    .h-feed .h-entry {
      margin: 0 0 0.8rem;
      font-size: 0.95rem;
      line-height: 1.55;
    }

    .h-feed .h-entry time {
      color: inherit;
    }

    .h-feed .p-summary {
      color: var(--text);
    }

    footer {
      margin-top: 2.5rem;
      padding-top: 1.2rem;
      border-top: 1px solid var(--rule);
      color: #9a9a9a;
      font-size: 0.85rem;
    }

    footer p {
      margin-bottom: 0.6rem;
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="sidebar-sticky">
      <div class="sidebar-about">
        <h1><a href="${rootPath}/">Amit Kathuria</a></h1>
        <p>${SITE_DESCRIPTION}</p>
      </div>
      <nav class="sidebar-nav">
        <a class="sidebar-nav-item" href="${rootPath}/about.html">About</a>
        <a class="sidebar-nav-item" href="${rootPath}/archive.html">Archive</a>
        <a class="sidebar-nav-item" href="${rootPath}/feed.xml">RSS</a>
      </nav>
    </div>
  </aside>
  <div class="content">
    <main>
      ${content}
    </main>
    <footer>
      ${!isIndex && showBackToPostsLink ? `<p><a href="${rootPath}/">← Back to all posts</a></p>` : ''}
      <p>Built with love and markdown · <a href="https://github.com/amitkathuria/amitkathuria.github.io">Source</a></p>
    </footer>
  </div>
</body>
</html>`;
}

// RSS feed generator
function generateRSS(posts: Post[], siteUrl: string): string {
  const now = new Date().toUTCString();
  const items = posts.map(p => `
    <item>
      <title><![CDATA[${p.displayDate}]]></title>
      <link>${siteUrl}/${p.slug}.html</link>
      <guid isPermaLink="true">${siteUrl}/${p.slug}.html</guid>
      <pubDate>${new Date(p.datetime).toUTCString()}</pubDate>
      <description><![CDATA[${p.blurb || p.html.slice(0, 500)}]]></description>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Amit Kathuria</title>
    <link>${siteUrl}</link>
    <description>${SITE_DESCRIPTION}</description>
    <language>en-us</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${siteUrl}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

async function build() {
  console.log('🐧 Building Amit\'s Blog...\n');
  const siteUrl = await resolveSiteUrl();
  
  // Ensure output dir exists
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }
  
  // Read all posts recursively so date-based folders are supported.
  const mdFiles = await getMarkdownFilesRecursive(POSTS_DIR);
  
  const posts: Post[] = [];
  
  for (const file of mdFiles) {
    const content = await readFile(file, 'utf-8');
    const { meta, body } = parseFrontmatter(content);
    const html = await marked(body);
    const relativePath = relative(POSTS_DIR, file).split('\\').join('/');
    const slug = relativePath.replace(/\.md$/, '');
    const parsedDate = parseDateFromMetaOrPath(meta.date, relativePath);
    const dateObj = parsedDate ?? new Date();
    const displayDate = formatDateDisplay(dateObj);
    const datetime = dateObj.toISOString();
    
    posts.push({
      slug,
      date: meta.date || displayDate,
      displayDate,
      datetime,
      sortTime: dateObj.getTime(),
      blurb: meta.blurb || '',
      content: body,
      html
    });
    
    // Write individual post page
    const postOutputPath = join(OUTPUT_DIR, `${slug}.html`);
    await mkdir(dirname(postOutputPath), { recursive: true });

    const postHtml = template(
      displayDate,
      `<article>
        <p class="post-date"><time class="dt-published" datetime="${datetime}">${displayDate}</time></p>
        ${html}
      </article>`,
      siteUrl,
      false,
      meta.blurb || '',
      '',
      `/${slug}.html`,
      getRootPathFromSlug(slug),
      false
    );
    
    await writeFile(postOutputPath, postHtml);
    console.log(`  ✓ ${slug}.html`);
  }
  
  // Sort by date (newest first)
  posts.sort((a, b) => b.sortTime - a.sortTime);
  
  // Build index
  const indexContent = `
    ${posts.map(p => `
        <div class="post h-entry">
          <a href="./${p.slug}.html" class="post-date u-url"><time class="dt-published" datetime="${p.datetime}">${p.displayDate}</time></a>
          <div class="e-content">${p.html}</div>
        </div>
      `).join('')}
    ${posts.length === 0 ? '<p>No posts yet. The blank page awaits...</p>' : ''}
  `;
  
  await writeFile(join(OUTPUT_DIR, 'index.html'), template('Home', indexContent, siteUrl, true, SITE_DESCRIPTION, '', '/'));
  console.log('  ✓ index.html');
  
  // Build archive page in microblog-style feed format.
  const archiveContent = `
    <div class="h-feed">
      ${posts.map(p => `
        <p class="h-entry">
          <a href="./${p.slug}.html" class="u-url"><time class="dt-published" datetime="${p.datetime}">${p.datetime.slice(0, 10)}</time></a>:
          <span class="p-summary">${escapeHtml(buildArchiveSummary(p))}</span>
        </p>
      `).join('')}
    </div>
  `;
  await writeFile(join(OUTPUT_DIR, 'archive.html'), template('Archive', archiveContent, siteUrl, true, '', '', '/archive.html'));
  console.log('  ✓ archive.html');
  
  // Generate RSS feed
  const rss = generateRSS(posts, siteUrl);
  await writeFile(join(OUTPUT_DIR, 'feed.xml'), rss);
  console.log('  ✓ feed.xml\n');
  
  // Process standalone pages (if pages/ exists)
  let pageCount = 0;
  if (existsSync(PAGES_DIR)) {
    const pageFiles = (await readdir(PAGES_DIR)).filter(f => f.endsWith('.md'));
    for (const file of pageFiles) {
      const content = await readFile(join(PAGES_DIR, file), 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      const html = await marked(body);
      const slug = basename(file, '.md');
      
      const pageHtml = template(
        meta.title || slug,
        `<article>
          <h1>${meta.title || slug}</h1>
          ${html}
        </article>`,
        siteUrl,
        true,
        meta.blurb || '',
        '',
        `/${slug}.html`
      );
      
      await writeFile(join(OUTPUT_DIR, `${slug}.html`), pageHtml);
      console.log(`  ✓ ${slug}.html (page)`);
      pageCount++;
    }
  }
  
  // Copy favicon
  await copyFile('./favicon.png', join(OUTPUT_DIR, 'favicon.png'));
  console.log('  ✓ favicon.png\n');
  
  console.log(`✨ Built ${posts.length} post(s)${pageCount > 0 ? ` and ${pageCount} page(s)` : ''} to ${OUTPUT_DIR}/`);
  console.log('   Open _site/index.html in a browser to view!');
}

build().catch(console.error);
