<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let variant: 'primary' | 'secondary' | 'ghost' = 'primary';
  export let disabled = false;

  const dispatch = createEventDispatcher<{ click: MouseEvent }>();

  function handleClick(event: MouseEvent) {
    if (disabled) return;
    dispatch('click', event);
  }
</script>

<button
  class="inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium shadow-sm transition
         disabled:opacity-50 disabled:cursor-not-allowed
         bg-indigo-600 text-white hover:bg-indigo-700
         data-[v=secondary]:bg-white data-[v=secondary]:text-gray-900 data-[v=secondary]:border data-[v=secondary]:hover:bg-gray-50
         data-[v=ghost]:bg-transparent data-[v=ghost]:text-gray-700 data-[v=ghost]:hover:bg-gray-100"
  data-v={variant}
  {disabled}
  on:click={handleClick}
>
  <slot />
</button>
