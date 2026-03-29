#!/usr/bin/env bun
/**
 * Amit's Blog Builder
 * A minimal static site generator for Amit's musings.
 * 
 * Usage: bun build.ts
 */

import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'fs/promises';
import { join, basename, dirname, extname } from 'path';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { decode } from 'he';
import { existsSync } from 'fs';

const PAGES_DIR = './pages';
const OUTPUT_DIR = './_site';
const CNAME_FILE = './CNAME';
const CACHE_DIR = './.cache';
const MASTODON_STATUSES_CACHE_FILE = join(CACHE_DIR, 'mastodon-statuses.json');
const MASTODON_STATUSES_META_FILE = join(CACHE_DIR, 'mastodon-statuses.meta.json');
const MASTODON_MEDIA_CACHE_DIR = join(CACHE_DIR, 'mastodon-media');
const OUTPUT_MEDIA_DIR = join(OUTPUT_DIR, 'media');
const DEFAULT_SITE_URL = 'https://amitkathuria.github.io';
const MASTODON_BASE_URL = (process.env.MASTODON_BASE_URL?.trim() || 'https://mastodon.social').replace(/\/$/, '');
const MASTODON_ACCOUNT_ACCT = process.env.MASTODON_ACCOUNT_ACCT?.trim() || 'amitkathuria';
const MASTODON_PAGE_SIZE = 40;
const MASTODON_MAX_POSTS = 200;
const MASTODON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const POSTS_PER_PAGE = 5;
const FORCE_REFRESH = process.env.MASTODON_FORCE_REFRESH === '1';
const SITE_DESCRIPTION = 'A personal blog where I share thoughts and reflections on technology, philosophy, art, and everyday life.';

interface Post {
  statusId: string;
  slug: string;
  sourceUrl: string;
  date: string;
  displayDate: string;
  datetime: string;
  sortTime: number;
  blurb: string;
  content: string;
  html: string;
}

interface CachedFeedMeta {
  fetchedAt: string;
}

interface ParsedFeed {
  posts: Post[];
  lastBuildDate: string | null;
}

interface MastodonAccountLookupResponse {
  id: string;
}

interface MastodonMediaAttachment {
  type?: string;
  url?: string | null;
  preview_url?: string | null;
  description?: string | null;
}

interface MastodonStatus {
  id: string;
  url?: string | null;
  created_at: string;
  content: string;
  visibility?: string;
  in_reply_to_id?: string | null;
  reblog?: unknown | null;
  media_attachments?: MastodonMediaAttachment[];
}

function formatDateDisplay(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(date);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const candidate = normalized.slice(0, maxLength + 1);
  const lastSpaceIndex = candidate.lastIndexOf(' ');
  const truncated = lastSpaceIndex > maxLength * 0.6
    ? candidate.slice(0, lastSpaceIndex)
    : normalized.slice(0, maxLength);

  return `${truncated.trimEnd()} ...`;
}

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value ? decode(value) : '';
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

function sanitizePostHtml(html: string): string {
  if (!html) return '';

  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'video', 'source']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel', 'translate'],
      span: ['class'],
      img: ['src', 'alt', 'title', 'loading'],
      video: ['src', 'controls', 'preload', 'poster'],
      source: ['src', 'type']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (_tagName, attribs) => {
        const relValues = new Set((attribs.rel ?? '').split(/\s+/).filter(Boolean));
        relValues.add('noopener');
        relValues.add('noreferrer');
        return {
          tagName: 'a',
          attribs: {
            ...attribs,
            rel: Array.from(relValues).join(' ')
          }
        };
      }
    }
  }).trim();
}

function buildPostBlurb(html: string): string {
  const source = plainTextFromHtml(html);
  return source ? truncateText(source, 180) : '';
}

function buildPageTitle(post: Post): string {
  return truncateText(post.blurb || post.displayDate, 72);
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function extractStatusId(sourceUrl: string): string | null {
  const match = sourceUrl.match(/\/(\d+)(?:\?.*)?$/);
  return match?.[1] ?? null;
}

function normalizeFileExtension(value: string): string {
  return /^\.[a-z0-9]{1,8}$/i.test(value) ? value.toLowerCase() : '';
}

function inferMediaExtension(sourceUrl: string, contentType: string | null, mediaType: string, responseUrl?: string): string {
  for (const candidateUrl of [responseUrl, sourceUrl]) {
    if (!candidateUrl) continue;

    try {
      const extension = normalizeFileExtension(extname(new URL(candidateUrl).pathname));
      if (extension) return extension;
    } catch {
      // Ignore malformed URLs and fall back to content type based detection.
    }
  }

  const normalizedContentType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const extensionByContentType: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov'
  };

  if (extensionByContentType[normalizedContentType]) {
    return extensionByContentType[normalizedContentType];
  }

  if (mediaType === 'video' || mediaType === 'gifv' || mediaType.startsWith('video/')) {
    return '.mp4';
  }

  return '.jpg';
}

