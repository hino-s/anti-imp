// anti-imp content script
// X(Twitter)上で、青バッジ(Verified)付きのリプライ/引用投稿を非表示にします。
// MV3 / ビルド不要

// ------------------------------
// 設定
// ------------------------------

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

// ------------------------------
// レート制限 / キャッシュ
// ------------------------------

// 同じscreenNameに対するbridge問い合わせを連発しないためのクールダウン。
/** @type {Map<string, number>} */
const userInfoFetchCooldownUntil = new Map()
const USERINFO_FETCH_COOLDOWN_MS = 15_000
const USERINFO_FETCH_COOLDOWN_MAX = 800

/**
 * クールダウン用Mapが無限に増えないように、期限切れを掃除します。
 */
function pruneCooldownMap(now) {
  if (userInfoFetchCooldownUntil.size <= USERINFO_FETCH_COOLDOWN_MAX) return
  for (const [k, until] of userInfoFetchCooldownUntil) {
    if (until <= now) userInfoFetchCooldownUntil.delete(k)
    if (userInfoFetchCooldownUntil.size <= USERINFO_FETCH_COOLDOWN_MAX) break
  }
}

// ------------------------------
// Bridge注入 & メッセージ通信
// ------------------------------

/**
 * `page_bridge.js` をページコンテキストに注入し、X内部のキャッシュへアクセスできるようにします。
 */
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
 * ページコンテキストへ userInfo（following / followersCount など）を問い合わせます。
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

    // userInfoが届いたら再スキャン（フォロワー数例外の判定タイミングを揃える）
    scheduleScan()

    // Quotesは users/entities が遅延で埋まることがあるため、0件なら数回リトライ。
    if (count === 0 && screenNames.length) {
      scheduleRetry()
    }
  })

  window.postMessage({
    type: BRIDGE_REQ_TYPE,
    requestId,
    screenNames,
  }, '*')

  // 応答が来ない場合に備えて、一定時間後に破棄
  setTimeout(() => pendingBridgeRequests.delete(requestId), 2000)
}

// ------------------------------
// DOMヘルパー
// ------------------------------

const HIDDEN_ATTR = 'data-antiimp-hidden'
const HIDDEN_REASON_ATTR = 'data-antiimp-hidden-reason'

/**
 * 会話ページ（/status/）または引用一覧（/quotes）かどうか。
 */
function isConversationOrQuotesPage() {
  // permalink会話ページ・引用一覧でのみ適用
  // 例:
  // - /{user}/status/{id}
  // - /{user}/status/{id}/quotes
  const path = location.pathname
  if (!path.includes('/status/')) return false
  // /photo/ などのメディア表示ページではDOM構造が異なるため適用しない
  if (path.includes('/photo/')) return false
  return true
}

/**
 * tweet要素から、タイムラインのセルコンテナ（cellInnerDiv）を取得します。
 * @param {HTMLElement} el
 */
function getTweetCellContainer(el) {
  return el.closest('div[data-testid="cellInnerDiv"]') || el
}

/**
 * 外側ツイートの「投稿者」が認証(Verified)かどうか。
 * （引用元ツイートの埋め込みにある認証バッジは無視します）
 * @param {HTMLElement} tweet
 */
function isVerifiedTweet(tweet) {
  // IMPORTANT:
  // Quotes一覧では、引用元ツイートが埋め込み表示されます。
  // 埋め込み側に認証バッジがあると誤判定するため、投稿者ヘッダ内のバッジだけを見る。

  const header = getAuthorHeader(tweet) || tweet

  // Xは data-testid="icon-verified" を使うことが多い
  if (header.querySelector('[data-testid="icon-verified"]')) return true

  // aria-labelに依存するフォールバック（言語設定に依存）
  const svg = header.querySelector('svg[aria-label]')
  if (!svg) return false
  const label = (svg.getAttribute('aria-label') || '').toLowerCase()
  return label.includes('verified') || label.includes('認証') || label.includes('認証済')
}

/**
 * 外側ツイートの投稿者ヘッダ（User-Nameブロック）を取得します。
 * Quotesではツイートがネストするため、埋め込み側のヘッダを拾わないようにします。
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
 * tweet要素から @screenName を抽出します（ベストエフォート）。
 * @param {HTMLElement} tweet
 * @returns {string|null}
 */
