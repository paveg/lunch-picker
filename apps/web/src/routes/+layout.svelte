<script lang="ts">
  import '../app.css';
  import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';

  const qc = new QueryClient();
</script>

<QueryClientProvider client={qc}>
  <slot />
</QueryClientProvider>
