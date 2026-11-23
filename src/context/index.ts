export { assembleCapsule, matchPitfalls } from './capsule.ts'
export { extractExportedSignatures, sliceWorkspaceContext } from './slicer.ts'
export type {
  CallSite,
  CapsuleSection,
  ContextCapsule,
  DroppedCapsuleItem,
  ImportedSignatureBlock,
  MatchedPitfall,
  PitfallNote,
  SliceMetrics,
  SliceRequest,
  SliceResult,
} from './types.ts'
