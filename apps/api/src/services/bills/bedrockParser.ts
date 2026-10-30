import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { AppError } from '../../errors/AppError.js';
import { timed } from '../../logging/timed.js';
import { PROMPT, validateParsedBill } from './billPrompt.js';
import {
  parseTimeout,
  type BillParser,
  type ParseOptions,
  type ParsedBillFromImage,
} from './parser.js';

// v3: the prompt asks for the full printed address and never a guessed one.
// v4: venue.name holds only the printed trading name, with hints where to find it.
const VERSION = 'v6';

/**
 * Reads the bill with a vision model on Amazon Bedrock (Claude Haiku by
 * default).
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

  async parse(
    image: Uint8Array,
    requestId: string,
    opts: ParseOptions = {},
  ): Promise<ParsedBillFromImage> {
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
            { abortSignal: opts.signal },
          ),
        { requestId, model: this.model },
      );
    } catch (err) {
      if (opts.signal?.aborted) throw parseTimeout('Bedrock');
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
 * Bedrock when BEDROCK_MODEL_ID is set, else a parser that always fails
 * (local runs without AWS credentials; tests inject their own parser).
 */
export const createBillParser = (cfg: { bedrockModelId?: string; region: string }): BillParser => {
  if (cfg.bedrockModelId) return new BedrockBillParser(cfg.bedrockModelId, cfg.region);
  return {
    model: 'none',
    version: 'v0',
    parse: () =>
      Promise.reject(
        new AppError(
          'INTERNAL_ERROR',
          'BillParser not configured (set BEDROCK_MODEL_ID, with AWS credentials that can call Bedrock)',
        ),
      ),
  };
};
