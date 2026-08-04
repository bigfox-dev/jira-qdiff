/*!
 * Jira Diff Highlighter (Server / Data Center)
 * Background (Chrome: service worker, Firefox: event page): keeps the per-site
 * content-script registrations in sync with the granted host permissions.
 *
 * On-premise Jira lives on an arbitrary internal hostname, so nothing is
 * matched statically — the popup asks for the permission, we register a
 * dynamic content script for that exact origin.
 */

/*
 * Cross-browser namespace. This file is promise-based, and that is exactly
 * where the two browsers differ: Chrome's MV3 `chrome.*` returns promises,
 * while Firefox's `chrome.*` is a callback-only compatibility alias — only
 * `browser.*` is promisified there. Picking `browser` first keeps every
 * `await` below meaningful in both.
 */
const api = globalThis.browser || globalThis.chrome;

const CONTENT_JS = [
    'common/settings.js',
    'common/theme.js',
    'content/diff.js',
    'content/extract.js',
    'content/markup.js',
    'content/history.js',
    'content/render.js',
    'content/adapters.js',
    'content/filter.js',
    'content/expand.js',
    'content/content.js'
];
const CONTENT_CSS = ['content/styles.css'];
const SITES_KEY = 'sites';
const ID_PREFIX = 'jdh-';

function scriptId(pattern) {
    return ID_PREFIX + pattern.replace(/[^a-z0-9]+/gi, '_');
}

async function getSites() {
    const stored = await api.storage.local.get(SITES_KEY);
    return Array.isArray(stored[SITES_KEY]) ? stored[SITES_KEY] : [];
}

async function setSites(sites) {
    await api.storage.local.set({ [SITES_KEY]: Array.from(new Set(sites)) });
}

async function registeredIds() {
    try {
        const scripts = await api.scripting.getRegisteredContentScripts();
        return scripts.filter((s) => s.id.startsWith(ID_PREFIX)).map((s) => s.id);
    } catch (err) {
        console.warn('[jira-diff] getRegisteredContentScripts failed', err);
        return [];
    }
}

async function registerSite(pattern) {
    const definition = {
        id: scriptId(pattern),
        matches: [pattern],
        js: CONTENT_JS,
        css: CONTENT_CSS,
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true
    };
    const existing = await registeredIds();
    const write = existing.includes(definition.id)
        ? (def) => api.scripting.updateContentScripts([def])
        : (def) => api.scripting.registerContentScripts([def]);

    try {
        await write(definition);
    } catch (err) {
        // Older engines reject the unknown `persistAcrossSessions` property;
        // registering without it still works for the current session.
        const { persistAcrossSessions, ...fallback } = definition;
        console.warn('[jira-diff] retrying registration without persistence', err);
        await write(fallback);
    }
}

async function unregisterSite(pattern) {
    const id = scriptId(pattern);
    if ((await registeredIds()).includes(id)) {
        await api.scripting.unregisterContentScripts({ ids: [id] });
    }
}

/** Drop registrations whose permission is gone; (re)create the ones that stay. */
async function reconcile() {
    const sites = await getSites();
    const granted = await api.permissions.getAll();
    const origins = new Set(granted.origins || []);

    const valid = sites.filter((pattern) => origins.has(pattern));
    if (valid.length !== sites.length) await setSites(valid);

    const wanted = new Set(valid.map(scriptId));
    const stale = (await registeredIds()).filter((id) => !wanted.has(id));
    if (stale.length) {
        try {
            await api.scripting.unregisterContentScripts({ ids: stale });
        } catch (err) {
            console.warn('[jira-diff] could not unregister stale scripts', err);
        }
    }

    for (const pattern of valid) {
        try {
            await registerSite(pattern);
        } catch (err) {
            console.warn('[jira-diff] could not register', pattern, err);
        }
    }
    return valid;
}

async function injectNow(tabId) {
    await api.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS });
    await api.scripting.executeScript({ target: { tabId }, files: CONTENT_JS });
}

const VIEWER_PREFIX = 'viewer:';
/** Keep a handful so reloading a viewer tab still works. */
const VIEWER_KEEP = 10;
/** storage.session tops out around 10 MB; stay well clear of it. */
const VIEWER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Hand a diff over to a standalone viewer tab.
 *
 * The payload goes through storage.session rather than a message to the new tab:
 * the tab is not listening yet when it is created, and an MV3 background can be
 * shut down at any moment, so holding it in a variable would lose it.
 */
async function openViewer(payload) {
    const serialised = JSON.stringify(payload);
    if (serialised.length > VIEWER_MAX_BYTES) {
        return { ok: false, error: 'This diff is too large to open in a tab' };
    }

    const stored = await api.storage.session.get(null);
    const existing = Object.keys(stored).filter((key) => key.startsWith(VIEWER_PREFIX));

    // Order by an explicit sequence number, not by timestamp: two hand-offs in
    // the same millisecond would tie, the sort would be a no-op, and pruning
    // would then drop the newest payloads instead of the oldest. The counter is
    // derived from what is already stored, so it survives a background restart.
    const nextSeq = existing.reduce(
        (max, key) => Math.max(max, stored[key].seq || 0), 0
    ) + 1;

    const stale = existing
        .sort((a, b) => (stored[b].seq || 0) - (stored[a].seq || 0))
        .slice(VIEWER_KEEP - 1);
    if (stale.length) await api.storage.session.remove(stale);

    const id = VIEWER_PREFIX + nextSeq + '-' + Math.random().toString(36).slice(2, 8);
    payload.seq = nextSeq;
    payload.createdAt = Date.now();
    await api.storage.session.set({ [id]: payload });

    await api.tabs.create({
        url: api.runtime.getURL('viewer/viewer.html?id=' + encodeURIComponent(id))
    });
    return { ok: true, id };
}

const handlers = {
    async status() {
        return { ok: true, sites: await getSites() };
    },

    async openViewer(payload) {
        return openViewer(payload);
    },

    async enableSite({ pattern, tabId }) {
        const sites = await getSites();
        if (!sites.includes(pattern)) sites.push(pattern);
        await setSites(sites);
        await registerSite(pattern);
        if (tabId !== undefined && tabId !== null) {
            try {
                await injectNow(tabId);
            } catch (err) {
                // Injection fails on privileged pages and before the tab settles;
                // the registered script will still run on the next load.
                console.warn('[jira-diff] immediate injection skipped', err);
            }
        }
        return { ok: true, sites: await getSites() };
    },

    async disableSite({ pattern }) {
        const sites = (await getSites()).filter((s) => s !== pattern);
        await setSites(sites);
        await unregisterSite(pattern);
        try {
            await api.permissions.remove({ origins: [pattern] });
        } catch (err) {
            console.warn('[jira-diff] permission removal failed', err);
        }
        return { ok: true, sites };
    },

    async reconcile() {
        return { ok: true, sites: await reconcile() };
    }
};

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    const key = message.type.replace(/^jdh:/, '');
    const handler = handlers[key];
    if (!handler) return false;

    handler(message.payload || {})
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response — honoured by both browsers
});

api.runtime.onInstalled.addListener(() => { reconcile(); });
api.runtime.onStartup.addListener(() => { reconcile(); });
api.permissions.onRemoved.addListener(() => { reconcile(); });
