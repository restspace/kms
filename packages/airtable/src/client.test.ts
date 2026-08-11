import { describe, expect, it } from 'vitest';
import { AirtableClient } from './client';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(responses?: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(url), method: init?.method ?? 'GET', body });
    const next = responses?.[Math.min(i++, (responses?.length ?? 1) - 1)] ?? { status: 200 };
    if (next.status !== 200) return new Response('{"error":"x"}', { status: next.status });
    const records = (body?.records ?? []).map((r: { id?: string }, j: number) => ({
      id: r.id ?? `rec-${calls.length}-${j}`,
      fields: {},
    }));
    return new Response(JSON.stringify(next.body ?? { records }), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function client(f: typeof fetch, slept: number[], extra = {}) {
  return new AirtableClient({
    apiKey: 'pat-test',
    baseId: 'appTEST',
    fetchImpl: f,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...extra,
  });
}

describe('AirtableClient', () => {
  it('batches creates at 10 records per request and returns rec ids in input order', async () => {
    const { impl, calls } = fakeFetch();
    const slept: number[] = [];
    const ids = await client(impl, slept).createRecords(
      'Submissions',
      Array.from({ length: 25 }, (_, i) => ({ Title: `t${i}` })),
    );
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (c.body as { records: unknown[] }).records.length)).toEqual([10, 10, 5]);
    expect(ids).toHaveLength(25);
    expect(ids[0]).toBe('rec-1-0');
    expect(ids[24]).toBe('rec-3-4');
    expect(calls[0]!.url).toBe('https://api.airtable.com/v0/appTEST/Submissions');
    expect(calls[0]!.method).toBe('POST');
  });

  it('throttles consecutive requests to stay under the 5 req/s base cap', async () => {
    const { impl } = fakeFetch();
    const slept: number[] = [];
    await client(impl, slept).createRecords(
      'Submissions',
      Array.from({ length: 30 }, () => ({})),
    );
    // 3 requests: the 2nd and 3rd must be spaced out (first needs no wait)
    expect(slept.length).toBeGreaterThanOrEqual(2);
    for (const ms of slept) expect(ms).toBeLessThanOrEqual(250);
  });

  it('backs off and retries on 429 instead of dying', async () => {
    const { impl, calls } = fakeFetch([{ status: 429 }, { status: 200 }]);
    const slept: number[] = [];
    await client(impl, slept, { backoffMs: 30_000 }).updateRecords('Tasks', [{ id: 'rec1', fields: {} }]);
    expect(calls).toHaveLength(2);
    expect(slept).toContain(30_000);
  });

  it('gives up after maxRetries consecutive 429s', async () => {
    const { impl, calls } = fakeFetch([{ status: 429 }]);
    const slept: number[] = [];
    await expect(
      client(impl, slept, { maxRetries: 2, backoffMs: 1 }).updateRecords('Tasks', [{ id: 'rec1', fields: {} }]),
    ).rejects.toThrow(/429/);
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  it('throws with status and body excerpt on other errors', async () => {
    const { impl } = fakeFetch([{ status: 422 }]);
    await expect(client(impl, []).createRecords('Bad', [{}])).rejects.toThrow(/airtable POST Bad: 422/);
  });

  it('deletes in batches of 10 via records[] query params', async () => {
    const { impl, calls } = fakeFetch();
    await client(impl, []).deleteRecords(
      'Rooms',
      Array.from({ length: 12 }, (_, i) => `rec${i}`),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('records[]=rec0');
    expect(calls[1]!.url).toContain('rec10');
  });
});
