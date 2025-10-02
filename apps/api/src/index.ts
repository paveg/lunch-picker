import { Hono } from 'hono';

interface Env {
  GOOGLE_PLACES_API_KEY: string;
  DB: D1Database;
  CACHE: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.text('ok'));

app.post('/search', async (c) => {
  // TODO: implement search logic backed by Google Places and D1 caching.
  return c.json({ results: [] });
});

export default app;
