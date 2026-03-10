import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Phone,
  Check,
  CheckCheck,

  AlertCircle,
  Clock,
  Loader2,
  Image,
  FileText,
  Mic,
  Video,
  MessageSquare,
  User,
} from 'lucide-react';
import {
  fetchMessages,
  sendMessage,
  WaspyMessage,
  WaspyConversation,
} from '../../services/waspy';
import { MessageInput } from './MessageInput';
import { TemplatePicker } from './TemplatePicker';

interface ChatWindowProps {
  conversation: WaspyConversation;
  canSend: boolean;
}

const POLL_INTERVAL = 10_000;

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusIcon({ status }: { status: WaspyMessage['status'] }) {
  switch (status) {
    case 'pending':
      return <Clock className="h-3 w-3 text-neutral-400" />;
    case 'sent':
      return <Check className="h-3 w-3 text-neutral-400" />;
    case 'delivered':
      return <CheckCheck className="h-3 w-3 text-neutral-400" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case 'failed':
      return <AlertCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MessageContent({ message }: { message: WaspyMessage }) {
  const { type, content } = message;

  switch (type) {
    case 'image':
      return (
        <div className="space-y-1">
          {content.url ? (
            <img
              src={content.url}
              alt={content.caption || 'Imagen'}
              className="max-w-full rounded-lg"
            />
          ) : (
            <div className="flex items-center gap-2 text-sm opacity-70">
              <Image className="h-4 w-4" />
              <span>Imagen</span>
            </div>
          )}
          {content.caption && <p className="text-sm">{content.caption}</p>}
        </div>
      );

    case 'document':
      return (
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 flex-shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {content.filename || 'Documento'}
            </p>
            {content.url && (
              <a
                href={content.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline opacity-70 hover:opacity-100"
              >
                Descargar
              </a>
            )}
          </div>
        </div>
      );

    case 'audio':
      return (
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 flex-shrink-0" />
          {content.url ? (
            <audio controls className="max-w-[200px]">
              <source src={content.url} />
            </audio>
          ) : (
            <span className="text-sm opacity-70">Audio</span>
          )}
        </div>
      );

    case 'video':
      return (
        <div className="space-y-1">
          {content.url ? (
            <video controls className="max-w-full rounded-lg">
              <source src={content.url} />
            </video>
          ) : (
            <div className="flex items-center gap-2 text-sm opacity-70">
              <Video className="h-4 w-4" />
              <span>Video</span>
            </div>
          )}
          {content.caption && <p className="text-sm">{content.caption}</p>}
        </div>
      );

    case 'template':
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-xs opacity-60">
            <MessageSquare className="h-3 w-3" />
            <span>Plantilla: {content.templateName}</span>
          </div>
          {content.text && <p className="text-sm">{content.text}</p>}
        </div>
      );

    case 'interactive':
      return (
        <div>
          {content.text && <p className="text-sm">{content.text}</p>}
          {!content.text && (
            <span className="text-sm opacity-70">Mensaje interactivo</span>
          )}
        </div>
      );

    case 'text':
    default:
      return <p className="text-sm whitespace-pre-wrap">{content.text}</p>;
  }
}

const statusLabels: Record<WaspyConversation['status'], string> = {
  open: 'Abierta',
  closed: 'Cerrada',
  pending: 'Pendiente',
};

const statusColors: Record<WaspyConversation['status'], string> = {
  open: 'bg-green-100 text-green-700',
  closed: 'bg-neutral-100 text-neutral-500',
  pending: 'bg-yellow-100 text-yellow-700',
};

export function ChatWindow({ conversation, canSend }: ChatWindowProps) {
  const [messages, setMessages] = useState<WaspyMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevConversationId = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const loadMessages = useCallback(
    async (showLoader = false) => {
      try {
        if (showLoader) setLoading(true);
        setError(null);
        const data = await fetchMessages(conversation.id);
        setMessages(data.messages);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Error al cargar mensajes'
        );
      } finally {
        setLoading(false);
      }
    },
    [conversation.id]
  );

  // Load messages on mount / conversation change
  useEffect(() => {
    if (prevConversationId.current !== conversation.id) {
      setMessages([]);
      prevConversationId.current = conversation.id;
    }
    loadMessages(true);
  }, [loadMessages, conversation.id]);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Polling
  useEffect(() => {
    const interval = setInterval(() => {
      loadMessages(false);
    }, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [loadMessages]);

  const handleSend = async (text: string) => {
    try {
      const newMessage = await sendMessage({
        conversationId: conversation.id,
        phoneNumberId: conversation.phoneNumberId,
        to: conversation.contactPhone.replace(/[^0-9]/g, ''),
        type: 'text',
        content: { body: text },
      });
      setMessages((prev) => [...prev, newMessage]);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Error al enviar mensaje'
      );
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-200">
          <User className="h-5 w-5 text-neutral-500" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-neutral-900">
            {conversation.contactName}
          </h2>
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <Phone className="h-3 w-3" />
            <span>{conversation.contactPhone}</span>
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[conversation.status]}`}
        >
          {statusLabels[conversation.status]}
        </span>
      </div>

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto bg-neutral-50 px-4 py-4"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-500">
            <AlertCircle className="h-6 w-6 text-red-400" />
            <p className="text-sm">{error}</p>
            <button
              onClick={() => loadMessages(true)}
              className="mt-1 text-xs text-neutral-600 underline hover:text-neutral-900"
            >
              Reintentar
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-neutral-400">No hay mensajes</p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => {
              const isOutbound = message.direction === 'outbound';
              return (
                <div
                  key={message.id}
                  className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[70%] px-3 py-2 ${
                      isOutbound
                        ? 'rounded-2xl rounded-tr-sm bg-neutral-900 text-white'
                        : 'rounded-2xl rounded-tl-sm bg-neutral-100 text-neutral-900'
                    }`}
                  >
                    <MessageContent message={message} />
                    <div
                      className={`mt-1 flex items-center gap-1 ${
                        isOutbound ? 'justify-end' : 'justify-start'
                      }`}
                    >
                      <span className="text-xs text-neutral-400">
                        {formatTime(message.timestamp)}
                      </span>
                      {isOutbound && <StatusIcon status={message.status} />}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <MessageInput
        onSend={handleSend}
        onTemplateClick={() => setTemplatePickerOpen(true)}
        disabled={false}
        canSend={canSend}
      />

      {/* Template Picker */}
      <TemplatePicker
        isOpen={templatePickerOpen}
        onClose={() => setTemplatePickerOpen(false)}
        conversationId={conversation.id}
        contactPhone={conversation.contactPhone}
        onSent={() => {
          setTemplatePickerOpen(false);
          loadMessages(false);
        }}
      />
    </div>
  );
}
