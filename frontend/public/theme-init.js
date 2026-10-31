// Runs in <head> before the first paint (#214): puts the saved colour theme on <html> so the page
// never flashes the wrong one. It reads the device copy of the settings (what is there offline
// too); "system" or nothing saved leaves the choice to prefers-color-scheme in index.css.
// The copy counts only if it belongs to the signed-in user cached on this device, so a signed-out
// device (or one whose data belongs to someone else) follows the system setting.
// A device that holds no account data (no owner, no cached user, no pending sign-out) and is not
// on /login or /signup opens the app without an account (#331): its theme is the device-only copy
// under ineedtofocus.anonymous.settings.
// Keep the storage keys in step with SETTINGS_KEY in src/settings/store.ts, USER_KEY, OWNER_KEY
// and PENDING_LOGOUT_KEY in src/auth/localData.ts and ANON_SETTINGS_KEY in
// src/anonymous/keys.ts (a test checks them).
try {
  var saved = JSON.parse(localStorage.getItem('ineedtofocus.settings') || 'null')
  var user = JSON.parse(localStorage.getItem('ineedtofocus.user') || 'null')
  var theme = saved && saved.values && saved.values.theme
  var mine = saved && user && typeof user.id === 'string' && saved.owner === user.id
  if (mine && (theme === 'dark' || theme === 'light')) {
    document.documentElement.setAttribute('data-theme', theme)
  }
  var path = location.pathname.replace(/\/+$/, '')
  var anonymous =
    !localStorage.getItem('ineedtofocus.owner') &&
    !user &&
    !localStorage.getItem('ineedtofocus.pendingLogout') &&
    path !== '/login' &&
    path !== '/signup'
  if (anonymous) {
    var own = JSON.parse(localStorage.getItem('ineedtofocus.anonymous.settings') || 'null')
    var chosen = own && own.values && own.values.theme
    if (chosen === 'dark' || chosen === 'light') {
      document.documentElement.setAttribute('data-theme', chosen)
    }
  }
} catch (error) {
  // Unreadable or blocked storage: follow the device.
}
