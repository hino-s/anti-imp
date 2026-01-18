// Runs in the page context (not the isolated content-script world).
// It can access X/Twitter's in-page JS (React/Redux caches) and respond to
// messages from the content script.

;(function() {
  'use strict'

  const REQ_TYPE = 'antiimp:getUserInfo'
  const RES_TYPE = 'antiimp:userInfo'

  /**
   * Tries to locate a Redux-like state object.
   * X changes this often; we keep it best-effort.
   * @returns {any|null}
   */
  function getState() {
    // Heuristics:
    // - Some builds expose a global store.
    // - Some keep it on a debug hook.
    const w = /** @type {any} */ (window)
    if (w.__REDUX_STORE__?.getState) return w.__REDUX_STORE__.getState()
    if (w.__STORE__?.getState) return w.__STORE__.getState()

    // Try devtools hook (may not exist in prod)
    const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__
    if (hook && hook.getFiberRoots) {
      // Not straightforward to get redux state from here; keep as fallback.
    }

    // Try scanning window keys for a store-ish object.
    try {
      for (const k of Object.keys(w)) {
        if (!k || k.length < 6) continue
        const v = w[k]
        if (v && typeof v.getState === 'function' && typeof v.dispatch === 'function') {
          return v.getState()
        }
      }
    } catch {
      // ignore
    }

    return null
  }

  /**
   * Gets cached user info from Redux/React state.
   * @returns {Record<string, {following?: boolean, followedBy?: boolean, followersCount?: number}>}
   */
  function getUserInfo() {
    /** @type {Record<string, {following?: boolean, followedBy?: boolean, followersCount?: number}>} */
    const userInfo = {}

    const state = getState()
    const userEntities = state?.entities?.users?.entities
    if (!userEntities) return userInfo

    for (const user of Object.values(userEntities)) {
      if (!user || typeof user !== 'object') continue
      const sn = /** @type {any} */(user).screen_name
      if (!sn) continue
      userInfo[sn] = {
        following: /** @type {any} */(user).following,
        followedBy: /** @type {any} */(user).followed_by,
        followersCount: /** @type {any} */(user).followers_count,
      }
    }
    return userInfo
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data.type !== REQ_TYPE) return

    const requestId = data.requestId
    const screenNames = Array.isArray(data.screenNames) ? data.screenNames : []

    const all = getUserInfo()
    /** @type {Record<string, any>} */
    const filtered = {}
    for (const sn of screenNames) {
      if (sn && all[sn]) filtered[sn] = all[sn]
    }

    window.postMessage({
      type: RES_TYPE,
      requestId,
      userInfo: filtered,
    }, '*')
  })
})()

