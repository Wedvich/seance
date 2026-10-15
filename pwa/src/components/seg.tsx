import type { ComponentChildren, JSX } from "preact";

/** A segmented radio group; the thumb slides in segment widths, sized by `--seg-n`. */
export function Seg<T extends string>(props: {
  label: string;
  options: readonly T[];
  value: T;
  render: (option: T) => ComponentChildren;
  onChange: (option: T) => void;
}): JSX.Element {
  const { label, options, value, render, onChange } = props;
  const index = options.indexOf(value);
  return (
    <div className="seg" role="radiogroup" aria-label={label} style={{ "--seg-n": options.length }}>
      <span className="seg-thumb" style={{ transform: `translateX(${index * 100}%)` }} aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          className="seg-btn"
          onClick={() => onChange(option)}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}
