import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { AppError } from '../../errors/AppError.js';
import { timed } from '../../logging/timed.js';
import { PROMPT, validateParsedBill } from './billPrompt.js';
import {
  decodeJpeg,
  downscale,
  encodeJpeg,
  receiptParts,
  type Box,
  type Raster,
} from './receiptImages.js';
import {
  parseTimeout,
  type BillParser,
  type ParseOptions,
  type ParsedBillFromImage,
} from './parser.js';

// v3: the prompt asks for the full printed address and never a guessed one.
// v4: venue.name holds only the printed trading name, with hints where to find it.
// v5: discount lines; v6: line totals.
// v7: finds the receipt, crops to it and reads a long one in overlapping parts.
// v8: a UK VAT line printed for information is not tax to add (#176).
// v9: a dish priced on the line under a 0.00 line is one item; admin fees and
// surcharges are service; an `unsure` note on lines it can't read clearly.
const VERSION = 'v9';

/**
 * Reads the bill with a vision model on Amazon Bedrock (Claude Sonnet by
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
    const parts = await this.receiptParts(image, requestId, opts);
    const text = await this.converse(
      [
        ...parts.map((bytes) => ({ image: { format: 'jpeg' as const, source: { bytes } } })),
        { text: parts.length > 1 ? partsNote(parts.length) + PROMPT : PROMPT },
      ],
      4096,
      requestId,
      opts,
    );
    if (!text) throw new AppError('PARSE_FAILED', 'Bedrock response missing content');
    return validateParsedBill(text, 'Bedrock');
  }

  /**
   * The photo as the model should see it: found and cropped to the receipt,
   * and cut into overlapping parts when it's long (receiptImages.ts). Any
   * trouble finding the receipt falls back to the whole photo, and a photo
   * that can't be decoded is sent as it came.
   */
  private async receiptParts(
    image: Uint8Array,
    requestId: string,
    opts: ParseOptions,
  ): Promise<Uint8Array[]> {
    let photo: Raster;
    try {
      photo = decodeJpeg(image);
    } catch {
      return [image];
    }
    const box = await this.findReceipt(photo, requestId, opts);
    return receiptParts(photo, box);
  }

  /** Asks the model where the receipt is in a small copy of the photo. Null if it can't say. */
  private async findReceipt(
    photo: Raster,
    requestId: string,
    opts: ParseOptions,
  ): Promise<Box | null> {
    try {
      const small = encodeJpeg(downscale(photo, 1024), 80);
      const text = await this.converse(
        [{ image: { format: 'jpeg', source: { bytes: small } } }, { text: FIND_RECEIPT_PROMPT }],
        200,
        requestId,
        opts,
      );
      return parseBox(text);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      return null;
    }
  }

  private async converse(
    content: ContentBlock[],
    maxTokens: number,
    requestId: string,
    opts: ParseOptions,
  ): Promise<string | undefined> {
    let out: ConverseCommandOutput;
    try {
      out = await timed(
        'bedrock',
        'converse',
        () =>
          this.client.send(
            new ConverseCommand({
              modelId: this.model,
              messages: [{ role: 'user', content }],
              inferenceConfig: { temperature: 0, maxTokens },
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
    return out.output?.message?.content?.find((c) => 'text' in c && c.text)?.text;
  }
}

const FIND_RECEIPT_PROMPT = `This photo shows a printed restaurant bill or receipt. Return ONLY JSON giving the edges of the receipt paper, including all of its printed text, as fractions of the photo's width and height (0 to 1):
{"left": number, "top": number, "right": number, "bottom": number}
If the receipt fills the photo or you can't find one, return {"left": 0, "top": 0, "right": 1, "bottom": 1}.`;

const partsNote = (n: number) =>
  `These ${n} images are parts of ONE receipt, in order from top to bottom. Each part overlaps the next by a few lines, so a line printed in an overlap appears in two parts: list it once. Read them together as one bill.

`;

/** The receipt's box from the model's answer, or null if it isn't one. */
export function parseBox(text: string | undefined): Box | null {
  const match = text?.match(/\{[^}]*\}/);
  if (!match) return null;
  try {
    const b = JSON.parse(match[0]) as Partial<Box>;
    const vals = [b.left, b.top, b.right, b.bottom];
    if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return b as Box;
  } catch {
    return null;
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
