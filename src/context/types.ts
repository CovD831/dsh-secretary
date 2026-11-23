import type { SourceRef } from '../spine/types.ts'

export interface PitfallNote {
  readonly id: string
  readonly triggerKeys: readonly string[]
  readonly andKeys?: readonly string[]
  readonly notKeys?: readonly string[]
  readonly content: string
  readonly sourceRef?: SourceRef
  readonly wordBoundary?: boolean
}

export interface MatchedPitfall extends PitfallNote {
  readonly matchedKeys: readonly string[]
}

export interface SliceRequest {
  readonly workspaceRoot: string
  readonly entryFiles?: readonly string[]
  readonly symbols?: readonly string[]
  readonly queryText?: string
  readonly pitfallNotes?: readonly PitfallNote[]
  readonly timeoutMs?: number
  readonly maxRgOutputBytes?: number
  readonly rgBin?: string
}

export interface SliceMetrics {
  readonly targetFiles: number
  readonly importedTypesCount: number
  readonly callSiteCount: number
  readonly relatedTestsCount: number
  readonly totalBytes: number
  readonly durationMs: number
}

export interface ImportedSignatureBlock {
  readonly sourceFile: string
  readonly importedFrom: string
  readonly signatures: readonly string[]
}

export interface CallSite {
  readonly file: string
  readonly line: number
  readonly text: string
}

export interface SliceResult {
  readonly workspaceRoot: string
  readonly targetFiles: readonly string[]
  readonly targetContents: readonly { readonly file: string; readonly content: string }[]
  readonly importedSignatures: readonly ImportedSignatureBlock[]
  readonly callSites: readonly CallSite[]
  readonly relatedTests: readonly string[]
  readonly matchedPitfalls: readonly MatchedPitfall[]
  readonly metrics: SliceMetrics
  readonly usedFallback: boolean
  readonly fallbackReason?: string
}

export interface CapsuleSection {
  readonly kind: 'pitfall' | 'target' | 'import-signature' | 'call-site' | 'related-test'
  readonly label: string
  readonly bytes: number
  readonly text: string
}

export interface DroppedCapsuleItem {
  readonly kind: CapsuleSection['kind']
  readonly label: string
  readonly bytes: number
  readonly reason: 'budget-exceeded'
}

export interface ContextCapsule {
  readonly overflow: boolean
  readonly budgetBytes: number
  readonly usedBytes: number
  readonly text: string
  readonly sections: readonly CapsuleSection[]
  readonly matchedPitfalls: readonly MatchedPitfall[]
  readonly droppedItems: readonly DroppedCapsuleItem[]
  readonly metrics: SliceMetrics
}
