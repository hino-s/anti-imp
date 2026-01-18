// anti-imp content script
// Hide verified (blue badge) replies on X/Twitter. MV3 / no build tools.

const DEFAULT_CONFIG = {
  enabled: true,
  hideBlueBadgeReplies: true,
  // Exceptions (keep visible):
  showIfFollowing: true,
  showIfFollowerCountAtLeastEnabled: false,
  showIfFollowerCountAtLeast: 1000
}

/** @typedef {{ following?: boolean, followedBy?: boolean, followersCount?: number }} UserInfo */

/** @type {typeof DEFAULT_CONFIG} */
let config = {...DEFAULT_CONFIG}

/** @type {Record<string, UserInfo>} */
const userInfoCache = Object.create(null)

const BRIDGE_REQ_TYPE = 'antiimp:getUserInfo'
const BRIDGE_RES_TYPE = 'antiimp:userInfo'

/** @type {Map<string, (data: any) => void>} */
const pendingBridgeRequests = new Map()

function injectPageBridge() {
  const id = 'antiimp-page-bridge'
  if (document.getElementById(id)) return
  const s = document.createElement('script')
  s.id = id
  s.src = chrome.runtime.getURL('page_bridge.js')
  ;(document.head || document.documentElement).appendChild(s)
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.type !== BRIDGE_RES_TYPE) return
  const requestId = data.requestId
  if (!requestId) return
  const cb = pendingBridgeRequests.get(requestId)
  if (!cb) return
  pendingBridgeRequests.delete(requestId)
  cb(data)
})

/**
 * Ask page context for userInfo about screenNames.
 * @param {string[]} screenNames
 */
function requestUserInfoFromPage(screenNames) {
  if (!screenNames.length) return
  const requestId = String(Date.now()) + ':' + String(Math.random()).slice(2)
  pendingBridgeRequests.set(requestId, (data) => {
    const ui = data.userInfo || {}
    for (const [sn, info] of Object.entries(ui)) {
      // @ts-ignore
      userInfoCache[sn] = {
        ...userInfoCache[sn],
        ...info,
      }
    }

    // Re-apply after userInfo arrives (fixes follower-count exception timing)
    scheduleScan()
  })

  window.postMessage({
    type: BRIDGE_REQ_TYPE,
    requestId,
    screenNames,
  }, '*')

  // fail-safe cleanup
  setTimeout(() => pendingBridgeRequests.delete(requestId), 2000)
}

const HIDDEN_ATTR = 'data-antiimp-hidden'
const HIDDEN_REASON_ATTR = 'data-antiimp-hidden-reason'

function isConversationOrQuotesPage() {
  // Apply in permalink conversation pages and quote timelines.
  // Examples:
  // - /{user}/status/{id}
  // - /{user}/status/{id}/quotes
  return location.pathname.includes('/status/')
}

/** @param {HTMLElement} el */
function getTweetCellContainer(el) {
  return el.closest('div[data-testid="cellInnerDiv"]') || el
}

/** @param {HTMLElement} tweet */
function isVerifiedTweet(tweet) {
  // X often uses data-testid icon-verified for the check badge.
  if (tweet.querySelector('[data-testid="icon-verified"]')) return true

  // Fallback for aria-label based icons (depends on locale).
  const svg = tweet.querySelector('svg[aria-label]')
  if (!svg) return false
  const label = (svg.getAttribute('aria-label') || '').toLowerCase()
  return label.includes('verified') || label.includes('認証') || label.includes('認証済')
}

/**
 * Extract @screenName from a tweet.
 * @param {HTMLElement} tweet
 * @returns {string|null}
 */
function getScreenNameFromTweet(tweet) {
  // Usually the user name block exists in header.
  const userNameBlock = tweet.querySelector('[data-testid="User-Name"]')
  const a = (userNameBlock || tweet).querySelector('a[href^="/"]')
  if (!a) return null

  const href = a.getAttribute('href') || ''
  // href is like /{screenName}
  const m = href.match(/^\/([^\/\?]+)(?:\?|$)/)
  if (!m) return null

  const screenName = m[1]
  // Guard against special routes.
  if (!screenName || screenName === 'home' || screenName === 'i' || screenName === 'settings') return null
  return screenName
}

/**
 * @param {string} raw
 * @returns {number|null}
 */
function parseFollowerCount(raw) {
  // Examples:
  // - "1,234"
  // - "12.3K" / "1.2M"
  // - "1.2万" / "3.4億"
  const s = raw.replace(/\s/g, '').replace(/,/g, '')
  const m = s.match(/(\d+(?:\.\d+)?)([KkMm万億])?$/)
  if (!m) return null
  let n = Number(m[1])
  if (Number.isNaN(n)) return null
  const unit = m[2]
  if (!unit) return Math.floor(n)
  if (unit === 'K' || unit === 'k') n *= 1_000
  else if (unit === 'M' || unit === 'm') n *= 1_000_000
  else if (unit === '万') n *= 10_000
  else if (unit === '億') n *= 100_000_000
  return Math.floor(n)
}

/**
 * Try to read user info from the hover card if present.
 * @param {string} screenName
 */
