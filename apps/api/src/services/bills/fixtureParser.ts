import { fingerprintOf, type BillParser, type ParsedBillFromImage } from './parser.js';

/**
 * Answers every read with the same result. Its fingerprint comes from that
 * result, so two fixtures with different answers never share a cached read.
 * `calls` counts reads that reached it (the analysis cache skips it).
 */
export class FixtureBillParser implements BillParser {
  readonly model = 'fixture';
  readonly version = 'v1';
  readonly fingerprint: string;
  calls = 0;

  constructor(
    private readonly result: ParsedBillFromImage,
    opts: { fingerprint?: string } = {},
  ) {
    this.fingerprint =
      opts.fingerprint ?? fingerprintOf(this.model, this.version, JSON.stringify(result));
  }

  parse(): Promise<ParsedBillFromImage> {
    this.calls++;
    return Promise.resolve(this.result);
  }
}

export class ThrowingBillParser implements BillParser {
  readonly model = 'throwing';
  readonly version = 'v1';
  readonly fingerprint = 'throwing:v1:00000000';

  constructor(private readonly error: Error) {}

  parse(): Promise<ParsedBillFromImage> {
    return Promise.reject(this.error);
  }
}
