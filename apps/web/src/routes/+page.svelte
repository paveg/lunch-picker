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

  function handleSubmit(e: Event) {
    e.preventDefault();
    triggerSearch();
  }

  // Calculate walking time in minutes (average walking speed: 80m/min or 4.8km/h)
  function calculateWalkTime(distanceMeters: number): { oneWay: number; roundTrip: number } {
    const walkingSpeedMPerMin = 80;
    const oneWay = Math.ceil(distanceMeters / walkingSpeedMPerMin);
    const roundTrip = oneWay * 2;
    return { oneWay, roundTrip };
  }
</script>

<main class="max-w-3xl mx-auto p-4 space-y-4">
  <h1 class="text-2xl font-bold">🍱 Lunch Picker</h1>

  <form on:submit={handleSubmit} class="grid gap-4 bg-white rounded-2xl p-4 shadow-sm">
    <div class="grid gap-2">
      <label for="radius" class="text-sm font-medium text-gray-700">
        検索範囲: {radius}m
      </label>
      <input
        id="radius"
        type="range"
        min="300"
        max="3000"
        step="100"
        bind:value={radius}
        aria-valuemin="300"
        aria-valuemax="3000"
        aria-valuenow={radius}
        aria-label="検索範囲（メートル）"
        class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
      />
    </div>

    <div class="grid gap-2">
      <label for="budget" class="text-sm font-medium text-gray-700">予算</label>
      <select
        id="budget"
        bind:value={budgetMax}
        class="border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
      >
        <option value="">予算なし</option>
        <option value="1">~1,000円</option>
        <option value="2">~2,000円</option>
        <option value="3">~3,000円</option>
        <option value="4">~4,000円</option>
      </select>
    </div>

    <div class="grid gap-2">
      <label for="cuisine" class="text-sm font-medium text-gray-700">料理の種類</label>
      <input
        id="cuisine"
        type="text"
        placeholder="カレー, ラーメン"
        bind:value={cuisine}
        aria-label="料理の種類（カンマ区切り）"
        class="border border-gray-300 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
      />
    </div>

    <Button type="submit" disabled={$searchMutation.isPending}>
      {$searchMutation.isPending ? '検索中...' : '探す'}
    </Button>
  </form>

  <div aria-live="polite" aria-atomic="true">
    {#if $searchMutation.isPending}
      <p class="text-sm text-gray-500">検索中…</p>
    {:else if $searchMutation.isSuccess && $searchMutation.data?.results?.length}
      <div class="space-y-3" role="region" aria-label="検索結果">
        {#each $searchMutation.data?.results ?? [] as r}
          <article class="bg-white rounded-2xl p-4 shadow-sm">
            <div class="flex justify-between items-start gap-4">
              <div class="flex-1 min-w-0">
                <h2 class="font-semibold text-lg">{r.name}</h2>
                <p class="text-sm text-gray-600 mt-1">
                  <span aria-label="評価">★{r.rating ?? '-'}</span>
                  <span aria-hidden="true">・</span>
                  <span aria-label="距離と移動時間">
                    {Math.round(r.distance_m)}m (徒歩
                    {#if calculateWalkTime(r.distance_m).roundTrip >= 60}
                      約{Math.round(calculateWalkTime(r.distance_m).roundTrip / 60)}時間
                    {:else}
                      {calculateWalkTime(r.distance_m).oneWay}分
                    {/if}、往復{calculateWalkTime(r.distance_m).roundTrip}分)
                  </span>
                  <span aria-hidden="true">・</span>
                  <span aria-label="価格">価格:{r.price_level ?? '-'}</span>
                  {#if r.open_now !== null}
                    <span aria-hidden="true">・</span>
                    <span aria-label="営業状況">{r.open_now ? '営業中' : '営業時間外'}</span>
                  {/if}
                </p>
              </div>
              <a
                href={r.gmaps_url}
                target="_blank"
                rel="noopener noreferrer"
                class="text-sm text-indigo-600 hover:text-indigo-800 underline whitespace-nowrap min-h-[44px] flex items-center"
                aria-label="{r.name}をGoogle Mapsで開く"
              >
                Maps
              </a>
            </div>
            <img
              src={r.static_map_url}
              alt="{r.name}の地図"
              class="mt-3 rounded-xl w-full"
              loading="lazy"
              width="640"
              height="360"
            />
          </article>
        {/each}
      </div>
    {:else if $searchMutation.isError}
      <p class="text-sm text-red-600" role="alert">検索に失敗しました</p>
    {:else}
      <p class="text-sm text-gray-500">候補がありません</p>
    {/if}
  </div>
</main>
