/**
 * Golden receipts: read every photo in fixtures/receipts/ with the real
 * bill reader and check the result against what's printed on the bill.
 * Catches prompt or model regressions before they reach anyone's table.
 *
 * Each receipt is a photo plus a JSON file with the same name:
 *
 *   fixtures/receipts/pizza-express-4.jpg
 *   fixtures/receipts/pizza-express-4.json   { "totalPence": 6475, "lines": 9 }
 *
 * `totalPence` (required) is the printed total including service and tax.
 * `lines` (optional) is the number of item lines on the bill.
 * `servicePence`, `taxPence` (optional) are checked when present.
 * `venue` (optional) is the place's name as printed, or `null` for a bill
 * that names none: the reader must give exactly that (ignoring case and
 * punctuation), or no name at all.
 * `items` (optional) are the printed lines, after any discount is taken off
 * its item: `{ "name", "quantity", "lineTotalPence" }`. Each is matched to a
 * read line by name, and a wrong quantity or price is reported.
 *
 * Run with the parser settings you want to test:
 *
 *   BEDROCK_MODEL_ID=eu.anthropic.claude-sonnet-4-6 AWS_PROFILE=gdp-dev \
 *     npm run golden -w apps/api
 *   npm run golden -w apps/api -- pizza-express-4          # one receipt
 *
 * Or through a deployed API (no AWS credentials needed: it signs in as a new
 * `@test.invalid` account, so nothing is served from an earlier read):
 *
 *   npm run golden -w apps/api -- --api https://api.test.paymeback.dev
 *
 * Exits non-zero if any receipt fails. Not part of CI: it costs real calls.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createBillParser } from '../src/services/bills/bedrockParser.js';
import { readByOf } from '../src/services/bills/parser.js';
import { sameVenueName } from '../src/services/bills/venueResolver.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/receipts');
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

type ExpectedLine = { name: string; quantity: number; lineTotalPence: number };
type ReadLine = { name: string; unitPricePence: number; quantity: number };
type Expected = {
  totalPence: number;
  lines?: number;
  servicePence?: number;
  taxPence?: number;
  items?: ExpectedLine[];
  venue?: string | null;
};

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/(\d+)\s*ml\b/g, '$1ml')
      .split(/[^a-z0-9.]+/)
      .filter((w) => w.length >= 2),
  );
const likeness = (a: Set<string>, b: Set<string>) => {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / Math.max(a.size, b.size, 1);
};

/**
 * Matches each printed line to the read line most like it by name (read
 * lines with the same name are added up first: an uneven split makes two)
 * and lists what's wrong: a wrong quantity or price, a printed line nothing
 * matched, or a read line that matched nothing.
 */
