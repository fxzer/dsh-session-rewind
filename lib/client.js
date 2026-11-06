/*
 * DSH client-module artifact: the per-message edit and rewind controls.
 *
 * Shipped in the loader's closure-factory format so a local checkout installs
 * with no build step and no third-party build dependency.
 *
 * Contract notes (verified against the DSH Web client):
 *  - `conversation.chat.turnTail` is a `kind: "list"`, `scope: "session"` slot
 *    that renders feature contributions immediately before a finished Turn's
 *    action row. Its slot props arrive as owner props and override the standard
 *    kit, so `turn` / `seq` are the Turn's own values, and the session-scoped
 *    standard kit supplies `sessionId` plus the session hooks;
 *  - a committed Turn cannot be edited in place: the session log is append-only
 *    and branching it is the supported operation. This control therefore uses
 *    the same `sessions.fork({ sessionId, atSeq })` + `uiWorkspace.openSession`
 *    idiom as the built-in branch button, then pre-seeds the new session's
 *    composer draft (the per-session key the Conversation store reads on shell
 *    creation) with the Turn's original prompt so it can be edited and resent;
 *  - the file half is two same-origin routes served by this package's Host half.
 *
 * Everything is feature-detected: if a future DSH renames a service, the slot or
 * a hook, the affected piece degrades (or the whole control disappears) instead
 * of raising inside the boot activation audit. The factory allocates nothing at
 * top level and cannot throw, and the registration is guarded, so evaluating
 * this file can never break the page boot.
 */
