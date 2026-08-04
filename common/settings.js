/*!
 * Jira Diff Highlighter (Server / Data Center)
 * Shared settings — loaded by both the content scripts and the popup.
 *
 * Cross-browser note: this file talks to the extension APIs in CALLBACK style,
 * so it must use the `chrome.*` namespace. Firefox exposes `chrome.*` as a
 * callback-compatible alias, while its `browser.*` is promise-only and would
 * silently never invoke these callbacks. Promise-based code (background.js)
 * does the opposite and prefers `browser`. Do not mix the two.
 */
(function (root) {
    'use strict';

    var DEFAULTS = {
        /** Master switch. */
        enabled: true,
        /** 'split' | 'unified' */
        viewMode: 'split',
        /** 'word' | 'char' */
        granularity: 'word',
        /** Fold long runs of untouched lines. */
        collapseUnchanged: true,
        contextLines: 3,
        /** Treat &nbsp;/indentation noise as insignificant. */
        normalizeWhitespace: true,
        /**
         * Which platform adapter to run.
         * 'auto'   — hostname decides (*.atlassian.net = Cloud), with a fallback
         * 'server' — on-premise Server / Data Center only
         * 'cloud'  — Cloud only
         * 'both'   — run both, for proxies that mix the two
         */
        platform: 'auto',
        /** 'auto' = long or multi-line values, 'listed' = only fieldNames. */
        fieldMode: 'auto',
        fieldNames: [
            'description', 'popis',
            'environment', 'prostredi', 'prostředí',
            'summary', 'souhrn',
            'comment', 'komentar', 'komentář',
            'acceptance'
        ],
        /** In 'auto' mode: minimum combined length before a field qualifies. */
        minLength: 80,
        /** Safety valve — skip absurdly large values. */
        maxChars: 400000,

        /** Dim wiki markup and highlight its structure inside the diff. */
        highlightMarkup: true,

        /** Chip bar above the history feed for switching fields off. */
        showFilterBar: true,
        /** Switch the bookkeeping fields off on first load. */
        hideNoisyFields: true,
        /** Matched as a substring, so localisations mostly work too. */
        noisyFields: [
            'rank',
            'worklog id',
            'time spent',
            'remaining estimate',
            'original estimate',
            'workflow',
            'remoteissuelink',
            'remoteworkitemlink',
            'attachment id'
        ]
    };

    var STORAGE_KEY = 'settings';

    function hasStorage() {
        return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
    }

    function merge(stored) {
        var out = {};
        Object.keys(DEFAULTS).forEach(function (key) {
            out[key] = stored && stored[key] !== undefined ? stored[key] : DEFAULTS[key];
        });
        return out;
    }

    function load() {
        if (!hasStorage()) return Promise.resolve(merge(root.JDH_TEST_SETTINGS));
        return new Promise(function (resolve) {
            chrome.storage.sync.get(STORAGE_KEY, function (data) {
                resolve(merge(data && data[STORAGE_KEY]));
            });
        });
    }

    function save(patch) {
        if (!hasStorage()) return Promise.resolve(merge(patch));
        return load().then(function (current) {
            var next = merge(Object.assign({}, current, patch));
            return new Promise(function (resolve) {
                var payload = {};
                payload[STORAGE_KEY] = next;
                chrome.storage.sync.set(payload, function () { resolve(next); });
            });
        });
    }

    function onChange(handler) {
        if (!hasStorage() || !chrome.storage.onChanged) return;
        chrome.storage.onChanged.addListener(function (changes, area) {
            if (area !== 'sync' || !changes[STORAGE_KEY]) return;
            handler(merge(changes[STORAGE_KEY].newValue));
        });
    }

    root.JDHSettings = {
        DEFAULTS: DEFAULTS,
        STORAGE_KEY: STORAGE_KEY,
        load: load,
        save: save,
        merge: merge,
        onChange: onChange
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHSettings;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
