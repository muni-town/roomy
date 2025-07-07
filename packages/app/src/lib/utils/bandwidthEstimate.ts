let current: number | undefined;

export const BandwidthEstimate = {
  get(): number | undefined {
    return current;
  },
  set(value: number) {
    current = value;
  },
};
