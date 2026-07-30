/*!
 * Jira Diff Highlighter (Server / Data Center)
 * ------------------------------------------------
 * Finds Jira Server/DC change-history rows and swaps the two plain
 * "Original / New" cells for a real diff widget.
 *
 * Target markup (unchanged since Jira 7.x):
 *   #issue_actions_container
 *     .issue-data-block#changehistory-<id>
 *       .changehistory.action-body
 *         table#changehistory_<id>
 *           tr > td.activity-name + td.activity-old-val + td.activity-new-val
 */
(function (root) {
    'use strict';

    if (root.__jiraDiffHighlighterLoaded) return;
    root.__jiraDiffHighlighterLoaded = true;

    var TABLE_SELECTOR = 'table[id^="changehistory_"], .changehistory table';
    var STATE_ATTR = 'jdhState';
    var DEBOUNCE_MS = 180;

    var settings = root.JDHSettings.DEFAULTS;
    var enhancements = [];
    var scheduled = null;
    var suppressObserver = false;

    /* ------------------------------------------------------------------ *
     * Field selection
     * ------------------------------------------------------------------ */

    function matchesFieldList(name) {
        var lower = name.toLowerCase();
        return settings.fieldNames.some(function (needle) {
            return needle && lower.indexOf(needle.toLowerCase()) !== -1;
        });
    }

    function shouldEnhance(data) {
        var combined = data.oldText.length + data.newText.length;
        if (!combined) return false;
        if (combined > settings.maxChars) return false;

        if (matchesFieldList(data.name)) return true;
        if (settings.fieldMode === 'listed') return false;

        var multiline = data.oldText.indexOf('\n') !== -1 || data.newText.indexOf('\n') !== -1;
        return multiline || combined >= settings.minLength;
    }

    /* ------------------------------------------------------------------ *
     * Enhancing a single history row
     * ------------------------------------------------------------------ */

    function enhanceRow(tr) {
        if (tr.dataset[STATE_ATTR]) return;

        var data;
        try {
            data = root.JDHExtract.readHistoryRow(tr, settings);
        } catch (err) {
            console.warn('[jira-diff] could not read history row', err);
            return;
        }
        if (!data) return;

        if (!shouldEnhance(data)) {
            tr.dataset[STATE_ATTR] = 'skipped';
            return;
        }

        var cells = [data.oldCell, data.newCell].filter(Boolean);
        var anchor = cells[0];
        if (!anchor || !anchor.parentNode) return;

        var host = document.createElement('td');
        host.className = 'jdh-host';
        host.colSpan = cells.length;

        var restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'jdh-restore';
        restore.textContent = '↩ Enhanced diff';
        restore.title = 'Switch back to the highlighted diff';
        restore.hidden = true;

        var showingOriginal = false;
        function setOriginalVisible(visible) {
            showingOriginal = visible;
            host.hidden = visible;
            restore.hidden = !visible;
            cells.forEach(function (cell) {
                cell.classList.toggle('jdh-hidden', !visible);
            });
        }
        restore.addEventListener('click', function (event) {
            event.preventDefault();
            setOriginalVisible(false);
        });

        var widget;
        try {
            widget = root.JDHRender.build(data.oldText, data.newText, settings, {
                fieldName: data.name,
                onToggleOriginal: function () { setOriginalVisible(true); },
                onViewChange: function (mode) {
                    if (typeof chrome !== 'undefined' && chrome.storage) {
                        root.JDHSettings.save({ viewMode: mode });
                    }
                }
            });
        } catch (err) {
            console.warn('[jira-diff] diff failed, leaving Jira markup intact', err);
            tr.dataset[STATE_ATTR] = 'failed';
            return;
        }

        host.appendChild(widget.element);
        anchor.parentNode.insertBefore(host, anchor);

        var restoreSlot = tr.querySelector('td.activity-name') || host;
        restoreSlot.appendChild(restore);

        setOriginalVisible(false);
        tr.dataset[STATE_ATTR] = 'enhanced';

        enhancements.push({
            tr: tr,
            host: host,
            restore: restore,
            cells: cells
        });
    }

    function teardown() {
        enhancements.forEach(function (item) {
            if (item.host.parentNode) item.host.remove();
            if (item.restore.parentNode) item.restore.remove();
            item.cells.forEach(function (cell) { cell.classList.remove('jdh-hidden'); });
            delete item.tr.dataset[STATE_ATTR];
        });
        enhancements = [];
        document.querySelectorAll('tr[data-jdh-state]').forEach(function (tr) {
            delete tr.dataset[STATE_ATTR];
        });
    }

    /* ------------------------------------------------------------------ *
     * Scanning
     * ------------------------------------------------------------------ */

    function scan() {
        if (!settings.enabled) return;
        suppressObserver = true;
        try {
            document.querySelectorAll(TABLE_SELECTOR).forEach(function (table) {
                table.querySelectorAll('tr').forEach(function (tr) {
                    if (!tr.querySelector('td.activity-old-val, td.activity-new-val')) return;
                    enhanceRow(tr);
                });
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
                if (!message || message.type !== 'jdh:rescan') return;
                root.JDHContent.rescan();
                sendResponse({ ok: true, enhanced: enhancements.length });
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
