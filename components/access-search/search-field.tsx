"use client";

import { forwardRef } from "react";
import { Search, X } from "lucide-react";

type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  /** Read by screen readers; the placeholder alone is not a label. */
  label: string;
  placeholder?: string;
  className?: string;
  /** Most characters the field takes, when a server refuses longer text. */
  maxLength?: number;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
};

/** A text input with a search icon and a clear button, shared by the sidebar
 * search and the Access tab filters. */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, label, placeholder, className = "", onKeyDown, onFocus, maxLength },
  ref,
) {
  return (
    <div className={`relative flex items-center ${className}`}>
      <Search size={15} strokeWidth={1.8} aria-hidden className="pointer-events-none absolute left-3 text-fg-subtle" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 w-full min-h-11 rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] py-2 pl-9 pr-8 text-sm text-fg placeholder:text-[var(--field-placeholder)] hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== "" && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={`Clear ${label.toLowerCase()}`}
          className="absolute right-2 rounded p-1 text-fg-subtle hover:text-fg"
        >
          <X size={14} strokeWidth={1.8} aria-hidden />
        </button>
      )}
    </div>
  );
});
