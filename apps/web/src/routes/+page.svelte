<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import { createQuery } from '@tanstack/svelte-query';
  import { searchPlaces } from '$lib/api/client';

  let radius = 1200;
  let budgetMax: string | null = null;
  let cuisine = '';

  async function getCoords() {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 4000 })
      );
      return { lat: pos.coords.latitude, lng: pos.coords.longitude };
    } catch (error) {
      console.error('Failed to get geolocation, using fallback', error);
      return { lat: 35.681236, lng: 139.767125 };
    }
  }

  const q = createQuery({
    queryKey: ['search', radius, budgetMax, cuisine],
    queryFn: async () => {
      const loc = await getCoords();
      const parsedBudget = budgetMax && budgetMax !== '' ? Number(budgetMax) : null;

      return (
        (
          await searchPlaces({
            body: {
              location: loc,
              radius_m: radius,
              cuisine: cuisine ? cuisine.split(',').map((s) => s.trim()) : [],
              budget:
                parsedBudget == null || Number.isNaN(parsedBudget) ? null : { max: parsedBudget },
              limit: 5,
            },
          })
        ).results ?? []
      );
    },
    enabled: false,
  });
</script>

<div class="max-w-3xl mx-auto p-4 space-y-4">
  <h1 class="text-2xl font-bold">🍱 Lunch Picker</h1>
  <div class="grid gap-3 bg-white rounded-2xl p-4 shadow-sm">
    <input type="range" min="300" max="3000" step="100" bind:value={radius} />
    <select bind:value={budgetMax} class="border rounded-xl p-2">
      <option value="">予算なし</option>
      <option value="1">~1</option>
      <option value="2">~2</option>
      <option value="3">~3</option>
      <option value="4">~4</option>
    </select>
    <input placeholder="カレー, ラーメン" bind:value={cuisine} class="border rounded-xl p-2" />
    <Button on:click={() => q.refetch()}>探す</Button>
  </div>

  {#if q.isFetching}
    <p class="text-sm text-gray-500">検索中…</p>
  {:else if q.data?.length}
    <div class="space-y-3">
      {#each q.data as r}
        <article class="bg-white rounded-2xl p-4 shadow-sm">
          <div class="flex justify-between">
            <div>
              <h2 class="font-semibold">{r.name}</h2>
              <p class="text-xs text-gray-500">
                ★{r.rating ?? '-'}・{Math.round(r.distance_m)}m・価格:{r.price_level ?? '-'}
              </p>
            </div>
            <a href={r.gmaps_url} target="_blank" class="text-xs underline">Google Maps</a>
          </div>
          <img src={r.static_map_url} alt="map" class="mt-3 rounded-xl" loading="lazy" />
        </article>
      {/each}
    </div>
  {:else}
    <p class="text-sm text-gray-500">候補がありません</p>
  {/if}
</div>
