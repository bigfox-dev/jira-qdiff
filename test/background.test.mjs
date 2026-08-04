/**
 * Runs background.js against fake extension APIs, once per browser flavour.
 *
 * The point is the namespace split: Chrome MV3 promisifies `chrome.*`, Firefox
 * promisifies only `browser.*` (its `chrome.*` is callback-only). background.js
 * is promise-based, so it must pick `browser` when present — these tests fail
 * if that shim is ever reverted to a bare `chrome.`.
 *
 * Run: node --test test/background.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

const PATTERN = 'https://jira.firma.cz/*';

/** Promise-based extension API double, mirroring what both browsers expose. */
function makeApi(options = {}) {
    const state = {
        storage: {},
        session: {},
        scripts: [],
        origins: new Set(options.origins || []),
        injected: [],
        registerCalls: [],
        createdTabs: []
    };

    const api = {
        storage: {
            local: {
                async get(key) {
                    return key in state.storage ? { [key]: state.storage[key] } : {};
                },
                async set(obj) {
                    Object.assign(state.storage, obj);
                }
            },
            session: {
                async get(key) {
                    if (key === null) return { ...state.session };
                    return key in state.session ? { [key]: state.session[key] } : {};
                },
                async set(obj) {
                    Object.assign(state.session, obj);
                },
                async remove(keys) {
                    (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
                        delete state.session[k];
                    });
                }
            }
        },
        tabs: {
            async create({ url }) {
                state.createdTabs.push(url);
                return { id: state.createdTabs.length };
            }
        },
        scripting: {
            async getRegisteredContentScripts() {
                return state.scripts.map((s) => ({ ...s }));
            },
            async registerContentScripts(defs) {
                state.registerCalls.push(defs[0]);
                if (options.rejectPersistence && 'persistAcrossSessions' in defs[0]) {
                    throw new Error('persistAcrossSessions is not supported');
                }
                for (const def of defs) {
                    if (state.scripts.some((s) => s.id === def.id)) {
                        throw new Error(`duplicate id ${def.id}`);
                    }
                    state.scripts.push(def);
                }
            },
            async updateContentScripts(defs) {
                state.registerCalls.push(defs[0]);
                for (const def of defs) {
                    const index = state.scripts.findIndex((s) => s.id === def.id);
                    if (index === -1) throw new Error(`unknown id ${def.id}`);
                    state.scripts[index] = def;
                }
            },
            async unregisterContentScripts({ ids }) {
                state.scripts = state.scripts.filter((s) => !ids.includes(s.id));
            },
            async insertCSS({ target }) {
                state.injected.push(['css', target.tabId]);
            },
            async executeScript({ target }) {
                state.injected.push(['js', target.tabId]);
            }
        },
        permissions: {
            async getAll() {
                return { origins: [...state.origins], permissions: [] };
            },
            async remove({ origins }) {
                origins.forEach((o) => state.origins.delete(o));
                return true;
            },
            onRemoved: { addListener() {} }
        },
        runtime: {
            getURL: (path) => 'chrome-extension://test/' + path,
            onMessage: { addListener(fn) { state.onMessage = fn; } },
            onInstalled: { addListener() {} },
            onStartup: { addListener() {} }
        }
    };

    return { api, state };
}

/** Load background.js into a fresh global that has only the given namespaces. */
function load(namespaces) {
    const context = vm.createContext({ console: { warn() {}, log() {} }, ...namespaces });
    vm.runInContext(SOURCE, context);
    return context;
}

/**
 * Values produced inside the vm carry that realm's prototypes, which
 * deepEqual refuses to match. Re-materialise them in this realm first.
 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function send(state, type, payload) {
    return new Promise((resolve, reject) => {
        const handled = state.onMessage({ type, payload }, {}, resolve);
        if (!handled) reject(new Error(`message "${type}" was not handled`));
    });
}

/* ------------------------------------------------------------------ */

const flavours = [
    ['firefox (browser.* promisified, chrome.* callback-only)', (api) => ({
        browser: api,
        // A Firefox-shaped decoy: present, but every call returns undefined.
        // If background.js reaches for it, every `await` collapses and the
        // assertions below break.
        chrome: new Proxy({}, {
            get() {
                return new Proxy(function () {}, { get: () => () => undefined, apply: () => undefined });
            }
        })
    })],
    ['chrome (chrome.* promisified, no browser global)', (api) => ({ chrome: api })]
];

