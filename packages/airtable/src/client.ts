// Airtable REST client (workplan-9 §6). PAT auth, batched writes at the API's
// 10-records-per-request cap, and proactive throttling: Airtable allows
// 5 req/s per base, so calls are spaced minIntervalMs apart rather than
// relying on 429 retry-after alone — an initial backfill would otherwise blow
// through the limit immediately. A 429 that slips through anyway (another
// client on the same base) sleeps backoffMs and retries a bounded number of
// times; other non-2xx statuses throw with the response body.

export interface AirtableFields {
  [field: string]: unknown;
}

export interface AirtableClientOptions {
  apiKey: string;
  baseId: string;
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
  /** injectable for tests; defaults to setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** spacing between requests — 250ms = 4 req/s, under the 5/s base cap */
  minIntervalMs?: number;
  /** wait after a 429 (Airtable documents a 30s penalty window) */
  backoffMs?: number;
  /** retries after a 429 before giving up */
  maxRetries?: number;
}

const BATCH = 10;

export class AirtableClient {
  private readonly apiKey: string;
  private readonly baseId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly backoffMs: number;
  private readonly maxRetries: number;
  private lastRequestAt = 0;

  constructor(opts: AirtableClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseId = opts.baseId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minIntervalMs = opts.minIntervalMs ?? 250;
    this.backoffMs = opts.backoffMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  /** Create records; returns the new Airtable record ids in input order. */
  async createRecords(table: string, fieldsList: AirtableFields[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < fieldsList.length; i += BATCH) {
      const records = fieldsList.slice(i, i + BATCH).map((fields) => ({ fields }));
      const body = await this.request('POST', table, { records, typecast: true });
      for (const rec of (body as { records: Array<{ id: string }> }).records) ids.push(rec.id);
    }
    return ids;
  }

  /** Update existing records by Airtable record id. */
  async updateRecords(table: string, records: Array<{ id: string; fields: AirtableFields }>): Promise<void> {
    for (let i = 0; i < records.length; i += BATCH) {
      await this.request('PATCH', table, { records: records.slice(i, i + BATCH), typecast: true });
    }
  }

  /**
   * Cheap read — the Settings page's "Test connection" probe. Lists at most
   * `maxRecords` rows from `table`; a 2xx proves the PAT is valid, scoped to
   * the base, and the table exists. Any failure throws with status + body.
   */
  async listRecords(table: string, maxRecords = 1): Promise<unknown[]> {
    const body = await this.request('GET', `${table}?maxRecords=${maxRecords}`);
    return (body as { records: unknown[] }).records;
  }

  /** Delete records by Airtable record id. */
  async deleteRecords(table: string, ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += BATCH) {
      const query = ids
        .slice(i, i + BATCH)
        .map((id) => `records[]=${encodeURIComponent(id)}`)
        .join('&');
      await this.request('DELETE', `${table}?${query}`);
    }
  }

  private async request(method: string, tableAndQuery: string, body?: unknown): Promise<unknown> {
    const [table = '', query] = tableAndQuery.split('?');
    const url = `https://api.airtable.com/v0/${this.baseId}/${encodeURIComponent(table)}${query ? `?${query}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`airtable ${method} ${table}: ${res.status} ${text.slice(0, 300)}`);
      }
      return res.json();
    }
  }
}
