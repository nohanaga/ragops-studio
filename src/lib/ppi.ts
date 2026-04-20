/**
 * Phase 7: Prediction-Powered Inference (PPI) for RAG evaluation metrics.
 *
 * PPI (Angelopoulos, Bates, Fannjiang, Jordan, Zrnic 2023) lets us combine
 *   - a small set of `n` HUMAN-labeled examples with paired predictions, and
 *   - a large set of `N` UNLABELED examples with predictions only,
 * to obtain a confidence-interval-bearing estimate of the population mean
 * of the metric Y, under the standard PPI assumption that the predictor
 * `f(X)` is unbiased _conditional on X_ (i.e. its bias is captured by the
 * paired labeled subset).
 *
 * Estimator:
 *   theta_pp = mean( f(X_j) over all N+n examples )
 *            - ( mean( f(X_i) over labeled ) - mean( Y_i over labeled ) )
 *   The second term is the "rectifier" that corrects for the predictor's
 *   bias measured on the labeled subset.
 *
 * Variance (large-sample, Slutsky):
 *   var_pp = var(f over all unlabeled) / N
 *          + var(f - Y over labeled) / n
 *
 * Symmetric CI: theta_pp +/- z_{1-alpha/2} * sqrt(var_pp).
 *
 * This is intentionally a small, dependency-free library so it can be
 * imported from the eval dataset / AutoTuning UI later without pulling
 * in stats packages.
 */

export interface PpiInput {
  /** Paired (humanLabel, prediction) on the labeled subset. */
  labeled: Array<{ y: number; f: number }>
  /** Predictions on the unlabeled subset (no human label needed). */
  unlabeledPredictions: number[]
  /**
   * Two-sided confidence level, e.g. 0.95 for 95 % CI.
   * Defaults to 0.95.
   */
  confidenceLevel?: number
}

export interface PpiResult {
  /** Point estimate of the population mean of Y, debiased via PPI. */
  estimate: number
  /** Inverse-variance-weighted standard error of `estimate`. */
  standardError: number
  /** Lower bound of the symmetric (1-alpha) CI. */
  ciLower: number
  /** Upper bound of the symmetric (1-alpha) CI. */
  ciUpper: number
  /** Effective `n` used in variance for the labeled rectifier term. */
  nLabeled: number
  /** Effective `N` used in variance for the unlabeled f-mean term. */
  nUnlabeled: number
  /**
   * Naive estimator (mean of human labels alone) for sanity-comparison.
   * If `nLabeled` is 0, this is `NaN`.
   */
  naiveEstimate: number
  /**
   * Standard error of the naive estimator (assuming independence).
   * `NaN` when `nLabeled` < 2.
   */
  naiveStandardError: number
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

/**
 * Sample variance (denominator = n-1). Returns 0 for n<2 so the variance
 * additions below collapse cleanly when one of the samples is degenerate.
 */
function sampleVariance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let s = 0
  for (const x of xs) {
    const d = x - m
    s += d * d
  }
  return s / (xs.length - 1)
}

/**
 * Inverse standard normal CDF (quantile function), used to map a
 * confidence level to a z-score. Beasley-Springer-Moro approximation
 * accurate to ~5e-9 for p in (0, 1).
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity
  // Beasley-Springer
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  let q: number
  let r: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  } else if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    )
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    )
  }
}

/**
 * Compute the PPI mean estimate, standard error, and confidence interval.
 *
 * Edge cases:
 *   - `labeled.length === 0` → falls back to the naive mean of unlabeled
 *     predictions (rectifier term unknown). Reported `naiveEstimate` is NaN.
 *   - `unlabeledPredictions.length === 0` → falls back to the naive
 *     mean of human labels alone (no PPI gain available).
 *   - Both empty → all NaNs.
 */
export function ppiMean(input: PpiInput): PpiResult {
  const alpha = 1 - (input.confidenceLevel ?? 0.95)
  const z = normalQuantile(1 - alpha / 2)

  const ys = input.labeled.map((p) => p.y)
  const fs = input.labeled.map((p) => p.f)
  const fu = input.unlabeledPredictions
  const n = ys.length
  const N = fu.length

  const naiveEstimate = n > 0 ? mean(ys) : NaN
  const naiveSe = n > 1 ? Math.sqrt(sampleVariance(ys) / n) : NaN

  // Degenerate fallbacks.
  if (n === 0 && N === 0) {
    return {
      estimate: NaN,
      standardError: NaN,
      ciLower: NaN,
      ciUpper: NaN,
      nLabeled: 0,
      nUnlabeled: 0,
      naiveEstimate,
      naiveStandardError: naiveSe,
    }
  }
  if (n === 0) {
    const est = mean(fu)
    const se = N > 1 ? Math.sqrt(sampleVariance(fu) / N) : 0
    return {
      estimate: est,
      standardError: se,
      ciLower: est - z * se,
      ciUpper: est + z * se,
      nLabeled: 0,
      nUnlabeled: N,
      naiveEstimate,
      naiveStandardError: naiveSe,
    }
  }
  if (N === 0) {
    return {
      estimate: naiveEstimate,
      standardError: naiveSe,
      ciLower: naiveEstimate - z * naiveSe,
      ciUpper: naiveEstimate + z * naiveSe,
      nLabeled: n,
      nUnlabeled: 0,
      naiveEstimate,
      naiveStandardError: naiveSe,
    }
  }

  // Standard PPI.
  const meanFu = mean(fu)
  const meanFL = mean(fs)
  const meanY = mean(ys)
  const rectifier = meanFL - meanY
  const estimate = meanFu - rectifier

  const residuals = input.labeled.map((p) => p.f - p.y)
  const varTerm =
    sampleVariance(fu) / N + sampleVariance(residuals) / n
  const se = Math.sqrt(Math.max(varTerm, 0))

  return {
    estimate,
    standardError: se,
    ciLower: estimate - z * se,
    ciUpper: estimate + z * se,
    nLabeled: n,
    nUnlabeled: N,
    naiveEstimate,
    naiveStandardError: naiveSe,
  }
}
