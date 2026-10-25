// Runs in <head> before the first paint (#214): puts the saved colour theme on <html> so the page
// never flashes the wrong one. It reads the device copy of the settings (what is there offline
// too); "system" or nothing saved leaves the choice to prefers-color-scheme in index.css.
// Keep the storage key in step with SETTINGS_KEY in src/settings/store.ts (a test checks it).
try {
  var saved = JSON.parse(localStorage.getItem('ineedtofocus.settings') || 'null')
  var theme = saved && saved.values && saved.values.theme
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme)
  }
} catch (error) {
  // Unreadable or blocked storage: follow the device.
}
