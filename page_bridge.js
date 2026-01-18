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
    const store = getReduxStore()
    if (store) return store.getState()

    return null
  }

  /** @type {{getState: Function, dispatch: Function} | null} */
  let cachedStore = null

  /**
   * Find a Redux store object (not the state).
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function getReduxStore() {
    if (cachedStore) return cachedStore

    const w = /** @type {any} */ (window)

    // 0) React root props path (often works on X)
    try {
      const storeFromRootProps = findReduxStoreFromReactRootProps()
      if (storeFromRootProps) {
        cachedStore = storeFromRootProps
        return cachedStore
      }
    } catch {
      // ignore
    }

    // 1) Common globals
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
      // ignore
    }

    // 3) Webpack runtime module cache (most robust for many SPAs)
    try {
      const storeFromWebpack = findReduxStoreFromWebpack()
      if (storeFromWebpack) {
        cachedStore = storeFromWebpack
        return cachedStore
      }
    } catch {
      // ignore
    }

    // 4) Fallback: scan window keys for store-like object
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
      // ignore
    }

    return null
  }

  /**
   * Try to extract redux store via #react-root __reactProps* chain.
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
   * Get webpack require function via global chunk arrays.
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
        // ignore
      }

      if (req && (req.c || req.m)) return req
    }
    return null
  }

  /**
   * Scan webpack module cache to find a Redux store.
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
      // Some modules export as default
      if (exp && exp.default) {
        const s2 = findStoreInObject(exp.default)
        if (s2) return s2
      }
    }
    return null
  }

  /**
   * Attempt to find a Redux store by walking React fiber trees.
   * This is best-effort and may break when X changes internals.
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
   * Walk fiber nodes looking for a react-redux Provider context with a store.
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

      // children/siblings
      if (f.child) stack.push(f.child)
      if (f.sibling) stack.push(f.sibling)

      // Some react internals keep alternate trees
      if (f.alternate) stack.push(f.alternate)
    }
    return null
  }

  /**
   * Best-effort extraction of store from various fiber fields.
   * @param {any} f
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function extractStoreFromFiber(f) {
    // react-redux Provider often puts context value on memoizedProps.value or memoizedState.
    // We scan a few likely locations for something that looks like a Redux store.
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
   * Shallow search for a store-like object in a given object.
   * @param {any} obj
   * @returns {{getState: Function, dispatch: Function} | null}
   */
  function findStoreInObject(obj) {
    if (!obj || typeof obj !== 'object') return null

    // Direct store
    if (typeof obj.getState === 'function' && typeof obj.dispatch === 'function') return obj

    // Common react-redux context value shape: {store, subscription, ...}
    if (obj.store && typeof obj.store.getState === 'function' && typeof obj.store.dispatch === 'function') return obj.store

    // Some shapes: {value: {store: ...}}
    if (obj.value) {
      const v = obj.value
      if (v && typeof v === 'object') {
        if (typeof v.getState === 'function' && typeof v.dispatch === 'function') return v
        if (v.store && typeof v.store.getState === 'function' && typeof v.store.dispatch === 'function') return v.store
      }
    }

    // One-level deep scan
    try {
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
          if (typeof v.getState === 'function' && typeof v.dispatch === 'function') return v
          if (v.store && typeof v.store.getState === 'function' && typeof v.store.dispatch === 'function') return v.store
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  /** @type {any|null} */
  let cachedEntitiesRoot = null

  /**
   * Try to locate the object that has `users.entities` (similar to getStateEntities() in the original code).
   * We cache the found root to avoid heavy scans.
   * @returns {any|null}
   */
  function getStateEntities() {
    if (cachedEntitiesRoot) return cachedEntitiesRoot

    const state = getState()
    if (!state) return null

    // Common shapes
    if (state?.entities?.users?.entities) {
      cachedEntitiesRoot = state.entities
      return cachedEntitiesRoot
    }
    if (state?.users?.entities) {
      cachedEntitiesRoot = state
      return cachedEntitiesRoot
    }

    // BFS scan (depth-limited)
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

        // enqueue child objects
        try {
          for (const v of Object.values(node)) {
            if (v && typeof v === 'object') queue.push(v)
          }
        } catch {
          // ignore
        }
      }
      depth++
    }

    return null
  }

  /**
   * Gets cached user info from Redux/React state.
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
      // X sometimes stores user fields under `legacy`.
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
      // Case-insensitive matching (content script normalizes to lower-case)
      try {
        lower[String(sn).toLowerCase()] = info
      } catch {
        // ignore
      }
    }
    return {exact, lower}
  }

  // Fallback cache (lower-case screen_name => info or null). Keeps BFS costs bounded.
  /** @type {Map<string, any>} */
  const fallbackUserCache = new Map()

  /**
   * Fallback search (batched): Quotes timeline sometimes doesn't populate users.entities for quote authors.
   * Do a single BFS over the state and resolve many screenNames at once.
   *
   * @param {any} state
   * @param {string[]} screenNamesLower
   * @returns {{found: Record<string, any>, steps: number}}
   */
  function findUserInfoByScreenNamesInState(state, screenNamesLower) {
    /** @type {Record<string, any>} */
    const found = {}
    if (!state || typeof state !== 'object') return {found, steps: 0}

    // Filter targets: remove those already cached.
    /** @type {Set<string>} */
    const targets = new Set()
    for (const sn of screenNamesLower) {
      if (!sn) continue
      if (fallbackUserCache.has(sn)) {
        const cached = fallbackUserCache.get(sn)
        if (cached) found[sn] = cached
      } else {
        targets.add(sn)
      }
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
            fallbackUserCache.set(key, info)
            found[key] = info
            targets.delete(key)
          }
        }

        // enqueue children
        for (const v of Object.values(u)) {
          if (v && typeof v === 'object') queue.push(v)
        }
      } catch {
        // ignore
      }
    }

    // Negative cache for remaining targets to avoid repeated BFS
    for (const sn of targets) fallbackUserCache.set(sn, null)

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
    let matchedExact = 0
    let matchedLower = 0
    let matchedFallback = 0

    const stateForFallback = getState()

    /** @type {string[]} */
    const fallbackTargets = []
    for (const sn of screenNames) {
      if (!sn) continue
      if (maps.exact[sn]) {
        filtered[sn] = maps.exact[sn]
        matchedExact++
        continue
      }
      const key = String(sn).toLowerCase()
      if (maps.lower[key]) {
        filtered[sn] = maps.lower[key]
        matchedLower++
        continue
      }

      fallbackTargets.push(key)
    }

    if (fallbackTargets.length) {
      const {found} = findUserInfoByScreenNamesInState(stateForFallback, fallbackTargets)
      for (const original of screenNames) {
        if (!original) continue
        if (filtered[original]) continue
        const key = String(original).toLowerCase()
        if (found[key]) {
          filtered[original] = found[key]
          matchedFallback++
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
