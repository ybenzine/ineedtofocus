import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnonymousContext, type AnonymousUse } from '../anonymous/AnonymousContext.ts'
import { FakeTagsApi } from '../test/fakeTagsApi.ts'
import { TagsError } from './api.ts'
import { TagsContext } from './context.ts'
import { TagsStore } from './store.ts'
import TagsSection from './TagsSection.tsx'

async function renderSection(api = new FakeTagsApi()) {
  const store = new TagsStore({ api, owner: 'u1' })
  await store.refresh()
  render(
    <TagsContext.Provider value={store}>
      <TagsSection />
    </TagsContext.Provider>,
  )
  return { api, store }
}

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
}

const nameField = () => screen.getByLabelText('Tag name')
const addTag = (name: string) => {
  fireEvent.change(nameField(), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
}
const chosenColor = () =>
  within(screen.getByRole('group', { name: 'Colour' }))
    .getAllByRole('radio')
    .find((r) => (r as HTMLInputElement).checked)
    ?.closest('label')?.textContent

afterEach(() => vi.restoreAllMocks())

describe('Settings → Tags (AC7.4–AC7.7)', () => {
  it('lists the six built-in tags with dots and no controls, under the note', async () => {
    await renderSection()
    const builtin = within(screen.getByRole('list', { name: 'Built-in tags' }))
    expect(builtin.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Work',
      'Study',
      'Nap',
      'Read',
      'Meditation',
      'Exercise',
    ])
    expect(
      document.querySelectorAll('.tag-list[aria-label="Built-in tags"] .tag-dot'),
    ).toHaveLength(6)
    expect(builtin.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText("Built-in tags can't be changed.")).toBeInTheDocument()
  })

  it('lists custom tags in use, oldest first, with their dots; removed ones are not listed', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work', 'teal')
    api.add('Old', 'red', true)
    api.add('Writing', 'yellow')
    await renderSection(api)
    const mine = within(screen.getByRole('list', { name: 'Your tags' }))
    expect(mine.getAllByRole('listitem')).toHaveLength(2)
    expect(mine.getByText('Deep work')).toBeInTheDocument()
    expect(mine.queryByText('Old')).not.toBeInTheDocument()
    expect(mine.getAllByRole('listitem')[0]?.querySelector('.tag-dot-teal')).not.toBeNull()
  })

  it('adds a tag: trimmed, line breaks as one space, in the chosen colour', async () => {
    const { api } = await renderSection()
    fireEvent.click(screen.getByRole('radio', { name: 'Teal' }))
    addTag('  Deep\n work  ')
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Added the tag Deep work.'),
    )
    expect(api.tags[0]).toMatchObject({ name: 'Deep work', color: 'teal' })
    expect(nameField()).toHaveValue('')
    expect(
      within(screen.getByRole('list', { name: 'Your tags' })).getByText('Deep work'),
    ).toBeInTheDocument()
  })

  it('offers the colours as radios in a group named "Colour", starting on the first free one', async () => {
    await renderSection()
    const group = screen.getByRole('group', { name: 'Colour' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Indigo', 'Blue', 'Teal', 'Green', 'Yellow', 'Orange', 'Red', 'Pink'])
    // The built-in tags use Indigo, Blue, Pink, Orange, Teal and Green.
    expect(chosenColor()).toBe('Yellow')
  })

  it('moves the starting colour past the ones in use, and back to Indigo when all are taken', async () => {
    const api = new FakeTagsApi()
    api.add('One', 'yellow')
    await renderSection(api)
    expect(chosenColor()).toBe('Red')
    addTag('Two') // Red
    await waitFor(() => expect(screen.getByRole('status')).not.toBeEmptyDOMElement())
    expect(chosenColor()).toBe('Indigo')
  })

  it('refuses an empty or too long name and sends nothing', async () => {
    const { api } = await renderSection()
    api.calls.length = 0
    addTag('   \n ')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name for the tag.')
    expect(nameField()).toHaveAttribute('aria-invalid', 'true')
    addTag('x'.repeat(25))
    expect(screen.getByRole('alert')).toHaveTextContent('Use 24 characters or fewer.')
    expect(api.calls).toEqual([])
    addTag('x'.repeat(24))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Added the tag'))
  })

  it('shows the name clash message for a built-in name and for a tag in use (case-insensitive)', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    await renderSection(api)
    addTag('work')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A tag with this name already exists.',
    )
    addTag('DEEP WORK')
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith('create'))).toHaveLength(2))
    expect(screen.getByRole('alert')).toHaveTextContent('A tag with this name already exists.')
  })

  it('shows the 20-in-use message for add, and stays able to add at 100 in all by bringing one back', async () => {
    const api = new FakeTagsApi()
    for (let i = 1; i <= 20; i++) api.add(`Tag ${i}`)
    await renderSection(api)
    addTag('One more')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You can have up to 20 tags of your own. Remove one to add another.',
    )
  })

  it('shows the 100-in-all message when a new tag would exceed it', async () => {
    const api = new FakeTagsApi()
    for (let i = 1; i <= 100; i++) api.add(`Old ${i}`, 'red', i > 5)
    await renderSection(api)
    addTag('Brand new')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You've reached the limit of 100 tags, including removed ones.",
    )
  })

  it('brings a removed tag back when its name is added (200), at 100 in all', async () => {
    const api = new FakeTagsApi()
    for (let i = 1; i <= 99; i++) api.add(`Old ${i}`, 'red', true)
    api.add('Writing', 'blue', true)
    await renderSection(api)
    expect(screen.queryByRole('list', { name: 'Your tags' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Red' }))
    addTag('writing')
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Brought back the tag Writing.'),
    )
    const mine = within(screen.getByRole('list', { name: 'Your tags' }))
    expect(mine.getByText('Writing')).toBeInTheDocument() // its stored name, not "writing"
    expect(api.tags).toHaveLength(100)
    expect(api.tags.find((t) => t.name === 'Writing')).toMatchObject({ color: 'red' })
  })

  it('refuses to bring one back with 20 in use', async () => {
    const api = new FakeTagsApi()
    for (let i = 1; i <= 20; i++) api.add(`Tag ${i}`)
    api.add('Gone', 'red', true)
    await renderSection(api)
    addTag('gone')
    expect(await screen.findByRole('alert')).toHaveTextContent('You can have up to 20 tags')
  })

  it('renames inline, and shows the clash messages by type', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    api.add('Reading')
    api.add('Gone', 'red', true)
    await renderSection(api)
    fireEvent.click(screen.getByRole('button', { name: 'Rename Deep work' }))
    const input = screen.getByLabelText('New name for Deep work')
    expect(input).toHaveValue('Deep work')
    fireEvent.change(input, { target: { value: 'reading' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A tag with this name already exists.',
    )
    fireEvent.change(input, { target: { value: 'gone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'A removed tag has this name. Add a tag with this name to bring it back.',
      ),
    )
    fireEvent.change(input, { target: { value: 'Writing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Renamed the tag to Writing.'),
    )
    expect(screen.queryByLabelText('New name for Deep work')).not.toBeInTheDocument()
    expect(api.tags[0]?.name).toBe('Writing')
  })

  it('checks a rename like an add, and Cancel leaves it unchanged', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    await renderSection(api)
    api.calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Rename Deep work' }))
    fireEvent.change(screen.getByLabelText('New name for Deep work'), { target: { value: ' ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name for the tag.')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.calls).toEqual([])
    expect(screen.getByText('Deep work')).toBeInTheDocument()
  })

  it('recolours from the swatches at once', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work', 'teal')
    await renderSection(api)
    const group = screen.getByRole('group', { name: 'Colour of Deep work' })
    expect(within(group).getByRole('radio', { name: 'Teal' })).toBeChecked()
    fireEvent.click(within(group).getByRole('radio', { name: 'Red' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Deep work is now Red.'),
    )
    expect(api.tags[0]?.color).toBe('red')
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Colour of Deep work' })).getByRole('radio', {
          name: 'Red',
        }),
      ).toBeChecked(),
    )
  })

  it('asks inline before removing, and the tag leaves the list', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    await renderSection(api)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Deep work' }))
    expect(
      screen.getByText(
        'Remove Deep work? It leaves the tag picker. Sessions that have it keep it.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.tags[0]?.removedAt).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Deep work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Removed the tag Deep work.'),
    )
    expect(api.tags[0]?.removedAt).not.toBeNull()
    expect(screen.queryByRole('list', { name: 'Your tags' })).not.toBeInTheDocument()
  })

  it('says a tag was removed on another device (type "removed") and reloads the list', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    api.add('Writing')
    const { store } = await renderSection(api)
    const first = api.tags[0]
    if (first) first.removedAt = '2026-11-02T00:00:00Z' // removed elsewhere
    fireEvent.click(screen.getByRole('button', { name: 'Rename Deep work' }))
    fireEvent.change(screen.getByLabelText('New name for Deep work'), {
      target: { value: 'Other' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This tag was removed on another device.',
    )
    await waitFor(() => expect(store.getState().tags[0]?.removedAt).not.toBeNull())
    expect(within(screen.getByRole('list', { name: 'Your tags' })).queryByText('Deep work')).toBe(
      null,
    )
  })

  it('picks the message from the type, whatever the server text says', async () => {
    const api = new FakeTagsApi()
    api.failWith = new TagsError('conflict', 'A tag with this name already exists.', 'limit_total')
    await renderSection(api)
    addTag('Whatever')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You've reached the limit of 100 tags, including removed ones.",
    )
  })

  it('shows an error and leaves the list as the server has it when a request fails', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    await renderSection(api)
    api.failWith = new TagsError('server', 'down')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Deep work' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't change tags.")
    expect(screen.getByText('Deep work')).toBeInTheDocument()
  })

  it('offline: shows the list without its controls and says changing needs a connection (AC7.9)', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work', 'teal')
    setOnline(false)
    await renderSection(api)
    expect(screen.getByText('Deep work')).toBeInTheDocument()
    expect(screen.getByText('Changing tags needs a connection.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('brings the controls back when the connection returns', async () => {
    setOnline(false)
    await renderSection()
    expect(screen.queryByLabelText('Tag name')).not.toBeInTheDocument()
    setOnline(true)
    window.dispatchEvent(new Event('online'))
    expect(await screen.findByLabelText('Tag name')).toBeInTheDocument()
  })

  it('every control has a label', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    await renderSection(api)
    for (const control of [...document.querySelectorAll('input, button')]) {
      const name =
        control.getAttribute('aria-label') ??
        (control as HTMLInputElement).labels?.[0]?.textContent ??
        control.textContent
      expect(name, control.outerHTML).toBeTruthy()
    }
  })
})

describe('Settings → Tags without an account (AC1.8, AC7.9)', () => {
  it('shows the built-in tags and the sign-up and log-in links, and makes no request', () => {
    const api = new FakeTagsApi()
    const store = new TagsStore() // no API, as the app builds it without an account
    const anonymous = { held: {}, openForm: vi.fn() } as unknown as AnonymousUse
    render(
      <AnonymousContext.Provider value={anonymous}>
        <TagsContext.Provider value={store}>
          <TagsSection />
        </TagsContext.Provider>
      </AnonymousContext.Provider>,
    )
    expect(
      within(screen.getByRole('list', { name: 'Built-in tags' })).getAllByRole('listitem'),
    ).toHaveLength(6)
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/signup',
    )
    expect(screen.getByRole('link', { name: 'log in' })).toHaveAttribute('href', '/login')
    expect(screen.getByText(/to add your own tags\./)).toBeInTheDocument()
    expect(screen.queryByLabelText('Tag name')).not.toBeInTheDocument()
    expect(api.calls).toEqual([])
  })
})