function tryUpdateUserInfoFromHoverCard(screenName) {
  // Legacy fallback (if bridge cannot access state).
  const hover = document.querySelector('[data-testid="HoverCard"], [data-testid="hoverCard"], [role="dialog"]')
  if (!hover) return

  const text = hover.textContent || ''
  const next = userInfoCache[screenName] ? {...userInfoCache[screenName]} : {}

  if (/\bFollowing\b/i.test(text) || text.includes('フォロー中')) {
    next.following = true
  }

  const followerLink = Array.from(hover.querySelectorAll('a')).find((a) => {
    const t = (a.textContent || '').trim()
    return /Followers/i.test(t) || t.includes('フォロワー')
  })
  if (followerLink) {
    const t = (followerLink.textContent || '').trim()
    const numPart = t.replace(/Followers/i, '').replace('フォロワー', '').trim()
    const parsed = parseFollowerCount(numPart)
    if (parsed != null) next.followersCount = parsed
  }

  userInfoCache[screenName] = next
}

/**
 * @param {string|null} screenName
 * @returns {boolean} true if allowed (should remain visible)
 */
function isAllowedByExceptions(screenName) {
  if (!screenName) return false
  const info = userInfoCache[screenName]
  if (!info) return false

  if (config.showIfFollowing && info.following) return true
  if (config.showIfFollowerCountAtLeastEnabled) {
    const threshold = Number(config.showIfFollowerCountAtLeast || 0)
    if ((info.followersCount || 0) >= threshold) return true
  }
  return false
}

/** @param {HTMLElement} tweet */
function hideTweet(tweet, reason) {
  const container = getTweetCellContainer(tweet)
  if (container.getAttribute(HIDDEN_ATTR) === 'true') return
  container.style.display = 'none'
  container.setAttribute(HIDDEN_ATTR, 'true')
  container.setAttribute(HIDDEN_REASON_ATTR, reason)
}

/** @param {HTMLElement} tweet */
function showTweet(tweet) {
  const container = getTweetCellContainer(tweet)
  if (container.getAttribute(HIDDEN_ATTR) !== 'true') return
  container.style.display = ''
  container.removeAttribute(HIDDEN_ATTR)
  container.removeAttribute(HIDDEN_REASON_ATTR)
}

function showAllHidden() {
  const hidden = document.querySelectorAll(`div[${HIDDEN_ATTR}="true"]`)
  for (const el of hidden) {
    /** @type {HTMLElement} */
    const h = /** @type {any} */(el)
    h.style.display = ''
    h.removeAttribute(HIDDEN_ATTR)
    h.removeAttribute(HIDDEN_REASON_ATTR)
  }
}

function scanAndApply() {
  if (!config.enabled || !config.hideBlueBadgeReplies || !isConversationOrQuotesPage()) {
    showAllHidden()
    return
  }

  const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
  if (tweets.length === 0) return

  // Ask page cache for user info for visible tweets (best effort)
  const screenNamesToFetch = []
  for (let i = 1; i < tweets.length; i++) {
    const sn = getScreenNameFromTweet(/** @type {HTMLElement} */(tweets[i]))
    if (!sn) continue

    const cached = userInfoCache[sn]
    // Fetch if we have no cache OR followersCount is still missing (common early)
    if (!cached || cached.followersCount == null) {
      screenNamesToFetch.push(sn)
    }
  }
  if (screenNamesToFetch.length) requestUserInfoFromPage(screenNamesToFetch.slice(0, 50))

  // Heuristic: first tweet is the main tweet; treat the rest as replies.
  for (let i = 0; i < tweets.length; i++) {
    const tweet = /** @type {HTMLElement} */(tweets[i])
    if (i === 0) {
      // never hide the root tweet
      showTweet(tweet)
      continue
    }

    if (!isVerifiedTweet(tweet)) {
      showTweet(tweet)
      continue
    }

    const screenName = getScreenNameFromTweet(tweet)
    const allowed = isAllowedByExceptions(screenName)
    if (allowed) {
      showTweet(tweet)
    } else {
      hideTweet(tweet, 'verified-reply')
    }
  }
}

let scheduled = false
function scheduleScan() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    scanAndApply()
  })
}

async function init() {
  injectPageBridge()

  config = await chrome.storage.local.get(DEFAULT_CONFIG)

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    for (const [k, v] of Object.entries(changes)) {
      // @ts-ignore
      config[k] = v.newValue
    }
    scheduleScan()
  })

  // Observe timeline updates
  new MutationObserver(() => scheduleScan()).observe(document.documentElement, {
    childList: true,
    subtree: true
  })

  // Capture hovercard info opportunistically
  let lastHoverScreenName = null
  let hoverTimer = 0
  document.addEventListener('mouseover', (ev) => {
    const a = /** @type {HTMLElement|null} */(ev.target instanceof Element ? ev.target.closest('a[href^="/"]') : null)
    if (!a) return
    const href = a.getAttribute('href') || ''
    const m = href.match(/^\/([^\/\?]+)(?:\?|$)/)
    if (!m) return
    const screenName = m[1]
    if (!screenName) return
    lastHoverScreenName = screenName

    window.clearTimeout(hoverTimer)
    hoverTimer = window.setTimeout(() => {
      if (!lastHoverScreenName) return
      tryUpdateUserInfoFromHoverCard(lastHoverScreenName)
      scheduleScan()
    }, 450)
  }, {capture: true})

  // When navigating within SPA, re-evaluate.
  const origPushState = history.pushState
  history.pushState = function() {
    // @ts-ignore
    origPushState.apply(this, arguments)
    setTimeout(scheduleScan, 50)
  }
  window.addEventListener('popstate', () => setTimeout(scheduleScan, 50))

  scanAndApply()
}

init().catch(() => {
  // Fail silent
})
