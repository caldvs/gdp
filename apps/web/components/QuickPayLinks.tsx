import { ExternalLink } from 'lucide-react';
import { formatGBP } from '@gdp/core/lib/money';
import { monzoPayUrl, revolutPayUrl } from '@gdp/core/lib/quickPay';
import { Mini } from './ui';

/**
 * "Pay with Monzo / Revolut" buttons, shown above the bank details when
 * the lead added a handle. Both open in a new tab: on a phone with the
 * app installed, the link hands over to the banking app.
 */
export function QuickPayLinks({ monzoHandle, revolutTag, amountPence, note }: {
  monzoHandle?: string; revolutTag?: string; amountPence?: number; note?: string;
}) {
  const monzo = monzoHandle ? monzoPayUrl(monzoHandle, amountPence, note) : null;
  const revolut = revolutTag ? revolutPayUrl(revolutTag) : null;
  if (!monzo && !revolut) return null;
  return (
    <div className="quick-pay">
      {monzo ? (
        <a className="btn quick-pay__btn quick-pay__btn--monzo" href={monzo} target="_blank" rel="noopener noreferrer">
          Pay with Monzo<ExternalLink size={14} aria-hidden />
        </a>
      ) : null}
      {revolut ? (
        <a className="btn quick-pay__btn quick-pay__btn--revolut" href={revolut} target="_blank" rel="noopener noreferrer">
          Pay with Revolut<ExternalLink size={14} aria-hidden />
        </a>
      ) : null}
      {revolut && amountPence !== undefined ? (
        <Mini className="t-center">in revolut, enter {formatGBP(amountPence)}</Mini>
      ) : null}
      <Mini className="t-center quick-pay__or">or pay by bank transfer</Mini>
    </div>
  );
}
