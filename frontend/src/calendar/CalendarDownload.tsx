// "Add to calendar (.ics)" on History (F14, AC14.6): the sessions the view on screen counts,
// from `GET /api/calendar/export.ics` with the History request's own parameters. Needs a
// connection; sessions not synced yet aren't in it.

import { useId, useState } from 'react'
import type { HistoryQuery } from '../history/api.ts'
import { useOnline } from '../sounds/useOnline.ts'
import { HttpCalendarApi, type CalendarApi } from './api.ts'
import { saveIcs } from './download.ts'

const defaultApi = new HttpCalendarApi()

export const DOWNLOAD_HINT =
  'Apple Calendar opens this file. In Google Calendar, import it at calendar.google.com → Settings → Import.'
export const UNSYNCED_HINT = 'Sessions not synced yet aren’t included.'

export default function CalendarDownload({
  query,
  unsynced,
  api = defaultApi,
}: {
  query: HistoryQuery
  /** True when this device has sessions in the view that haven't reached the server. */
  unsynced: boolean
  api?: Pick<CalendarApi, 'exportIcs'>
}) {
  const id = useId()
  const online = useOnline()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function download() {
    setBusy(true)
    setError('')
    const result = await api.exportIcs(query)
    setBusy(false)
    if (result.kind !== 'ok') {
      setError('Couldn’t make the calendar file. Try again.')
      return
    }
    // The file comes after a request, so it is saved, not opened in a new tab.
    saveIcs(result.value.text, result.value.fileName)
  }

  return (
    <div className="calendar-download">
      <button
        type="button"
        disabled={!online || busy}
        aria-describedby={`${id}-hint`}
        onClick={() => void download()}
      >
        Add to calendar (.ics)
      </button>
      <p id={`${id}-hint`} className="field-hint">
        {online ? DOWNLOAD_HINT : 'Needs a connection.'}
        {unsynced ? ` ${UNSYNCED_HINT}` : ''}
      </p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </div>
  )
}
