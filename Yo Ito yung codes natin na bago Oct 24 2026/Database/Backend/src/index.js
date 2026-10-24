import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './db.js';
import { authRouter } from './routes/auth.js';
import { itemsRouter } from './routes/items.js';
import { bazaarRouter } from './routes/bazaar.js';
import { inventoryRouter } from './routes/inventory.js';
import { notificationsRouter } from './routes/notifications.js';
import { shipmentsRouter } from './routes/shipments.js';
import { chatRouter } from './routes/chat-route.js';
import { locationRouter } from './routes/location.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const app = express();

const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({ origin: origins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', '..')));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('select 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    console.error('HEALTH CHECK FAILED:', err);
    res.status(500).json({
      status: 'error',
      message: err.message || String(err),
      code: err.code || null,
      detail: err.detail || null,
      hint: err.hint || null,
      where: err.where || null,
    });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/items', itemsRouter);
app.use('/api/items', bazaarRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/shipments', shipmentsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/location', locationRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = Number(process.env.PORT) || 8000;
app.listen(port, () => {
  console.log(`Cainta One API listening on http://127.0.0.1:${port}`);
});