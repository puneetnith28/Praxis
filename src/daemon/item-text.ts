/**
 * The plain-text form of a structured agent item — what the Supervisor reads
 * for agents that have no terminal stream (Codex, LocalHarness over ACP).
 * One place, so both runtimes are watched identically.
 */
import type { CodexItem } from './protocol.js';

/** Text for a finished item, or '' for one the Supervisor need not see. */
export function itemText(it: CodexItem): string {
  if (it.kind === 'message' && it.role === 'agent') return it.text || '';
  if (it.kind === 'command') {
    const out = (it.output || '').slice(-2000);
    return `$ ${it.command || ''}\n${out}\n(exit ${it.exitCode ?? '?'})`;
  }
  if (it.kind === 'error') return 'ERROR: ' + (it.text || '');
  if (it.kind === 'file') return `edited file: ${it.path || ''}`;
  return '';
}

/**
 * Turn an item stream into a text stream: one string per finished item, each
 * item at most once (an item is upserted many times while it runs).
 */
export function textListener(listener: (text: string) => void): (it: CodexItem) => void {
  const emitted = new Set<string>();
  return (it) => {
    if (it.status === 'running') return;
    if (emitted.has(it.id)) return;
    const text = itemText(it);
    if (!text.trim()) return;
    emitted.add(it.id);
    if (emitted.size > 2000) emitted.clear();
    listener(text + '\n');
  };
}
