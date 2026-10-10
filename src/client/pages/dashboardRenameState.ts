export type RenameDraft = {
  drawingId: string
  value: string
}

export type RenameError = {
  id: string
  message: string
}

export function clearRenameUiForCompletedSave(
  draft: RenameDraft | null,
  error: RenameError | null,
  completedDrawingId: string
) {
  return {
    draft: draft?.drawingId === completedDrawingId ? null : draft,
    error: error?.id === completedDrawingId ? null : error,
  }
}
