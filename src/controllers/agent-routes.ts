import { Router } from 'express';
export function createAgentRouter(): Router {
  const r = Router();
  r.get('/', (req, res) => res.json({ agents: [] }));
  return r;
}
