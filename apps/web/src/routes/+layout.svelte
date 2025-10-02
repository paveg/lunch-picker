<script lang="ts">
  import '../app.css';
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
  import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
  import { browser, dev } from '$app/environment';

  const qc = new QueryClient();
</script>

<QueryClientProvider client={qc}>
  <slot />
  {#if dev && browser}
    <SvelteQueryDevtools initialIsOpen={false} position="bottom-right" />
  {/if}
</QueryClientProvider>