async function findCachedMediaFilename(baseName: string): Promise<string | null> {
  if (!existsSync(MASTODON_MEDIA_CACHE_DIR)) return null;

  const entries = await readdir(MASTODON_MEDIA_CACHE_DIR);
  return entries.find(entry => entry === baseName || entry.startsWith(`${baseName}.`)) ?? null;
}

async function copyCachedMediaToOutput(filename: string): Promise<string> {
  await mkdir(OUTPUT_MEDIA_DIR, { recursive: true });
  await copyFile(join(MASTODON_MEDIA_CACHE_DIR, filename), join(OUTPUT_MEDIA_DIR, filename));
  return `/media/${filename}`;
}

async function resolveMediaAssetUrl(statusId: string, mediaIndex: number, sourceUrl: string, mediaType: string): Promise<string> {
  const baseName = `${statusId}-${mediaIndex}`;
  const cachedFilename = await findCachedMediaFilename(baseName);

  if (cachedFilename) {
    return copyCachedMediaToOutput(cachedFilename);
  }

  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const extension = inferMediaExtension(sourceUrl, response.headers.get('content-type'), mediaType, response.url);
    const filename = `${baseName}${extension}`;

    await mkdir(MASTODON_MEDIA_CACHE_DIR, { recursive: true });
    await writeFile(join(MASTODON_MEDIA_CACHE_DIR, filename), new Uint8Array(await response.arrayBuffer()));

    return copyCachedMediaToOutput(filename);
  } catch (error) {
    console.warn(`  ! Unable to cache Mastodon media for status ${statusId}: ${error instanceof Error ? error.message : String(error)}`);
    return sourceUrl;
  }
}

async function buildMediaAttachmentHtml(status: MastodonStatus): Promise<string> {
  const mediaHtml = await Promise.all(asArray(status.media_attachments).map(async (media, mediaIndex) => {
    const sourceUrl = media.url?.trim() || media.preview_url?.trim();
    if (!sourceUrl) return '';

    const type = media.type?.trim() ?? '';
    const description = media.description?.trim() ?? '';
    const resolvedUrl = await resolveMediaAssetUrl(status.id, mediaIndex, sourceUrl, type);
    const escapedUrl = escapeHtml(resolvedUrl);
    const escapedDescription = escapeHtml(description || 'Mastodon media attachment');

    if (type === 'image' || type.startsWith('image/')) {
      return `<p><img src="${escapedUrl}" alt="${escapedDescription}" loading="lazy"></p>`;
    }

    if (type === 'video' || type === 'gifv' || type.startsWith('video/')) {
      return `<p><video controls preload="metadata" src="${escapedUrl}"></video></p>`;
    }

    return '';
  }));

  return mediaHtml.filter(Boolean).join('\n');
}

async function normalizeMastodonStatusToPost(status: MastodonStatus): Promise<Post | null> {
  if (status.visibility !== 'public') return null;
  if (status.in_reply_to_id || status.reblog) return null;

  const sourceUrl = status.url?.trim() || `${MASTODON_BASE_URL}/@${MASTODON_ACCOUNT_ACCT}/${status.id}`;
  const parsedDate = new Date(status.created_at);
  if (Number.isNaN(parsedDate.getTime())) return null;

  const descriptionHtml = sanitizePostHtml(status.content ?? '');
  const mediaHtml = await buildMediaAttachmentHtml(status);
  const html = sanitizePostHtml([descriptionHtml, mediaHtml].filter(Boolean).join('\n'));
  if (!html) return null;

  return {
    statusId: status.id,
    slug: status.id,
    sourceUrl,
    date: parsedDate.toISOString(),
    displayDate: formatDateDisplay(parsedDate),
    datetime: parsedDate.toISOString(),
    sortTime: parsedDate.getTime(),
    blurb: buildPostBlurb(html),
    content: plainTextFromHtml(html),
    html
  };
}

async function parseMastodonStatuses(statuses: MastodonStatus[]): Promise<ParsedFeed> {
  const posts: Post[] = [];

  for (const status of statuses) {
    const post = await normalizeMastodonStatusToPost(status);
    if (post) posts.push(post);
  }

  return { posts, lastBuildDate: statuses[0]?.created_at ?? null };
}

