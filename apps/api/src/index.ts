import { Hono } from 'hono';
import type { Context } from 'hono';

interface Env {
  GOOGLE_PLACES_API_KEY: string;
  DB: D1Database;
  CACHE: KVNamespace;
}

type SearchRequest = {
  location: { lat: number; lng: number };
  radius_m: number;
  cuisine?: string[];
  budget?: null | { max: number };
  limit?: number;
};

interface SearchResult {
  place_id: string;
  name: string;
  rating: number | null;
  distance_m: number;
  price_level: string | null;
  open_now: boolean | null;
  fit_score: number;
  static_map_url: string;
  gmaps_url: string;
  address: string | null;
  types: string[];
}

interface CachedSearchResponse {
  results: SearchResult[];
  cachedAt: number;
}

const RATE_LIMIT_CAPACITY = 10;
const RATE_LIMIT_INTERVAL_MS = 60_000;
const SEARCH_CACHE_TTL = 600; // seconds
const STATIC_MAP_SIZE = '640x360';
const STATIC_MAP_ZOOM = '16';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.text('ok'));

app.get('/api/maps/static', async (c) => {
  const apiKey = c.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return c.text('Missing Google API key', 500);
  }

  const lat = parseFloat(c.req.query('lat') ?? '');
  const lng = parseFloat(c.req.query('lng') ?? '');

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.text('Invalid coordinates', 400);
  }

  const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.searchParams.set('center', `${lat},${lng}`);
  url.searchParams.set('zoom', STATIC_MAP_ZOOM);
  url.searchParams.set('size', STATIC_MAP_SIZE);
  url.searchParams.set('markers', `color:red|${lat},${lng}`);
  url.searchParams.set('scale', '2');
  url.searchParams.set('maptype', 'roadmap');
  url.searchParams.set('key', apiKey);

  const upstream = await fetch(url.toString(), {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });

  if (!upstream.ok) {
    return c.text('Failed to retrieve static map', upstream.status);
  }

  const headers = new Headers(upstream.headers);
  headers.set('Cache-Control', 'public, max-age=3600');

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
});

app.post('/api/search', async (c) => {
  const apiKey = c.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'Google Places API key is not configured.' }, 500);
  }

  const body = await safeParseBody(c);
  if (!body.ok) {
    return c.json({ error: body.error }, 400);
  }
  const request = body.value;

  const rateKey = getRateLimitKey(c);
  const rate = await consumeToken(c, rateKey);
  if (!rate.allowed) {
    c.header('Retry-After', rate.retryAfterSeconds.toString());
    return c.json({ error: 'Too many requests' }, 429);
  }

  const cacheKey = buildCacheKey(request);
  const cached = await c.env.CACHE.get<CachedSearchResponse>(cacheKey, { type: 'json' });
  if (cached) {
    c.header('X-Cache', 'HIT');
    return c.json(cached);
  }

  const places = await fetchNearbyPlaces(request, apiKey);
  if (!places.ok) {
    return c.json({ error: places.error }, places.status ?? 502);
  }

  const normalized = normalizePlaces(places.value, request);
  const response: CachedSearchResponse = {
    results: normalized,
    cachedAt: Date.now(),
  };

  await c.env.CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: SEARCH_CACHE_TTL });

  c.header('X-Cache', 'MISS');
  return c.json(response);
});

function getRateLimitKey(c: Context<{ Bindings: Env }>): string {
  const teamId = c.req.header('x-team-id');
  if (teamId) return `team:${teamId}`;
  const ip =
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for') ||
    c.req.header('x-real-ip') ||
    'anonymous';
  return `ip:${ip}`;
}

