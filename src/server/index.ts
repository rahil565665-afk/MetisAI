import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app } from './app.js';
import { PORT, assertServerConfig } from './config.js';

const server = createServer(app);
const clientPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/client');
app.use(express.static(clientPath));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientPath, 'index.html'), (error) => {
  if (error) res.status(404).send('Client build not found. Run pnpm build first.');
}));

try { assertServerConfig(); } catch (error) {
  const reason = error instanceof Error ? error.message : 'Server configuration is invalid.';
  console.warn('[startup-config]', reason);
}
server.listen(PORT, '0.0.0.0', () => console.info(`Reception console listening on ${PORT}`));
