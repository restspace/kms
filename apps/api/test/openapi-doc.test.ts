// The OpenAPI document is generated from the RESOURCES registry, so drift shows
// up as a malformed document rather than a stale sentence. These checks are the
// ones a human reviewer cannot do by eye: that every $ref resolves, that
// operationIds are unique (agent tooling turns them into function names), and
// that every filter the query executor accepts is either published or
// deliberately marked unavailable.

import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { RESOURCES } from '../src/routes/adminApi';

interface Doc {
  openapi: string;
  info: { title: string; description: string };
  paths: Record<string, Record<string, { operationId?: string; parameters?: { name: string; in: string }[] }>>;
  components: { schemas: Record<string, unknown> };
}

const METHODS = ['get', 'post', 'put', 'delete'];

/** Every `$ref` string anywhere in the document. */
function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

function resolve(doc: unknown, pointer: string): unknown {
  return pointer
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], doc);
}

describe('GET /api/v1/openapi.json', () => {
  let doc: Doc;

  beforeAll(async () => {
    const res = await SELF.fetch('https://example.com/api/v1/openapi.json');
    expect(res.status).toBe(200);
    doc = (await res.json()) as Doc;
  });

  it('is served without credentials and declares OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.description).toContain('GET /events');
  });

  it('resolves every $ref', () => {
    const refs = [...new Set(collectRefs(doc))];
    expect(refs.length).toBeGreaterThan(20);
    for (const pointer of refs) {
      expect(pointer.startsWith('#/'), `${pointer} is not a local ref`).toBe(true);
      expect(resolve(doc, pointer), `${pointer} does not resolve`).toBeDefined();
    }
  });

  it('gives every operation a unique operationId', () => {
    const ids: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        expect(op.operationId, `${method.toUpperCase()} ${path} has no operationId`).toBeTruthy();
        ids.push(op.operationId!);
      }
    }
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('publishes every registry filter that a query string can carry', () => {
    // The two exceptions are documented in the list description rather than as
    // parameters: one takes an array, the other only applies to the SPA's
    // organisation-directory mode.
    const unavailable = new Set(['contacts.contact_ids', 'contacts.events']);
    for (const [resource, def] of Object.entries(RESOURCES)) {
      const op = doc.paths[`/events/{event_id}/${resource}`]?.get;
      expect(op, `no list operation for ${resource}`).toBeDefined();
      // Shared controls are $refs into components/parameters; resolve them so
      // this reads the same vocabulary a client would.
      const published = new Set(
        (op!.parameters ?? []).map((p) => {
          const pointer = (p as unknown as { $ref?: string }).$ref;
          return pointer ? (resolve(doc, pointer) as { name: string }).name : p.name;
        }),
      );
      for (const filter of Object.keys(def.filters)) {
        if (unavailable.has(`${resource}.${filter}`)) {
          expect(published.has(filter)).toBe(false);
          expect(JSON.stringify(op)).toContain(filter);
        } else {
          expect(published.has(filter), `${resource}.${filter} is not documented`).toBe(true);
        }
      }
      for (const control of ['event_id', 'cursor', 'limit', 'offset', 'sort']) {
        expect(published.has(control), `${resource} list is missing ?${control}`).toBe(true);
      }
    }
  });

  it('is advertised by /llms.txt, whose links all resolve', async () => {
    const res = await SELF.fetch('https://example.com/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    const text = await res.text();

    // llmstxt.org shape: an H1, then a blockquote summary.
    expect(text.startsWith('# ')).toBe(true);
    expect(text).toMatch(/\n> .+/);

    // The point of the file: the spec URL, on the host it was fetched from.
    expect(text).toContain('https://example.com/api/v1/openapi.json');

    // Every absolute link it advertises must be a route this app serves — a
    // stale link sends an agent somewhere that does not exist. The human
    // surfaces legitimately answer 401 when signed out, so the bar is "not a
    // missing route", not "200".
    const links = [...text.matchAll(/\]\((https:\/\/example\.com[^)]*)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(3);
    for (const url of [...new Set(links)]) {
      const hit = await SELF.fetch(url, { redirect: 'manual' });
      expect(hit.status, `${url} is advertised but answers ${hit.status}`).not.toBe(404);
      expect(hit.status, `${url} is advertised but answers ${hit.status}`).toBeLessThan(500);
    }
  });

  it('describes only endpoints that exist — every path is a real route', async () => {
    // A 404 from the router itself (no matching route) comes back as Hono's
    // plain-text "404 Not Found"; every documented path must instead reach the
    // API and be turned away by its own auth layer with a JSON error body.
    for (const path of Object.keys(doc.paths)) {
      if (path === '/openapi.json') continue;
      const url = `https://example.com/api/v1${path
        .replace('{event_id}', 'evt_missing')
        .replace('{id}', 'rec_missing')}`;
      for (const method of METHODS) {
        if (!doc.paths[path]![method]) continue;
        const res = await SELF.fetch(url, {
          method: method.toUpperCase(),
          headers: { 'content-type': 'application/json' },
          body: method === 'get' || method === 'delete' ? undefined : '{}',
        });
        expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
        expect(res.headers.get('content-type')).toContain('application/json');
      }
    }
  });
});
