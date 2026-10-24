// The Garmin FIT SDK is used only to validate bytes independently, never to read or write in
// @fit-doctor/core.
import { Decoder, Stream } from '@garmin/fitsdk';

export interface SdkResult {
  isFIT: boolean;
  integrity: boolean;
  messages: Record<string, Record<string, unknown>[]>;
  errors: unknown[];
}

export function sdkCheck(bytes: Uint8Array): SdkResult {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  const isFIT = decoder.isFIT();
  const integrity = decoder.checkIntegrity();
  const { messages, errors } = decoder.read({
    convertDateTimesToDates: false,
    convertTypesToStrings: false,
    mergeHeartRates: false,
  });
  return { isFIT, integrity, messages: messages as SdkResult['messages'], errors };
}

/**
 * True when the file uses compressed timestamp headers, which @garmin/fitsdk cannot decode.
 * For such files only the CRC integrity check is meaningful.
 */
export function sdkCanDecode(compressedCount: number): boolean {
  return compressedCount === 0;
}
