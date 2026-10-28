/**
 * Project memory — facts a team wants every agent to know, kept per project.
 *
 * LocalHarness keeps memory per agent; Bedrock runs several CLIs on one
 * project, so here memory belongs to the project and every agent reads it:
 * the newest facts are written into each agent's instruction section when it
 * starts, and the REST API (and so the UI) reads and edits them.
 *
 * Stored as ~/.conduit/projects/<projectId>/memory.json — one small JSON
 * array, rewritten atomically, capped so it cannot grow without bound.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { writeJsonAtomic } from './storage-fs.js';

export interface MemoryFact {
  id: string;
  text: string;
  /** Who recorded it: "User", an agent's name, "Keeper". */
  source: string;
  createdAt: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_FACTS = 200;
export const MAX_FACT_CHARS = 1000;
/** How many of the newest facts go into an agent's instructions. */
export const FACTS_IN_INSTRUCTIONS = 20;

function memoryFile(projectId: string): string {
  if (!SAFE_ID.test(projectId)) throw new Error('Invalid project id');
  return path.join(os.homedir(), '.conduit', 'projects', projectId, 'memory.json');
}

export function listFacts(projectId: string): MemoryFact[] {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryFile(projectId), 'utf-8'));
    return Array.isArray(raw)
      ? raw.filter((f) => f && typeof f.id === 'string' && typeof f.text === 'string')
      : [];
  } catch {
    return [];
  }
}

function save(projectId: string, facts: MemoryFact[]): void {
  const file = memoryFile(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, facts);
}

/** Record a fact. Returns it, or null for an empty one. The oldest drop off past the cap. */
export function addFact(projectId: string, text: string, source = 'User'): MemoryFact | null {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
  if (!clean) return null;
  const fact: MemoryFact = {
    id: randomUUID(),
    text: clean,
    source: String(source || 'User').slice(0, 80),
    createdAt: new Date().toISOString(),
  };
  const facts = [...listFacts(projectId), fact];
  save(projectId, facts.slice(-MAX_FACTS));
  return fact;
}

/** Forget one fact. False when there was no such fact. */
export function forgetFact(projectId: string, factId: string): boolean {
  const facts = listFacts(projectId);
  const next = facts.filter((f) => f.id !== factId);
  if (next.length === facts.length) return false;
  save(projectId, next);
  return true;
}

/** Facts whose text contains every word of `query` (case-insensitive), newest first. */
export function searchFacts(projectId: string, query: string): MemoryFact[] {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = listFacts(projectId).reverse();
  if (!words.length) return all;
  return all.filter((f) => words.every((w) => f.text.toLowerCase().includes(w)));
}

/** The instruction-section lines for this project's memory, or none. */
export function memoryLines(projectId: string): string[] {
  const facts = listFacts(projectId).slice(-FACTS_IN_INSTRUCTIONS);
  if (!facts.length) return [];
  return [
    '',
    '### Project memory',
    'Facts the team recorded for every agent on this project:',
    ...facts.map((f) => `- ${f.text}`),
  ];
}
