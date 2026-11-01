/* eslint-disable no-console -- CLI script, console is the whole point */

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
 *
 * Run with the parser settings you want to test:
 *
 *   BEDROCK_MODEL_ID=eu.anthropic.claude-haiku-4-5-20251001-v1:0 AWS_PROFILE=gdp-dev \
 *     npm run golden -w apps/api
 *   npm run golden -w apps/api -- pizza-express-4          # one receipt
 *
 * Exits non-zero if any receipt fails. Not part of CI: it costs real calls.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBillParser } from '../src/services/bills/bedrockParser.js';
import { readByOf } from '../src/services/bills/parser.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/receipts');
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

type Expected = { totalPence: number; lines?: number; servicePence?: number; taxPence?: number };

const fmt = (p: number) => `£${(p / 100).toFixed(2)}`;

export function checkReceipt(
  expected: Expected,
  read: {
    items: { unitPricePence: number; quantity: number }[];
    serviceChargePence: number;
    taxPence: number;
  },
): string[] {
  const problems: string[] = [];
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
  return problems;
}

async function main(): Promise<number> {
  const only = new Set(process.argv.slice(2));
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

  const parser = createBillParser({
    bedrockModelId: process.env.BEDROCK_MODEL_ID,
    region: process.env.AWS_REGION ?? 'eu-west-2',
  });
  console.log(`Reading ${photos.length} receipt(s) with ${parser.model} (${parser.version})\n`);

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
      const read = await parser.parse(
        new Uint8Array(readFileSync(join(DIR, photo))),
        `golden-${name}`,
      );
      const problems = checkReceipt(expected, read);
      const by = readByOf(parser, read).model;
      const ms = Date.now() - started;
      if (problems.length === 0) {
        console.log(
          `✓  ${name}: ${read.items.length} lines, ${fmt(expected.totalPence)} (${by}, ${ms} ms)`,
        );
      } else {
        failed += 1;
        console.log(`✗  ${name}: ${problems.join('; ')} (${by}, ${ms} ms)`);
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
