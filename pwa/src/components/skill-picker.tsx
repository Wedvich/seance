import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import type { SkillEntry } from "../skills.ts";

export function skillOptionId(listId: string, index: number): string {
  // By index, not name: an id has to stay valid whatever a skill dir is called.
  return `${listId}-opt-${index}`;
}

/**
 * The `/` picker under the prompt. Inline in the card rather than an overlay so
 * the on-screen keyboard can never cover it; the textarea keeps focus and owns
 * the keys (`spawn-screen.tsx`), so this only renders and takes taps.
 */
export function SkillPicker(props: {
  id: string;
  query: string;
  items: readonly SkillEntry[];
  active: number;
  describe: (entry: SkillEntry) => string;
  onPick: (name: string) => void;
}): JSX.Element {
  const { id, query, items, active, describe, onPick } = props;

  useEffect(() => {
    document.querySelector(`#${skillOptionId(id, active)}`)?.scrollIntoView({ block: "nearest" });
  }, [id, active]);

  return (
    <div id={id} className="skill-list" role="listbox" aria-label="Skills">
      {items.length === 0 ? (
        <div className="skill-item skill-item-none">
          <span className="skill-name">No skill named {query}</span>
          <span className="skill-sub">sent as typed</span>
        </div>
      ) : (
        items.map((entry, i) => (
          <button
            key={entry.name}
            type="button"
            id={skillOptionId(id, i)}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            className={i === active ? "skill-item skill-item-active" : "skill-item"}
            // A tap would otherwise move focus here, blurring the textarea and
            // dropping the keyboard (Firefox Android); click still activates.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onPick(entry.name)}
          >
            <span className="skill-name">/{entry.name}</span>
            <span className="skill-sub">{describe(entry)}</span>
          </button>
        ))
      )}
    </div>
  );
}
