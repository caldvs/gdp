import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import {
  ParsedBillFromImageSchema,
  type ParsedBillFromImage,
  type ReadBy,
} from '../services/bills/parser.js';
import type { Venue } from '../types/bills.js';

/**
 * What a parser read from one photo: `ANALYSIS#<sha256>` / `P#<fingerprint>`.
 * Shared by everyone (Callum, 4 Nov 2026): it holds no user id, only what's
 * printed on the receipt, and can only be found by someone with the exact
 * bytes. Never amended; a lead's corrections live on their bill. Rows expire
 * after 30 days. Failed reads are never written.
 * See docs/design/analysis-cache.md.
 */
export type Analysis = {
  parsed: ParsedBillFromImage;
  venue?: Venue;
  /** The model and prompt version that read it (the bill's parsedFrom.parser). */
  readBy: ReadBy;
  analysedAt: string;
};

export const ANALYSIS_TTL_DAYS = 30;

const pk = (sha256: string) => `ANALYSIS#${sha256}`;
const sk = (fingerprint: string) => `P#${fingerprint}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

export const analysisStore = {
  async get(sha256: string, fingerprint: string): Promise<Analysis | null> {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: pk(sha256), sk: sk(fingerprint) } }),
    );
    // DynamoDB deletes expired rows lazily: one past its TTL is a miss.
    if (!Item || (typeof Item.ttlAt === 'number' && Item.ttlAt <= nowSeconds())) return null;
    // A row that no longer fits the parser's schema is read again.
    const parsed = ParsedBillFromImageSchema.safeParse(Item.parsed);
    if (!parsed.success) return null;
    return {
      parsed: parsed.data,
      ...(Item.venue ? { venue: Item.venue as Venue } : {}),
      readBy: { model: Item.parser as string, version: Item.parserVersion as string },
      analysedAt: Item.analysedAt as string,
    };
  },

  /**
   * Writes the row unless a live one is there. Two reads of the same new
   * photo race here; the first one wins and the other's result is dropped
   * (its own bill keeps it). Returns whether this write won.
   */
  async putIfAbsent(sha256: string, fingerprint: string, analysis: Analysis): Promise<boolean> {
    const analysedAtSeconds = Math.floor(Date.parse(analysis.analysedAt) / 1000);
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pk: pk(sha256),
            sk: sk(fingerprint),
            parsed: analysis.parsed,
            ...(analysis.venue ? { venue: analysis.venue } : {}),
            parser: analysis.readBy.model,
            parserVersion: analysis.readBy.version,
            fingerprint,
            analysedAt: analysis.analysedAt,
            ttlAt: analysedAtSeconds + ANALYSIS_TTL_DAYS * 24 * 60 * 60,
          },
          ConditionExpression: 'attribute_not_exists(pk) OR ttlAt <= :now',
          ExpressionAttributeValues: { ':now': nowSeconds() },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  },
};
