// Removing a recent YouTube link on New session (AC8.9, #490): the control, the inline confirm,
// the list from the response, the chosen link kept, offline and a failed request.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickSoundOpen } from '../test/setupUi.ts'
import { MemoryPreferencesStore } from '../setup/preferences.ts'
import SessionSetup from '../setup/SessionSetup.tsx'
import YoutubeSetup from './YoutubeSetup.tsx'
import { httpYoutubeLinksApi, type RecentLink } from './youtubeLinksApi.ts'
import { REMOVE_ERROR, REMOVE_OFFLINE_HINT } from './RecentLinkList.tsx'

const URL1 = 'https://youtu.be/dQw4w9WgXcQ'
const URL2 = 'https://youtu.be/aqz-KE-bpKQ'
const T1 = 'Lofi radio'
const LINKS: RecentLink[] = [
  { url: URL1, title: T1 },
  { url: URL2, title: null },
]

function setup(remove: (url: string) => Promise<RecentLink[]> = async () => LINKS.slice(1)) {
  const api = {
    list: vi.fn(async () => LINKS),
    use: vi.fn(async () => LINKS),
    remove: vi.fn(remove),
  }
  render(
    <SessionSetup preferences={new MemoryPreferencesStore()} onStart={vi.fn()} youtubeApi={api} />,
  )
  pickSoundOpen('YouTube')
  return api
}

const removeControl = (name: string) =>
  screen.findByRole('button', { name: `Remove ${name} from recent links` })

// The control is a new element once the confirm has closed, so it is looked up again.
const removeControlNow = (name: string) =>
  screen.getByRole('button', { name: `Remove ${name} from recent links` })

afterEach(() => vi.restoreAllMocks())

describe('removing a recent YouTube link', () => {
  it('labels each control with the title, or the url without one, apart from the row button', async () => {
    setup()
    const control = await removeControl(T1)
    expect(control).toBeInTheDocument()
    expect(await removeControl(URL2)).toBeInTheDocument()
    const row = screen.getByRole('button', { name: T1 })
    expect(row).not.toBe(control)
    expect(row).not.toContainElement(control)
  })

  it('asks first, with Cancel focused, and removes nothing until Remove', async () => {
    const api = setup()
    fireEvent.click(await removeControl(T1))
    expect(screen.getByText(`Remove ${T1} from your recent links?`)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('Cancel changes nothing and returns focus to the remove control', async () => {
    const api = setup()
    const control = await removeControl(T1)
    fireEvent.click(control)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(removeControlNow(T1)).toHaveFocus())
    expect(api.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: T1 })).toBeInTheDocument()
    expect(screen.queryByText(/from your recent links\?/)).not.toBeInTheDocument()
  })

  it('Escape closes the confirm and returns focus to the remove control', async () => {
    const api = setup()
    const control = await removeControl(T1)
    fireEvent.click(control)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    await waitFor(() => expect(removeControlNow(T1)).toHaveFocus())
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('Remove sends the listed url and the list becomes the response', async () => {
    const api = setup()
    fireEvent.click(await removeControl(T1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: T1 })).not.toBeInTheDocument())
    expect(api.remove).toHaveBeenCalledExactlyOnceWith(URL1)
    expect(screen.getByRole('button', { name: 'YouTube video' })).toBeInTheDocument()
    expect(screen.getByText('Removed from your recent links.')).toBeInTheDocument()
    expect(screen.getByLabelText('YouTube link')).toHaveFocus()
  })

  it('keeps the removed link chosen for this session', async () => {
    setup()
    fireEvent.click(await screen.findByRole('button', { name: T1 }))
    expect(screen.getByLabelText('YouTube link')).toHaveValue(URL1)
    fireEvent.click(await removeControl(T1))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: T1 })).not.toBeInTheDocument())
    expect(screen.getByLabelText('YouTube link')).toHaveValue(URL1)
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
  })

  it('on a failed request leaves the list, shows an error and refocuses the control', async () => {
    setup(async () => {
      throw new Error('boom')
    })
    const control = await removeControl(T1)
    fireEvent.click(control)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(REMOVE_ERROR)
    expect(screen.getByRole('button', { name: T1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'YouTube video' })).toBeInTheDocument()
    await waitFor(() => expect(removeControlNow(T1)).toHaveFocus())
  })

  it('disables the controls offline, with the needs-a-connection hint, and re-enables them', async () => {
    // New session swaps the whole YouTube part for the Rain suggestion while offline (AC8.7), so
    // the section is rendered on its own here.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const api = {
      list: vi.fn(async () => LINKS),
      use: vi.fn(async () => LINKS),
      remove: vi.fn(async () => []),
    }
    render(<YoutubeSetup text="" onTextChange={vi.fn()} hintId="h" api={api} />)
    const control = await removeControl(T1)
    expect(control).toBeDisabled()
    expect(screen.getByText(REMOVE_OFFLINE_HINT)).toBeInTheDocument()
    expect(control).toHaveAccessibleDescription(REMOVE_OFFLINE_HINT)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(control).toBeEnabled()
    expect(screen.queryByText(REMOVE_OFFLINE_HINT)).not.toBeInTheDocument()
  })
})

describe('httpYoutubeLinksApi.remove', () => {
  it('sends DELETE with the url and reads the updated list', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ links: [{ url: URL2, title: 'B' }] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await httpYoutubeLinksApi.remove(URL1)).toEqual([{ url: URL2, title: 'B' }])
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/youtube-links',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ url: URL1 }) }),
    )
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }))
    await expect(httpYoutubeLinksApi.remove(URL1)).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})
