// YouTube without an account (#331): there is no list of recent links, and nothing about a
// link or its title is sent to the server.

import type { YoutubeLinksApi } from '../sounds/youtubeLinksApi.ts'

export const anonymousYoutubeApi: YoutubeLinksApi = {
  list: () => Promise.resolve([]),
  use: () => Promise.resolve([]),
}
