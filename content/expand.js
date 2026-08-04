/*!
 * Jira Diff Highlighter
 * ------------------------------------------------
 * Full-viewport overlay for a single diff widget.
 *
 * The widget is physically moved to <body> rather than just given
 * `position: fixed` in place. Jira Cloud's generated DOM is full of ancestors
 * with transforms and containment, any of which turns a fixed element into a
 * merely absolutely-positioned one — moving out of that subtree sidesteps the
 * whole class of problem instead of guessing which ancestor is to blame.
 *
 * A placeholder keeps the widget's original slot so it can go back exactly
 * where it came from.
 */
(function (root) {
    'use strict';

    /** Only one widget can be expanded at a time. */
    var active = null;

    function isExpanded(widget) {
        return !!(active && active.widget === widget);
    }

    function onKeydown(event) {
        if (event.key === 'Escape' && active) {
            event.preventDefault();
            event.stopPropagation();
            collapse();
        }
    }

    function collapse() {
        if (!active) return;
        var current = active;
        active = null;

        current.widget.classList.remove('is-expanded');
        document.removeEventListener('keydown', onKeydown, true);

        // Jira may have re-rendered the feed while we were detached; if the slot
        // is gone there is nowhere to put the widget back.
        if (current.placeholder.parentNode) {
            current.placeholder.parentNode.insertBefore(current.widget, current.placeholder);
        } else {
            current.widget.remove();
        }
        current.placeholder.remove();
        current.shell.remove();
        current.backdrop.remove();

        if (typeof current.onChange === 'function') current.onChange(false);
    }

    function expand(widget, onChange) {
        if (active) collapse();
        if (!widget.parentNode) return;

        var placeholder = document.createElement('div');
        placeholder.className = 'jdh-placeholder';
        widget.parentNode.insertBefore(placeholder, widget);

        var backdrop = document.createElement('div');
        backdrop.className = 'jdh-backdrop';
        backdrop.addEventListener('click', function () { collapse(); });

        var shell = document.createElement('div');
        shell.className = 'jdh-overlay';
        shell.appendChild(widget);

        document.body.appendChild(backdrop);
        document.body.appendChild(shell);
        widget.classList.add('is-expanded');
        document.addEventListener('keydown', onKeydown, true);

        active = {
            widget: widget,
            placeholder: placeholder,
            shell: shell,
            backdrop: backdrop,
            onChange: onChange
        };
        if (typeof onChange === 'function') onChange(true);
    }

    function toggle(widget, onChange) {
        if (isExpanded(widget)) collapse();
        else expand(widget, onChange);
    }

    /** Called from teardown so a rescan never orphans an expanded widget. */
    function release(widget) {
        if (isExpanded(widget)) collapse();
    }

    root.JDHExpand = {
        toggle: toggle,
        collapse: collapse,
        release: release,
        isExpanded: isExpanded
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHExpand;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
