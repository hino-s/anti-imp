// MV3 service worker. Currently only used to set default config on install.

const DEFAULT_CONFIG = {
  enabled: true,
  // When ON, hide verified (blue badge) replies.
  hideBlueBadgeReplies: true,
  // Exceptions (keep visible):
  showIfFollowing: true,
  showIfFollowerCountAtLeastEnabled: false,
  showIfFollowerCountAtLeast: 1000
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(null)
  const toSet = {}
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    if (stored[k] === undefined) toSet[k] = v
  }
  if (Object.keys(toSet).length) {
    await chrome.storage.local.set(toSet)
  }
})
