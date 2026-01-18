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

// Avoid spamming bridge requests for the same screenName.
/** @type {Map<string, number>} */
const userInfoFetchCooldownUntil = new Map()
const USERINFO_FETCH_COOLDOWN_MS = 15_000

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
    const count = Object.keys(ui).length
    for (const [sn, info] of Object.entries(ui)) {
      // @ts-ignore
      userInfoCache[sn] = {
        ...userInfoCache[sn],
        ...info,
      }
    }

    // Re-apply after userInfo arrives (fixes follower-count exception timing)
    scheduleScan()

    // Quotes page tends to fill users/entities lazily; retry a few times if we got nothing.
    if (count === 0 && screenNames.length) {
      scheduleRetry()
    }
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
  // IMPORTANT:
  // On quote timelines, an article often contains an embedded quoted tweet.
  // That embedded tweet can include a verified icon even if the quoting user is not verified.
  // Therefore we only consider the verified icon inside the *author header*.

  const header = getAuthorHeader(tweet) || tweet

  // X often uses data-testid icon-verified for the check badge.
  if (header.querySelector('[data-testid="icon-verified"]')) return true

  // Fallback for aria-label based icons (depends on locale).
  const svg = header.querySelector('svg[aria-label]')
  if (!svg) return false
  const label = (svg.getAttribute('aria-label') || '').toLowerCase()
  return label.includes('verified') || label.includes('認証') || label.includes('認証済')
}

/**
 * On Quotes pages, an outer tweet can contain an embedded quoted tweet (sometimes as a nested <article>).
 * We need the *outer* tweet author's header.
 * @param {HTMLElement} tweet
 */
function getAuthorHeader(tweet) {
  const candidates = Array.from(tweet.querySelectorAll('[data-testid="User-Name"]'))
  for (const el of candidates) {
    const closestArticle = el.closest('article[data-testid="tweet"]')
    if (closestArticle === tweet) return /** @type {HTMLElement} */ (el)
  }
  return null
}

/**
 * Extract @screenName from a tweet.
 * @param {HTMLElement} tweet
 * @returns {string|null}
 */
function getScreenNameFromTweet(tweet) {
  // Usually the user name block exists in header.
  const userNameBlock = getAuthorHeader(tweet)
  const scope = userNameBlock || tweet

  // 1) Prefer @handle text if present (more robust than href patterns).
  const text = (scope.textContent || '').trim()
  const at = text.match(/@([A-Za-z0-9_]{1,15})/)
  if (at) return at[1].toLowerCase()

  // 2) Fallback to profile link like /{screenName}
  const a = scope.querySelector('a[href^="/"]')
  if (!a) return null

  const href = a.getAttribute('href') || ''
  const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\b|\/|\?|$)/)
  if (!m) return null

  const screenName = m[1].toLowerCase()
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

/**
 * If follower-count exception is enabled but followersCount is not available yet,
 * we keep the tweet visible (do not hide prematurely).
 * @param {string|null} screenName
 */
function shouldDeferHideBecauseFollowersCountUnknown(screenName) {
  if (!config.showIfFollowerCountAtLeastEnabled) return false
  if (!screenName) return true
  const info = userInfoCache[screenName]
  return !info || info.followersCount == null
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
    retryCount = 0
    showAllHidden()
    return
  }

  if (!config.showIfFollowerCountAtLeastEnabled) {
    retryCount = 0
  }

  // IMPORTANT:
  // On Quotes pages, each timeline cell can contain:
  // - the outer quote tweet (author we care about)
  // - an embedded quoted tweet (often also rendered as an <article data-testid="tweet">)
  // Order is not guaranteed. We must pick the *outer* article.
  const cells = Array.from(document.querySelectorAll('div[data-testid="cellInnerDiv"]'))
  const tweets = cells
    .map((cell) => {
      const articles = Array.from(cell.querySelectorAll('article[data-testid="tweet"]'))
      if (!articles.length) return null

      // Choose an article that is NOT nested within another tweet article.
      // (Embedded quoted tweets are typically nested.)
      const outer = articles.find((a) => a.parentElement && !a.parentElement.closest('article[data-testid="tweet"]'))
      return outer || articles[0]
    })
    .filter(Boolean)
  if (tweets.length === 0) return

  // Ask page cache for user info for visible tweets (best effort)
  /** @type {Set<string>} */
  const screenNamesToFetch = new Set()
  for (let i = 1; i < tweets.length; i++) {
    const sn = getScreenNameFromTweet(/** @type {HTMLElement} */(tweets[i]))
    if (!sn) continue

    const cached = userInfoCache[sn]
    // Fetch if we have no cache OR followersCount is still missing (common early)
    if (!cached || cached.followersCount == null) {
      const now = Date.now()
      const until = userInfoFetchCooldownUntil.get(sn) || 0
      if (now >= until) {
        userInfoFetchCooldownUntil.set(sn, now + USERINFO_FETCH_COOLDOWN_MS)
        screenNamesToFetch.add(sn)
      }
    }
  }
  if (screenNamesToFetch.size) requestUserInfoFromPage(Array.from(screenNamesToFetch).slice(0, 200))

  // logs removed

  // Heuristic: first cell is the main tweet; treat the rest as replies/quotes.
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
      // If follower count exception is enabled but we don't have follower count yet,
      // keep it visible for now and decide after state arrives.
      if (shouldDeferHideBecauseFollowersCountUnknown(screenName)) {
        showTweet(tweet)
      } else {
        hideTweet(tweet, 'verified-reply')
      }
    }
  }

  // logs removed
}

// Quotes pages often populate users.entities lazily. Retry a few times so follower counts can arrive.
let retryCount = 0
function scheduleRetry() {
  if (!config.showIfFollowerCountAtLeastEnabled) return
  if (!isConversationOrQuotesPage()) return
  if (retryCount >= 8) return
  retryCount++
  const delay = Math.min(6000, 600 * Math.pow(1.4, retryCount))
  setTimeout(() => {
    scanAndApply()
  }, delay)
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

  // NOTE: Hovercard-based parsing is disabled to keep followerCount source consistent.

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
