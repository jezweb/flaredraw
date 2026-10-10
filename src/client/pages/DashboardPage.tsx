import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Drawing } from '@/client/lib/api-client'
import { signOut } from '@/client/lib/auth'
import { useThemeContext } from '@/client/components/ThemeProvider'
import { clearRenameUiForCompletedSave, type RenameDraft, type RenameError } from '@/client/pages/dashboardRenameState'

const themeIcons: Record<string, string> = {
  light: '\u2600\uFE0F',  // sun
  dark: '\uD83C\uDF19',    // moon
  system: '\uD83D\uDCBB',  // laptop
}

function sortDrawingsByLastModified(items: Drawing[]) {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.lastModified ?? '') || 0
    const bTime = Date.parse(b.lastModified ?? '') || 0
    return bTime - aTime
  })
}

function getDrawingTitle(drawing: Drawing) {
  return drawing.title?.trim() || 'Untitled'
}

export function DashboardPage() {
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [loading, setLoading] = useState(true)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSavingId, setRenameSavingId] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<RenameError | null>(null)
  const navigate = useNavigate()
  const { theme, cycleTheme } = useThemeContext()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const renameSubmittingIdRef = useRef<string | null>(null)
  const renameBlurIgnoreIdRef = useRef<string | null>(null)
  const renameDraftRef = useRef<RenameDraft | null>(null)
  const renameErrorRef = useRef<RenameError | null>(null)

  useEffect(() => {
    api.drawings.list().then((data) => {
      setDrawings(data.drawings)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  useEffect(() => {
    renameDraftRef.current = renamingId ? { drawingId: renamingId, value: renameValue } : null
  }, [renamingId, renameValue])

  useEffect(() => {
    renameErrorRef.current = renameError
  }, [renameError])

  useEffect(() => {
    if (!menuOpenId) return

    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpenId(null)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpenId(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpenId])

  async function handleNew() {
    const { id } = await api.drawings.create()
    navigate(`/draw/${id}`)
  }

  async function handleDelete(id: string) {
    setMenuOpenId(null)
    if (!confirm('Delete this drawing?')) return
    await api.drawings.delete(id)
    setDrawings((prev) => prev.filter((d) => d.id !== id))
  }

  function startRenaming(drawing: Drawing) {
    setMenuOpenId(null)
    setRenameError((prev) => (prev?.id === drawing.id ? null : prev))
    setRenamingId(drawing.id)
    setRenameValue(getDrawingTitle(drawing))
  }

  function cancelRenaming(options?: { ignoreBlurForId?: string }) {
    if (options?.ignoreBlurForId) {
      renameBlurIgnoreIdRef.current = options.ignoreBlurForId
    }
    setRenamingId(null)
    setRenameValue('')
    setRenameError(null)
  }

  async function submitRename(drawing: Drawing) {
    if (renameBlurIgnoreIdRef.current === drawing.id) {
      renameBlurIgnoreIdRef.current = null
      return
    }

    if (renameSubmittingIdRef.current === drawing.id) return

    const currentTitle = getDrawingTitle(drawing)
    const title = renameValue.trim() || 'Untitled'

    if (title === currentTitle) {
      cancelRenaming()
      return
    }

    renameSubmittingIdRef.current = drawing.id
    setRenameSavingId(drawing.id)
    setRenameError(null)

    try {
      await api.drawings.updateTitle(drawing.id, title)
      const lastModified = new Date().toISOString()
      setDrawings((prev) =>
        sortDrawingsByLastModified(
          prev.map((item) => (item.id === drawing.id ? { ...item, title, lastModified } : item))
        )
      )
      const nextRenameUi = clearRenameUiForCompletedSave(
        renameDraftRef.current,
        renameErrorRef.current,
        drawing.id
      )
      setRenamingId(nextRenameUi.draft?.drawingId ?? null)
      setRenameValue(nextRenameUi.draft?.value ?? '')
      setRenameError(nextRenameUi.error)
    } catch (error) {
      setRenameError({
        id: drawing.id,
        message: error instanceof Error ? error.message : 'Failed to rename drawing',
      })
      requestAnimationFrame(() => {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
      })
    } finally {
      renameSubmittingIdRef.current = null
      setRenameSavingId((current) => (current === drawing.id ? null : current))
    }
  }

  function handleLogout() {
    signOut().then(() => {
      window.location.href = '/login'
    })
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return 'Never'
    return new Date(dateStr).toLocaleDateString('en-AU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">FlareDraw</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={handleNew}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              New Drawing
            </button>
            <button
              onClick={cycleTheme}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              title={`Theme: ${theme}`}
            >
              {themeIcons[theme]}
            </button>
            <button
              onClick={() => navigate('/settings')}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              title="Settings"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              onClick={handleLogout}
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-5xl px-6 py-8">
        {loading ? (
          <div className="text-center text-sm text-zinc-500">Loading drawings...</div>
        ) : drawings.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-lg text-zinc-500 dark:text-zinc-400">No drawings yet</p>
            <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
              Click "New Drawing" to get started
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {drawings.map((drawing) => (
              <div
                key={drawing.id}
                className="group cursor-pointer rounded-lg border border-zinc-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
                onClick={() => {
                  if (renamingId === drawing.id || renameSavingId === drawing.id) return
                  navigate(`/draw/${drawing.id}`)
                }}
              >
                {/* Placeholder for thumbnail */}
                <div className="mb-3 flex h-32 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                  <span className="text-3xl text-zinc-300 dark:text-zinc-600">
                    {drawing.elementCount ?? 0} elements
                  </span>
                </div>
                <div className="flex items-start justify-between">
                  <div
                    className="min-w-0 flex-1"
                    onClick={(e) => {
                      if (renamingId === drawing.id) {
                        e.stopPropagation()
                      }
                    }}
                  >
                    {renamingId === drawing.id ? (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => {
                            setRenameValue(e.target.value)
                            setRenameError((prev) => (prev?.id === drawing.id ? null : prev))
                          }}
                          onBlur={() => {
                            void submitRename(drawing)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void submitRename(drawing)
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelRenaming({ ignoreBlurForId: drawing.id })
                            }
                          }}
                          disabled={renameSavingId === drawing.id}
                          className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm font-medium text-zinc-900 outline-none ring-0 transition focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
                          aria-label="Drawing title"
                        />
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          {renameSavingId === drawing.id ? 'Saving...' : 'Enter to save, Esc to cancel'}
                        </p>
                        {renameError?.id === drawing.id ? (
                          <p className="mt-1 text-xs text-red-500 dark:text-red-400">
                            {renameError.message}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <h3 className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                          {getDrawingTitle(drawing)}
                        </h3>
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          {formatDate(drawing.lastModified)}
                        </p>
                      </>
                    )}
                  </div>
                  <div
                    className="relative ml-2"
                    ref={menuOpenId === drawing.id ? menuRef : null}
                  >
                    <button
                      disabled={renamingId === drawing.id || renameSavingId === drawing.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuOpenId((prev) => (prev === drawing.id ? null : drawing.id))
                      }}
                      className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                      title="Drawing actions"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.75" />
                        <circle cx="12" cy="12" r="1.75" />
                        <circle cx="12" cy="19" r="1.75" />
                      </svg>
                    </button>
                    {menuOpenId === drawing.id ? (
                      <div
                        className="absolute right-0 top-8 z-10 w-32 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => {
                            startRenaming(drawing)
                          }}
                          className="block w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => {
                            void handleDelete(drawing.id)
                          }}
                          className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
