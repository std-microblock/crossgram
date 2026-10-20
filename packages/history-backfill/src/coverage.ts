/**
 * 一个会话已确认从上游取过的原生序号区间集合（含两端），全部保存在内存里。
 *
 * 重启后从本地已存的 nativeSequence 重新推导；被撤回、被过滤的序号在重启后会被视为空洞再取一次，
 * 一次按序号的回填拿到原始区间后即可重新覆盖，因此不需要持久化。
 */
export interface SequenceSpan {
  start: number
  end: number
}

export interface SequenceGap {
  /** 空洞的最小序号（含）。 */
  low: number
  /** 空洞的最大序号（含）。 */
  high: number
}

export class SequenceCoverage {
  /** 按 `start` 升序、互不重叠且不相邻的区间。 */
  private _spans: SequenceSpan[] = []

  get spans(): readonly SequenceSpan[] {
    return this._spans
  }

  get size(): number {
    return this._spans.length
  }

  get min(): number | undefined {
    return this._spans[0]?.start
  }

  get max(): number | undefined {
    return this._spans.at(-1)?.end
  }

  /** 已覆盖的序号总数。 */
  get covered(): number {
    return this._spans.reduce((sum, span) => sum + span.end - span.start + 1, 0)
  }

  has(sequence: number): boolean {
    return this._spans.some((span) => span.start <= sequence && sequence <= span.end)
  }

  /** 加入区间 `[low, high]`，与重叠或相邻的已有区间合并。 */
  add(low: number, high: number = low): void {
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) return
    if (low > high) [low, high] = [high, low]
    if (high < 1) return
    low = Math.max(1, low)
    const output: SequenceSpan[] = []
    let merged: SequenceSpan = { start: low, end: high }
    let inserted = false
    for (const span of this._spans) {
      if (span.end + 1 < merged.start) {
        output.push(span)
      } else if (merged.end + 1 < span.start) {
        if (!inserted) {
          output.push(merged)
          inserted = true
        }
        output.push(span)
      } else {
        merged = { start: Math.min(span.start, merged.start), end: Math.max(span.end, merged.end) }
      }
    }
    if (!inserted) output.push(merged)
    this._spans = output
  }

  /**
   * 从高往低找第一个空洞：先看 `upperBound` 与最高区间之间（停机期间顶部缺的消息），
   * 再看区间之间。不返回最低区间以下的部分，那属于「向更早方向追溯」。
   */
  highestGap(upperBound?: number): SequenceGap | undefined {
    const top = this.max
    if (upperBound !== undefined && Number.isSafeInteger(upperBound)) {
      if (top === undefined) return upperBound >= 1 ? { low: 1, high: upperBound } : undefined
      if (upperBound > top) return { low: top + 1, high: upperBound }
    }
    for (let index = this._spans.length - 1; index > 0; index--) {
      const upper = this._spans[index]
      const lower = this._spans[index - 1]
      if (lower.end + 1 < upper.start) return { low: lower.end + 1, high: upper.start - 1 }
    }
    return undefined
  }

  /** 区间之间（不含顶部与底部）的空洞数量与序号总数。 */
  gapStats(upperBound?: number): { count: number, missing: number } {
    let count = 0
    let missing = 0
    for (let index = 1; index < this._spans.length; index++) {
      const width = this._spans[index].start - this._spans[index - 1].end - 1
      if (width > 0) {
        count++
        missing += width
      }
    }
    const top = this.max
    if (upperBound !== undefined && top !== undefined && upperBound > top) {
      count++
      missing += upperBound - top
    }
    return { count, missing }
  }

  /** 由倒序（或任意顺序）的已存序号构建区间。 */
  static fromSequences(sequences: Iterable<number>): SequenceCoverage {
    const coverage = new SequenceCoverage()
    const sorted = [...new Set(sequences)].filter((value) => Number.isSafeInteger(value) && value > 0)
      .sort((left, right) => left - right)
    let start: number | undefined
    let end = 0
    for (const value of sorted) {
      if (start === undefined) {
        start = end = value
      } else if (value === end + 1) {
        end = value
      } else {
        coverage._spans.push({ start, end })
        start = end = value
      }
    }
    if (start !== undefined) coverage._spans.push({ start, end })
    return coverage
  }
}
