// @ts-nocheck — template legado 1:1.
import React, { useRef, useCallback, useEffect } from 'react';
import { Bold, Italic, Link as LinkIcon, List, ListOrdered, Image as ImageIcon } from 'lucide-react';

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeightClass?: string;
};

export const AdminRichTextEditor: React.FC<Props> = ({
  value,
  onChange,
  placeholder = 'Conteúdo…',
  minHeightClass = 'min-h-[180px]'
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const lastHtmlRef = useRef(value);

  /** Sincroniza HTML só quando o valor vem de fora (troca de página, load). */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value !== lastHtmlRef.current && el.innerHTML !== value) {
      el.innerHTML = value;
      lastHtmlRef.current = value;
    }
  }, [value]);

  const exec = useCallback((cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    if (ref.current) {
      const html = ref.current.innerHTML;
      lastHtmlRef.current = html;
      onChange(html);
    }
  }, [onChange]);

  const onInput = () => {
    if (!ref.current) return;
    const html = ref.current.innerHTML;
    lastHtmlRef.current = html;
    onChange(html);
  };

  const insertLink = () => {
    const url = window.prompt('URL (https://…)');
    if (url && /^https:\/\//i.test(url.trim())) exec('createLink', url.trim());
  };

  const insertImage = () => {
    const url = window.prompt('URL da imagem (https://… ou caminho /uploads/…)');
    if (url && url.trim()) exec('insertImage', url.trim());
  };

  return (
    <div className="rounded-lg border border-slate-700 overflow-hidden bg-slate-950">
      <div className="flex flex-wrap gap-1 p-2 border-b border-slate-800 bg-slate-900/80">
        <button type="button" onClick={() => exec('bold')} className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Negrito">
          <Bold size={14} />
        </button>
        <button type="button" onClick={() => exec('italic')} className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Itálico">
          <Italic size={14} />
        </button>
        <button type="button" onClick={() => exec('insertUnorderedList')} className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Lista">
          <List size={14} />
        </button>
        <button type="button" onClick={() => exec('insertOrderedList')} className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Lista numerada">
          <ListOrdered size={14} />
        </button>
        <button type="button" onClick={insertLink} className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Link">
          <LinkIcon size={14} />
        </button>
        <button type="button" onClick={insertImage} className="p-1.5 rounded hover:bg-slate-800 text-slate-300" title="Imagem">
          <ImageIcon size={14} />
        </button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        dir="ltr"
        onInput={onInput}
        data-placeholder={placeholder}
        className={`${minHeightClass} p-3 text-sm text-slate-200 outline-none prose prose-invert prose-sm max-w-none empty:before:content-[attr(data-placeholder)] empty:before:text-slate-600 [unicode-bidi:plaintext]`}
      />
    </div>
  );
};
