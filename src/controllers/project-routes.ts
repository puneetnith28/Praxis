import { Router } from 'express';
export function createProjectRouter(): Router {
  const r = Router();
  r.get('/', (req, res) => res.json({ projects: [] }));
  return r;
}
