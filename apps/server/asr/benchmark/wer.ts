export type WerResult = {
  readonly substitutions: number
  readonly deletions: number
  readonly insertions: number
  readonly referenceWords: number
  readonly wer: number
}

function words(text: string): string[] {
  return text.trim().toLocaleLowerCase("fr-FR").split(/\s+/).filter(Boolean)
}

function cell(matrix: number[][], row: number, column: number): number {
  return matrix[row]?.[column] ?? 0
}

export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = words(reference)
  const hyp = words(hypothesis)
  const matrix = Array.from({ length: ref.length + 1 }, () => Array<number>(hyp.length + 1).fill(0))
  for (let i = 0; i <= ref.length; i++) matrix[i]![0] = i
  for (let j = 0; j <= hyp.length; j++) matrix[0]![j] = j
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      matrix[i]![j] = ref[i - 1] === hyp[j - 1]
        ? cell(matrix, i - 1, j - 1)
        : Math.min(cell(matrix, i - 1, j - 1) + 1, cell(matrix, i - 1, j) + 1, cell(matrix, i, j - 1) + 1)
    }
  }
  let i = ref.length
  let j = hyp.length
  let substitutions = 0
  let deletions = 0
  let insertions = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1]) {
      i--
      j--
    } else if (i > 0 && j > 0 && cell(matrix, i, j) === cell(matrix, i - 1, j - 1) + 1) {
      substitutions++
      i--
      j--
    } else if (i > 0 && cell(matrix, i, j) === cell(matrix, i - 1, j) + 1) {
      deletions++
      i--
    } else {
      insertions++
      j--
    }
  }
  const distance = substitutions + deletions + insertions
  return { substitutions, deletions, insertions, referenceWords: ref.length, wer: ref.length ? distance / ref.length : (hyp.length ? 1 : 0) }
}
