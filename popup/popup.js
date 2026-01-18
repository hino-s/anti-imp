const DEFAULTS = {
  enabled: true,
  hideBlueBadgeReplies: true,
  showIfFollowing: true,
  showIfFollowerCountAtLeastEnabled: false,
  showIfFollowerCountAtLeast: 1000
}

/** @param {string} id */
function $(id) {
  return document.getElementById(id)
}

async function load() {
  const config = await chrome.storage.local.get(DEFAULTS)
  $('toggleHide').checked = !!config.hideBlueBadgeReplies
  $('toggleFollowing').checked = !!config.showIfFollowing
  $('toggleFollowerCount').checked = !!config.showIfFollowerCountAtLeastEnabled
  $('followerCount').value = String(config.showIfFollowerCountAtLeast ?? DEFAULTS.showIfFollowerCountAtLeast)
  updateDisabledState()
}

function updateDisabledState() {
  $('followerCount').disabled = !$('toggleFollowerCount').checked
}

async function save() {
  const next = {
    hideBlueBadgeReplies: $('toggleHide').checked,
    showIfFollowing: $('toggleFollowing').checked,
    showIfFollowerCountAtLeastEnabled: $('toggleFollowerCount').checked,
    showIfFollowerCountAtLeast: Number($('followerCount').value || DEFAULTS.showIfFollowerCountAtLeast)
  }
  await chrome.storage.local.set(next)
}

document.addEventListener('DOMContentLoaded', async () => {
  await load()

  $('toggleHide').addEventListener('change', save)
  $('toggleFollowing').addEventListener('change', save)
  $('toggleFollowerCount').addEventListener('change', () => {
    updateDisabledState()
    save()
  })
  $('followerCount').addEventListener('change', save)
})

