export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30000),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const detail = data?.msg || data?.message || JSON.stringify(data).slice(0, 500);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return data;
}

export function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
