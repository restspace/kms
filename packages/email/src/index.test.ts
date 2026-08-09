// Unit test for sweep item P2-20: provider-level idempotency. Resend gets a
// real Idempotency-Key header; SendGrid's v3 mail/send API has no such
// header, so it gets a custom_args tag instead (documented residual risk in
// the provider code). Runs in the 'unit' vitest project (node env, no
// workerd needed) with a stubbed global fetch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResendProvider, createSendGridProvider } from './index';

const baseMail = {
  to: 'speaker@example.com',
  subject: 'Hello',
  text: 'plain',
  html: '<p>html</p>',
};

describe('provider idempotency', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Resend request carries Idempotency-Key equal to log_key', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: 'resend-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createResendProvider('test-key', 'KMS <no-reply@example.com>');
    await provider.send({ ...baseMail, log_key: 'decision_accepted:con-1:sub-1:v1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('decision_accepted:con-1:sub-1:v1');
  });

  it('Resend request omits the header when log_key is absent', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: 'resend-2' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createResendProvider('test-key', 'KMS <no-reply@example.com>');
    await provider.send(baseMail);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });

  it('SendGrid request tags the send with custom_args.idempotency_key (no native idempotency header on v3 mail/send)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('', { status: 200, headers: { 'x-message-id': 'sg-1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createSendGridProvider('test-key', 'KMS <no-reply@example.com>');
    await provider.send({ ...baseMail, log_key: 'schedule_confirmed:con-1:sess-1:v0' });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string) as { custom_args?: { idempotency_key?: string } };
    expect(body.custom_args?.idempotency_key).toBe('schedule_confirmed:con-1:sess-1:v0');
  });
});
