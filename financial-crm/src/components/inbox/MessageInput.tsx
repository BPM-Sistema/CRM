"use client";

import { useRef, useState, useCallback, type KeyboardEvent, type ChangeEvent } from "react";
import { Send, FileText, Loader2 } from "lucide-react";

interface MessageInputProps {
  onSend: (text: string) => Promise<void>;
  onTemplateClick: () => void;
  disabled?: boolean;
  canSend: boolean;
}

export function MessageInput({
  onSend,
  onTemplateClick,
  disabled = false,
  canSend,
}: MessageInputProps) {
  const [text, setText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isDisabled = disabled || isSending;

  const resetTextareaHeight = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, []);

  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Cap at 4 rows (~96px assuming ~24px line-height)
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      autoGrow();
    },
    [autoGrow],
  );

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || isDisabled || !canSend) return;

    setIsSending(true);
    try {
      await onSend(trimmed);
      setText("");
      resetTextareaHeight();
    } finally {
      setIsSending(false);
      textareaRef.current?.focus();
    }
  }, [text, isDisabled, canSend, onSend, resetTextareaHeight]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  if (!canSend) {
    return (
      <div className="border-t border-neutral-200 p-3">
        <p className="text-center text-sm text-neutral-500">
          No tienes permiso para enviar mensajes
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-neutral-200 p-3">
      <div className="flex items-end gap-2">
        {/* Template button */}
        <button
          type="button"
          onClick={onTemplateClick}
          disabled={isDisabled}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-600 transition-colors hover:bg-neutral-200 disabled:opacity-50"
          aria-label="Plantillas"
        >
          <FileText className="h-4 w-4" />
        </button>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder="Escribe un mensaje..."
          rows={1}
          className="max-h-24 min-h-[36px] flex-1 resize-none rounded-xl border border-neutral-300 px-3 py-2 text-sm leading-5 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-50"
        />

        {/* Send button */}
        <button
          type="button"
          onClick={handleSend}
          disabled={isDisabled || !text.trim()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neutral-900 text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
          aria-label="Enviar"
        >
          {isSending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
