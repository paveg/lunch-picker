export default {
  "lunch-picker": {
    input: './packages/openapi/openapi.yaml',
    output: {
      target: 'apps/web/src/lib/api/generated.ts',
      schemas: 'apps/web/src/lib/api/model',
      client: 'svelte-query',
      httpClient: 'fetch',
      mode: 'single',
      override: {
        mutator: {
          path: 'apps/web/src/lib/api/fetcher.ts',
          name: 'fetcher'
        }
      }
    }
  }
}
