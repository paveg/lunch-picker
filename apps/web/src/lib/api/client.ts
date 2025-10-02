import type { SearchRequest, SearchResponse } from './model';

export async function searchPlaces(body: SearchRequest): Promise<SearchResponse> {
  const res = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Failed to search places: ${res.status}`);
  }

  return (await res.json()) as SearchResponse;
}
