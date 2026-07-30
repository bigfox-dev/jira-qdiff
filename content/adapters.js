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

    var serverAdapter = {
        id: 'server',

        detect: function () {
            return !!document.querySelector(SERVER_TABLES);
        },

        collect: function (settings) {
            var targets = [];
            document.querySelectorAll(SERVER_TABLES).forEach(function (table) {
                table.querySelectorAll('tr').forEach(function (tr) {
                    if (tr.dataset.jdhState) return;
                    if (!tr.querySelector('td.activity-old-val, td.activity-new-val')) return;

                    var data = Extract.readHistoryRow(tr, settings);
                    if (!data) return;

                    targets.push({
                        node: tr,
                        fieldName: data.name,
                        matchText: data.name,
                        oldText: data.oldText,
                        newText: data.newText,
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

    var cloudAdapter = {
        id: 'cloud',

        detect: function () {
            return findHistoryItems().length > 0 ||
                findScopes().length > 0 ||
                /(^|\.)atlassian\.(net|com)$/i.test(location.hostname);
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

            function makeTarget(container, pair, fieldName, matchText) {
                return {
                    node: container,
                    fieldName: fieldName,
                    matchText: matchText,
                    oldText: Extract.elementToText(pair.oldNode, textOptions),
                    newText: Extract.elementToText(pair.newNode, textOptions),
                    mount: mountCloud(container)
                };
            }

            var items = findHistoryItems();
            if (items.length) {
                var fromItems = [];
                items.forEach(function (item) {
                    var pair = findPairIn(item);
                    if (!pair || pair.container.dataset.jdhState) return;

                    var header = findHeader(item, pair.container);
                    var fieldName = fieldFromHeader(header);
                    var headerText = header ? (header.textContent || '').trim() : '';

                    if (!fieldName) {
                        fieldName = guessFieldName(headerText || findLabel(pair.container), settings);
                    }
                    // Prefer the field name alone: the header also carries the
                    // author, and a person called "Summary" should not count.
                    fromItems.push(makeTarget(
                        pair.container, pair, fieldName, fieldName || headerText
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
                        container, pair, guessFieldName(label, settings), label
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
        findPairIn: findPairIn
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHAdapters;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
