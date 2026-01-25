// ページコンテキストで実行されるスクリプトです（content scriptの分離環境ではありません）。
// X/Twitterのページ内JS（React/Reduxキャッシュ等）へアクセスし、
// content script からの問い合わせに応答します。

;(function() {
  'use strict'

  const REQ_TYPE = 'antiimp:getUserInfo'
  const RES_TYPE = 'antiimp:userInfo'

  // ------------------------------
  // Reduxストアの探索
  // ------------------------------

  /**
   * Reduxライクな state を取得します（ベストエフォート）。
   * @returns {any|null}
   */
  function getState() {
    // ヒューリスティック：
    // - 一部ビルドはグローバルにstoreを持つ
    // - 一部ビルドはデバッグ用フック等に隠れている
    const store = getReduxStore()
    if (store) return store.getState()

    return null
  }

  /** @type {{getState: Function, dispatch: Function} | null} */
  let cachedStore = null

  /**
   * Reduxストア本体（getState/dispatchを持つオブジェクト）を探索します。
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function getReduxStore() {
    if (cachedStore) return cachedStore

    const w = /** @type {any} */ (window)

    // 0) React root props 経由（Xで動くことが多い）
    try {
      const storeFromRootProps = findReduxStoreFromReactRootProps()
      if (storeFromRootProps) {
        cachedStore = storeFromRootProps
        return cachedStore
      }
    } catch {
      // 失敗した場合は無視して次の探索へ
    }

    // 1) よくあるグローバル変数
    if (w.__REDUX_STORE__?.getState && w.__REDUX_STORE__?.dispatch) {
      cachedStore = w.__REDUX_STORE__
      return cachedStore
    }
    if (w.__STORE__?.getState && w.__STORE__?.dispatch) {
      cachedStore = w.__STORE__
      return cachedStore
    }

    // 2) React fiber -> react-redux Provider context
    try {
      const storeFromFiber = findReduxStoreFromReactFiber()
      if (storeFromFiber) {
        cachedStore = storeFromFiber
        return cachedStore
      }
    } catch {
      // 無視
    }

    // 3) Webpack runtime の module cache
    try {
      const storeFromWebpack = findReduxStoreFromWebpack()
      if (storeFromWebpack) {
        cachedStore = storeFromWebpack
        return cachedStore
      }
    } catch {
      // 無視
    }

    // 4) フォールバック：window上のキーを総当りしてstoreっぽい物を探す
    try {
      const keys = Object.getOwnPropertyNames(w)
      for (const k of keys) {
        if (!k || k.length < 6) continue
        const v = w[k]
        if (v && typeof v.getState === 'function' && typeof v.dispatch === 'function') {
          cachedStore = v
          return cachedStore
        }
      }
    } catch {
      // 無視
    }

    return null
  }

  /**
   * #react-root の __reactProps* チェーンから store を取り出します。
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function findReduxStoreFromReactRootProps() {
    const root = document.getElementById('react-root')
    if (!root || !root.firstElementChild) return null

    const el = root.firstElementChild
    const key = Object.keys(el).find((k) => k.startsWith('__reactProps'))
    if (!key) return null

    const props = el[key]?.children?.props?.children?.props
    const store = props?.store
    if (store && typeof store.getState === 'function' && typeof store.dispatch === 'function') {
      return store
    }
    return null
  }

  /**
   * webpackのchunk配列から __webpack_require__ 相当を取り出します。
   * @returns {any|null}
   */
  function getWebpackRequire() {
    const w = /** @type {any} */ (window)
    const chunkGlobals = Object.getOwnPropertyNames(w).filter((k) => k.startsWith('webpackChunk'))
    for (const name of chunkGlobals) {
      const chunk = w[name]
      if (!chunk || !Array.isArray(chunk) || typeof chunk.push !== 'function') continue

      let req = null
      try {
        chunk.push([
          [Math.floor(Math.random() * 1e9)],
          {},
          (r) => {
            req = r
          },
        ])
      } catch {
        // 無視
      }

      if (req && (req.c || req.m)) return req
    }
    return null
  }

  /**
   * webpack module cache を走査してRedux storeを探します。
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function findReduxStoreFromWebpack() {
    const req = getWebpackRequire()
    if (!req) return null

    const cache = req.c || {}
    const modules = Object.values(cache)

    for (const mod of modules) {
      const exp = mod && mod.exports
      const store = findStoreInObject(exp)
      if (store) return store
      // default export の場合もある
      if (exp && exp.default) {
        const s2 = findStoreInObject(exp.default)
        if (s2) return s2
      }
    }
    return null
  }

  /**
   * React fiberツリーを走査してRedux storeを探します。
   * ベストエフォートであり、Xの内部実装変更で壊れる可能性があります。
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function findReduxStoreFromReactFiber() {
    const w = /** @type {any} */ (window)
    const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__
    if (!hook || typeof hook.getFiberRoots !== 'function') return null

    /** @type {Set<any>} */
    const roots = new Set()
    try {
      for (const rendererID of hook.getFiberRoots.keys()) {
        const set = hook.getFiberRoots(rendererID)
        if (!set) continue
        for (const r of set) roots.add(r)
      }
    } catch {
      return null
    }

    for (const root of roots) {
      const fiberRoot = root && (root.current || root)
      const found = walkFiberForStore(fiberRoot)
      if (found) return found
    }
    return null
  }

  /**
   * fiberノードを走査して、storeを持つreact-reduxのProvider contextを探します。
   * @param {any} fiber
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function walkFiberForStore(fiber) {
    /** @type {any[]} */
    const stack = []
    if (fiber) stack.push(fiber)
    const visited = new Set()
    let steps = 0
    const maxSteps = 50_000

    while (stack.length && steps++ < maxSteps) {
      const f = stack.pop()
      if (!f || typeof f !== 'object') continue
      if (visited.has(f)) continue
      visited.add(f)

      const store = extractStoreFromFiber(f)
      if (store) return store

      // child / sibling
      if (f.child) stack.push(f.child)
      if (f.sibling) stack.push(f.sibling)

      // React内部では alternate ツリーを持つことがある
      if (f.alternate) stack.push(f.alternate)
    }
    return null
  }

  /**
   * fiberの各フィールドからstoreらしきオブジェクトを取り出します（ベストエフォート）。
   * @param {any} f
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function extractStoreFromFiber(f) {
    // react-redux Provider は context value を memoizedProps.value / memoizedState に載せることが多い。
    // Redux storeっぽいものが入っていそうな場所をいくつか走査する。
    const candidates = []
    if (f.memoizedProps) candidates.push(f.memoizedProps)
    if (f.memoizedProps && f.memoizedProps.value) candidates.push(f.memoizedProps.value)
    if (f.memoizedState) candidates.push(f.memoizedState)
    if (f.dependencies) candidates.push(f.dependencies)
    if (f.dependencies && f.dependencies.firstContext) candidates.push(f.dependencies.firstContext)

    for (const c of candidates) {
      const store = findStoreInObject(c)
      if (store) return store
    }
    return null
  }

  /**
   * 与えられたオブジェクト内から、storeっぽいオブジェクトを浅く探索します。
   * @param {any} obj
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function findStoreInObject(obj) {
    if (!obj || typeof obj !== 'object') return null

    // 直接store
    if (typeof obj.getState === 'function' && typeof obj.dispatch === 'function') return obj

    // よくあるreact-reduxのcontext value: {store, subscription, ...}
    if (obj.store && typeof obj.store.getState === 'function' && typeof obj.store.dispatch === 'function') return obj.store

    // 例: {value: {store: ...}}
    if (obj.value) {
      const v = obj.value
      if (v && typeof v === 'object') {
        if (typeof v.getState === 'function' && typeof v.dispatch === 'function') return v
        if (v.store && typeof v.store.getState === 'function' && typeof v.store.dispatch === 'function') return v.store
      }
    }

    // 1階層だけ探索
    try {
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
          if (typeof v.getState === 'function' && typeof v.dispatch === 'function') return v
          if (v.store && typeof v.store.getState === 'function' && typeof v.store.dispatch === 'function') return v.store
        }
      }
    } catch {
      // 無視
    }
    return null
  }

  /** @type {any|null} */
  let cachedEntitiesRoot = null

  // ------------------------------
  // users.entities の取得
  // ------------------------------

  /**
   * stateツリーから `users.entities` を持つオブジェクトを見つけます。
   * @returns {any|null}
   */
  function getStateEntities() {
    if (cachedEntitiesRoot) return cachedEntitiesRoot

    const state = getState()
    if (!state) return null

    // よくある形
    if (state?.entities?.users?.entities) {
      cachedEntitiesRoot = state.entities
      return cachedEntitiesRoot
    }
    if (state?.users?.entities) {
      cachedEntitiesRoot = state
      return cachedEntitiesRoot
    }

    // BFSで探索（深さ制限）
    /** @type {any[]} */
    const queue = [state]
    const visited = new Set()
    let depth = 0
    const maxDepth = 4

    while (queue.length && depth <= maxDepth) {
      const levelSize = queue.length
      for (let i = 0; i < levelSize; i++) {
        const node = queue.shift()
        if (!node || typeof node !== 'object') continue
        if (visited.has(node)) continue
        visited.add(node)

        if (node?.users?.entities && typeof node.users.entities === 'object') {
          cachedEntitiesRoot = node
          return cachedEntitiesRoot
        }
        if (node?.entities?.users?.entities && typeof node.entities.users.entities === 'object') {
          cachedEntitiesRoot = node.entities
          return cachedEntitiesRoot
        }

        // 子オブジェクトをキューに積む
        try {
          for (const v of Object.values(node)) {
            if (v && typeof v === 'object') queue.push(v)
          }
        } catch {
          // 無視
        }
      }
      depth++
    }

    return null
  }

  /**
   * `users.entities` から検索用マップを構築します。
   * - exact: screen_name（生）
   * - lower: screen_name（小文字）
   * @returns {{exact: Record<string, any>, lower: Record<string, any>}}
   */
  function getUserInfoMaps() {
    /** @type {Record<string, {following?: boolean, followedBy?: boolean, followersCount?: number}>} */
    const exact = {}
    /** @type {Record<string, {following?: boolean, followedBy?: boolean, followersCount?: number}>} */
    const lower = {}

    const userEntities = getStateEntities()?.users?.entities
    if (!userEntities) return {exact, lower}

    for (const user of Object.values(userEntities)) {
      if (!user || typeof user !== 'object') continue
      // Xでは user.legacy 配下に値が入ることがあります。
      const u = /** @type {any} */(user)
      const legacy = u.legacy && typeof u.legacy === 'object' ? u.legacy : null

      const sn = (legacy?.screen_name ?? u.screen_name)
      if (!sn) continue

      const info = {
        following: (legacy?.following ?? u.following),
        followedBy: (legacy?.followed_by ?? u.followed_by),
        followersCount: (legacy?.followers_count ?? u.followers_count),
      }
      exact[sn] = info
      // 大文字小文字を無視して照合するため、小文字キーも作る
      try {
        lower[String(sn).toLowerCase()] = info
      } catch {
        // 無視
      }
    }
    return {exact, lower}
  }

  // ------------------------------
  // フォールバック探索（Quotes向け）
  // ------------------------------

  // フォールバックキャッシュ（lower-case screen_name => {value, expiresAt}）
  // BFSのコストを抑えつつ、遅れてロードされるユーザーにも追従できるようTTL付き。
  const FALLBACK_CACHE_MAX = 2000
  const FALLBACK_CACHE_TTL_POS_MS = 10 * 60 * 1000
  const FALLBACK_CACHE_TTL_NEG_MS = 12 * 1000

  /** @type {Map<string, {value: any|null, expiresAt: number}>} */
  const fallbackUserCache = new Map()

  /**
   * フォールバックキャッシュから取得します。
   * @param {string} keyLower
   * @returns {any|null|undefined} undefined=未キャッシュ/期限切れ, null=見つからない（負のキャッシュ）, object=見つかった
   */
  function getFallbackCache(keyLower) {
    const hit = fallbackUserCache.get(keyLower)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) {
      fallbackUserCache.delete(keyLower)
      return undefined
    }
    return hit.value
  }

  /**
   * フォールバックキャッシュへ保存します。
   * @param {string} keyLower
   * @param {any|null} value
   * @param {number} ttlMs
   */
  function setFallbackCache(keyLower, value, ttlMs) {
    // 挿入順を更新
    if (fallbackUserCache.has(keyLower)) fallbackUserCache.delete(keyLower)
    fallbackUserCache.set(keyLower, {value, expiresAt: Date.now() + ttlMs})

    // サイズ上限（Mapは挿入順を保持する）
    while (fallbackUserCache.size > FALLBACK_CACHE_MAX) {
      const oldestKey = fallbackUserCache.keys().next().value
      if (!oldestKey) break
      fallbackUserCache.delete(oldestKey)
    }
  }

  /**
   * フォールバック探索（バッチ）：Quotesでは quote作者が users.entities に載らない場合があります。
   * state全体を1回BFSして、複数screenNameをまとめて解決します。
   *
   * @param {any} state
   * @param {string[]} screenNamesLower
   * @returns {{found: Record<string, any>, steps: number}}
   */
  function findUserInfoByScreenNamesInState(state, screenNamesLower) {
    /** @type {Record<string, any>} */
    const found = {}
    if (!state || typeof state !== 'object') return {found, steps: 0}

    // キャッシュ済みは除外
    /** @type {Set<string>} */
    const targets = new Set()
    for (const sn of screenNamesLower) {
      if (!sn) continue
      const cached = getFallbackCache(sn)
      if (cached === undefined) targets.add(sn)
      else if (cached) found[sn] = cached
    }

    if (!targets.size) return {found, steps: 0}

    const visited = new Set()
    /** @type {any[]} */
    const queue = [state]
    let steps = 0
    const maxSteps = 80_000

    while (queue.length && steps++ < maxSteps && targets.size) {
      const node = queue.shift()
      if (!node || typeof node !== 'object') continue
      if (visited.has(node)) continue
      visited.add(node)

      try {
        const u = /** @type {any} */(node)
        const legacy = u.legacy && typeof u.legacy === 'object' ? u.legacy : null
        const sn = (legacy?.screen_name ?? u.screen_name)
        if (sn) {
          const key = String(sn).toLowerCase()
          if (targets.has(key)) {
            const info = {
              following: (legacy?.following ?? u.following),
              followedBy: (legacy?.followed_by ?? u.followed_by),
              followersCount: (legacy?.followers_count ?? u.followers_count),
            }
            setFallbackCache(key, info, FALLBACK_CACHE_TTL_POS_MS)
            found[key] = info
            targets.delete(key)
          }
        }

        // 子オブジェクトをキューに積む
        for (const v of Object.values(u)) {
          if (v && typeof v === 'object') queue.push(v)
        }
      } catch {
        // 無視
      }
    }

    // 見つからなかったものは負のキャッシュ（ただし短TTLで、後からロードされる場合に追従）
    for (const sn of targets) setFallbackCache(sn, null, FALLBACK_CACHE_TTL_NEG_MS)

    return {found, steps}
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data.type !== REQ_TYPE) return

    const requestId = data.requestId
    const screenNames = Array.isArray(data.screenNames) ? data.screenNames : []

    const maps = getUserInfoMaps()
    /** @type {Record<string, any>} */
    const filtered = {}

    const stateForFallback = getState()

    /** @type {string[]} */
    const fallbackTargets = []
    for (const sn of screenNames) {
      if (!sn) continue
      if (maps.exact[sn]) {
        filtered[sn] = maps.exact[sn]
        continue
      }
      const key = String(sn).toLowerCase()
      if (maps.lower[key]) {
        filtered[sn] = maps.lower[key]
        continue
      }

      // 1回の要求でのフォールバック探索対象を制限（未解決は後で再リクエストされる）
      if (fallbackTargets.length < 50) fallbackTargets.push(key)
    }

    if (fallbackTargets.length) {
      const {found} = findUserInfoByScreenNamesInState(stateForFallback, fallbackTargets)
      for (const original of screenNames) {
        if (!original) continue
        if (filtered[original]) continue
        const key = String(original).toLowerCase()
        if (found[key]) {
          filtered[original] = found[key]
        }
      }
    }

    window.postMessage({
      type: RES_TYPE,
      requestId,
      userInfo: filtered,
    }, '*')
  })
})()