(() => {
// The IIFE wrapper exists so every binding stays script-local: a revisioned
// re-load (HMR) of a classic script would otherwise die on the shared global
// lexical environment with "Identifier has already been declared".
const loader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__;
if (loader === undefined || loader === null || typeof loader.load !== 'function') return;
loader.load({
  id: 'dsh-session-rewind',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const safeRequire = (id) => {
      try {
        const value = require(id);
        return value === undefined ? null : value;
      } catch {
        return null;
      }
    };

    const React = safeRequire('react');
    const jsxRuntime = safeRequire('react/jsx-runtime');

    const jsx = jsxRuntime !== null && typeof jsxRuntime.jsx === 'function' ? jsxRuntime.jsx : null;
    const jsxs = jsxRuntime !== null && typeof jsxRuntime.jsxs === 'function' ? jsxRuntime.jsxs : null;

    /** The Chat turn tail: rendered before a finished Turn's action row. */
    const SLOT_NAME = 'conversation.chat.turnTail';
    /** The Chat header action row: the discoverable entry to the candidate list. */
    const PLUGIN_ID = 'session-rewind';
    const NS = 'session-rewind';
    const STYLE_ID = 'dsh-session-rewind/turn-tail';
    const CANDIDATES_ROUTE = '/api/session-rewind.candidates';
    const INPLACE_ROUTE = '/api/session-rewind.inplace';
    const CUTS_ROUTE = '/api/session-rewind.cuts';
    const DIAGNOSE_ROUTE = '/api/session-rewind.diagnose';
    const TAIL_ROUTE = '/api/session-rewind.tail';
    const BOOT_REVISION = '1.6.2';
    const HIDDEN_ATTR = 'data-session-rewind-hidden';
    /** The constant body of the marker this plugin appends; never user content. */
    const MARKER_TEXT = '(session-rewind)';
    /** Hard cap for one edit/rewind request, so a stuck request cannot wedge the UI. */
    const REQUEST_TIMEOUT_MS = 25_000;

    /** One per-message bridge per session, shared by every TurnRewind instance. */
    const bridgeRegistry = new Map();
    /** The Conversation store's persistence prefix; one key per session. */

    //#region dictionaries
    const zh = {
      'message.title': '回退到这条消息',
      'message.editTitle': '编辑这条消息',
      'popover.chat': '仅回退对话',
      'popover.both': '回退对话并恢复文件',
      'notice.already': '这条消息已经回退过了，已从界面隐藏。',
      'notice.editReady': '已暂停，原消息已撤回并放回输入框，可编辑后重发。',
      'notice.failed': '操作失败',
      'notice.working': '正在处理…',
      'notice.rewound': '已回退',
      'notice.refilled': '原话已放回输入框',
      'notice.restored': '已恢复 {count} 个文件',
      'notice.busy': '上一个操作还在进行，请稍候…',
    };
    const en = {
      'message.title': 'Rewind to this message',
      'message.editTitle': 'Edit this message',
      'popover.chat': 'Rewind the conversation',
      'popover.both': 'Rewind and restore files',
      'notice.already': 'That message was already rewound; its row is now hidden.',
      'notice.editReady': 'Paused. The original message was withdrawn and is back in the composer for editing.',
      'notice.failed': 'The operation failed',
      'notice.working': 'Working…',
      'notice.rewound': 'Rewound',
      'notice.refilled': 'Original text is back in the composer',
      'notice.restored': 'Restored {count} file(s)',
      'notice.busy': 'The previous action is still running; please wait…',
    };
    //#endregion

    //#region stylesheet
    const SHEET = [
      '[data-session-rewind-hidden="true"]{display:none !important}',
      '.dshSessionRewindHost{display:flex;width:100%;justify-content:flex-end;align-items:center;gap:6px;padding:2px 6px 0;min-height:20px}',
      '.dshSessionRewindPersistent{opacity:1 !important;visibility:visible !important;pointer-events:auto !important}',
      '.dshSessionRewindPersistent *{opacity:1 !important;visibility:visible !important}',
    ].join('\n');
    //#endregion

    /** Send one structural report to the Host. Never throws, never blocks. */
    function sendDiagnose(sessionId, payload) {
      try {
        void fetch(DIAGNOSE_ROUTE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, report: payload }),
          credentials: 'same-origin',
        }).catch(() => undefined);
      } catch {
        /* diagnostics must never break the page */
      }
    }

    function installStyle() {
      if (typeof document === 'undefined') return;
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
      if (existing !== null && existing.textContent === SHEET) return;
      const tag = existing ?? document.createElement('style');
      if (existing !== null) {
        // A revisioned reload must replace the previous text, not duplicate it.
        tag.textContent = SHEET;
        return;
      }
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = SHEET;
      (document.head ?? document.documentElement)?.appendChild(tag);
    }

    function fill(template, params) {
      const text = String(template);
      if (params === null || params === undefined) return text;
      return text.replace(/\{(\w+)\}/gu, (match, name) => {
        const value = params[name];
        return value === undefined || value === null ? match : String(value);
      });
    }

    const prefersChinese = typeof navigator !== 'undefined'
      && typeof navigator.language === 'string'
      && navigator.language.toLowerCase().startsWith('zh');
    const fallbackDict = prefersChinese ? zh : en;

    function localMessage(key, params) {
      const template = fallbackDict[key] ?? en[key] ?? key;
      return fill(template, params);
    }

    /** Hidden turn-tail host: keeps one bridge alive per rendered Session. */
    function TurnRewind(props) {
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined;
      const tr = typeof props.tr === 'function' ? props.tr : localMessage;
      React.useEffect(() => {
        if (sessionId === undefined) return undefined;
        const existing = bridgeRegistry.get(sessionId);
        if (existing !== undefined) {
          existing.refs += 1;
          return () => releaseBridge(sessionId, existing);
        }
        let bridge;
        try {
          bridge = createRowBridge({ ctx: props.ctx, sessionId, tr, inputActions: props.inputActions });
        } catch (error) {
          sendDiagnose('__boot__', { reason: 'bridge-failed', error: String(error?.message ?? error), boot: BOOT_REVISION });
          warn(error);
          return undefined;
        }
        const entry = { refs: 1, bridge };
        bridgeRegistry.set(sessionId, entry);
        sendDiagnose('__boot__', { reason: 'bridge-mounted', sessionId, boot: BOOT_REVISION });
        return () => releaseBridge(sessionId, entry);
      }, [sessionId]);
      return null;
    }

    function releaseBridge(sessionId, entry) {
      entry.refs -= 1;
      if (entry.refs > 0) return;
      bridgeRegistry.delete(sessionId);
      try { entry.bridge.dispose(); } catch (error) { warn(error); }
    }

    function createRowBridge({ ctx, sessionId, tr, inputActions }) {
      const state = {
        disposed: false,
        turnToSeq: new Map(),
        activeTurns: new Set(),
        hiddenTurns: new Set(),
        buttons: new Map(),
        hiddenRows: new Map(),
        observer: null,
        scheduled: 0,
        popover: null,
        busy: false,
        candidatesRequest: 0,
        cutsRequest: 0,
      };

      const errors = [];
      const seen = new Set();

      /**
       * Describe one element's structure without any message text, so the page
       * can tell the Host what it actually renders. Used only for diagnostics.
       */
      const describeNode = (element, depth) => {
        if (element === null || element === undefined || depth < 0) return null;
        const attrs = {};
        for (const attribute of Array.from(element.attributes ?? [])) {
          if (!String(attribute.name).startsWith('data-')) continue;
          attrs[attribute.name] = String(attribute.value).slice(0, 80);
        }
        const children = [];
        for (const child of Array.from(element.children ?? []).slice(0, 8)) {
          const described = describeNode(child, depth - 1);
          if (described !== null) children.push(described);
        }
        return {
          tag: String(element.tagName ?? '').toLowerCase(),
          cls: String(element.className ?? '').slice(0, 120),
          attrs,
          ...(children.length === 0 ? {} : { children }),
        };
      };

      /** Send one structural snapshot to the Host (no text, memory only). */
      const report = (reason) => {
        let payload;
        try {
          const userRows = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'));
          const turnRows = Array.from(document.querySelectorAll('[data-chat-turn]'));
          const mappedRows = userRows.filter((row) => {
            const turn = Number(row.getAttribute('data-chat-turn') ?? row.closest('[data-chat-turn]')?.getAttribute('data-chat-turn'));
            return Number.isInteger(turn) && state.turnToSeq.has(turn);
          });
          payload = {
            reason,
            mounted: true,
            url: String(window.location?.pathname ?? ''),
            counts: {
              userRows: userRows.length,
              turnRows: turnRows.length,
              mappedRows: mappedRows.length,
              mapped: state.turnToSeq.size,
              injected: state.buttons.size,
              glyphs: Array.from(state.buttons.values()).filter((b) => b.querySelector('svg') !== null).length,
            },
            sampleUserRow: userRows[0] === undefined ? null : describeNode(userRows[0], 3),
            sampleTurnRow: turnRows[0] === undefined ? null : describeNode(turnRows[0], 2),
            errors: errors.slice(0, 5),
          };
        } catch (error) {
          payload = { reason, mounted: true, fatal: String(error && error.message ? error.message : error) };
        }
        try {
          void fetch(DIAGNOSE_ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, report: payload }),
            credentials: 'same-origin',
          }).catch(() => undefined);
        } catch {
          /* diagnostics must never break the page */
        }
      };

      const serviceOf = (name) => {
        try {
          const value = ctx?.get?.(name);
          return value === undefined ? undefined : value;
        } catch {
          return undefined;
        }
      };

      const postJson = async (route, body, timeoutMs = REQUEST_TIMEOUT_MS) => {
        const abort = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = abort === null ? 0 : window.setTimeout(() => abort.abort(), timeoutMs);
        let response;
        try {
          response = await fetch(route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin',
            ...(abort === null ? {} : { signal: abort.signal }),
          });
        } finally {
          window.clearTimeout(timer);
        }
        const value = await response.json().catch(() => null);
        if (!response.ok) {
          const error = new Error(
            (value !== null && typeof value === 'object' && typeof value.message === 'string'
              ? value.message
              : `${tr('notice.failed')}（HTTP ${response.status}）`),
          );
          error.status = response.status;
          error.code = value !== null && typeof value === 'object' && typeof value.code === 'string' ? value.code : null;
          throw error;
        }
        return value;
      };

      /** Put a message body back into this session's composer. */
      const setComposer = (text) => {
        if (typeof text !== 'string' || text === '') return false;
        try {
          if (inputActions !== undefined && inputActions !== null && typeof inputActions.setDraft === 'function') {
            inputActions.setDraft(text);
            if (typeof inputActions.persistDraft === 'function') inputActions.persistDraft();
            return true;
          }
        } catch {
          /* fall through to the facade */
        }
        try {
          const conversation = serviceOf('conversation');
          const sessions = serviceOf('sessions');
          const scope = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined;
          const input = conversation?.input;
          if (input !== undefined && scope !== undefined) {
            input.for(scope).setDraft(text);
            if (typeof input.for(scope).focus === 'function') input.for(scope).focus();
            return true;
          }
        } catch {
          /* fall through to the raw element */
        }
        try {
          const element = document.querySelector('[data-composer-input]');
          if (element === null) return false;
          element.textContent = text;
          return true;
        } catch {
          return false;
        }
      };

      /** Hide or restore the rendered rows at or after the executed cut. */
      /**
       * Hide exactly the rows of the Turns a rewind withdrew.
       *
       * The attribute (plus a `display: none !important` rule in SHEET) is used
       * instead of an inline style because the Chat re-renders its rows and would
       * drop an inline override; an unknown attribute survives that. Turns the user
       * starts after rewinding are not in the set, so they stay visible.
       */
      const applyHiding = () => {
        if (state.disposed) return;
        const rows = document.querySelectorAll('[data-chat-turn]');
        for (const row of rows) {
          const turn = Number(row.getAttribute('data-chat-turn'));
          if (!Number.isInteger(turn)) continue;
          const isMarker = (row.textContent ?? '').trim() === MARKER_TEXT;
          if (isMarker || state.hiddenTurns.has(turn)) {
            if (!row.hasAttribute(HIDDEN_ATTR)) row.setAttribute(HIDDEN_ATTR, 'true');
          } else if (row.hasAttribute(HIDDEN_ATTR)) {
            row.removeAttribute(HIDDEN_ATTR);
          }
        }
      };


      const closePopover = () => {
        if (state.popover !== null) {
          try {
            state.popover.remove();
          } catch {
            /* already gone */
          }
          state.popover = null;
        }
      };

      const runEdit = async (seq, turn, notice) => {
        if (state.disposed) return;
        if (state.busy) {
          notice(tr('notice.busy'));
          return;
        }
        state.busy = true;
        try {
          notice(tr('notice.working'));
          const result = await postJson(INPLACE_ROUTE, { sessionId, seq, edit: true });
          if (state.disposed) return;
          if (Array.isArray(result.hiddenTurns)) {
            for (const hiddenTurn of result.hiddenTurns) {
              if (Number.isInteger(hiddenTurn)) state.hiddenTurns.add(hiddenTurn);
            }
          }
          if (state.hiddenTurns.size === 0 && Number.isInteger(result.hiddenFromTurn)) state.hiddenTurns.add(result.hiddenFromTurn);
          if (Number.isInteger(turn)) state.hiddenTurns.add(turn);
          state.activeTurns.delete(turn);
          applyHiding();
          const filled = setComposer(typeof result.prompt === 'string' ? result.prompt : '');
          sendDiagnose(sessionId, { reason: 'edit', filled, markerSeq: result.markerSeq, sequence: seq, promptChars: result.prompt?.length ?? 0 });
          notice(filled ? tr('notice.editReady') : tr('notice.failed'));
        } catch (error) {
          sendDiagnose(sessionId, { reason: 'edit-failed', error: String(error?.message ?? error), sequence: seq });
          notice(error instanceof Error ? error.message : tr('notice.failed'));
        } finally {
          state.busy = false;
          schedule();
        }
      };

      const runRewind = async (seq, restoreFiles, notice, fromTurn = null) => {
        if (state.disposed) return;
        if (state.busy) {
          notice(tr('notice.busy'));
          return;
        }
        state.busy = true;
        try {
          notice(tr('notice.working'));
          const result = await postJson(INPLACE_ROUTE, { sessionId, seq, restoreFiles });
          if (state.disposed) return;
          if (Array.isArray(result.hiddenTurns) && result.hiddenTurns.length > 0) {
            for (const turn of result.hiddenTurns) {
              if (Number.isInteger(turn)) state.hiddenTurns.add(turn);
            }
          } else if (Number.isInteger(result.hiddenFromTurn)) {
            state.hiddenTurns = new Set([result.hiddenFromTurn]);
          }
          applyHiding();
          const filled = setComposer(typeof result.prompt === 'string' ? result.prompt : '');
          sendDiagnose(sessionId, {
            reason: 'rewind',
            filled,
            markerSeq: result.markerSeq,
            hiddenFromTurn: result.hiddenFromTurn,
            promptChars: typeof result.prompt === 'string' ? result.prompt.length : 0,
            restore: result.restore ?? null,
            injected: state.buttons.size,
            hiddenRows: state.hiddenTurns.size,
          });
          const restore = result.restore;
          const parts = [];
          if (filled) parts.push(tr('notice.refilled'));
          if (restore !== undefined && (restore.restored > 0 || restore.deleted > 0)) {
            parts.push(tr('notice.restored', { count: restore.restored + restore.deleted }));
          }
          notice(parts.length === 0 ? tr('notice.rewound') : `${tr('notice.rewound')} · ${parts.join(' · ')}`);
        } catch (error) {
          const code = error !== null && typeof error === 'object' ? error.code ?? null : null;
          sendDiagnose(sessionId, {
            reason: 'rewind-failed',
            error: String(error && error.message ? error.message : error),
            code,
            sequence: seq,
          });
          if (code === 'not-on-surface') {
            // Already withdrawn by an earlier rewind: hide the row and say so,
            // instead of reporting a failure the user cannot act on.
            const turn = Number.isInteger(fromTurn) ? fromTurn : null;
            if (Number.isInteger(turn)) {
              state.hiddenTurns.add(turn);
              applyHiding();
            }
            notice(tr('notice.already'));
            return;
          }
          notice(error instanceof Error && error.message !== '' ? error.message : tr('notice.failed'));
        } finally {
          state.busy = false;
          schedule();
        }
      };

      const openPopover = (anchor, seq, notice, turn = null) => {
        closePopover();
        const popover = document.createElement('div');
        popover.setAttribute('data-session-rewind-popover', '');
        popover.style.cssText = [
          'position:fixed',
          'z-index:60',
          'display:flex',
          'flex-direction:column',
          'gap:4px',
          'min-width:196px',
          'padding:6px',
          'border:1px solid var(--dsw-alias-border-l2)',
          'border-radius:10px',
          'background:var(--dsw-alias-bg-base,#fff)',
          'box-shadow:0 12px 28px rgba(0,0,0,.18)',
        ].join(';');
        const rect = typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
        if (rect !== null) {
          const popoverWidth = 200;
          const idealLeft = rect.right - popoverWidth;
          const clampedLeft = Math.max(8, Math.min(window.innerWidth - popoverWidth - 8, idealLeft));
          popover.style.left = `${String(Math.round(clampedLeft))}px`;
          popover.style.top = `${String(Math.round(rect.bottom) + 6)}px`;
        }
        const makeButton = (label, onClick) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.style.cssText = [
            'padding:4px 9px',
            'border:0',
            'border-radius:7px',
            'background:transparent',
            'cursor:pointer',
            'text-align:left',
            'font-family:var(--dsw-font-family)',
            'font-size:12px',
            'color:var(--dsw-alias-label-primary)',
          ].join(';');
          button.addEventListener('mouseenter', () => {
            button.style.background = 'var(--dsw-alias-interactive-bg-hover)';
          });
          button.addEventListener('mouseleave', () => {
            button.style.background = 'transparent';
          });
          button.addEventListener('click', () => {
            try {
              onClick();
            } catch (error) {
              sendDiagnose(sessionId, {
                reason: 'option-failed',
                error: String(error && error.message ? error.message : error),
                boot: BOOT_REVISION,
                sequence: seq,
              });
            }
          });
          return button;
        };
        popover.appendChild(makeButton(tr('popover.chat'), () => {
          closePopover();
          void runRewind(seq, false, notice, turn);
        }));
        popover.appendChild(makeButton(tr('popover.both'), () => {
          closePopover();
          void runRewind(seq, true, notice, turn);
        }));
        document.body.appendChild(popover);
        state.popover = popover;
        const onOutside = (event) => {
          if (state.popover === null) return;
          if (typeof event?.target === 'object' && (state.popover.contains(event.target) || anchor.contains(event.target))) return;
          closePopover();
          document.removeEventListener('pointerdown', onOutside, true);
        };
        const onKey = (event) => {
          if (event?.key !== 'Escape') return;
          closePopover();
          document.removeEventListener('keydown', onKey);
        };
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey);
      };

      const notice = (text) => {
        // A transient status line pinned to the chat, so a failure is visible.
        let tag = document.querySelector('[data-session-rewind-notice]');
        if (tag === null) {
          tag = document.createElement('div');
          tag.setAttribute('data-session-rewind-notice', '');
          tag.style.cssText = [
            'position:fixed',
            'left:50%',
            'bottom:96px',
            'transform:translateX(-50%)',
            'z-index:70',
            'padding:4px 10px',
            'border-radius:999px',
            'background:var(--dsw-alias-bg-base,#fff)',
            'border:1px solid var(--dsw-alias-border-l2)',
            'color:var(--dsw-alias-label-primary)',
            'font-family:var(--dsw-font-family)',
            'font-size:11px',
            'box-shadow:0 8px 20px rgba(0,0,0,.16)',
          ].join(';');
          document.body.appendChild(tag);
        }
        tag.textContent = text;
        window.clearTimeout(notice.timer);
        notice.timer = window.setTimeout(() => {
          try {
            tag.remove();
          } catch {
            /* already gone */
          }
        }, 4200);
      };

      const turnOfRow = (row) => {
        const own = Number(row.getAttribute('data-chat-turn'));
        if (Number.isInteger(own)) return own;
        const holder = typeof row.closest === 'function' ? row.closest('[data-chat-turn]') : null;
        const inherited = Number(holder?.getAttribute('data-chat-turn'));
        return Number.isInteger(inherited) ? inherited : undefined;
      };

      const updateButton = (button, editMode) => {
        const nextMode = editMode ? 'edit' : 'rewind';
        if (button.getAttribute('data-edit-mode') === nextMode && button.children.length > 0) return;
        button.setAttribute('data-edit-mode', nextMode);
        button.title = editMode ? tr('message.editTitle') : tr('message.title');
        button.setAttribute('aria-label', button.title);
        button.innerHTML = [
          '<svg viewBox="0 0 16 16" width="16" height="16" fill="none"',
          ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round"',
          ' stroke-linejoin="round" aria-hidden="true" focusable="false" style="pointer-events:none">',
          editMode
            ? '<path d="M11.5 2.5L13.5 4.5L5 13H3V11L11.5 2.5Z" style="pointer-events:none" /><path d="M9.5 4.5L11.5 6.5" style="pointer-events:none" />'
            : '<path d="M6 4.5L2.5 8L6 11.5" style="pointer-events:none" /><path d="M2.5 8H10C12.2091 8 14 9.79086 14 12V12.5" style="pointer-events:none" />',
          '</svg>',
        ].join('');
      };

      const inject = () => {
        if (state.disposed) return;
        const rows = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'));
        for (const row of rows) {
          const turn = turnOfRow(row);
          if (!Number.isInteger(turn)) continue;
          const seq = state.turnToSeq.get(turn);
          if (seq === undefined || seq === null) continue;
          const existingButton = row.querySelector('[data-session-rewind-btn]');
          if (existingButton !== null) {
            updateButton(existingButton, state.activeTurns.has(turn));
            continue;
          }
          // Always host the control in its own container at the end of the row.
          // The official action row only paints on hover, so putting the control
          // there made it invisible until the pointer was over the message.
          // The control belongs on the official action line, right of the copy
          // button. That line is laid out by hashed class names, but its
          // `[data-clock]` marker is stable. It also paints only on hover, so the
          // line is pinned visible below — which puts this control and the shipped
          // icons on screen together, without needing a hover.
          const actions = row.querySelector('[data-clock]');
          let anchor = actions;
          if (anchor === null || anchor === undefined) {
            const hostParent = row.querySelector('[data-slot="conversation.chat.node"]') ?? row;
            anchor = document.createElement('div');
            anchor.setAttribute('data-session-rewind-host', '');
            anchor.className = 'dshSessionRewindHost';
            hostParent.appendChild(anchor);
          } else if (!anchor.classList.contains('dshSessionRewindPersistent')) {
            anchor.classList.add('dshSessionRewindPersistent');
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.setAttribute('data-session-rewind-btn', '');
          const editMode = state.activeTurns.has(turn);
          updateButton(button, editMode);
          button.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'justify-content:center',
            'flex:none',
            'width:28px',
            'height:28px',
            'padding:6px',
            'margin-inline-start:2px',
            'border:0',
            'border-radius:var(--dsw-radius-sm, 4px)',
            'background:transparent',
            'cursor:pointer',
            'color:var(--dsw-alias-label-tertiary, currentColor)',
            'line-height:0',
            'vertical-align:middle',
            'box-sizing:border-box',
          ].join(';');
          button.addEventListener('mouseenter', () => {
            button.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))';
            button.style.color = 'var(--dsw-alias-label-primary, currentColor)';
          });
          button.addEventListener('mouseleave', () => {
            button.style.background = 'transparent';
            button.style.color = 'var(--dsw-alias-label-tertiary, currentColor)';
          });
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (state.busy) return;
            sendDiagnose(sessionId, { reason: 'click', turn, seq, buttons: state.buttons.size, mapped: state.turnToSeq.size });
            if (state.activeTurns.has(turn)) void runEdit(seq, turn, notice);
            else openPopover(button, seq, notice, turn);
          });
          anchor.appendChild(button);
          state.buttons.set(row, button);
        }
      };

      let reporting = false;
      const schedule = () => {
        if (state.disposed || state.scheduled !== 0) return;
        state.scheduled = window.setTimeout(() => {
          state.scheduled = 0;
          let injected = state.buttons.size;
          try {
            inject();
            applyHiding();
          } catch (error) {
            errors.push(String(error && error.message ? error.message : error));
          }
          // A message sent after the last fetch has no target yet: re-read the
          // candidate map (throttled) so the newest row gets a control too.
          try {
            const unmapped = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]')).some(
              (row) => row.querySelector('[data-session-rewind-btn]') === null,
            );
            if (unmapped && Date.now() - candidatesAt > 1500) void loadCandidates();
          } catch {
            /* ignore */
          }
          // Report once when the page has rows but nothing could be attached, so
          // the Host can see why without a browser inspector.
          if (!reporting && state.buttons.size > 0) {
            reporting = true;
            report('attached');
          } else if (!reporting && state.buttons.size === 0 && injected === 0) {
            const marker = `${String(document.querySelectorAll('[data-chat-flow-kind="user"]').length)}:${String(state.turnToSeq.size)}`;
            if (!seen.has(marker)) {
              seen.add(marker);
              report('no-attach');
            }
          }
        }, 120);
      };

      let candidatesAt = 0;
      const loadCandidates = async () => {
        candidatesAt = Date.now();
        const requestId = ++state.candidatesRequest;
        try {
          const value = await postJson(CANDIDATES_ROUTE, { sessionId });
          if (state.disposed || requestId !== state.candidatesRequest) return;
          const next = new Map();
          const active = new Set();
          const prompts = new Map();
          for (const candidate of Array.isArray(value.turns) ? value.turns : []) {
            if (!Number.isInteger(candidate?.turn) || !Number.isInteger(candidate?.userSeq)) continue;
            next.set(candidate.turn, candidate.userSeq);
            if (candidate.edit === true) { active.add(candidate.turn); prompts.set(candidate.turn, candidate.prompt ?? ''); }
          }
          for (const candidate of Array.isArray(value.active) ? value.active : []) {
            if (Number.isInteger(candidate?.turn) && Number.isInteger(candidate?.userSeq)) { next.set(candidate.turn, candidate.userSeq); active.add(candidate.turn); prompts.set(candidate.turn, candidate.prompt ?? ''); }
          }
          state.turnToSeq = next; state.activeTurns = active;
          schedule();
        } catch {
          /* the bridge simply stays empty */
        }
      };

      const loadCuts = async () => {
        const requestId = ++state.cutsRequest;
        try {
          const value = await postJson(CUTS_ROUTE, { sessionId });
          if (state.disposed || requestId !== state.cutsRequest) return;
          if (Array.isArray(value.hiddenTurns)) {
            state.hiddenTurns = new Set(value.hiddenTurns.filter((turn) => Number.isInteger(turn)));
          } else if (Number.isInteger(value.hiddenFromTurn)) {
            state.hiddenTurns = new Set([value.hiddenFromTurn]);
          }
          applyHiding();
        } catch {
          /* ignore */
        }
      };

      try {
        state.observer = new window.MutationObserver(() => {
          schedule();
        });
        state.observer.observe(document.body, { childList: true, subtree: true });
      } catch {
        state.observer = null;
      }
      void loadCandidates();
      void loadCuts();
      schedule();
      window.setTimeout(() => {
        if (!state.disposed) report('mount');
      }, 2600);

      return {
        /** Re-read the cut and the candidate map after an external rewind. */
        refresh() {
          void loadCandidates();
          void loadCuts();
        },
        /** Run one in-place rewind from any UI that already knows the seq. */
        rewind(seq, restoreFiles) {
          return runRewind(seq, restoreFiles === true, notice);
        },
        dispose() {
          state.disposed = true;
          closePopover();
          try {
            state.observer?.disconnect();
          } catch {
            /* ignore */
          }
          window.clearTimeout(state.scheduled);
          for (const button of state.buttons.values()) {
            try {
              button.remove();
            } catch {
              /* ignore */
            }
          }
          state.buttons.clear();
          for (const [row, display] of state.hiddenRows) {
            try {
              row.style.display = display;
            } catch {
              /* ignore */
            }
          }
          state.hiddenRows.clear();
          try {
            document.querySelector('[data-session-rewind-notice]')?.remove();
          } catch {
            /* ignore */
          }
        },
      };
    }

    /**
     * @param {object} ctx DSH Cordis client context.
     */
    function apply(ctx) {
      if (jsx === null || jsxs === null || React === null) return;
      if (typeof React.useState !== 'function'
        || typeof React.useRef !== 'function'
        || typeof React.useEffect !== 'function') return;

      try {
        installStyle();
      } catch {
        /* a missing <head> only costs styling */
      }

      let boundTranslate = null;
      const tr = (key, params) => {
        if (boundTranslate !== null) {
          try {
            return boundTranslate(key, params);
          } catch {
            /* fall back to the bundled dictionaries */
          }
        }
        return localMessage(key, params);
      };

      try {
        ctx.inject(['locale'], (scope) => {
          try {
            scope.effect(() => scope.locale.register(NS, { zh, en }), 'session-rewind: dictionaries');
            const bound = scope.locale.bind(NS);
            if (typeof bound === 'function') boundTranslate = bound;
          } catch {
            /* bundled dictionaries remain in charge */
          }
        });
      } catch {
        /* the locale service is optional */
      }

      // `ctx` is handed to the components so they can reach `sessions` /
      // `uiWorkspace` lazily: resolving them at registration time would pin a
      // service instance that a plugin reload has already replaced.
      const component = (props) => jsx(TurnRewind, { ...props, ctx, tr });

      try {
        ctx.inject(['slots'], (scope) => {
          const injected = [];
          try {
            scope.slots.inject(SLOT_NAME, () => scope.slots.register({
              name: SLOT_NAME,
              id: PLUGIN_ID,
              order: -1,
              inject: () => ({ tr }),
            }, component));
            injected.push(SLOT_NAME);
          } catch (error) {
            warn(error);
          }
          // The session-header entry was retired: rewriting is now offered only on
          // the user's own message row, so no second entry point is registered.
          sendDiagnose('__boot__', {
            reason: 'apply',
            slots: injected,
            boot: BOOT_REVISION,
            hasDocument: typeof document !== 'undefined',
          });
        });
      } catch (error) {
        warn(error);
        sendDiagnose('__boot__', { reason: 'apply-failed', error: String(error && error.message ? error.message : error), boot: BOOT_REVISION });
      }
    }

    function warn(error) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[dsh-session-rewind]', error);
      } catch {
        /* nothing else to do */
      }
    }

    exports.apply = apply;
    /** The Chat turn-tail slot is the only service this plugin needs. */
    exports.inject = [];
    return module.exports;
  },
});
})();