function absolutizeMediaUrls(html: string, siteUrl: string): string {
  return html.replace(/(<(?:img|video|source)\b[^>]*\s(?:src|poster)=["'])\/([^"']+)(["'])/g, `$1${siteUrl}/$2$3`);
}

function extractLocalMediaFilenames(html: string): string[] {
  return Array.from(html.matchAll(/\/media\/([^"'\s>]+)/g), match => match[1]);
}

async function emitCachedMediaForPosts(posts: Post[]): Promise<number> {
  const filenames = new Set(posts.flatMap(post => extractLocalMediaFilenames(post.html)));
  let copiedCount = 0;

  for (const filename of filenames) {
    if (!existsSync(join(MASTODON_MEDIA_CACHE_DIR, filename))) {
      console.warn(`  ! Expected cached media file is missing: ${filename}`);
      continue;
    }

    await copyCachedMediaToOutput(filename);
    copiedCount++;
  }

  return copiedCount;
}

async function readCachedStatuses(): Promise<{ statuses: MastodonStatus[]; fetchedAt: number } | null> {
  if (!existsSync(MASTODON_STATUSES_CACHE_FILE) || !existsSync(MASTODON_STATUSES_META_FILE)) {
    return null;
  }

  try {
    const [statusesRaw, metaRaw] = await Promise.all([
      readFile(MASTODON_STATUSES_CACHE_FILE, 'utf-8'),
      readFile(MASTODON_STATUSES_META_FILE, 'utf-8')
    ]);
    const meta = JSON.parse(metaRaw) as CachedFeedMeta;
    const statuses = JSON.parse(statusesRaw) as MastodonStatus[];
    const fetchedAt = new Date(meta.fetchedAt).getTime();

    if (Number.isNaN(fetchedAt)) return null;
    return { statuses, fetchedAt };
  } catch {
    return null;
  }
}

async function writeCachedStatuses(statuses: MastodonStatus[]): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const meta: CachedFeedMeta = { fetchedAt: new Date().toISOString() };

  await Promise.all([
    writeFile(MASTODON_STATUSES_CACHE_FILE, JSON.stringify(statuses, null, 2)),
    writeFile(MASTODON_STATUSES_META_FILE, JSON.stringify(meta, null, 2))
  ]);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch Mastodon data (${response.status} ${response.statusText}) from ${url}`);
  }

  return response.json() as Promise<T>;
}

async function fetchMastodonStatuses(): Promise<MastodonStatus[]> {
  const account = await fetchJson<MastodonAccountLookupResponse>(`${MASTODON_BASE_URL}/api/v1/accounts/lookup?acct=${encodeURIComponent(MASTODON_ACCOUNT_ACCT)}`);
  const statuses: MastodonStatus[] = [];
  let maxId: string | null = null;

  while (statuses.length < MASTODON_MAX_POSTS) {
    const params = new URLSearchParams({
      exclude_replies: 'true',
      exclude_reblogs: 'true',
      limit: String(MASTODON_PAGE_SIZE)
    });
    if (maxId) params.set('max_id', maxId);

    const page = await fetchJson<MastodonStatus[]>(`${MASTODON_BASE_URL}/api/v1/accounts/${account.id}/statuses?${params.toString()}`);
    if (page.length === 0) break;

    statuses.push(...page);
    if (page.length < MASTODON_PAGE_SIZE) break;

    maxId = page[page.length - 1]?.id ?? null;
    if (!maxId) break;
  }

  return statuses.slice(0, MASTODON_MAX_POSTS);
}

async function loadMastodonStatuses(): Promise<{ statuses: MastodonStatus[]; source: 'cache' | 'network' | 'stale-cache' }> {
  const cachedStatuses = await readCachedStatuses();
  const cacheIsFresh = cachedStatuses && (Date.now() - cachedStatuses.fetchedAt) <= MASTODON_CACHE_TTL_MS;

  if (cachedStatuses && cacheIsFresh && !FORCE_REFRESH) {
    return { statuses: cachedStatuses.statuses, source: 'cache' };
  }

  try {
    const statuses = await fetchMastodonStatuses();
    await writeCachedStatuses(statuses);
    return { statuses, source: 'network' };
  } catch (error) {
    if (cachedStatuses) {
      console.warn(`  ! Mastodon API fetch failed, using cached statuses instead: ${error instanceof Error ? error.message : String(error)}`);
      return { statuses: cachedStatuses.statuses, source: 'stale-cache' };
    }

    throw error;
  }
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

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function getHomePageFilename(pageNumber: number): string {
  return pageNumber === 1 ? 'index.html' : `page-${pageNumber}.html`;
}

function getArchivePageFilename(pageNumber: number): string {
  return pageNumber === 1 ? 'archive.html' : `archive-${pageNumber}.html`;
}

function getHomePageCanonicalPath(pageNumber: number): string {
  return pageNumber === 1 ? '/' : `/${getHomePageFilename(pageNumber)}`;
}

function getArchivePageCanonicalPath(pageNumber: number): string {
  return pageNumber === 1 ? '/archive.html' : `/${getArchivePageFilename(pageNumber)}`;
}

function getHomePageHref(pageNumber: number): string {
  return pageNumber === 1 ? './' : `./${getHomePageFilename(pageNumber)}`;
}

function getArchivePageHref(pageNumber: number): string {
  return `./${getArchivePageFilename(pageNumber)}`;
}

function renderPaginationNav(
  currentPage: number,
  totalPages: number,
  hrefForPage: (pageNumber: number) => string,
  previousLabel: string,
  nextLabel: string
): string {
  if (totalPages <= 1) return '';

  const previousLink = currentPage > 1
    ? `<a class="pagination-prev" href="${hrefForPage(currentPage - 1)}">${previousLabel}</a>`
    : '<span></span>';

  const nextLink = currentPage < totalPages
    ? `<a class="pagination-next" href="${hrefForPage(currentPage + 1)}">${nextLabel}</a>`
    : '<span></span>';

  return `
    <nav class="pagination" aria-label="Pagination">
      ${previousLink}
      <span class="pagination-page">Page ${currentPage} of ${totalPages}</span>
      ${nextLink}
    </nav>
  `;
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
  showBackToPostsLink = true,
  canonicalUrl = ''
) => {
  const siteTitle = "Amit Kathuria";
  const fullTitle = isIndex ? siteTitle : `${title} - ${siteTitle}`;
  const description = blurb || SITE_DESCRIPTION;
  const shareImage = image || `${siteUrl}/share.png`;
  const resolvedCanonicalUrl = canonicalUrl || `${siteUrl}${canonicalPath}`;
  const escapedFullTitle = escapeHtml(fullTitle);
  const escapedDescription = escapeHtml(description);
  const escapedShareImage = escapeHtml(shareImage);
  const escapedCanonicalUrl = escapeHtml(resolvedCanonicalUrl);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="${rootPath}/favicon.png">
  <title>${escapedFullTitle}</title>
  <meta name="description" content="${escapedDescription}">
  <link rel="canonical" href="${escapedCanonicalUrl}">
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapedFullTitle}">
  <meta property="og:description" content="${escapedDescription}">
  <meta property="og:image" content="${escapedShareImage}">
  <meta property="og:url" content="${escapedCanonicalUrl}">
  <meta property="og:site_name" content="${siteTitle}">
  
  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapedFullTitle}">
  <meta name="twitter:description" content="${escapedDescription}">
  <meta name="twitter:image" content="${escapedShareImage}">
  
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

    .post .e-content img {
      max-width: min(100%, 22rem);
      margin-left: auto;
      margin-right: auto;
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

    .pagination {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 1rem;
      margin-top: 2rem;
      font-size: 0.9rem;
    }

    .pagination-page {
      color: #9a9a9a;
      white-space: nowrap;
    }

    .pagination-next {
      justify-self: end;
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
      <p>Built with Bun and the Mastodon API · <a href="https://github.com/amitkathuria/amitkathuria.github.io">Source</a></p>
    </footer>
  </div>
</body>
</html>`;
}

// RSS feed generator
function wrapCdata(value: string): string {
  return `<![CDATA[${value.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

function generateRSS(posts: Post[], siteUrl: string, lastBuildDate: string | null): string {
  const resolvedLastBuildDate = (() => {
    const candidate = lastBuildDate ? new Date(lastBuildDate) : null;
    if (candidate && !Number.isNaN(candidate.getTime())) return candidate.toUTCString();
    if (posts[0]) return new Date(posts[0].datetime).toUTCString();
    return new Date().toUTCString();
  })();

  const items = posts.map(p => `
    <item>
      <title>${wrapCdata(buildPageTitle(p))}</title>
      <link>${siteUrl}/${p.slug}.html</link>
      <guid isPermaLink="true">${siteUrl}/${p.slug}.html</guid>
      <pubDate>${new Date(p.datetime).toUTCString()}</pubDate>
      <description>${wrapCdata(absolutizeMediaUrls(p.html, siteUrl))}</description>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Amit Kathuria</title>
    <link>${siteUrl}</link>
    <description>${SITE_DESCRIPTION}</description>
    <language>en-us</language>
    <lastBuildDate>${resolvedLastBuildDate}</lastBuildDate>
    <atom:link href="${siteUrl}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

async function build() {
  console.log('🐧 Building Amit\'s Blog...\n');
  const siteUrl = await resolveSiteUrl();
  const { statuses, source: feedSource } = await loadMastodonStatuses();
  const { posts, lastBuildDate } = await parseMastodonStatuses(statuses);
  posts.sort((a, b) => b.sortTime - a.sortTime);
  
  if (existsSync(OUTPUT_DIR)) {
    await rm(OUTPUT_DIR, { recursive: true, force: true });
  }
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`  ✓ Loaded Mastodon statuses from ${feedSource}`);

  const emittedMediaCount = await emitCachedMediaForPosts(posts);
  if (emittedMediaCount > 0) {
    console.log(`  ✓ media/ (${emittedMediaCount} file${emittedMediaCount === 1 ? '' : 's'})`);
  }

  for (const post of posts) {
    const postOutputPath = join(OUTPUT_DIR, `${post.slug}.html`);

    const postHtml = template(
      buildPageTitle(post),
      `<article class="h-entry">
        <p class="post-date"><a class="u-url" href="/${post.slug}.html"><time class="dt-published" datetime="${post.datetime}">${post.displayDate}</time></a></p>
        <div class="e-content">${post.html}</div>
        <p class="meta">Originally posted on <a class="u-syndication" href="${escapeHtml(post.sourceUrl)}" target="_blank" rel="noopener noreferrer">Mastodon</a></p>
      </article>`,
      siteUrl,
      false,
      post.blurb,
      '',
      `/${post.slug}.html`,
      getRootPathFromSlug(post.slug),
      false
    );

    await writeFile(postOutputPath, postHtml);
    console.log(`  ✓ ${post.slug}.html`);
  }

  const paginatedPosts = chunkArray(posts, POSTS_PER_PAGE);
  if (paginatedPosts.length === 0) {
    paginatedPosts.push([]);
  }

  for (const [index, pagePosts] of paginatedPosts.entries()) {
    const pageNumber = index + 1;
    const filename = getHomePageFilename(pageNumber);
    const indexContent = `
      ${pagePosts.map(p => `
          <div class="post h-entry">
            <a href="./${p.slug}.html" class="post-date u-url"><time class="dt-published" datetime="${p.datetime}">${p.displayDate}</time></a>
            <div class="e-content">${p.html}</div>
          </div>
        `).join('')}
      ${pagePosts.length === 0 ? '<p>No posts yet. The blank page awaits...</p>' : ''}
      ${renderPaginationNav(pageNumber, paginatedPosts.length, getHomePageHref, 'Newer Posts', 'Older Posts')}
    `;

    await writeFile(
      join(OUTPUT_DIR, filename),
      template(
        pageNumber === 1 ? 'Home' : `Home - Page ${pageNumber}`,
        indexContent,
        siteUrl,
        pageNumber === 1,
        SITE_DESCRIPTION,
        '',
        getHomePageCanonicalPath(pageNumber),
        '.',
        false
      )
    );
    console.log(`  ✓ ${filename}`);
  }

  for (const [index, pagePosts] of paginatedPosts.entries()) {
    const pageNumber = index + 1;
    const filename = getArchivePageFilename(pageNumber);
    const archiveContent = `
      <div class="h-feed">
        ${pagePosts.map(p => `
          <p class="h-entry">
            <a href="./${p.slug}.html" class="u-url"><time class="dt-published" datetime="${p.datetime}">${p.datetime.slice(0, 10)}</time></a>:
            <span class="p-summary">${escapeHtml(buildArchiveSummary(p))}</span>
          </p>
        `).join('')}
      </div>
      ${renderPaginationNav(pageNumber, paginatedPosts.length, getArchivePageHref, 'Newer Entries', 'Older Entries')}
    `;

    await writeFile(
      join(OUTPUT_DIR, filename),
      template(
        pageNumber === 1 ? 'Archive' : `Archive - Page ${pageNumber}`,
        archiveContent,
        siteUrl,
        false,
        '',
        '',
        getArchivePageCanonicalPath(pageNumber),
        '.',
        false
      )
    );
    console.log(`  ✓ ${filename}`);
  }
  
  // Generate RSS feed
  const rss = generateRSS(posts, siteUrl, lastBuildDate);
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
