import type { SearchRequest, SearchResponse } from './model';

interface SearchPlacesArgs {
  body: SearchRequest;
}

export async function searchPlaces({ body }: SearchPlacesArgs): Promise<SearchResponse> {
  const res = await fetch('/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Failed to search places: ${res.status}`);
  }

  return (await res.json()) as SearchResponse;
}