export function checkLines(
  expected: ExpectedLine[],
  read: ReadLine[],
): { right: number; problems: string[] } {
  const groups = new Map<string, { name: string; quantity: number; total: number }>();
  for (const r of read) {
    const key = r.name.trim().toLowerCase();
    const g = groups.get(key) ?? { name: r.name, quantity: 0, total: 0 };
    g.quantity += r.quantity;
    g.total += r.unitPricePence * r.quantity;
    groups.set(key, g);
  }
  const left = [...groups.values()].map((g) => ({ ...g, words: words(g.name) }));
  const pairs = expected
    .flatMap((e, i) => left.map((g, j) => ({ i, j, score: likeness(words(e.name), g.words) })))
    .filter((p) => p.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  const takenE = new Set<number>();
  const takenR = new Set<number>();
  const match = new Map<number, number>();
  for (const p of pairs) {
    if (takenE.has(p.i) || takenR.has(p.j)) continue;
    takenE.add(p.i);
    takenR.add(p.j);
    match.set(p.i, p.j);
  }

  let right = 0;
  const problems: string[] = [];
  expected.forEach((e, i) => {
    const j = match.get(i);
    if (j === undefined) {
      problems.push(`missing ${e.quantity} × ${e.name} (${fmt(e.lineTotalPence)})`);
      return;
    }
    const g = left[j]!;
    if (g.quantity === e.quantity && g.total === e.lineTotalPence) {
      right += 1;
      return;
    }
    problems.push(
      `${e.name}: read ${g.quantity} for ${fmt(g.total)}, printed ${e.quantity} for ${fmt(e.lineTotalPence)}`,
    );
  });
  left.forEach((g, j) => {
    if (!takenR.has(j)) problems.push(`extra ${g.quantity} × ${g.name} (${fmt(g.total)})`);
  });
  return { right, problems };
}

const fmt = (p: number) => `£${(p / 100).toFixed(2)}`;

export function checkReceipt(
  expected: Expected,
  read: {
    items: ReadLine[];
    serviceChargePence: number;
    taxPence: number;
    venue?: { name?: string } | undefined;
  },
): string[] {
  const problems: string[] = [];
  if (expected.venue !== undefined) {
    const got = read.venue?.name;
    if (expected.venue === null && got) problems.push(`venue "${got}", bill names none`);
    if (expected.venue !== null && got && !sameVenueName(got, expected.venue)) {
      problems.push(`venue "${got}", printed "${expected.venue}"`);
    }
    if (expected.venue !== null && !got) problems.push(`no venue, printed "${expected.venue}"`);
  }
  const subtotal = read.items.reduce((a, i) => a + i.unitPricePence * i.quantity, 0);
  const total = subtotal + read.serviceChargePence + read.taxPence;
  if (total !== expected.totalPence) {
    problems.push(
      `total ${fmt(total)}, printed ${fmt(expected.totalPence)} (${fmt(total - expected.totalPence)} out)`,
    );
  }
  if (expected.lines !== undefined && read.items.length !== expected.lines) {
    problems.push(`${read.items.length} lines, bill has ${expected.lines}`);
  }
  if (expected.servicePence !== undefined && read.serviceChargePence !== expected.servicePence) {
    problems.push(`service ${fmt(read.serviceChargePence)}, printed ${fmt(expected.servicePence)}`);
  }
  if (expected.taxPence !== undefined && read.taxPence !== expected.taxPence) {
    problems.push(`tax ${fmt(read.taxPence)}, printed ${fmt(expected.taxPence)}`);
  }
  if (expected.items) {
    const lines = checkLines(expected.items, read.items);
    if (lines.problems.length > 0) {
      problems.push(`${lines.right}/${expected.items.length} lines right`, ...lines.problems);
    }
  }
  return problems;
}

type Reader = {
  label: string;
  read: (bytes: Uint8Array, name: string) => Promise<Parameters<typeof checkReceipt>[1]>;
};

/** Reads through a deployed API's own upload → read flow, as a new test account. */
async function apiReader(base: string): Promise<Reader> {
  const call = async <T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.token && { authorization: `Bearer ${init.token}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { code: string } };
    if (!res.ok) throw new Error(`${path}: ${res.status} ${body.error?.code ?? ''}`);
    return body;
  };
  const email = `golden-${Date.now()}@test.invalid`;
  const { token } = await call<{ token: string }>('/v1/auth/email/test-sign-in', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  type Bill = Parameters<typeof checkReceipt>[1] & { parsedFrom?: { parser?: string } };
  return {
    label: `${base} as ${email}`,
    read: async (bytes) => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const slot = await call<{ status: string; uploadId?: string; url?: string; billId?: string }>(
        '/v1/bills/uploads',
        {
          method: 'POST',
          token,
          body: JSON.stringify({ sha256, sizeBytes: bytes.length, mimeType: 'image/jpeg' }),
        },
      );
      let billId = slot.billId;
      if (slot.status === 'new') {
        const put = await fetch(slot.url!, {
          method: 'PUT',
          body: bytes,
          headers: { 'content-type': 'image/jpeg' },
        });
        if (!put.ok) throw new Error(`upload: ${put.status}`);
        let read = await call<{ readId: string; status: string; billId?: string; error?: unknown }>(
          '/v1/bills/reads',
          {
            method: 'POST',
            token,
            headers: { 'idempotency-key': crypto.randomUUID() },
            body: JSON.stringify({ uploadId: slot.uploadId }),
          },
        );
        for (let i = 0; i < 60 && read.status !== 'done' && read.status !== 'failed'; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          read = await call(`/v1/bills/reads/${read.readId}`, { token });
        }
        if (read.status !== 'done')
          throw new Error(`read ${read.status}: ${JSON.stringify(read.error)}`);
        billId = read.billId;
      }
      return call<Bill>(`/v1/bills/${billId}`, { token });
    },
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apiAt = args.indexOf('--api');
  const api = apiAt >= 0 ? args.splice(apiAt, 2)[1] : undefined;
  const only = new Set(args);
  const photos = existsSync(DIR)
    ? readdirSync(DIR)
        .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
        .filter((f) => only.size === 0 || only.has(basename(f, extname(f))))
        .sort()
    : [];
  if (photos.length === 0) {
    console.error(`No receipts in ${DIR}. Add a photo and a .json with its printed total.`);
    return 2;
  }

  let reader: Reader;
  if (api) {
    reader = await apiReader(api.replace(/\/$/, ''));
  } else {
    const parser = createBillParser({
      bedrockModelId: process.env.BEDROCK_MODEL_ID,
      region: process.env.AWS_REGION ?? 'eu-west-2',
    });
    reader = {
      label: `${parser.model} (${parser.version})`,
      read: async (bytes, name) => {
        const read = await parser.parse(bytes, `golden-${name}`);
        return { ...read, by: readByOf(parser, read).model };
      },
    };
  }
  console.log(`Reading ${photos.length} receipt(s) with ${reader.label}\n`);

  let failed = 0;
  for (const photo of photos) {
    const name = basename(photo, extname(photo));
    const spec = join(DIR, `${name}.json`);
    if (!existsSync(spec)) {
      console.log(`?  ${name}: no ${name}.json, skipped`);
      continue;
    }
    const expected = JSON.parse(readFileSync(spec, 'utf8')) as Expected;
    const started = Date.now();
    try {
      const read = await reader.read(new Uint8Array(readFileSync(join(DIR, photo))), name);
      const problems = checkReceipt(expected, read);
      const by =
        (read as { by?: string; parsedFrom?: { parser?: string } }).by ??
        (read as { parsedFrom?: { parser?: string } }).parsedFrom?.parser ??
        'api';
      const ms = Date.now() - started;
      if (problems.length === 0) {
        console.log(
          `✓  ${name}: ${read.items.length} lines, ${fmt(expected.totalPence)} (${by}, ${ms} ms)`,
        );
      } else {
        failed += 1;
        console.log(`✗  ${name} (${by}, ${ms} ms)\n     ${problems.join('\n     ')}`);
      }
    } catch (err) {
      failed += 1;
      console.log(`✗  ${name}: ${(err as Error).message}`);
    }
  }
  console.log(`\n${photos.length - failed}/${photos.length} read correctly`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
