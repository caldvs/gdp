import type { BillParser, ParsedBillFromImage } from './parser.js';

export class FixtureBillParser implements BillParser {
  readonly model = 'fixture';
  readonly version = 'v1';

  constructor(private readonly result: ParsedBillFromImage) {}

  parse(): Promise<ParsedBillFromImage> {
    return Promise.resolve(this.result);
  }
}

export class ThrowingBillParser implements BillParser {
  readonly model = 'throwing';
  readonly version = 'v1';

  constructor(private readonly error: Error) {}

  parse(): Promise<ParsedBillFromImage> {
    return Promise.reject(this.error);
  }
}