async function consumeToken(c: Context<{ Bindings: Env }>, key: string) {
  type Bucket = { tokens: number; updatedAt: number };
  const bucketKey = `ratelimit:${key}`;
  const now = Date.now();
  const existing = await c.env.CACHE.get<Bucket>(bucketKey, { type: 'json' });
  const capacity = RATE_LIMIT_CAPACITY;

  let tokens = capacity;
  let updatedAt = now;

  if (existing) {
    const elapsed = now - existing.updatedAt;
    const refill = (elapsed / RATE_LIMIT_INTERVAL_MS) * capacity;
    tokens = Math.min(capacity, existing.tokens + refill);
    updatedAt = now;
  }

  if (tokens < 1) {
    await c.env.CACHE.put(bucketKey, JSON.stringify({ tokens, updatedAt }), { expirationTtl: 120 });
    const retryAfter = Math.ceil(RATE_LIMIT_INTERVAL_MS / capacity / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  tokens -= 1;
  await c.env.CACHE.put(bucketKey, JSON.stringify({ tokens, updatedAt }), { expirationTtl: 120 });
  return { allowed: true, retryAfterSeconds: 0 };
}

async function safeParseBody(c: Context<{ Bindings: Env }>) {
  try {
    const json = (await c.req.json()) as SearchRequest;
    if (
      !json?.location ||
      typeof json.location.lat !== 'number' ||
      typeof json.location.lng !== 'number'
    ) {
      return { ok: false as const, error: 'location.lat and location.lng are required numbers.' };
    }
    if (typeof json.radius_m !== 'number' || Number.isNaN(json.radius_m) || json.radius_m <= 0) {
      return { ok: false as const, error: 'radius_m must be a positive number.' };
    }
    json.limit = clamp(json.limit ?? 5, 1, 20);
    json.radius_m = Math.min(json.radius_m, 50000);
    json.cuisine = (json.cuisine ?? []).map((c) => c.toLowerCase()).filter(Boolean);
    return { ok: true as const, value: json };
  } catch {
    return { ok: false as const, error: 'Invalid JSON payload' };
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildCacheKey(req: SearchRequest) {
  const { location, radius_m, cuisine = [], budget } = req;
  const cuisineKey = [...cuisine].sort().join(',');
  const budgetKey = budget?.max ?? 'none';
  const roundedLat = location.lat.toFixed(4);
  const roundedLng = location.lng.toFixed(4);
  return `search:${roundedLat}:${roundedLng}:${radius_m}:${cuisineKey}:${budgetKey}`;
}

async function fetchNearbyPlaces(req: SearchRequest, apiKey: string) {
  const endpoint = 'https://places.googleapis.com/v1/places:searchNearby';
  const body = {
    includedTypes: ['restaurant'],
    maxResultCount: 20,
    languageCode: 'ja',
    locationRestriction: {
      circle: {
        center: {
          latitude: req.location.lat,
          longitude: req.location.lng,
        },
        radius: req.radius_m,
      },
    },
  };

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.rating',
    'places.priceLevel',
    'places.types',
    'places.currentOpeningHours.openNow',
    'places.location',
    'places.googleMapsUri',
    'places.shortFormattedAddress',
  ].join(',');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    return {
      ok: false as const,
      status: response.status,
      error: `Places API error (${response.status}): ${errorPayload}`,
    };
  }

  const data = (await response.json()) as { places?: GooglePlace[] };
  return { ok: true as const, value: data.places ?? [] };
}

type GooglePlace = {
  id: string;
  displayName?: { text: string };
  rating?: number;
  priceLevel?: string;
  types?: string[];
  currentOpeningHours?: { openNow?: boolean };
  location?: { latitude: number; longitude: number };
  googleMapsUri?: string;
  shortFormattedAddress?: string;
};

function normalizePlaces(places: GooglePlace[], req: SearchRequest): SearchResult[] {
  const effectiveCuisine = req.cuisine ?? [];

  const filtered = places.filter((place) => matchesCuisine(place, effectiveCuisine));
  const results = filtered
    .map((place) => buildSearchResult(place, req))
    .sort((a, b) => b.fit_score - a.fit_score)
    .slice(0, req.limit ?? 5);

  return results;
}

function matchesCuisine(place: GooglePlace, cuisineFilters: string[]) {
  if (cuisineFilters.length === 0) return true;
  const types = place.types ?? [];
  const name = place.displayName?.text?.toLowerCase() ?? '';
  return cuisineFilters.some((needle) => {
    if (name.includes(needle)) return true;
    return types.some((type) => type.toLowerCase().includes(needle));
  });
}

function buildSearchResult(place: GooglePlace, req: SearchRequest): SearchResult {
  const name = place.displayName?.text ?? 'Unknown place';
  const lat = place.location?.latitude ?? req.location.lat;
  const lng = place.location?.longitude ?? req.location.lng;
  const distance = haversineMeters(req.location.lat, req.location.lng, lat, lng);
  const openNow = place.currentOpeningHours?.openNow ?? null;
  const rating = place.rating ?? null;
  const priceLevel = place.priceLevel ?? null;

  const fitScore = computeFitScore({
    rating,
    distance,
    radius: req.radius_m,
    priceLevel,
    openNow,
  });

  return {
    place_id: place.id,
    name,
    rating,
    distance_m: distance,
    price_level: priceLevel,
    open_now: openNow,
    fit_score: fitScore,
    static_map_url: buildStaticMapUrl(lat, lng, place.id),
    gmaps_url:
      place.googleMapsUri ?? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    address: place.shortFormattedAddress ?? null,
    types: place.types ?? [],
  };
}

function buildStaticMapUrl(lat: number, lng: number, placeId: string) {
  const params = new URLSearchParams({ lat: lat.toString(), lng: lng.toString(), placeId });
  return `/api/maps/static?${params.toString()}`;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function computeFitScore(args: {
  rating: number | null;
  distance: number;
  radius: number;
  priceLevel: string | null;
  openNow: boolean | null;
}) {
  const ratingScore = args.rating ? args.rating / 5 : 0.6;
  const distanceScore = 1 - Math.min(1, args.distance / Math.max(args.radius, 1));
  const priceScore = priceToScore(args.priceLevel);
  const openScore = args.openNow === null ? 0.5 : args.openNow ? 1 : 0;
  const composite = ratingScore * 0.4 + distanceScore * 0.3 + priceScore * 0.2 + openScore * 0.1;
  return Math.round(composite * 1000) / 1000;
}

function priceToScore(priceLevel: string | null) {
  if (!priceLevel) return 0.6;
  const mapping: Record<string, number> = {
    PRICE_LEVEL_FREE: 1,
    PRICE_LEVEL_INEXPENSIVE: 0.9,
    PRICE_LEVEL_MODERATE: 0.7,
    PRICE_LEVEL_EXPENSIVE: 0.4,
    PRICE_LEVEL_VERY_EXPENSIVE: 0.2,
  };
  return mapping[priceLevel] ?? 0.6;
}

export default app;
