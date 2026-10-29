#!/usr/bin/env node
/**
 * Which voice Conduit speaks with.
 *
 * The old code took the first voice matching the language, which on Windows is
 * a legacy formant voice — so a machine with Microsoft Aria installed spoke as
 * Microsoft David. These pin the ranking that fixes it.
 */
import { pickVoice } from '../client/src/utils/speech.ts';

let pass = 0, fail = 0;
const failures = [];
function t(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const v = (name, lang, dflt = false) => ({ name, lang, default: dflt });

// What this machine actually reports, legacy voices first — which is the
// order that produced the bug.
const WINDOWS = [
  v('Microsoft David - English (United States)', 'en-US', true),
  v('Microsoft Zira - English (United States)', 'en-US'),
  v('Microsoft Mark - English (United States)', 'en-US'),
  v('Microsoft Aria Online (Natural) - English (United States)', 'en-US'),
  v('Microsoft Guy Online (Natural) - English (United States)', 'en-US'),
  v('Microsoft Libby Online (Natural) - English (United Kingdom)', 'en-GB'),
  v('Microsoft Hedda - German (Germany)', 'de-DE'),
];

console.log('\nVoice selection\n');

const picked = pickVoice(WINDOWS, 'en-US');
t(/Natural/i.test(picked?.name || ''), 'prefers a natural voice over a legacy one', picked?.name);
t(!/David/.test(picked?.name || ''), 'does not settle for the first language match', picked?.name);

t(pickVoice(WINDOWS, 'en-US', 'Microsoft Guy Online (Natural) - English (United States)')?.name
  === 'Microsoft Guy Online (Natural) - English (United States)',
  'an explicit choice always wins');

t(pickVoice(WINDOWS, 'en-US', 'Some Voice That Left')?.name !== undefined,
  'a saved voice that no longer exists falls back rather than going silent');

// Language handling.
t(pickVoice(WINDOWS, 'en-GB')?.lang === 'en-GB', 'an exact language match is preferred');
t(pickVoice(WINDOWS, 'en-AU')?.lang.startsWith('en'), 'falls back within the same language');
t(pickVoice(WINDOWS, 'de-DE')?.name === 'Microsoft Hedda - German (Germany)', 'German picks German');
t(pickVoice(WINDOWS, 'ja-JP') === undefined, 'no voice at all beats the wrong language');
t(pickVoice([], 'en-US') === undefined, 'an empty list is handled');

// Only legacy voices installed — still has to choose one.
{
  const legacyOnly = [v('Microsoft David - English (United States)', 'en-US')];
  t(pickVoice(legacyOnly, 'en-US')?.name.includes('David'),
    'a legacy voice is used when it is all there is');
}

console.log(`\n${pass} passed, ${fail} failed${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}\n`);
process.exit(fail ? 1 : 0);
