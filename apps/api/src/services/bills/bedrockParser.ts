import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { AppError } from '../../errors/AppError.js';
import { baseLogger } from '../../logging/logger.js';
import { timed } from '../../logging/timed.js';
import { PROMPT, GeminiBillParser, validateParsedBill } from './geminiParser.js';
import { readByOf, type BillParser, type ParseResult, type ParsedBillFromImage } from './parser.js';

const VERSION = 'v2';

/**
 * Reads the bill with a vision model on Amazon Bedrock (Claude Haiku by
 * default), using the same prompt and output schema as the Gemini parser.
 * Runs on the Lambda's own AWS credentials: no API key.
 */
export class BedrockBillParser implements BillParser {
  readonly version = VERSION;
  private readonly client: BedrockRuntimeClient;

  constructor(
    readonly model: string,
    region: string,
  ) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async parse(image: Uint8Array, requestId: string): Promise<ParsedBillFromImage> {
    let out: ConverseCommandOutput;
    try {
      out = await timed(
        'bedrock',
        'converse',
        () =>
          this.client.send(
            new ConverseCommand({
              modelId: this.model,
              messages: [
                {
                  role: 'user',
                  content: [
                    { image: { format: 'jpeg', source: { bytes: image } } },
                    { text: PROMPT },
                  ],
                },
              ],
              inferenceConfig: { temperature: 0, maxTokens: 4096 },
              requestMetadata: { requestId },
            }),
          ),
        { requestId, model: this.model },
      );
    } catch (err) {
      const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
      throw new AppError('PARSE_FAILED', `Bedrock: ${e.name ?? 'error'}`, {
        status: e.$metadata?.httpStatusCode,
        body: (e.message ?? '').slice(0, 500),
      });
    }

    const text = out.output?.message?.content?.find((c) => 'text' in c && c.text)?.text;
    if (!text) throw new AppError('PARSE_FAILED', 'Bedrock response missing content');
    return validateParsedBill(text, 'Bedrock');
  }
}

/**
 * Try the first parser; if it fails for a reason other than "couldn't read
 * any items", try the second. Low confidence isn't retried: a second model
 * reading the same blurry photo rarely does better, and it doubles the wait.
 *
 * `model`/`version` name the primary (what we expect to answer); each
 * result's `readBy` names the one that did, so bills credit the right model.
 */
export class FallbackBillParser implements BillParser {
  readonly model: string;
  readonly version: string;

  constructor(
    private readonly primary: BillParser,
    private readonly secondary: BillParser,
  ) {
    this.model = primary.model;
    this.version = primary.version;
  }

  async parse(image: Uint8Array, requestId: string): Promise<ParseResult> {
    try {
      const result = await this.primary.parse(image, requestId);
      return { ...result, readBy: readByOf(this.primary, result) };
    } catch (err) {
      if (err instanceof AppError && err.code === 'PARSE_LOW_CONFIDENCE') throw err;
      baseLogger.warn(
        { event: 'bill.parse.fallback', requestId, from: this.primary.model, err },
        'Primary bill reader failed; trying the fallback',
      );
      const result = await this.secondary.parse(image, requestId);
      return { ...result, readBy: readByOf(this.secondary, result) };
    }
  }
}

/**
 * Bedrock when BEDROCK_MODEL_ID is set (with Gemini as the fallback if its
 * key is set too), else Gemini alone, else a parser that always fails.
 */
export const createBillParser = (cfg: {
  bedrockModelId?: string;
  region: string;
  geminiApiKey?: string;
}): BillParser => {
  const gemini = cfg.geminiApiKey ? new GeminiBillParser(cfg.geminiApiKey) : undefined;
  if (cfg.bedrockModelId) {
    const bedrock = new BedrockBillParser(cfg.bedrockModelId, cfg.region);
    return gemini ? new FallbackBillParser(bedrock, gemini) : bedrock;
  }
  if (gemini) return gemini;
  return {
    model: 'none',
    version: 'v0',
    parse: () =>
      Promise.reject(
        new AppError(
          'INTERNAL_ERROR',
          'BillParser not configured (set BEDROCK_MODEL_ID or GEMINI_API_KEY)',
        ),
      ),
  };
};
