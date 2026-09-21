export type BenchmarkSample = {
  readonly id: string
  readonly reference: string
  readonly hypothesis: string
}

export const DEFAULT_BENCHMARK_DATASET: readonly BenchmarkSample[] = [
  { id: "john-3-16", reference: "Jean chapitre trois verset seize", hypothesis: "Jean chapitre 3 verset 16" },
  { id: "psalm-23-1", reference: "Psaume vingt-trois verset un", hypothesis: "Psaume vingt trois verset un" },
]
