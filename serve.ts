#!/usr/bin/env bun
/**
 * Simple dev server for the blog
 * Usage: bun serve.ts
 */

import { serve } from 'bun';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const PORT = 3456;
const SITE_DIR = './_site';

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    
    // Default to index.html
    if (path === '/') path = '/index.html';
    
    // Remove leading slash
    const filePath = join(SITE_DIR, path.slice(1));
    
    if (!existsSync(filePath)) {
      return new Response('Not found', { status: 404 });
    }
    
    const content = await readFile(filePath);
    const contentType = path.endsWith('.html') ? 'text/html' : 'text/plain';
    
    return new Response(content, {
      headers: { 'Content-Type': contentType }
    });
  }
});

console.log(`🐧 Amit's Blog running at http://localhost:${PORT}`);
console.log('   Press Ctrl+C to stop\n');
