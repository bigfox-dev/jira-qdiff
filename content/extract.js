/*!
 * Jira Diff Highlighter (Server / Data Center)
 * ------------------------------------------------
 * Turns an on-premise Jira change-history <td> back into plain text.
 *
 * Jira Server/DC renders history values as escaped wiki markup with <br/> for
 * newlines, autolinked URLs, an "Original:"/"New:" <b> label and — for some
 * fields — a raw <span class="hist-value">[ ... ]</span> tail. All of that has
 * to be stripped before diffing, otherwise the label and the raw value show up
 * as changes.
 */
(function (root) {
    'use strict';

    var BLOCK_TAGS = new Set([
        'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'pre', 'table', 'ul', 'ol', 'dl', 'dd', 'dt', 'hr'
    ]);

    var SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);

    var NBSP_RE = / /g;
    var INVISIBLE_RE = /[​‌‍﻿]/g;

    /** "Original:", "New:", "Původní:", "Nový:" … — any short bold label. */
    function isValueLabel(el) {
        if (!el || el.nodeType !== 1) return false;
        if (!/^(b|strong)$/i.test(el.tagName)) return false;
        var text = (el.textContent || '').trim();
        return text.length > 0 && text.length <= 32 && /[:：]$/.test(text);
    }

    function firstMeaningfulChild(node) {
        for (var i = 0; i < node.childNodes.length; i++) {
            var child = node.childNodes[i];
            if (child.nodeType === 3 && !child.nodeValue.trim()) continue;
            if (child.nodeType === 8) continue;
            return child;
        }
        return null;
    }

    function walk(node, out, ctx, preformatted) {
        if (node.nodeType === 3) {
            // Server/DC emits "<br/>\n" for every newline in the stored value, so
            // a raw newline in a text node is just HTML whitespace there and must
            // not break the line — otherwise every break is counted twice.
            // Cloud does the opposite: it hands over a plain-text blob whose real
            // newlines are the only line breaks there are.
            var keep = preformatted || ctx.textNewlines;
            out.push(keep ? node.nodeValue : node.nodeValue.replace(/[\r\n]+/g, ' '));
            return;
        }
        if (node.nodeType !== 1) return;

        var tag = node.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) return;

        if (tag === 'br') {
            out.push('\n');
            return;
        }
        if (tag === 'img') {
            var alt = node.getAttribute('alt');
            if (alt) out.push(alt);
            return;
        }

        // Cloud renders rich text, so a bare list would collapse into one blob.
        if (tag === 'li' && ctx.listMarkers) out.push('• ');

        var pre = preformatted || tag === 'pre';
        for (var i = 0; i < node.childNodes.length; i++) {
            walk(node.childNodes[i], out, ctx, pre);
        }

        if (BLOCK_TAGS.has(tag)) out.push('\n');
    }

    /**
     * Read any history value element down to plain text.
     *
     * @param {Element|null} element
     * @param {{normalizeWhitespace?: boolean, textNewlines?: boolean,
     *          listMarkers?: boolean, stripLabel?: boolean}} [options]
     * @returns {string}
     */
    function elementToText(element, options) {
        if (!element) return '';
        var opts = options || {};
        var clone = element.cloneNode(true);

        // The bracketed raw value ("[ 18000 ]") is Jira internals, not content.
        clone.querySelectorAll('span.hist-value').forEach(function (n) {
            n.remove();
        });

        if (opts.stripLabel !== false) {
            var first = firstMeaningfulChild(clone);
            if (isValueLabel(first)) first.remove();
        }

        var parts = [];
        walk(clone, parts, {
            textNewlines: opts.textNewlines === true,
            listMarkers: opts.listMarkers === true
        }, false);
        return normalize(parts.join(''), opts.normalizeWhitespace !== false);
    }

    /** Server/DC change-history cell (.activity-old-val / .activity-new-val). */
    function cellToText(td, options) {
        return elementToText(td, options);
    }

    function normalize(text, collapseWhitespace) {
        // &nbsp; carries Jira's wiki-markup indentation; treat it as a space.
        var value = text
            .replace(NBSP_RE, ' ')
            .replace(INVISIBLE_RE, '')
            .replace(/\r\n?/g, '\n');

        var lines = value.split('\n').map(function (line) {
            if (collapseWhitespace) {
                return line.replace(/[ \t]+/g, ' ').trim();
            }
            return line.replace(/[ \t]+$/g, '');
        });

        if (collapseWhitespace) {
            // Jira's "&nbsp;" spacer lines pile up; one blank line says the same.
            lines = lines.filter(function (line, index) {
                return line !== '' || index === 0 || lines[index - 1] !== '';
            });
        }

        while (lines.length && !lines[0].trim()) lines.shift();
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

        return lines.join('\n');
    }

    /**
     * Read one <tr> of a Jira Server change-history table.
     * @returns {{name:string, oldCell:Element|null, newCell:Element|null,
     *            oldText:string, newText:string}|null}
     */
    function readHistoryRow(tr, options) {
        var nameCell = tr.querySelector('td.activity-name');
        var oldCell = tr.querySelector('td.activity-old-val');
        var newCell = tr.querySelector('td.activity-new-val');
        if (!oldCell && !newCell) return null;

        return {
            name: nameCell ? (nameCell.textContent || '').trim() : '',
            oldCell: oldCell,
            newCell: newCell,
            oldText: cellToText(oldCell, options),
            newText: cellToText(newCell, options)
        };
    }

    root.JDHExtract = {
        elementToText: elementToText,
        cellToText: cellToText,
        readHistoryRow: readHistoryRow,
        normalize: normalize
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHExtract;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
