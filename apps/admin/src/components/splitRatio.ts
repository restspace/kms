export interface SplitRatioClampOptions {
  minLeftPx: number;
  minRightPx: number;
  minRatio?: number;
  maxRatio?: number;
  relaxedMinRatio?: number;
  relaxedMaxRatio?: number;
}

/**
 * Clamp split ratio based on pane minimum widths, while keeping drag usable when the
 * configured minimums are impossible to satisfy for the current container width.
 */
export const clampSplitRatioForWidth = (
  nextRatio: number,
  totalWidth: number,
  options: SplitRatioClampOptions
): number => {
  const minRatioBound = options.minRatio ?? 0.1;
  const maxRatioBound = options.maxRatio ?? 0.9;
  const relaxedMin = options.relaxedMinRatio ?? 0.2;
  const relaxedMax = options.relaxedMaxRatio ?? 0.8;

  const clamp = (value: number, min: number, max: number): number => {
    return Math.min(max, Math.max(min, value));
  };

  const safeWidth = Math.max(1, totalWidth);
  const sumMinWidths = options.minLeftPx + options.minRightPx;
  if (safeWidth < sumMinWidths) {
    return clamp(nextRatio, relaxedMin, relaxedMax);
  }

  const minRatio = Math.min(maxRatioBound, Math.max(minRatioBound, options.minLeftPx / safeWidth));
  const maxRatio = Math.max(minRatio, Math.min(maxRatioBound, 1 - (options.minRightPx / safeWidth)));
  return clamp(nextRatio, minRatio, maxRatio);
};