function getScreenNameFromTweet(tweet) {
  // 基本的にユーザー名ブロックはヘッダにある
  const userNameBlock = getAuthorHeader(tweet)
  const scope = userNameBlock || tweet

  // 1) @handle のテキストが取れればそれを優先（hrefより頑健）
  const text = (scope.textContent || '').trim()
  const at = text.match(/@([A-Za-z0-9_]{1,15})/)
  if (at) return at[1].toLowerCase()

  // 2) フォールバック：プロフィールリンク（/{screenName}）から推測
  const a = scope.querySelector('a[href^="/"]')
  if (!a) return null

  const href = a.getAttribute('href') || ''
  const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\b|\/|\?|$)/)
  if (!m) return null

  const screenName = m[1].toLowerCase()
  // 特殊ルート除外
  if (!screenName || screenName === 'home' || screenName === 'i' || screenName === 'settings') return null
  return screenName
}

/**
 * 例外設定（フォロー中 / フォロワー数閾値）により「表示するべきか」を判定します。
 * @param {string|null} screenName
 * @returns {boolean} true=表示する
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
 * フォロワー数閾値の例外がONなのに followersCount が未取得の場合は、
 * 誤って非表示にしないため一旦表示を維持します。
 * @param {string|null} screenName
 * @returns {boolean}
 */
function shouldDeferHideBecauseFollowersCountUnknown(screenName) {
  if (!config.showIfFollowerCountAtLeastEnabled) return false
  if (!screenName) return true
  const info = userInfoCache[screenName]
  return !info || info.followersCount == null
}

/**
 * ツイートのタイムラインセルを非表示にします。
 * @param {HTMLElement} tweet
 * @param {string} reason
 */
function hideTweet(tweet, reason) {
  const container = getTweetCellContainer(tweet)
  if (container.getAttribute(HIDDEN_ATTR) === 'true') return
  container.style.display = 'none'
  container.setAttribute(HIDDEN_ATTR, 'true')
  container.setAttribute(HIDDEN_REASON_ATTR, reason)
}

/**
 * 非表示を解除して、ツイートのタイムラインセルを表示します。
 * @param {HTMLElement} tweet
 */
function showTweet(tweet) {
  const container = getTweetCellContainer(tweet)
  if (container.getAttribute(HIDDEN_ATTR) !== 'true') return
  container.style.display = ''
  container.removeAttribute(HIDDEN_ATTR)
  container.removeAttribute(HIDDEN_REASON_ATTR)
}

/**
 * これまで非表示にしたセルをすべて表示に戻します。
 */
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

// ------------------------------
// メイン処理（走査＆適用）
// ------------------------------

