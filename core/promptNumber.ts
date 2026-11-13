/** Round displayed prompt measurements without changing the underlying map data. */
export function promptNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumSignificantDigits: 3,
    useGrouping: false,
  }).format(value);
}
