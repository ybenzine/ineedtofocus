// Runs in <head> before the first paint (#214): puts the saved colour theme on <html> so the page
// never flashes the wrong one. It reads the device copy of the settings (what is there offline
// too); "system" or nothing saved leaves the choice to prefers-color-scheme in index.css.
// The copy counts only if it belongs to the signed-in user cached on this device, so a signed-out
// device (or one whose data belongs to someone else) follows the system setting.
// Keep the storage keys in step with SETTINGS_KEY in src/settings/store.ts and USER_KEY in
// src/auth/localData.ts (a test checks both).
try {
  var saved = JSON.parse(localStorage.getItem('ineedtofocus.settings') || 'null')
  var user = JSON.parse(localStorage.getItem('ineedtofocus.user') || 'null')
  var theme = saved && saved.values && saved.values.theme
  var mine = saved && user && typeof user.id === 'string' && saved.owner === user.id
  if (mine && (theme === 'dark' || theme === 'light')) {
    document.documentElement.setAttribute('data-theme', theme)
  }
} catch (error) {
  // Unreadable or blocked storage: follow the device.
}
