/** Offsets at which two equal-length byte arrays differ. */
export function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
  if (a.length !== b.length) throw new Error(`length differs: ${a.length} vs ${b.length}`);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}
