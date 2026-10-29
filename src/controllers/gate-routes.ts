import { Router } from 'express';
export function createGateRouter(): Router {
  const r = Router();
  r.get('/', (req, res) => res.json({ gates: [] }));
  return r;
}
