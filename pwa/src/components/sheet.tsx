import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { centeredScrollTop } from "../scroll.ts";
import type { MatchSplit } from "../sheet-filter.ts";
import type { Dot, Tile } from "../view.ts";
import { lockedSheetHeight, viewportInsets } from "../viewport.ts";

const FOCUSABLE = 'button:not([disabled]), [href], input, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Bottom sheet with dialog semantics. Escape and focus return are here for
 * keyboard use in a desktop browser as much as for assistive tech — the sheet
 * replaces the screen's focus context, so leaving focus behind it strands you.
 * `search` and `footer` pin a filter field and a setting row around the list;
 * a sheet with a field is the one the on-screen keyboard can cover, so only it
 * locks its height and follows the visual viewport.
 */
export function Sheet(props: {
  title: string;
  /** True while the exit animation plays; unmount follows via onExited. */
  closing?: boolean;
  onExited?: () => void;
  onClose: () => void;
  /** A form rather than a list: still a bottom sheet on a phone, a centred dialog on a desk. */
  variant?: "dialog";
  /** A filter field pinned under the head; the sheet then keeps one height and tracks the visible viewport. */
  search?: { readonly label: string; readonly query: string; readonly onQuery: (query: string) => void } | null;
  /** Pinned under the list, outside its scroll. */
  footer?: ComponentChildren;
  children: ComponentChildren;
}): JSX.Element {
  const { title, closing = false, onExited, onClose, variant, search = null, footer, children } = props;
  const dialog = variant === "dialog";
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const tracked = search !== null;
  const lastQuery = useRef(search?.query);
  const pressedScrim = useRef(false);
  const listId = useId();
  const filtering = search !== null && search.query !== "";

  // Padding, not a resized scrim: visual-viewport events trail the keyboard (on iOS by its whole animation), and the
  // scrim must keep dimming and swallowing taps over the whole screen meanwhile. Written to the node, not state, so it
  // lands before the scroll measurement below; Preact owns className, so no classList.
  useLayoutEffect(() => {
    const node = scrim.current;
    const viewport = window.visualViewport;
    if (!tracked || node === null || viewport === null) return;
    const apply = (): void => {
      const insets = viewportInsets(viewport, document.documentElement.clientHeight);
      if (insets === null) {
        node.style.removeProperty("padding-top");
        node.style.removeProperty("padding-bottom");
        delete node.dataset.viewport;
        return;
      }
      node.style.paddingTop = `${insets.top}px`;
      node.style.paddingBottom = `${insets.bottom}px`;
      node.dataset.viewport = "visual";
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
    };
  }, [tracked]);

  // Locked so narrowing the list can't shrink the sheet and drop the field down the screen, hence skipped while a
  // filter is typed. Otherwise re-measured on every render: the list arrives late (After reads the queue on open) and
  // the footer hint changes length. Measured with the keyboard-only styles off (hidden hint, trimmed padding), or a
  // sheet opened under the keyboard would lock short of its footer; and against the layout viewport, so a sheet opened
  // while the keyboard is closing doesn't lock to the squeezed height. One synchronous block: nothing paints between.
  const relock = useRef<() => void>(() => {});
  relock.current = (): void => {
    const node = panel.current;
    const items = list.current;
    if (!tracked || node === null || items === null) return;
    if (filtering && node.style.height !== "") return;
    const scrimNode = scrim.current;
    const viewportMode = scrimNode?.dataset.viewport;
    if (scrimNode !== null) delete scrimNode.dataset.viewport;
    node.style.removeProperty("height");
    // Everything but the list (head, field, footer, padding, border) is what the panel adds to it.
    const content = node.offsetHeight - items.offsetHeight + items.scrollHeight;
    if (scrimNode !== null && viewportMode !== undefined) scrimNode.dataset.viewport = viewportMode;
    node.style.height = `${lockedSheetHeight(content, document.documentElement.clientHeight)}px`;
  };
  useLayoutEffect(() => {
    relock.current();
  });
  useEffect(() => {
    if (!tracked) return;
    const onResize = (): void => relock.current();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [tracked]);

  // Before first paint, so a long list opens on its selection rather than
  // visibly jumping to it. Rects, not offsetTop: the panel is mid slide-in.
  useLayoutEffect(() => {
    const node = list.current;
    const selected = node?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!node || !selected) return;
    node.scrollTop = centeredScrollTop(
      {
        top: node.getBoundingClientRect().top,
        height: node.clientHeight,
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
      },
      { top: selected.getBoundingClientRect().top, height: selected.offsetHeight },
    );
  }, []);

  // Layout effect: its cleanup must run before the panel leaves the DOM, as Preact 11 defers useEffect cleanups past paint.
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const node = panel.current;
    const input = searchInput.current;
    // A phone's keyboard would open over the list the sheet was opened to show.
    if (input !== null && window.matchMedia("(pointer: fine)").matches) input.focus({ preventScroll: true });
    else node?.focus();
    return () => {
      // The sheet outlives its dismissal by the exit animation, and the form
      // beneath is tappable for all of it. Focus that has already moved on is the
      // user's: taking it back mid-animation closes the keyboard they just opened.
      if (!(previous instanceof HTMLElement)) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body && node?.contains(active) !== true) return;
      previous.focus();
    };
  }, []);

  // A narrowed list keeps its old offset, which can sit past the first matches.
  useLayoutEffect(() => {
    if (lastQuery.current === search?.query) return;
    lastQuery.current = search?.query;
    if (list.current !== null) list.current.scrollTop = 0;
  }, [search?.query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || panel.current === null) return;
      const targets = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = targets[0];
      const last = targets.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={scrim}
      className={["scrim", closing && "scrim-closing", dialog && "scrim-dialog"].filter(Boolean).join(" ")}
      onPointerDown={(event) => {
        pressedScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // A drag that selects text in the field and lets go over the scrim clicks the scrim, the press's common ancestor.
        if (event.target === event.currentTarget && pressedScrim.current) onClose();
      }}
    >
      <div
        className={[dialog ? "sheet card sheet-dialog" : "sheet card", tracked && "sheet-locked"]
          .filter(Boolean)
          .join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
        tabIndex={-1}
        onAnimationEnd={(event) => {
          if (event.animationName === "sheet-out") onExited?.();
        }}
      >
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {search !== null && (
          <div className="sheet-search">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input
              ref={searchInput}
              type="search"
              enterKeyHint="search"
              aria-controls={listId}
              className="sheet-search-input"
              aria-label={search.label}
              placeholder={search.label}
              value={search.query}
              autoComplete="off"
              autoCapitalize="off"
              spellcheck={false}
              onInput={(event) => search.onQuery(event.currentTarget.value)}
            />
            {search.query !== "" && (
              <button
                type="button"
                className="sheet-search-clear"
                aria-label="Clear filter"
                // Keeps focus where it was, so a tap neither opens nor drops the keyboard.
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  // The button unmounts under a keyboard activation (detail 0); focus would fall to body and escape the
                  // Tab trap. A tap or click never moves focus.
                  search.onQuery("");
                  if (event.detail === 0) searchInput.current?.focus();
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className="sheet-items" ref={list} id={listId}>
          {children}
        </div>
        {footer !== undefined && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A bin, in the same feather-weight stroke as the header cog. It says what the
 * action now does — the entry is deleted at the relay, for every app — where the
 * eye-off it replaced said "hidden here, for now". A ✕ is still avoided: it would
 * read as the sheet's own close button one row above it.
 */
function TrashIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function dotClass(dot: Dot): string {
  return dot === "ok" ? "dot dot-ok" : dot === "auto" ? "dot dot-auto" : "dot";
}

/**
 * Keeps the sheet mounted while its exit animation plays; state has already
 * dropped it. The timeout backstops a lost animationend, which would otherwise
 * strand an invisible scrim over the screen.
 */
export function useSheetExit<K>(sheet: K | null): [K | null, boolean, () => void] {
  const [rendered, setRendered] = useState(sheet);

  useLayoutEffect(() => {
    if (sheet !== null) setRendered(sheet);
  }, [sheet]);

  const closing = sheet === null && rendered !== null;

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setRendered(null), 400);
    return () => clearTimeout(timer);
  }, [closing]);

  return [rendered, closing, () => setRendered(null)];
}

/** A tile of the spawn form's grid, which opens a sheet; the Queue screen's Older filters reuse it. */
export function TileButton(props: { tile: Tile; offline?: boolean; onClick: () => void }): JSX.Element {
  const { tile, offline = false, onClick } = props;
  const valueClass = tile.mono ? "tile-value tile-value-mono" : "tile-value";
  return (
    <button
      type="button"
      className={offline ? "tile card tile-offline" : "tile card"}
      onClick={onClick}
      aria-label={tile.tag === null ? `${tile.label}: ${tile.value}` : `${tile.label}: ${tile.value}, ${tile.tag}`}
    >
      <span className="label">{tile.label}</span>
      <span className={valueClass}>
        {tile.dot !== null && <span className={dotClass(tile.dot)} />}
        <span>{tile.value}</span>
        {tile.tag !== null && <span className="tile-tag">{tile.tag}</span>}
      </span>
    </button>
  );
}

export function SheetItem(props: {
  label: string;
  sub?: string | null;
  selected?: boolean;
  disabled?: boolean;
  mono?: boolean;
  /** Command row (does something) rather than option row (picks something). */
  action?: boolean;
  dot?: Dot | null;
  /** The filter's first hit in `label`, drawn in the accent colour. */
  match?: MatchSplit | null;
  /** Trailing remove button. A nested button would be invalid, so this splits the row in two. */
  onRemove?: (() => void) | null;
  removeLabel?: string;
  /** A second trailing button beside `onRemove`: a row-level command, shown as `actionText`. */
  onAction?: (() => void) | null;
  actionLabel?: string;
  actionText?: string;
  actionDisabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  const {
    label,
    sub = null,
    selected = false,
    disabled = false,
    mono = false,
    action = false,
    dot = null,
    match = null,
    onRemove = null,
    removeLabel = `Remove ${label}`,
    onAction = null,
    actionLabel = label,
    actionText = "↻",
    actionDisabled = false,
    onClick,
  } = props;
  const classes = ["sheet-item"];
  if (selected) classes.push("sheet-item-selected");
  if (disabled) classes.push("sheet-item-disabled");
  if (action) classes.push("sheet-item-action");

  const item = (
    <button type="button" className={classes.join(" ")} onClick={onClick} disabled={disabled} aria-current={selected}>
      {dot !== null && <span className={dotClass(dot)} />}
      <span className="sheet-item-text">
        <span className={mono ? "sheet-item-label sheet-item-mono" : "sheet-item-label"}>
          {match === null ? (
            label
          ) : (
            <>
              {match.before}
              <mark className="sheet-item-hit">{match.hit}</mark>
              {match.after}
            </>
          )}
        </span>
        {sub !== null && <span className="sheet-item-sub">{sub}</span>}
      </span>
      {selected && (
        <span className="sheet-check" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );

  if (onRemove === null && onAction === null) return item;
  return (
    <div className="sheet-item-row">
      {item}
      {onAction !== null && (
        <button
          type="button"
          className="sheet-item-remove"
          onClick={onAction}
          disabled={actionDisabled}
          aria-label={actionLabel}
        >
          {actionText}
        </button>
      )}
      {onRemove !== null && (
        <button type="button" className="sheet-item-remove" onClick={onRemove} aria-label={removeLabel}>
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

/** One switch row for a setting that belongs to the sheet's choice, pinned in its footer. */
export function SheetSetting(props: {
  title: string;
  hint: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { title, hint, on, disabled = false, onToggle } = props;
  return (
    <button
      type="button"
      className="sheet-setting"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="sheet-setting-text">
        <span className="sheet-setting-title">{title}</span>
        <span className="sheet-setting-hint">{hint}</span>
      </span>
      <span className={on ? "toggle toggle-on" : "toggle"} aria-hidden="true">
        <span className="toggle-knob" />
      </span>
    </button>
  );
}
