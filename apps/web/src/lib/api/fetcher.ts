import { PUBLIC_API_BASE_URL } from '$env/static/public';

export type FetcherConfig<TVariables> = {
  url: string;
  method: string;
  params?: Record<string, unknown>;
  headers?: HeadersInit;
  data?: TVariables;
  signal?: AbortSignal;
  baseURL?: string;
};

function buildUrl(url: string, params?: Record<string, unknown>, baseURL?: string) {
  const searchParams = new URLSearchParams();
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value == null) return;
      if (Array.isArray(value)) {
        value.forEach((item) => searchParams.append(key, String(item)));
      } else {
        searchParams.append(key, String(value));
      }
    });
  }

  const hasBase = baseURL ? mergeBaseAndPath(baseURL, url) : url;

  const queryString = searchParams.toString();
  return queryString ? `${hasBase}?${queryString}` : hasBase;
}

const DEFAULT_BASE_URL = PUBLIC_API_BASE_URL || '/api';

function mergeBaseAndPath(baseURL: string, path: string) {
  if (!/^https?:/i.test(baseURL)) {
    const separator = baseURL.endsWith('/') || path.startsWith('/') ? '' : '/';
    return `${baseURL}${separator}${path.replace(/^\//, '')}`;
  }

  const base = new URL(baseURL);
  if (!base.pathname || base.pathname === '/') {
    base.pathname = '/api/';
  } else if (!base.pathname.endsWith('/')) {
    base.pathname = `${base.pathname}/`;
  }

  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  return new URL(normalizedPath, base).toString();
}

export async function fetcher<TData, TVariables = unknown>(
  config: FetcherConfig<TVariables>
): Promise<TData> {
  const { url, method, params, headers, data, signal, baseURL } = config;
  const requestUrl = buildUrl(url, params, baseURL ?? DEFAULT_BASE_URL);

  let body: BodyInit | undefined;
  let resolvedHeaders: HeadersInit | undefined = headers;

  if (data instanceof FormData || data instanceof URLSearchParams || data instanceof Blob) {
    body = data as BodyInit;
  } else if (data !== undefined) {
    body = JSON.stringify(data);
    resolvedHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };
  }

  const response = await fetch(requestUrl, {
    method,
    headers: resolvedHeaders,
    body,
    signal,
  });

  const text = await response.text();
  let parsed: TData | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as TData;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const error = new Error(`Request failed with status ${response.status}`);
    (error as Error & { response?: Response }).response = response;
    (error as Error & { body?: string }).body = text;
    throw error;
  }

  if (parsed === null) {
    throw new Error('Failed to parse response body');
  }

  return parsed;
}
