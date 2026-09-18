/*!
 * Jira Diff Highlighter
 * ------------------------------------------------
 * Platform adapters.
 *
 * Everything platform-specific lives here: how to find a change record, how to
 * read its old/new value, and where to hang the widget. The renderer never
 * learns which Jira it is looking at, which is what keeps both flavours looking
 * identical.
 *
 * Each adapter exposes:
 *   id       string
 *   detect() boolean            — could this page hold targets at all? (cheap)
 *   collect(settings) Target[]  — unprocessed change records
 *
 * A Target is:
 *   node        Element         — marker element, carries data-jdh-state
 *   fieldName   string          — short label shown in the widget toolbar
 *   matchText   string          — text matched against settings.fieldNames
 *   oldText     string
 *   newText     string
 *   mount(widgetEl, restoreBtn) -> { setOriginalVisible(bool), detach() }
 */
(function (root) {
    'use strict';

    var Extract = root.JDHExtract;

    /* ================================================================== *
     * Server / Data Center
     *
     * Stable markup since Jira 7.x:
     *   table#changehistory_<id>
     *     tr > td.activity-name + td.activity-old-val + td.activity-new-val
     * ================================================================== */

    var SERVER_TABLES = 'table[id^="changehistory_"], .changehistory table';

    /** Author and timestamp live in the block header, above the change table. */
    function serverMeta(tr) {
        var block = tr.closest('.issue-data-block') || tr.closest('.actionContainer');
        var details = block && block.querySelector('.action-details');
        if (!details) return { author: null, when: null };

        // Older skins and anonymised exports drop the user-hover class, so fall
        // back to whatever link the header leads with.
        var author = details.querySelector('.user-hover, a[href*="ViewProfile"], a');
        var time = details.querySelector('time[datetime]');
        var date = details.querySelector('.date');

        return {
            author: author ? (author.textContent || '').trim() : null,
            when: time
                ? (time.getAttribute('datetime') && (time.textContent || '').trim()) ||
                  time.getAttribute('datetime')
                : (date ? (date.getAttribute('title') || (date.textContent || '').trim()) : null)
        };
    }

    var serverAdapter = {
        id: 'server',

        detect: function () {
            return !!document.querySelector(SERVER_TABLES);
        },

        historyRoot: function () {
            return document.getElementById('issue_actions_container') ||
                document.querySelector('.issuePanelContainer') ||
                (document.querySelector(SERVER_TABLES) || {}).parentElement ||
                null;
        },

        collect: function (settings) {
            var targets = [];
            document.querySelectorAll(SERVER_TABLES).forEach(function (table) {
                table.querySelectorAll('tr').forEach(function (tr) {
                    if (!tr.querySelector('td.activity-old-val, td.activity-new-val')) return;

                    var data = Extract.readHistoryRow(tr, settings);
                    if (!data) return;
                    var meta = serverMeta(tr);

                    targets.push({
                        node: tr,
                        rowElement: tr,
                        fieldName: data.name,
                        matchText: data.name,
                        oldText: data.oldText,
                        newText: data.newText,
                        author: meta.author,
                        when: meta.when,
                        mount: mountServer(tr, data)
                    });
                });
            });
            return targets;
        }
    };

    function mountServer(tr, data) {
        return function (widgetEl, restoreBtn) {
            var cells = [data.oldCell, data.newCell].filter(Boolean);
            var anchor = cells[0];
            if (!anchor || !anchor.parentNode) return null;

            var host = document.createElement('td');
            host.className = 'jdh-host';
            host.colSpan = cells.length;
            host.appendChild(widgetEl);
            anchor.parentNode.insertBefore(host, anchor);

            // The narrow field-name cell is the only spot that stays visible
            // while Jira's own two columns are on screen.
            (tr.querySelector('td.activity-name') || host).appendChild(restoreBtn);

            return {
                setOriginalVisible: function (visible) {
                    host.hidden = visible;
                    restoreBtn.hidden = !visible;
                    cells.forEach(function (cell) {
                        cell.classList.toggle('jdh-hidden', !visible);
                    });
                },
                detach: function () {
                    host.remove();
                    restoreBtn.remove();
                    cells.forEach(function (cell) { cell.classList.remove('jdh-hidden'); });
                }
            };
        };
    }

    /* ================================================================== *
     * Cloud (*.atlassian.net)
     *
     * Cloud ships a generated React DOM. Every presentational class is hashed
     * ("_19pku2gc"), so styling hooks are useless — but the data-testids are
     * semantic and survive:
     *
     *   div[data-testid="history.feed-container"]
     *     ul > li
     *       div[data-testid="issue-history.ui.history-items.<kind>-history-item.history-item"]
     *         div[data-vc="profilecard-wrapper"]            author avatar
     *         div                                           content column
     *           div > div                                   header line:
     *             div > [profilecard-wrapper]                 author name
     *             "updated the "                              connector text
     *             span                                        FIELD NAME
     *           div                                         timestamp
     *           div                                         ← the pair, 3 children:
     *             div  old value
     *             div  (empty — the arrow is drawn in CSS)
     *             div  new value
     *
     * So: scope by testid, then confirm by shape. The shape check is what keeps
     * this working when Atlassian renames a testid, and the field name is read
     * from the header's last leaf <span> — no keyword list, any language.
     * ================================================================== */

    /** Matches the item root *and* its avatar descendants; outermost wins. */
    var CLOUD_ITEM_SELECTOR = '[data-testid*="history-item" i]';

    var AUTHOR_SELECTOR = '[data-vc="profilecard-wrapper"]';

    /** Only used to scope the search when no history items are found. */
    var UPDATE_WORDS = [
        'updated', 'changed', 'added', 'removed', 'set',
        'actualizo', 'aktualisiert', 'geandert', 'mis a jour', 'modifie',
        'aggiornato', 'atualizou', 'bijgewerkt', 'zmenil', 'zmenila',
        'обновил', 'изменил', '更新', '변경'
    ];

    var SCOPE_SELECTOR = [
        '[data-testid*="activity" i]',
        '[data-testid*="history" i]',
        '[data-test-id*="activity" i]',
        '[data-test-id*="history" i]',
        '[id*="activity" i]',
        '[id*="history" i]',
        'section[aria-label*="activity" i]',
        'section[aria-label*="history" i]'
    ].join(',');

    var INTERACTIVE = 'button, input, textarea, select, [contenteditable="true"], [role="button"]';

    function normalizeWord(value) {
        return String(value == null ? '' : value)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .trim();
    }

    /**
     * Outermost element that looks like the activity/history region. Scoping
     * matters for both speed and false positives — a three-child container is
     * a common shape elsewhere on the page.
     */
    function findScopes() {
        var found = [];
        document.querySelectorAll(SCOPE_SELECTOR).forEach(function (el) {
            if (!found.some(function (other) { return other.contains(el); })) {
                found.push(el);
            }
        });
        return found;
    }

    /** Outermost elements only — a testid substring also hits nested avatars. */
    function outermost(nodeList) {
        var found = [];
        nodeList.forEach(function (el) {
            if (!found.some(function (other) { return other.contains(el); })) {
                found.push(el);
            }
        });
        return found;
    }

    function findHistoryItems() {
        return outermost(document.querySelectorAll(CLOUD_ITEM_SELECTOR));
    }

    function hasDirectText(el) {
        for (var i = 0; i < el.childNodes.length; i++) {
            var child = el.childNodes[i];
            if (child.nodeType === 3 && child.nodeValue.trim()) return true;
        }
        return false;
    }

    /**
     * The header line — the ancestor of an author chip that also owns the
     * connector text ("updated the "). Everything above it is layout, and the
     * timestamp sits in a *sibling*, so walking up like this beats grabbing the
     * item's last span.
     *
     * An item carries two author chips: the avatar (a direct child of the item)
     * and the name inside the header. Only the second one leads anywhere, so
     * every chip has to be tried — starting from the first would stop at the
     * item itself.
     */
    function findHeader(item, pairContainer) {
        var chips = item.querySelectorAll(AUTHOR_SELECTOR);
        for (var c = 0; c < chips.length; c++) {
            var node = chips[c].parentElement;
            while (node && node !== item) {
                if (hasDirectText(node) &&
                    !(pairContainer && node.contains(pairContainer))) {
                    return node;
                }
                node = node.parentElement;
            }
        }
        return null;
    }

    /**
     * Field name = last leaf <span> of the header, skipping the author chip.
     * Works for "updated the Description", "changed the Status" and equally for
     * custom fields ("RemoteWorkItemLink") or any localisation.
     */
    function fieldFromHeader(header) {
        if (!header) return '';
        var spans = header.querySelectorAll('span');
        for (var i = spans.length - 1; i >= 0; i--) {
            var span = spans[i];
            if (span.childElementCount > 0) continue;
            if (span.closest(AUTHOR_SELECTOR)) continue;
            var text = (span.textContent || '').trim();
            if (text && text.length <= 48) return text;
        }
        return '';
    }

    /**
     * Author and timestamp. The author chip sits inside the header; the
     * timestamp is the header's *sibling*, one level up.
     */
    function cloudMeta(item, header) {
        if (!header) return { author: null, when: null };

        var chip = header.querySelector(AUTHOR_SELECTOR);
        var when = null;
        var parent = header.parentElement;
        if (parent) {
            for (var i = 0; i < parent.children.length; i++) {
                var sibling = parent.children[i];
                if (sibling === header) continue;
                var text = (sibling.textContent || '').trim();
                if (text) {
                    when = text;
                    break;
                }
            }
        }
        return {
            author: chip ? (chip.textContent || '').trim() : null,
            when: when
        };
    }

    /** First descendant that has the old/new shape. */
    function findPairIn(root) {
        var divs = root.querySelectorAll('div');
        for (var i = 0; i < divs.length; i++) {
            var container = divs[i];
            if (container.childElementCount !== 3) continue;
            if (container.closest('.jdh, .jdh-host')) continue;
            var pair = readChangePair(container);
            if (pair) {
                pair.container = container;
                return pair;
            }
        }
        return null;
    }

    /** Text of the nearest preceding element — fallback when there is no chip. */
    function findLabel(container) {
        var node = container;
        for (var hop = 0; node && hop < 4; hop++) {
            var sibling = node.previousElementSibling;
            while (sibling) {
                var text = (sibling.textContent || '').trim();
                if (text && text.length <= 300) return text;
                sibling = sibling.previousElementSibling;
            }
            node = node.parentElement;
        }
        return '';
    }

    /**
     * Pull a short field name out of "Michal Zavadil updated the Description".
     * Only the configured names can be recognised across locales; anything else
     * falls back to no label at all, which the toolbar handles.
     */
    function guessFieldName(label, settings) {
        var haystack = normalizeWord(label);
        var best = null;
        (settings.fieldNames || []).forEach(function (needle) {
            var candidate = normalizeWord(needle);
            if (!candidate) return;
            var at = haystack.indexOf(candidate);
            if (at === -1) return;
            if (!best || candidate.length > best.length) {
                best = label.substr(at, candidate.length);
            }
        });
        if (!best) return '';
        return best.charAt(0).toUpperCase() + best.slice(1);
    }

    function hasUpdateWord(label) {
        var haystack = normalizeWord(label);
        return UPDATE_WORDS.some(function (word) {
            return haystack.indexOf(normalizeWord(word)) !== -1;
        });
    }

    /**
     * Does this container hold an old/new pair?
     * @returns {{oldNode: Element, newNode: Element}|null}
     */
    function readChangePair(container) {
        if (container.childElementCount !== 3) return null;

        var first = container.children[0];
        var middle = container.children[1];
        var last = container.children[2];

        // The separator carries the arrow as a CSS background — no text of its
        // own. A textual "→" would still pass; anything longer is not a divider.
        if ((middle.textContent || '').trim().length > 3) return null;

        var oldHas = (first.textContent || '').trim().length > 0;
        var newHas = (last.textContent || '').trim().length > 0;
        if (!oldHas && !newHas) return null;

        if (container.querySelector(INTERACTIVE)) return null;

        return { oldNode: first, newNode: last };
    }

    /* ------------------------------------------------------------------ *
     * Survey — what is on the page when the adapter comes up empty
     *
     * Atlassian reshapes this DOM without notice, and when that happens the
     * only useful question is "which guard rejected what". These helpers mirror
     * the real guards above rather than describing them, so the answer cannot
     * drift away from the code that actually does the rejecting.
     * ------------------------------------------------------------------ */

    function describeElement(el) {
        if (!el) return null;
        var testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
        return el.tagName.toLowerCase() +
            (testid ? '[data-testid="' + testid + '"]' : '') +
            (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '');
    }

    /** Nearest ancestors that carry a testid — the trail back to a known anchor. */
    function testidTrail(el, depth) {
        var trail = [];
        var node = el.parentElement;
        while (node && trail.length < (depth || 3)) {
            var testid = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
            if (testid) trail.push(testid);
            node = node.parentElement;
        }
        return trail;
    }

    /** Every history/activity-ish testid on the page, most frequent first. */
    function testidHistogram(limit) {
        var counts = new Map();
        document.querySelectorAll('[data-testid], [data-test-id]').forEach(function (el) {
            var value = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '';
            if (!/history|activity|changelog|feed/i.test(value)) return;
            counts.set(value, (counts.get(value) || 0) + 1);
        });
        var out = [];
        counts.forEach(function (count, testid) { out.push({ testid: testid, count: count }); });
        out.sort(function (a, b) { return b.count - a.count; });
        return out.slice(0, limit || 30);
    }

    /**
     * Containers that look like they could be an old/new pair, each with the
     * reason the adapter turned it down.
     */
    function surveyCandidates(limit) {
        var scopes = findScopes();
        var roots = scopes.length ? scopes : [document.body];
        var found = [];
        var seen = new Set();

        roots.forEach(function (rootEl) {
            if (!rootEl) return;
            rootEl.querySelectorAll('div').forEach(function (el) {
                var count = el.childElementCount;
                if (count < 2 || count > 4) return;
                if (seen.has(el)) return;
                if (el.closest('.jdh, .jdh-host, .jdh-filter, .jdh-overlay')) return;

                // Describe every child, not just the ends. When the shape is
                // what changed, the child list is the whole story — and ranking
                // on it keeps the genuinely interesting container at the top
                // instead of letting a plain two-child wrapper outrank it.
                var children = Array.prototype.map.call(el.children, function (child) {
                    var text = (child.textContent || '').trim();
                    return {
                        tag: child.tagName.toLowerCase(),
                        chars: text.length,
                        preview: text.slice(0, 60)
                    };
                });
                var total = children.reduce(function (sum, c) { return sum + c.chars; }, 0);
                if (total < 20) return;

                var middleText = count === 3 ? children[1].preview : null;
                var interactive = el.querySelector(INTERACTIVE);

                var reason;
                if (count !== 3) {
                    reason = 'childElementCount is ' + count + ', the adapter needs 3';
                } else if (children[1].chars > 3) {
                    reason = 'separator holds text ' + JSON.stringify(middleText.slice(0, 24));
                } else if (!children[0].chars && !children[2].chars) {
                    reason = 'both sides empty';
                } else if (interactive) {
                    reason = 'contains interactive ' + describeElement(interactive);
                } else {
                    reason = 'ACCEPTED';
                }

                seen.add(el);
                found.push({
                    el: el,
                    info: {
                        reason: reason,
                        childCount: count,
                        totalChars: total,
                        children: children,
                        ancestorTestids: testidTrail(el, 3)
                    }
                });
                if (found.length >= 400) return;
            });
        });

        // Keep only the innermost candidates. A wrapper around a change record
        // matches the same loose shape test, but it *contains* the real thing —
        // so anything holding another candidate is scaffolding, not the pair.
        var innermost = found.filter(function (entry) {
            return !found.some(function (other) {
                return other !== entry && entry.el.contains(other.el);
            });
        });

        innermost.sort(function (a, b) {
            if ((a.info.reason === 'ACCEPTED') !== (b.info.reason === 'ACCEPTED')) {
                return a.info.reason === 'ACCEPTED' ? -1 : 1;
            }
            return b.info.totalChars - a.info.totalChars;
        });
        return innermost.slice(0, limit || 12).map(function (entry) { return entry.info; });
    }

    function surveyCloud(options) {
        var opts = options || {};
        return {
            itemSelector: CLOUD_ITEM_SELECTOR,
            itemsMatched: findHistoryItems().length,
            authorChips: document.querySelectorAll(AUTHOR_SELECTOR).length,
            authorSelector: AUTHOR_SELECTOR,
            scopesMatched: findScopes().length,
            historyTestids: testidHistogram(opts.maxTestids),
            candidates: surveyCandidates(opts.maxCandidates)
        };
    }

    var cloudAdapter = {
        id: 'cloud',

        detect: function () {
            return findHistoryItems().length > 0 ||
                findScopes().length > 0 ||
                /(^|\.)atlassian\.(net|com)$/i.test(location.hostname);
        },

        historyRoot: function () {
            var feed = document.querySelector('[data-testid*="feed-container" i]');
            if (feed) return feed;
            var items = findHistoryItems();
            if (!items.length) return findScopes()[0] || null;
            // Nearest ancestor shared by every item.
            var root = items[0];
            while (root && !items.every(function (i) { return root.contains(i); })) {
                root = root.parentElement;
            }
            return root;
        },

        collect: function (settings) {
            var textOptions = {
                normalizeWhitespace: settings.normalizeWhitespace,
                // Cloud hands the value over as a plain-text blob; its real
                // newlines are the only line breaks it has.
                textNewlines: true,
                listMarkers: true,
                stripLabel: false
            };

            function makeTarget(container, pair, fieldName, matchText, meta, rowElement) {
                return {
                    node: container,
                    rowElement: rowElement || container,
                    fieldName: fieldName,
                    matchText: matchText,
                    oldText: Extract.elementToText(pair.oldNode, textOptions),
                    newText: Extract.elementToText(pair.newNode, textOptions),
                    author: (meta && meta.author) || null,
                    when: (meta && meta.when) || null,
                    mount: mountCloud(container)
                };
            }

            var items = findHistoryItems();
            if (items.length) {
                var fromItems = [];
                items.forEach(function (item) {
                    var pair = findPairIn(item);
                    if (!pair) return;

                    var header = findHeader(item, pair.container);
                    var fieldName = fieldFromHeader(header);
                    var headerText = header ? (header.textContent || '').trim() : '';

                    if (!fieldName) {
                        fieldName = guessFieldName(headerText || findLabel(pair.container), settings);
                    }
                    // Prefer the field name alone: the header also carries the
                    // author, and a person called "Summary" should not count.
                    fromItems.push(makeTarget(
                        pair.container, pair, fieldName, fieldName || headerText,
                        cloudMeta(item, header), item.closest('li') || item
                    ));
                });
                return fromItems;
            }

            // Fallback: no recognisable history items, so go by shape alone.
            // Without a scope we would be sweeping the whole page, so demand the
            // "<someone> updated ..." line as corroboration.
            var scopes = findScopes();
            var strict = scopes.length === 0;
            if (strict) scopes = [document.body];

            var targets = [];
            var accepted = [];

            scopes.forEach(function (scope) {
                if (!scope) return;
                scope.querySelectorAll('div').forEach(function (container) {
                    if (container.childElementCount !== 3) return;
                    if (container.dataset.jdhState) return;
                    if (container.closest('.jdh, .jdh-host')) return;
                    if (accepted.some(function (el) { return el.contains(container); })) return;

                    var pair = readChangePair(container);
                    if (!pair) return;

                    var label = findLabel(container);
                    if (strict && !hasUpdateWord(label)) return;

                    accepted.push(container);
                    targets.push(makeTarget(
                        container, pair, guessFieldName(label, settings), label,
                        null, container.closest('li') || container
                    ));
                });
            });
            return targets;
        }
    };

    function mountCloud(container) {
        return function (widgetEl, restoreBtn) {
            if (!container.parentNode) return null;

            var host = document.createElement('div');
            host.className = 'jdh-host jdh-host--cloud';
            host.appendChild(widgetEl);
            host.appendChild(restoreBtn);
            container.parentNode.insertBefore(host, container.nextSibling);

            return {
                setOriginalVisible: function (visible) {
                    // The host stays put — it carries the button that gets back.
                    widgetEl.hidden = visible;
                    restoreBtn.hidden = !visible;
                    container.classList.toggle('jdh-hidden', !visible);
                },
                detach: function () {
                    host.remove();
                    container.classList.remove('jdh-hidden');
                }
            };
        };
    }

    /* ================================================================== *
     * Selection
     * ================================================================== */

    var CLOUD_HOST = /(^|\.)(atlassian\.net|atlassian\.com|jira\.com)$/i;

    /** @param {string} [hostname] defaults to the current location. */
    function detectPlatform(hostname) {
        var host = hostname === undefined ? location.hostname : hostname;
        return CLOUD_HOST.test(host) ? 'cloud' : 'server';
    }

    /**
     * Which adapters to run. Server is always cheap and precise (it keys off an
     * id prefix Cloud does not have), so 'auto' runs it unconditionally and adds
     * Cloud when the hostname says so — or when Server came up empty on a page
     * that does look like an activity feed, which covers Cloud behind a custom
     * domain and on-prem behind an odd one.
     */
    function selectAdapters(mode, hostname) {
        if (mode === 'server') return [serverAdapter];
        if (mode === 'cloud') return [cloudAdapter];
        if (mode === 'both') return [serverAdapter, cloudAdapter];

        if (detectPlatform(hostname) === 'cloud') return [cloudAdapter, serverAdapter];
        return serverAdapter.detect() ? [serverAdapter] : [serverAdapter, cloudAdapter];
    }

    root.JDHAdapters = {
        server: serverAdapter,
        cloud: cloudAdapter,
        detectPlatform: detectPlatform,
        selectAdapters: selectAdapters,
        // exported for diagnostics / tests
        readChangePair: readChangePair,
        guessFieldName: guessFieldName,
        findScopes: findScopes,
        findLabel: findLabel,
        findHistoryItems: findHistoryItems,
        findHeader: findHeader,
        fieldFromHeader: fieldFromHeader,
        findPairIn: findPairIn,
        surveyCloud: surveyCloud
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHAdapters;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
