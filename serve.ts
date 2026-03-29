#!/usr/bin/env bun
// @ts-nocheck
/**
 * Simple dev server for the blog
 * Usage: bun serve.ts
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

declare const Bun: any;

const PORT = 3456;
const SITE_DIR = './_site';

function getContentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.avif')) return 'image/avif';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.webm')) return 'video/webm';
  if (path.endsWith('.mov')) return 'video/quicktime';
  return 'text/plain; charset=utf-8';
}

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);
    let path = url.pathname;
    
    // Default to index.html
    if (path === '/') path = '/index.html';
    
    // Remove leading slash
    const filePath = join(SITE_DIR, path.slice(1));
    
    if (!existsSync(filePath)) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(await readFile(filePath), {
      headers: { 'Content-Type': getContentType(path) }
    });
  }
});

console.log(`🐧 Amit's Blog running at http://localhost:${PORT}`);
console.log('   Press Ctrl+C to stop\n');
