/*!
 * Jira Diff Highlighter
 * ------------------------------------------------
 * Orchestration: ask the platform adapters for change records, run every one
 * that is worth diffing through the shared renderer, and keep doing that as
 * Jira swaps the activity feed around.
 *
 * Nothing here knows Server markup from Cloud markup — see content/adapters.js.
 */
(function (root) {
    'use strict';

    if (root.__jiraDiffHighlighterLoaded) return;
    root.__jiraDiffHighlighterLoaded = true;

    var STATE_ATTR = 'jdhState';
    var DEBOUNCE_MS = 180;

    var settings = root.JDHSettings.DEFAULTS;
    var enhancements = [];
    var scheduled = null;
    var suppressObserver = false;

    /* ------------------------------------------------------------------ *
     * Field selection
     * ------------------------------------------------------------------ */

    function matchesFieldList(text) {
        var lower = (text || '').toLowerCase();
        if (!lower) return false;
        return settings.fieldNames.some(function (needle) {
            return needle && lower.indexOf(needle.toLowerCase()) !== -1;
        });
    }

    function shouldEnhance(target) {
        var combined = target.oldText.length + target.newText.length;
        if (!combined) return false;
        if (combined > settings.maxChars) return false;

        if (matchesFieldList(target.matchText || target.fieldName)) return true;
        if (settings.fieldMode === 'listed') return false;

        var multiline = target.oldText.indexOf('\n') !== -1 ||
            target.newText.indexOf('\n') !== -1;
        return multiline || combined >= settings.minLength;
    }

    /* ------------------------------------------------------------------ *
     * Enhancing one change record
     * ------------------------------------------------------------------ */

    function enhance(target) {
        var node = target.node;
        if (node.dataset[STATE_ATTR]) return;

        if (!shouldEnhance(target)) {
            node.dataset[STATE_ATTR] = 'skipped';
            return;
        }

        var restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'jdh-restore';
        restore.textContent = '↩ Enhanced diff';
        restore.title = 'Switch back to the highlighted diff';
        restore.hidden = true;

        var handle = null;
        restore.addEventListener('click', function (event) {
            event.preventDefault();
            if (handle) handle.setOriginalVisible(false);
        });

        var widget;
        try {
            widget = root.JDHRender.build(target.oldText, target.newText, settings, {
                fieldName: target.fieldName,
                onToggleOriginal: function () {
                    if (handle) handle.setOriginalVisible(true);
                },
                onViewChange: function (mode) {
                    if (typeof chrome !== 'undefined' && chrome.storage) {
                        root.JDHSettings.save({ viewMode: mode });
                    }
                }
            });
        } catch (err) {
            console.warn('[jira-diff] diff failed, leaving Jira markup intact', err);
            node.dataset[STATE_ATTR] = 'failed';
            return;
        }

        handle = target.mount(widget.element, restore);
        if (!handle) {
            node.dataset[STATE_ATTR] = 'failed';
            return;
        }

        handle.setOriginalVisible(false);
        node.dataset[STATE_ATTR] = 'enhanced';
        enhancements.push({ node: node, handle: handle });
    }

    function teardown() {
        enhancements.forEach(function (item) {
            try {
                item.handle.detach();
            } catch (err) {
                console.warn('[jira-diff] could not detach widget', err);
            }
            delete item.node.dataset[STATE_ATTR];
        });
        enhancements = [];
        document.querySelectorAll('[data-jdh-state]').forEach(function (node) {
            delete node.dataset[STATE_ATTR];
        });
    }

    /* ------------------------------------------------------------------ *
     * Scanning
     * ------------------------------------------------------------------ */

    function scan() {
        if (!settings.enabled) return;
        suppressObserver = true;
        try {
            root.JDHAdapters.selectAdapters(settings.platform).forEach(function (adapter) {
                var targets;
                try {
                    targets = adapter.collect(settings);
                } catch (err) {
                    console.warn('[jira-diff] adapter "' + adapter.id + '" failed', err);
                    return;
                }
                targets.forEach(enhance);
            });
        } finally {
            suppressObserver = false;
        }
    }

    function schedule() {
        if (scheduled) clearTimeout(scheduled);
        scheduled = setTimeout(function () {
            scheduled = null;
            scan();
        }, DEBOUNCE_MS);
    }

    function isOurNode(node) {
        return node.nodeType === 1 && node.classList &&
            (node.classList.contains('jdh-host') ||
             node.classList.contains('jdh-restore') ||
             node.classList.contains('jdh'));
    }

    /** Ignore the DOM churn we cause ourselves, otherwise we re-scan forever. */
    function isOurMutation(mutation) {
        var target = mutation.target;
        if (target && target.nodeType === 1 && target.closest && target.closest('.jdh')) {
            return true;
        }
        var touched = Array.prototype.slice.call(mutation.addedNodes)
            .concat(Array.prototype.slice.call(mutation.removedNodes));
        return touched.length > 0 && touched.every(isOurNode);
    }

    function observe() {
        var observer = new MutationObserver(function (mutations) {
            if (suppressObserver) return;
            for (var i = 0; i < mutations.length; i++) {
                if (!isOurMutation(mutations[i])) {
                    schedule();
                    return;
                }
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    /* ------------------------------------------------------------------ *
     * Diagnostics
     *
     * Cloud markup is generated and undocumented, so when the heuristic misses
     * this is what tells you why. Run  JDHContent.diagnose()  in the console on
     * the History tab.
     * ------------------------------------------------------------------ */

    function diagnose() {
        var Adapters = root.JDHAdapters;
        var items = Adapters.findHistoryItems();
        var scopes = Adapters.findScopes();

        var report = {
            host: location.hostname,
            detectedPlatform: Adapters.detectPlatform(),
            platformSetting: settings.platform,
            adapters: Adapters.selectAdapters(settings.platform).map(function (a) { return a.id; }),
            serverTables: document.querySelectorAll('table[id^="changehistory_"]').length,
            cloudHistoryItems: items.length,
            activityScopes: scopes.slice(0, 5).map(function (el) {
                return {
                    tag: el.tagName.toLowerCase(),
                    testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null,
                    id: el.id || null
                };
            }),
            enhanced: enhancements.length,
            states: {}
        };

        document.querySelectorAll('[data-jdh-state]').forEach(function (node) {
            var state = node.dataset[STATE_ATTR];
            report.states[state] = (report.states[state] || 0) + 1;
        });

        // Per history item: what was found, and what the field filter made of it.
        report.items = items.slice(0, 40).map(function (item) {
            var pair = Adapters.findPairIn(item);
            var header = Adapters.findHeader(item, pair && pair.container);
            var entry = {
                testid: (item.getAttribute('data-testid') || '')
                    .replace('issue-history.ui.history-items.', ''),
                field: Adapters.fieldFromHeader(header) || null,
                foundPair: !!pair,
                state: pair ? (pair.container.dataset[STATE_ATTR] || 'unseen') : null
            };
            if (pair) {
                var options = {
                    normalizeWhitespace: settings.normalizeWhitespace,
                    textNewlines: true,
                    listMarkers: true,
                    stripLabel: false
                };
                entry.oldLength = root.JDHExtract.elementToText(pair.oldNode, options).length;
                entry.newLength = root.JDHExtract.elementToText(pair.newNode, options).length;
            } else {
                // No pair: say what the shape actually looked like.
                entry.childCounts = Array.prototype.map.call(
                    item.querySelectorAll('div'),
                    function (d) { return d.childElementCount; }
                ).filter(function (n) { return n === 3; }).length;
            }
            return entry;
        });

        console.log('[jira-diff] diagnostics', report);
        return report;
    }

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function applySettings(next) {
        settings = next;
        teardown();
        if (settings.enabled) scan();
    }

    root.JDHContent = {
        rescan: function () { teardown(); scan(); },
        teardown: teardown,
        diagnose: diagnose,
        getSettings: function () { return settings; },
        applySettings: applySettings
    };

    function start() {
        root.JDHSettings.load().then(function (loaded) {
            settings = loaded;
            if (settings.enabled) scan();
            observe();
        });

        root.JDHSettings.onChange(applySettings);

        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
                if (!message) return;
                if (message.type === 'jdh:rescan') {
                    root.JDHContent.rescan();
                    sendResponse({ ok: true, enhanced: enhancements.length });
                    return;
                }
                if (message.type === 'jdh:diagnose') {
                    sendResponse({ ok: true, report: diagnose() });
                }
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
