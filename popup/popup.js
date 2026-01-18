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
  const row = $('followerCountRow')
  if (row) {
    row.classList.toggle('disabledRow', !$('toggleFollowerCount').checked)
  }

  const exceptionsCard = $('exceptionsCard')
  const mainOn = $('toggleHide').checked
  if (exceptionsCard) {
    exceptionsCard.classList.toggle('disabled', !mainOn)
  }
  // Disable all inputs in the exceptions card when main feature is OFF
  if (exceptionsCard) {
    const inputs = exceptionsCard.querySelectorAll('input')
    for (const input of inputs) {
      input.disabled = !mainOn || (input.id === 'followerCount' && !$('toggleFollowerCount').checked)
    }
  }
}

let saveTimer = 0
function scheduleSave() {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    save()
  }, 250)
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

  $('toggleHide').addEventListener('change', () => {
    updateDisabledState()
    save()
  })
  $('toggleFollowing').addEventListener('change', save)
  $('toggleFollowerCount').addEventListener('change', () => {
    updateDisabledState()
    save()
  })
  // Save threshold asynchronously while typing (debounced)
  $('followerCount').addEventListener('input', scheduleSave)
  $('followerCount').addEventListener('change', save)
})
