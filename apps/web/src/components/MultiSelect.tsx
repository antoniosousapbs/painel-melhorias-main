import { useEffect, useRef, useState } from 'react';

interface MultiSelectProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  displayFn?: (v: string) => string;
}

/** Dropdown de seleção múltipla com busca — usado na barra de filtros do Dashboard e
 * reusado no Histórico de Chamados Encerrados para manter os mesmos filtros. */
export default function MultiSelect({ label, options, selected, onChange, displayFn }: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const display = displayFn || ((v: string) => v);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const filtered = query
    ? options.filter(o => display(o).toLowerCase().includes(query.toLowerCase()))
    : options;

  const allSelected = selected.length === 0;

  const toggle = (val: string) => {
    if (selected.includes(val)) onChange(selected.filter(s => s !== val));
    else onChange([...selected, val]);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="h-9 min-w-[130px] flex items-center justify-between gap-2 px-3 border border-border rounded-sm bg-bg text-[13px] focus-ring transition-[border-color,box-shadow] duration-150"
        aria-expanded={open}
      >
        <span className={selected.length > 0 ? 'text-txt' : 'text-txt-3'}>
          {selected.length > 0 ? `${label} (${selected.length})` : label}
        </span>
        <svg className="w-3 h-3 text-txt-3" fill="none" stroke="currentColor" viewBox="0 0 12 12">
          <path d="M3 5l3 3 3-3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 w-[280px] max-h-[280px] overflow-auto bg-surface border border-border rounded-sm shadow p-1.5 z-10">
          <input
            autoFocus
            placeholder={`Buscar ${label.toLowerCase()}...`}
            className="w-full h-[30px] mb-1.5 px-2 border border-border rounded-sm text-[12px] focus-ring"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {/* Todos */}
          <label className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-[#f4f8ff] border-b border-border mb-1 pb-2 font-semibold text-[13px]">
            <input
              type="checkbox"
              className="w-[14px] h-[14px]"
              checked={allSelected}
              onChange={() => onChange([])}
            />
            Todos
          </label>
          {filtered.map(opt => (
            <label
              key={opt}
              className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-[#f4f8ff] text-[13px]"
            >
              <input
                type="checkbox"
                className="w-[14px] h-[14px]"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
              />
              {display(opt)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
