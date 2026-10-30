import { describe, it, expect, vi } from 'vitest';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SesEmailSender } from './sesSender.js';

type SendFn = (cmd: SendEmailCommand) => Promise<{ MessageId: string }>;

describe('SesEmailSender', () => {
  function makeClient(sendImpl: SendFn): SESv2Client {
    return { send: vi.fn<SendFn>(sendImpl) } as unknown as SESv2Client;
  }

  it('builds a SendEmailCommand with the configured from-address and supplied body', async () => {
    const send = vi.fn<SendFn>(() => Promise.resolve({ MessageId: 'm-1' }));
    const client = { send } as unknown as SESv2Client;
    const sender = new SesEmailSender({
      fromAddress: 'noreply@gdp.app',
      client,
    });

    await sender.send({
      to: 'alice@example.com',
      subject: 'Your code',
      body: { text: 'Code: 123456', html: '<p>Code: <b>123456</b></p>' },
      category: 'otp',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]![0];
    expect(cmd).toBeInstanceOf(SendEmailCommand);
    expect(cmd.input.FromEmailAddress).toBe('noreply@gdp.app');
    expect(cmd.input.Destination?.ToAddresses).toEqual(['alice@example.com']);
    expect(cmd.input.Content?.Simple?.Subject?.Data).toBe('Your code');
    expect(cmd.input.Content?.Simple?.Body?.Text?.Data).toBe('Code: 123456');
    expect(cmd.input.Content?.Simple?.Body?.Html?.Data).toBe('<p>Code: <b>123456</b></p>');
    expect(cmd.input.EmailTags).toEqual([{ Name: 'category', Value: 'otp' }]);
  });

  it('omits EmailTags when no category supplied', async () => {
    const send = vi.fn<SendFn>(() => Promise.resolve({ MessageId: 'm-2' }));
    const client = { send } as unknown as SESv2Client;
    const sender = new SesEmailSender({ fromAddress: 'noreply@gdp.app', client });

    await sender.send({
      to: 'bob@example.com',
      subject: 'Hi',
      body: { text: 'hi', html: '<p>hi</p>' },
    });

    const cmd = send.mock.calls[0]![0];
    expect(cmd.input.EmailTags).toBeUndefined();
  });

  it('propagates SDK errors so callers can react / retry', async () => {
    const boom = new Error('throttled');
    const client = makeClient(() => Promise.reject(boom));
    const sender = new SesEmailSender({ fromAddress: 'noreply@gdp.app', client });

    await expect(
      sender.send({
        to: 'c@example.com',
        subject: 's',
        body: { text: 't', html: 'h' },
      }),
    ).rejects.toBe(boom);
  });

  it("reports its provider as 'ses'", () => {
    const sender = new SesEmailSender({
      fromAddress: 'noreply@gdp.app',
      client: {} as SESv2Client,
    });
    expect(sender.provider).toBe('ses');
  });
});