for (const [label, wire] of flavours) {
    test(`${label}: enable -> status -> disable round trip`, async () => {
        const { api, state } = makeApi({ origins: [PATTERN] });
        load(wire(api));
        assert.ok(state.onMessage, 'background must register a message listener');

        const enabled = await send(state, 'jdh:enableSite', { pattern: PATTERN, tabId: 42 });
        assert.equal(enabled.ok, true);
        assert.deepEqual(plain(enabled.sites), [PATTERN]);
        assert.equal(state.scripts.length, 1);
        assert.deepEqual(plain(state.scripts[0].matches), [PATTERN]);
        assert.ok(state.scripts[0].js.includes('content/content.js'));
        assert.ok(state.scripts[0].css.includes('content/styles.css'));
        assert.deepEqual(state.injected, [['css', 42], ['js', 42]]);

        const status = await send(state, 'jdh:status', {});
        assert.deepEqual(plain(status.sites), [PATTERN]);

        const disabled = await send(state, 'jdh:disableSite', { pattern: PATTERN });
        assert.deepEqual(plain(disabled.sites), []);
        assert.equal(state.scripts.length, 0);
        assert.equal(state.origins.has(PATTERN), false, 'permission must be released');
    });

    test(`${label}: enabling twice updates instead of duplicating`, async () => {
        const { api, state } = makeApi({ origins: [PATTERN] });
        load(wire(api));

        await send(state, 'jdh:enableSite', { pattern: PATTERN, tabId: 1 });
        const second = await send(state, 'jdh:enableSite', { pattern: PATTERN, tabId: 1 });

        assert.deepEqual(plain(second.sites), [PATTERN], 'site list must not gain duplicates');
        assert.equal(state.scripts.length, 1, 'registration must be updated, not re-added');
    });
}

test('reconcile drops registrations whose permission was revoked', async () => {
    const { api, state } = makeApi({ origins: [PATTERN] });
    load({ browser: api });

    await send(state, 'jdh:enableSite', { pattern: PATTERN, tabId: 1 });
    assert.equal(state.scripts.length, 1);

    state.origins.delete(PATTERN); // user removed the host permission in settings
    const result = await send(state, 'jdh:reconcile', {});

    assert.deepEqual(plain(result.sites), []);
    assert.equal(state.scripts.length, 0, 'orphaned content script must be unregistered');
    assert.deepEqual(plain(state.storage.sites), [], 'stored site list must be pruned');
});

test('registration retries without persistAcrossSessions when rejected', async () => {
    const { api, state } = makeApi({ origins: [PATTERN], rejectPersistence: true });
    load({ browser: api });

    const result = await send(state, 'jdh:enableSite', { pattern: PATTERN, tabId: 1 });

    assert.equal(result.ok, true);
    assert.equal(state.registerCalls.length, 2, 'expected one failed and one retried call');
    assert.equal(state.registerCalls[0].persistAcrossSessions, true);
    assert.equal('persistAcrossSessions' in state.registerCalls[1], false);
    assert.equal(state.scripts.length, 1, 'site must end up registered anyway');
});

/* ------------------------------------------------------------------ *
 * Standalone viewer hand-off
 * ------------------------------------------------------------------ */

test('openViewer stores the payload and opens a tab pointing at it', async () => {
    const { api, state } = makeApi();
    load({ browser: api });

    const result = await send(state, 'jdh:openViewer', {
        fieldName: 'Description', oldText: 'a', newText: 'b'
    });

    assert.equal(result.ok, true);
    assert.equal(state.createdTabs.length, 1);

    const keys = Object.keys(state.session);
    assert.equal(keys.length, 1);
    assert.ok(keys[0].startsWith('viewer:'));
    assert.equal(plain(state.session[keys[0]]).newText, 'b');
    assert.ok(
        state.createdTabs[0].includes('viewer/viewer.html?id=' + encodeURIComponent(keys[0])),
        `tab url must carry the id, got ${state.createdTabs[0]}`
    );
    assert.ok(state.session[keys[0]].createdAt, 'payload needs a timestamp for pruning');
});

test('old viewer payloads are pruned so session storage cannot grow forever', async () => {
    const { api, state } = makeApi();
    load({ browser: api });

    for (let i = 0; i < 14; i++) {
        // eslint-disable-next-line no-await-in-loop
        await send(state, 'jdh:openViewer', { fieldName: 'F' + i, oldText: 'a', newText: 'b' });
    }

    const keys = Object.keys(state.session).filter((k) => k.startsWith('viewer:'));
    assert.equal(keys.length, 10, 'only the ten most recent hand-offs are kept');

    // The newest must survive; the very first must be gone.
    const fields = keys.map((k) => state.session[k].fieldName);
    assert.ok(fields.includes('F13'), 'the newest payload must be kept');
    assert.ok(!fields.includes('F0'), 'the oldest payload must be dropped');
});

test('an oversized diff is refused rather than blowing the session quota', async () => {
    const { api, state } = makeApi();
    load({ browser: api });

    const result = await send(state, 'jdh:openViewer', {
        fieldName: 'Description',
        oldText: 'x'.repeat(3 * 1024 * 1024),
        newText: 'y'.repeat(3 * 1024 * 1024)
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /too large/i);
    assert.equal(state.createdTabs.length, 0, 'no tab may be opened');
    assert.deepEqual(Object.keys(state.session), [], 'nothing may be stored');
});

test('unknown messages are declined so other listeners can handle them', async () => {
    const { api, state } = makeApi();
    load({ browser: api });

    assert.equal(state.onMessage({ type: 'jdh:rescan' }, {}, () => {}), false);
    assert.equal(state.onMessage({ nope: 1 }, {}, () => {}), false);
});

test('a failing handler answers instead of hanging the popup', async () => {
    const { api, state } = makeApi({ origins: [PATTERN] });
    api.storage.local.set = async () => { throw new Error('quota exceeded'); };
    load({ browser: api });

    const result = await send(state, 'jdh:enableSite', { pattern: PATTERN, tabId: 1 });
    assert.equal(result.ok, false);
    assert.match(result.error, /quota exceeded/);
});
