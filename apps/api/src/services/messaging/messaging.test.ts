import { describe, expect, it, vi } from 'vitest';
import { formatUkMobile, maskPhone, parseUkMobile } from './phone.js';
import { AwsSmsSender, ConsoleSmsSender } from './sms.js';

describe('phone numbers', () => {
  it('masks for logs', () => {
    expect(maskPhone('+447700900123')).toBe('+44•••••••123');
    expect(maskPhone('123')).toBe('•••');
  });

  it('#213: parses UK mobiles as typed', () => {
    for (const t of [
      '07700 900123',
      '7700900123',
      '+44 7700 900123',
      '0044 7700-900123',
      '(07700) 900 123',
    ]) {
      expect(parseUkMobile(t)).toBe('+447700900123');
    }
    for (const t of ['020 7946 0000', '0770090012', '+1 555 165 1251', 'abc', '']) {
      expect(parseUkMobile(t)).toBeNull();
    }
    expect(formatUkMobile('+447700900123')).toBe('+44 7700 900123');
  });
});

describe('#231 AWS SMS', () => {
  it('sends a transactional text from the sender ID', async () => {
    const send = vi.fn((_cmd: unknown) => Promise.resolve({ MessageId: 'm-1' }));
    const s = new AwsSmsSender({ senderId: 'PayMeBack' }, { send } as never);
    expect(await s.send('+447700900123', 'hi')).toEqual({ messageId: 'm-1' });
    expect((send.mock.calls[0]![0] as { input: unknown }).input).toEqual({
      DestinationPhoneNumber: '+447700900123',
      OriginationIdentity: 'PayMeBack',
      MessageBody: 'hi',
      MessageType: 'TRANSACTIONAL',
    });
    const c = new ConsoleSmsSender();
    await c.send('+447700900123', 'x');
    expect(c.outbox).toEqual([{ to: '+447700900123', body: 'x' }]);
  });
});
