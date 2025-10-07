import { Hono } from 'hono';
import { cors } from 'hono/cors';
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

app.options('/api/*', (c) =>
  c.body(null, 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  })
);

app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 86400,
  })
);

type CacheLike = Pick<KVNamespace, 'get' | 'put' | 'delete'>;

const inMemoryCache = createInMemoryCache();

const MOCK_PLACE_TEMPLATES = [
  {
    id: 'mock-1',
    name: 'ごはん処 和み',
    baseDistanceMeters: 180,
    bearingDegrees: 20,
    rating: 4.2,
    priceLevel: 'PRICE_LEVEL_INEXPENSIVE' as const,
    openNow: true,
    types: ['restaurant', 'japanese_restaurant'],
    address: '駅前1-2-3',
  },
  {
    id: 'mock-2',
    name: '麺屋 こだま',
    baseDistanceMeters: 320,
    bearingDegrees: 95,
    rating: 4.5,
    priceLevel: 'PRICE_LEVEL_MODERATE' as const,
    openNow: true,
    types: ['restaurant', 'ramen_restaurant'],
    address: '中央通り5-6-1',
  },
  {
    id: 'mock-3',
    name: 'スパイス香房',
    baseDistanceMeters: 420,
    bearingDegrees: 210,
    rating: 4.1,
    priceLevel: 'PRICE_LEVEL_INEXPENSIVE' as const,
    openNow: false,
    types: ['restaurant', 'curry_restaurant'],
    address: '南町3-8-10',
  },
  {
    id: 'mock-4',
    name: 'トラットリア ソレイユ',
    baseDistanceMeters: 290,
    bearingDegrees: 300,
    rating: 4.6,
    priceLevel: 'PRICE_LEVEL_EXPENSIVE' as const,
    openNow: true,
    types: ['restaurant', 'italian_restaurant'],
    address: '西新町7-4-2',
  },
  {
    id: 'mock-5',
    name: '茶寮 ほっと',
    baseDistanceMeters: 150,
    bearingDegrees: 135,
    rating: 4.0,
    priceLevel: null,
    openNow: null,
    types: ['cafe'],
    address: '北広場2-1-5',
  },
];

function getCacheBinding(c: Context<{ Bindings: Env }>): CacheLike {
  return c.env.CACHE ?? inMemoryCache;
}

