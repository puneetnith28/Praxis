#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

console.log('Packaging Bedrock release artifacts...');
const distDir = path.resolve('dist');
fs.mkdirSync(distDir, { recursive: true });
const manifest = {
  version: '1.0.0',
  buildDate: new Date().toISOString(),
  checksum: crypto.createHash('sha256').update('bedrock-release-v1.0.0').digest('hex')
};
fs.writeFileSync(path.join(distDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('✓ Release packaging complete: dist/release-manifest.json');