/**
 * 画面上のツイートを走査し、設定に従って表示/非表示を適用します。
 */
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
  // Quotes一覧では、1セル内に
  // - 外側の引用ツイート（こちらが判定対象）
  // - 引用元の埋め込みツイート（こちらは判定対象外）
  // が存在し得ます。順序が保証されないため、外側だけを選びます。
  const cells = Array.from(document.querySelectorAll('div[data-testid="cellInnerDiv"]'))
  const tweets = cells
    .map((cell) => {
      const articles = Array.from(cell.querySelectorAll('article[data-testid="tweet"]'))
      if (!articles.length) return null

      // 他のtweet articleの内側にネストしていないもの（外側tweet）を優先。
      // （引用元の埋め込みtweetはネストしていることが多い）
      const outer = articles.find((a) => a.parentElement && !a.parentElement.closest('article[data-testid="tweet"]'))
      return outer || articles[0]
    })
    .filter(Boolean)
  if (tweets.length === 0) return

  // 元ツイの投稿者（ツイート主）を特定。
  // ツイート主のリプライは、青バッジ付きでも表示する。
  const rootAuthor = getRootAuthorScreenName(tweets)

  // 必要なユーザー情報（フォロー中/フォロワー数）をページ側キャッシュから取得（ベストエフォート）
  /** @type {Set<string>} */
  const now = Date.now()
  const screenNamesToFetch = new Set()
  for (let i = 1; i < tweets.length; i++) {
    const sn = getScreenNameFromTweet(/** @type {HTMLElement} */(tweets[i]))
    if (!sn) continue

    const cached = userInfoCache[sn]
    // キャッシュが無い、または followersCount が未取得の場合は取得対象にする
    if (!cached || cached.followersCount == null) {
      pruneCooldownMap(now)
      const until = userInfoFetchCooldownUntil.get(sn) || 0
      if (now >= until) {
        userInfoFetchCooldownUntil.set(sn, now + USERINFO_FETCH_COOLDOWN_MS)
        screenNamesToFetch.add(sn)
      }
    }
  }
  if (screenNamesToFetch.size) requestUserInfoFromPage(Array.from(screenNamesToFetch).slice(0, 200))

  // 先頭セルは元ツイとして常に表示し、2件目以降をリプライ/引用として判定します。
  for (let i = 0; i < tweets.length; i++) {
    const tweet = /** @type {HTMLElement} */(tweets[i])
    if (i === 0) {
      // 元ツイは常に表示
      showTweet(tweet)
      continue
    }

    // ツイート主のリプライは表示（青バッジでも隠さない）
    const screenName = getScreenNameFromTweet(tweet)
    if (rootAuthor && screenName && screenName === rootAuthor) {
      showTweet(tweet)
      continue
    }

    if (!isVerifiedTweet(tweet)) {
      showTweet(tweet)
      continue
    }

    const allowed = isAllowedByExceptions(screenName)
    if (allowed) {
      showTweet(tweet)
    } else {
      // フォロワー数閾値例外がONでも、followersCountが未取得なら一旦表示を維持し、
      // 取得後に再判定します。
      if (shouldDeferHideBecauseFollowersCountUnknown(screenName)) {
        showTweet(tweet)
      } else {
        hideTweet(tweet, 'verified-reply')
      }
    }
  }

  // ログ出力は削除
}

/**
 * 元ツイ投稿者（ツイート主）の screenName を取得します。
 * @param {Element[]} tweets
 * @returns {string|null}
 */
function getRootAuthorScreenName(tweets) {
  try {
    const first = tweets && tweets[0]
    if (first) {
      const fromTweet = getScreenNameFromTweet(/** @type {HTMLElement} */(first))
      if (fromTweet) return fromTweet
    }
  } catch {
    // 無視
  }

  // フォールバック：URLから推測（/{screenName}/status/{id}）
  try {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\//)
    if (m) return m[1].toLowerCase()
  } catch {
    // 無視
  }

  return null
}

// Quotesは users.entities が遅延で埋まることがあるため、数回リトライして追従します。
let retryCount = 0
/**
 * Quotesページ向け：users/entities が遅延で埋まる場合があるため、
 * バックオフしながら数回再スキャンします。
 */
function scheduleRetry() {
  if (!config.showIfFollowerCountAtLeastEnabled) return
  if (!isConversationOrQuotesPage()) return
  if (retryCount >= 8) return
  retryCount++
  const delay = Math.min(6000, 600 * Math.pow(1.4, retryCount))
  setTimeout(() => {
    scheduleScan()
  }, delay)
}

const MIN_SCAN_INTERVAL_MS = 200
let lastScanAt = 0
let scanTimer = 0
let scheduled = false
/**
 * スキャンをスケジュールします。
 * MutationObserverの連続発火で重くならないよう、最小間隔を設けています。
 */
function scheduleScan() {
  if (scheduled) return
  scheduled = true
  window.clearTimeout(scanTimer)

  const now = Date.now()
  const wait = Math.max(0, MIN_SCAN_INTERVAL_MS - (now - lastScanAt))
  scanTimer = window.setTimeout(() => {
    lastScanAt = Date.now()
    scheduled = false
    scanAndApply()
  }, wait)
}

async function init() {
  // ------------------------------
  // 起動処理
  // ------------------------------
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

  // タイムライン更新を監視
  new MutationObserver(() => scheduleScan()).observe(document.documentElement, {
    childList: true,
    subtree: true
  })

  // SPA内遷移でも再判定
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