function createInMemoryCache(): CacheLike {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  return {
    async get(key: string, options?: { type?: 'json' | 'text' }) {
      const record = store.get(key);
      if (!record) return null;
      if (record.expiresAt && record.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }

      if (options?.type === 'json') {
        try {
          return JSON.parse(record.value);
        } catch {
          return null;
        }
      }

      return record.value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as CacheLike;
}

app.get('/api/health', (c) => c.text('ok'));

app.get('/api/maps/static', async (c) => {
  const lat = parseFloat(c.req.query('lat') ?? '');
  const lng = parseFloat(c.req.query('lng') ?? '');

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.text('Invalid coordinates', 400);
  }

  const apiKey = c.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return createPlaceholderMap(lat, lng);
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
  const cache = getCacheBinding(c);
  const apiKey = c.env.GOOGLE_PLACES_API_KEY;

  const body = await safeParseBody(c);
  if (!body.ok) {
    return c.json({ error: body.error }, 400);
  }
  const request = body.value;

  const rateKey = getRateLimitKey(c);
  const rate = await consumeToken(cache, rateKey);
  if (!rate.allowed) {
    c.header('Retry-After', rate.retryAfterSeconds.toString());
    return c.json({ error: 'Too many requests' }, 429);
  }

  const cacheKey = buildCacheKey(request);
  const cached = await cache.get<CachedSearchResponse>(cacheKey, { type: 'json' });
  if (cached) {
    c.header('X-Cache', 'HIT');
    return c.json(cached);
  }

  if (!apiKey) {
    const mockResponse = buildMockSearchResponse(request);
    await cache.put(cacheKey, JSON.stringify(mockResponse), { expirationTtl: 120 });
    c.header('X-Cache', 'MISS');
    c.header('X-Mock-Data', 'true');
    return c.json(mockResponse);
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

  await cache.put(cacheKey, JSON.stringify(response), { expirationTtl: SEARCH_CACHE_TTL });

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

async function consumeToken(cache: CacheLike, key: string) {
  type Bucket = { tokens: number; updatedAt: number };
  const bucketKey = `ratelimit:${key}`;
  const now = Date.now();
  const existing = await cache.get<Bucket>(bucketKey, { type: 'json' });
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
    await cache.put(bucketKey, JSON.stringify({ tokens, updatedAt }), { expirationTtl: 120 });
    const retryAfter = Math.ceil(RATE_LIMIT_INTERVAL_MS / capacity / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  tokens -= 1;
  await cache.put(bucketKey, JSON.stringify({ tokens, updatedAt }), { expirationTtl: 120 });
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

function buildMockSearchResponse(req: SearchRequest): CachedSearchResponse {
  const limit = Math.min(req.limit ?? 5, MOCK_PLACE_TEMPLATES.length);
  const cuisines = (req.cuisine ?? []).filter(Boolean);
  const fallbackLabels = ['定食', 'ラーメン', 'カレー', '寿司', 'カフェ'];
  const labels = cuisines.length > 0 ? cuisines : fallbackLabels;
  const radius = Math.max(100, Math.min(req.radius_m, 1000));

  const useFallbackLabels = cuisines.length === 0;

  const results = Array.from({ length: limit }).map((_, index) => {
    const template = MOCK_PLACE_TEMPLATES[index % MOCK_PLACE_TEMPLATES.length];
    const label = labels[index % labels.length];
    const distance = Math.min(radius, template.baseDistanceMeters + index * 80);
    const coords = displaceCoordinate(
      req.location.lat,
      req.location.lng,
      distance,
      template.bearingDegrees
    );

    const place: GooglePlace = {
      id: `${template.id}-${index}`,
      displayName: { text: useFallbackLabels ? template.name : `${template.name} (${label})` },
      rating: template.rating,
      priceLevel: template.priceLevel ?? undefined,
      types: template.types,
      currentOpeningHours: template.openNow == null ? undefined : { openNow: template.openNow },
      location: {
        latitude: coords.latitude,
        longitude: coords.longitude,
      },
      googleMapsUri: `https://www.google.com/maps/search/?api=1&query=${coords.latitude},${coords.longitude}`,
      shortFormattedAddress: template.address,
    };

    return buildSearchResult(place, req);
  });

  return {
    results,
    cachedAt: Date.now(),
  };
}

function displaceCoordinate(
  lat: number,
  lng: number,
  distanceMeters: number,
  bearingDegrees: number
) {
  const earthRadius = 6371e3;
  const angularDistance = distanceMeters / earthRadius;
  const bearing = (bearingDegrees * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;

  const newLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(angularDistance) +
      Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const newLngRad =
    lngRad +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
      Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(newLatRad)
    );

  return {
    latitude: (newLatRad * 180) / Math.PI,
    longitude: (newLngRad * 180) / Math.PI,
  };
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

function createPlaceholderMap(lat: number, lng: number) {
  const [width, height] = STATIC_MAP_SIZE.split('x').map((value) => Number.parseInt(value, 10));
  const safeWidth = Number.isFinite(width) ? width : 640;
  const safeHeight = Number.isFinite(height) ? height : 360;
  const label = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#ede9fe" />
      <stop offset="100%" stop-color="#c4b5fd" />
    </linearGradient>
  </defs>
  <rect width="${safeWidth}" height="${safeHeight}" fill="url(#bg)" rx="24" />
  <text x="50%" y="45%" text-anchor="middle" font-family="Arial, sans-serif" font-size="32" fill="#312e81">Mock Map</text>
  <text x="50%" y="60%" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" fill="#4338ca">${label}</text>
  <text x="50%" y="75%" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#4f46e5">Set GOOGLE_PLACES_API_KEY to see real maps</text>
</svg>`;

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

export default app;
