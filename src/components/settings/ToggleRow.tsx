import { useId } from 'react';

interface ToggleRowProps {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * A checkbox setting: title and description on the left, the box on the
 * right. The row is the label, so a click on the text toggles the box; the
 * title alone is the box's name and the description its description.
 */
export default function ToggleRow({ title, description, checked, onChange }: ToggleRowProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  return (
    <label className="flex items-center justify-between">
      <span>
        <span id={titleId} className="block text-sm font-medium text-text-muted">
          {title}
        </span>
        <span id={descriptionId} className="block text-xs text-text-faint">
          {description}
        </span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="h-4 w-4 rounded text-accent-text focus:ring-accent"
      />
    </label>
  );
}
