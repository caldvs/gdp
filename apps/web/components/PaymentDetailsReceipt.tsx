'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { formatGBP } from '@gdp/core/lib/money';
import { copyText } from '@/lib/clipboard';
import { Mini, Receipt } from './ui';

export type PaymentBankDetails = { accountHolderName: string; sortCode: string; accountNumber: string };

export function PaymentDetailsReceipt({ bankDetails, reference, amountPence, intro = 'open your banking app, transfer to' }: {
  bankDetails: PaymentBankDetails; reference?: string; amountPence?: number; intro?: string;
}) {
  return (
    <div className="stack gap-xs">
      {intro ? <Mini>{intro}</Mini> : null}
      <Receipt>
        <CopyRow label="name" value={bankDetails.accountHolderName} mono={false} />
        <CopyRow label="sort code" value={formatSortCode(bankDetails.sortCode)} rawValue={bankDetails.sortCode} />
        <CopyRow label="account number" value={bankDetails.accountNumber} />
        {reference ? <CopyRow label="reference" value={reference} /> : <PlaceholderRow label="reference" />}
        {amountPence !== undefined ? (
          <CopyRow label="amount" value={formatGBP(amountPence)} rawValue={(amountPence / 100).toFixed(2)} />
        ) : null}
      </Receipt>
    </div>
  );
}

export function CopyRow({ label, value, rawValue, mono = true }: { label: string; value: string; rawValue?: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onCopy = async () => {
    await copyText(rawValue ?? value);
    setCopied(true);
    if (typeof navigator.vibrate === 'function') navigator.vibrate(40);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1100);
  };
  return (
    <div className="copy-row">
      <div className="copy-row__body">
        <Mini>{label}</Mini>
        <div className={mono ? 'copy-row__v copy-row__v--mono' : 'copy-row__v'}>{value}</div>
      </div>
      <button type="button" className={copied ? 'copy-chip copy-chip--copied' : 'copy-chip'} onClick={onCopy} aria-label={`Copy ${label}`}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
        <span aria-live="polite">{copied ? 'copied' : 'copy'}</span>
      </button>
    </div>
  );
}

function PlaceholderRow({ label }: { label: string }) {
  return (
    <div className="copy-row">
      <div className="copy-row__body">
        <Mini>{label}</Mini>
        <div className="copy-row__v copy-row__v--mono t-mute">preparing…</div>
      </div>
      <button type="button" className="copy-chip" disabled><Copy size={12} /> copy</button>
    </div>
  );
}

function formatSortCode(raw: string): string {
  return raw.length === 6 ? `${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4)}` : raw;
}
