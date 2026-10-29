#!/usr/bin/env node
import fs from 'node:fs';

const checks = [
  { file: 'client/index.html', forbidden: /<title>.*conduit.*<\/title>/i },
  { file: 'client/src/components/LandingPage.tsx', forbidden: /Welcome to Conduit/i },
];

let failed = false;
for (const { file, forbidden } of checks) {
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    if (forbidden.test(content)) {
      console.error(`Brand assertion failed in ${file}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log('✓ All brand assertions passed');
