import test from 'node:test'
import assert from 'node:assert/strict'
import { clearRenameUiForCompletedSave } from '../src/client/pages/dashboardRenameState.ts'

test('preserves another card rename draft when a different save finishes', () => {
  const result = clearRenameUiForCompletedSave(
    { drawingId: 'drawing-b', value: 'Updated title B' },
    { id: 'drawing-a', message: 'old error' },
    'drawing-a'
  )

  assert.deepEqual(result, {
    draft: { drawingId: 'drawing-b', value: 'Updated title B' },
    error: null,
  })
})

test('clears rename draft when the saved drawing still owns the active rename UI', () => {
  const result = clearRenameUiForCompletedSave(
    { drawingId: 'drawing-a', value: 'Updated title A' },
    null,
    'drawing-a'
  )

  assert.deepEqual(result, {
    draft: null,
    error: null,
  })
})
