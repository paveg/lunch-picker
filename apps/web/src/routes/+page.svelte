<script lang="ts">
  import Button from '$lib/ui/Button.svelte';
  import { createPostSearch } from '$lib/api/generated';
  import { get } from 'svelte/store';

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

  const searchMutation = createPostSearch();

  const triggerSearch = async () => {
    if (get(searchMutation).isPending) return;

    const loc = await getCoords();
    const parsedBudget = budgetMax && budgetMax !== '' ? Number(budgetMax) : null;

    try {
      await get(searchMutation).mutateAsync({
        data: {
          location: loc,
          radius_m: radius,
          cuisine: cuisine
            ? cuisine
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          budget: parsedBudget == null || Number.isNaN(parsedBudget) ? null : { max: parsedBudget },
          limit: 5,
        },
      });
    } catch (error) {
      console.error('Search request failed', error);
    }
  };
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
    <Button on:click={triggerSearch} disabled={$searchMutation.isPending}>探す</Button>
  </div>

  {#if $searchMutation.isPending}
    <p class="text-sm text-gray-500">検索中…</p>
  {:else if $searchMutation.isSuccess && $searchMutation.data?.results?.length}
    <div class="space-y-3">
      {#each $searchMutation.data?.results ?? [] as r}
        <article class="bg-white rounded-2xl p-4 shadow-sm">
          <div class="flex justify-between">
            <div>
              <h2 class="font-semibold">{r.name}</h2>
              <p class="text-xs text-gray-500">
                ★{r.rating ?? '-'}・{Math.round(r.distance_m)}m・価格:{r.price_level ?? '-'}
                {#if r.open_now !== null}
                  ・{r.open_now ? '営業中' : '営業時間外'}
                {/if}
              </p>
            </div>
            <a href={r.gmaps_url} target="_blank" class="text-xs underline">Google Maps</a>
          </div>
          <img src={r.static_map_url} alt="map" class="mt-3 rounded-xl" loading="lazy" />
        </article>
      {/each}
    </div>
  {:else if $searchMutation.isError}
    <p class="text-sm text-red-500">検索に失敗しました</p>
  {:else}
    <p class="text-sm text-gray-500">候補がありません</p>
  {/if}
</div>
