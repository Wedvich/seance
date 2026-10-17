import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

export function skillOptionId(listId: string, index: number): string {
  // By index, not name: an id has to stay valid whatever a skill dir is called.
  return `${listId}-opt-${index}`;
}

/**
 * The `/` picker under the prompt. Inline in the card rather than an overlay so
 * the on-screen keyboard can never cover it; the textarea keeps focus and owns
 * the keys (`spawn-screen.tsx`), so this only renders and takes taps.
 */
/** The typed text in bold where it sits in the name, so a substring hit reads as one. */
function MatchedName(props: { name: string; query: string }): JSX.Element {
  const { name, query } = props;
  const at = query === "" ? -1 : name.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, at)}
      <b>{name.slice(at, at + query.length)}</b>
      {name.slice(at + query.length)}
    </>
  );
}

export function SkillPicker(props: {
  id: string;
  query: string;
  items: readonly string[];
  active: number;
  onPick: (name: string) => void;
}): JSX.Element {
  const { id, query, items, active, onPick } = props;

  const list = useRef<HTMLDivElement>(null);

  // Not scrollIntoView for the top row: that scrolls every ancestor too, which
  // shifts the page on a phone. scrollTop only moves the list.
  useEffect(() => {
    const el = list.current;
    if (el === null) return;
    if (active === 0) {
      el.scrollTop = 0;
      return;
    }
    el.querySelector(`#${skillOptionId(id, active)}`)?.scrollIntoView({ block: "nearest" });
  }, [id, active, items]);

  if (items.length === 0) {
    return (
      <div className="skill-list" role="status" aria-live="polite">
        <div className="skill-item skill-item-none">
          <span className="skill-name">No skill named {query}</span>
          <span className="skill-sub">sent as typed</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={list} id={id} className="skill-list" role="listbox" aria-label="Skills">
      {items.map((name, i) => (
        <button
          key={name}
          type="button"
          id={skillOptionId(id, i)}
          role="option"
          tabIndex={-1}
          aria-selected={i === active}
          className={i === active ? "skill-item skill-item-active" : "skill-item"}
          // A tap would otherwise move focus here, blurring the textarea and
          // dropping the keyboard (Firefox Android); click still activates.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onPick(name)}
        >
          <span className="skill-name">
            /<MatchedName name={name} query={query} />
          </span>
        </button>
      ))}
    </div>
  );
}
