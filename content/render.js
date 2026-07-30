/*!
 * Jira Diff Highlighter (Server / Data Center)
 * ------------------------------------------------
 * Builds the diff widget DOM.
 *
 * Two passes, GitHub-style:
 *   1. line-level diff  -> aligned rows (equal / replace / del / ins)
 *   2. word-level diff  -> intra-line highlights inside "replace" rows
 *
 * Everything is created with createElement/textContent — ticket content is
 * never re-injected as HTML.
 */
(function (root) {
    'use strict';

    var D = root.JDHDiff;
    var DELETE = -1;
    var EQUAL = 0;
    var INSERT = 1;

    /** Above this ratio of changed characters, a line pair is treated as an
     *  outright rewrite and rendered without confusing word-level confetti. */
    var REWRITE_RATIO = 0.72;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function splitLines(text) {
        return text.length ? text.split('\n') : [];
    }

    /* ------------------------------------------------------------------ *
     * Row model
     * ------------------------------------------------------------------ */

    function buildRows(oldLines, newLines) {
        var groups = D.group(D.diffArrays(oldLines, newLines));
        var rows = [];
        var i, k;

        for (i = 0; i < groups.length; i++) {
            var g = groups[i];

            if (g.op === EQUAL) {
                for (k = 0; k < g.aEnd - g.aStart; k++) {
                    rows.push({ type: 'equal', a: g.aStart + k, b: g.bStart + k });
                }
                continue;
            }

            if (g.op === DELETE) {
                var next = groups[i + 1];
                if (next && next.op === INSERT) {
                    var dels = g.aEnd - g.aStart;
                    var ins = next.bEnd - next.bStart;
                    var span = Math.max(dels, ins);
                    for (k = 0; k < span; k++) {
                        var a = k < dels ? g.aStart + k : -1;
                        var b = k < ins ? next.bStart + k : -1;
                        rows.push({
                            type: a !== -1 && b !== -1 ? 'replace' : (a !== -1 ? 'del' : 'ins'),
                            a: a,
                            b: b
                        });
                    }
                    i++; // the INSERT group has been consumed
                } else {
                    for (k = 0; k < g.aEnd - g.aStart; k++) {
                        rows.push({ type: 'del', a: g.aStart + k, b: -1 });
                    }
                }
                continue;
            }

            for (k = 0; k < g.bEnd - g.bStart; k++) {
                rows.push({ type: 'ins', a: -1, b: g.bStart + k });
            }
        }
        return rows;
    }

    /** Replace long runs of untouched lines with a single expandable marker. */
    function collapseEqualRuns(rows, context) {
        var out = [];
        var i = 0;
        while (i < rows.length) {
            if (rows[i].type !== 'equal') {
                out.push(rows[i]);
                i++;
                continue;
            }
            var j = i;
            while (j < rows.length && rows[j].type === 'equal') j++;
            var run = rows.slice(i, j);
            var head = i === 0 ? 0 : context;
            var tail = j === rows.length ? 0 : context;

            if (run.length > head + tail + 2) {
                for (var h = 0; h < head; h++) out.push(run[h]);
                out.push({ type: 'skip', rows: run.slice(head, run.length - tail) });
                for (var t = run.length - tail; t < run.length; t++) out.push(run[t]);
            } else {
                for (var r = 0; r < run.length; r++) out.push(run[r]);
            }
            i = j;
        }
        return out;
    }

    function computeStats(rows) {
        var added = 0;
        var removed = 0;
        for (var i = 0; i < rows.length; i++) {
            var t = rows[i].type;
            if (t === 'ins') added++;
            else if (t === 'del') removed++;
            else if (t === 'replace') {
                added++;
                removed++;
            }
        }
        return { added: added, removed: removed };
    }

    /* ------------------------------------------------------------------ *
     * Cell rendering
     * ------------------------------------------------------------------ */

    function appendSegments(cell, segments, side) {
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            if (seg.op === EQUAL) {
                cell.appendChild(document.createTextNode(seg.text));
            } else if (seg.op === DELETE && side === 'old') {
                cell.appendChild(el('del', 'jdh-mark jdh-mark--del', seg.text));
            } else if (seg.op === INSERT && side === 'new') {
                cell.appendChild(el('ins', 'jdh-mark jdh-mark--ins', seg.text));
            }
        }
    }

    /** Word-level diff for one aligned line pair, cached on the row. */
    function segmentsFor(row, ctx) {
        if (row.type !== 'replace') return null;
        if (row._segments !== undefined) return row._segments;

        var oldLine = ctx.oldLines[row.a];
        var newLine = ctx.newLines[row.b];
        var result = D.diffText(oldLine, newLine, ctx.settings.granularity);
        row._segments = result.changedRatio > REWRITE_RATIO ? null : result.segments;
        return row._segments;
    }

    function fillCell(cell, text, row, side, ctx) {
        if (text === undefined || text === null) {
            cell.classList.add('jdh-code--empty');
            return;
        }
        var segments = segmentsFor(row, ctx);
        if (segments) {
            appendSegments(cell, segments, side);
        } else if (row.type === 'del' || (row.type === 'replace' && side === 'old')) {
            cell.appendChild(el('del', 'jdh-mark jdh-mark--del', text));
        } else if (row.type === 'ins' || (row.type === 'replace' && side === 'new')) {
            cell.appendChild(el('ins', 'jdh-mark jdh-mark--ins', text));
        } else {
            cell.textContent = text;
        }
    }

    function gutter(value, side) {
        var g = el('div', 'jdh-gutter jdh-gutter--' + side);
        g.textContent = value === -1 || value === undefined ? '' : String(value + 1);
        return g;
    }

    /* ------------------------------------------------------------------ *
     * Skip / expand markers
     * ------------------------------------------------------------------ */

    function makeSkipRow(row, ctx, columns) {
        var wrapper = el('div', 'jdh-row jdh-row--skip');
        var cell = el('div', 'jdh-skip');
        cell.style.gridColumn = '1 / -1';

        var button = el('button', 'jdh-expand');
        button.type = 'button';
        button.textContent = '⋯ ' + row.rows.length + ' ' +
            (row.rows.length === 1 ? 'unchanged line' : 'unchanged lines');
        button.title = 'Show unchanged lines';
        button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            var frag = document.createDocumentFragment();
            for (var i = 0; i < row.rows.length; i++) {
                frag.appendChild(renderRow(row.rows[i], ctx, columns));
            }
            wrapper.replaceWith(frag);
        });

        cell.appendChild(button);
        wrapper.appendChild(cell);
        return wrapper;
    }

    /* ------------------------------------------------------------------ *
     * Row rendering
     * ------------------------------------------------------------------ */

    function renderRow(row, ctx, mode) {
        if (row.type === 'skip') return makeSkipRow(row, ctx, mode);
        return mode === 'unified' ? renderUnifiedRow(row, ctx) : renderSplitRow(row, ctx);
    }

    function renderSplitRow(row, ctx) {
        var wrapper = el('div', 'jdh-row jdh-row--' + row.type);

        wrapper.appendChild(gutter(row.a, 'old'));
        var oldCell = el('div', 'jdh-code jdh-code--old');
        if (row.a === -1) oldCell.classList.add('jdh-code--filler');
        else fillCell(oldCell, ctx.oldLines[row.a], row, 'old', ctx);
        wrapper.appendChild(oldCell);

        wrapper.appendChild(gutter(row.b, 'new'));
        var newCell = el('div', 'jdh-code jdh-code--new');
        if (row.b === -1) newCell.classList.add('jdh-code--filler');
        else fillCell(newCell, ctx.newLines[row.b], row, 'new', ctx);
        wrapper.appendChild(newCell);

        return wrapper;
    }

    function unifiedLine(kind, aIdx, bIdx, sign, row, side, ctx) {
        var wrapper = el('div', 'jdh-row jdh-row--' + kind);
        wrapper.appendChild(gutter(aIdx, 'old'));
        wrapper.appendChild(gutter(bIdx, 'new'));
        wrapper.appendChild(el('div', 'jdh-sign', sign));

        var cell = el('div', 'jdh-code');
        var text = side === 'old' ? ctx.oldLines[aIdx] : ctx.newLines[bIdx];
        fillCell(cell, text, row, side, ctx);
        wrapper.appendChild(cell);
        return wrapper;
    }

    function renderUnifiedRow(row, ctx) {
        if (row.type === 'equal') {
            return unifiedLine('equal', row.a, row.b, ' ', row, 'old', ctx);
        }
        if (row.type === 'del') {
            return unifiedLine('del', row.a, -1, '−', row, 'old', ctx);
        }
        if (row.type === 'ins') {
            return unifiedLine('ins', -1, row.b, '+', row, 'new', ctx);
        }
        // replace -> two stacked lines
        var frag = document.createDocumentFragment();
        frag.appendChild(unifiedLine('del', row.a, -1, '−', row, 'old', ctx));
        frag.appendChild(unifiedLine('ins', -1, row.b, '+', row, 'new', ctx));
        return frag;
    }

    /* ------------------------------------------------------------------ *
     * Toolbar
     * ------------------------------------------------------------------ */

    function badge(className, text, title) {
        var b = el('span', 'jdh-badge ' + className, text);
        if (title) b.title = title;
        return b;
    }

    function toolbarButton(label, action, value, title) {
        var button = el('button', 'jdh-btn', label);
        button.type = 'button';
        button.dataset.action = action;
        if (value) button.dataset.value = value;
        if (title) button.title = title;
        return button;
    }

    /* ------------------------------------------------------------------ *
     * Public entry point
     * ------------------------------------------------------------------ */

    /**
     * @param {string} oldText
     * @param {string} newText
     * @param {object} settings
     * @param {{fieldName?: string, onToggleOriginal?: Function}} [meta]
     * @returns {{element: HTMLElement, stats: {added:number, removed:number}}}
     */
    function build(oldText, newText, settings, meta) {
        var info = meta || {};
        var ctx = {
            oldLines: splitLines(oldText),
            newLines: splitLines(newText),
            settings: settings
        };

        var rawRows = buildRows(ctx.oldLines, ctx.newLines);
        var stats = computeStats(rawRows);
        var identical = stats.added === 0 && stats.removed === 0;

        var container = el('div', 'jdh');
        container.dataset.view = settings.viewMode === 'unified' ? 'unified' : 'split';

        /* toolbar ----------------------------------------------------- */
        var toolbar = el('div', 'jdh-toolbar');
        if (info.fieldName) {
            toolbar.appendChild(el('span', 'jdh-field', info.fieldName));
        }
        if (identical) {
            toolbar.appendChild(badge('jdh-badge--neutral', 'no textual change'));
        } else {
            toolbar.appendChild(badge('jdh-badge--add', '+' + stats.added,
                stats.added + ' added line(s)'));
            toolbar.appendChild(badge('jdh-badge--del', '−' + stats.removed,
                stats.removed + ' removed line(s)'));
        }
        toolbar.appendChild(el('span', 'jdh-spacer'));

        var segmented = el('div', 'jdh-segmented');
        var splitBtn = toolbarButton('Side by side', 'view', 'split', 'Two-column diff');
        var unifiedBtn = toolbarButton('Unified', 'view', 'unified', 'Single-column diff');
        segmented.appendChild(splitBtn);
        segmented.appendChild(unifiedBtn);
        toolbar.appendChild(segmented);

        var expandAllBtn = toolbarButton('Expand all', 'expand', null,
            'Reveal collapsed unchanged lines');
        toolbar.appendChild(expandAllBtn);

        var originalBtn = toolbarButton('Jira original', 'original', null,
            "Show Jira's built-in view of this change");
        toolbar.appendChild(originalBtn);

        container.appendChild(toolbar);

        /* body -------------------------------------------------------- */
        var viewport = el('div', 'jdh-viewport');
        var grid = el('div', 'jdh-grid');
        viewport.appendChild(grid);
        container.appendChild(viewport);

        function paint() {
            var mode = container.dataset.view;
            grid.className = 'jdh-grid jdh-grid--' + mode;
            grid.textContent = '';

            var rows = settings.collapseUnchanged
                ? collapseEqualRuns(rawRows, Math.max(0, settings.contextLines | 0))
                : rawRows;

            var frag = document.createDocumentFragment();
            for (var i = 0; i < rows.length; i++) {
                frag.appendChild(renderRow(rows[i], ctx, mode));
            }
            grid.appendChild(frag);

            splitBtn.classList.toggle('is-active', mode === 'split');
            unifiedBtn.classList.toggle('is-active', mode === 'unified');
            expandAllBtn.hidden = !grid.querySelector('.jdh-row--skip');
        }

        toolbar.addEventListener('click', function (event) {
            var button = event.target.closest('button[data-action]');
            if (!button || !toolbar.contains(button)) return;
            event.preventDefault();
            event.stopPropagation();

            var action = button.dataset.action;
            if (action === 'view') {
                container.dataset.view = button.dataset.value;
                paint();
                if (typeof info.onViewChange === 'function') {
                    info.onViewChange(button.dataset.value);
                }
            } else if (action === 'expand') {
                grid.querySelectorAll('.jdh-row--skip .jdh-expand').forEach(function (b) {
                    b.click();
                });
                expandAllBtn.hidden = true;
            } else if (action === 'original') {
                if (typeof info.onToggleOriginal === 'function') info.onToggleOriginal();
            }
        });

        paint();

        return { element: container, stats: stats, repaint: paint };
    }

    root.JDHRender = {
        build: build,
        buildRows: buildRows,
        collapseEqualRuns: collapseEqualRuns
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
