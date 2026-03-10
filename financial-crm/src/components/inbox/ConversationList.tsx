import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { Search, MessageSquare } from 'lucide-react';
import { WaspyConversation } from '../../services/waspy';

interface ConversationListProps {
  conversations: WaspyConversation[];
  selectedId: string | undefined;
  onSelect: (conversation: WaspyConversation) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  loading: boolean;
}

const AVATAR_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-cyan-500',
  'bg-orange-500',
  'bg-teal-500',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

function SkeletonItem() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 animate-pulse">
      <div className="w-10 h-10 rounded-full bg-neutral-200 flex-shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-4 bg-neutral-200 rounded w-2/3" />
        <div className="h-3 bg-neutral-100 rounded w-full" />
      </div>
      <div className="h-3 bg-neutral-100 rounded w-10 flex-shrink-0" />
    </div>
  );
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
  loading,
}: ConversationListProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-3 border-b border-neutral-100">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Buscar por nombre o teléfono..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-neutral-50 border border-neutral-200 rounded-lg placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300 focus:border-transparent transition-colors"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonItem key={i} />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
            <div className="w-12 h-12 rounded-full bg-neutral-100 flex items-center justify-center mb-3">
              <MessageSquare size={20} className="text-neutral-400" />
            </div>
            <p className="text-sm font-medium text-neutral-500">
              No hay conversaciones
            </p>
            <p className="text-xs text-neutral-400 mt-1">
              {searchQuery
                ? 'No se encontraron resultados para la búsqueda'
                : 'Las conversaciones aparecerán aquí'}
            </p>
          </div>
        ) : (
          conversations.map((conversation) => {
            const isSelected = conversation.id === selectedId;
            const initials = getInitials(conversation.contactName || '?');
            const avatarColor = getAvatarColor(conversation.contactName || '');

            return (
              <button
                key={conversation.id}
                onClick={() => onSelect(conversation)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-neutral-100'
                    : 'hover:bg-neutral-50'
                }`}
              >
                {/* Avatar */}
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-white text-sm font-medium ${avatarColor}`}
                >
                  {initials}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-sm truncate ${
                        conversation.unreadCount > 0
                          ? 'font-semibold text-neutral-900'
                          : 'font-medium text-neutral-800'
                      }`}
                    >
                      {conversation.contactName || 'Sin nombre'}
                    </span>
                    {conversation.lastMessageAt && (
                      <span className="text-[11px] text-neutral-400 flex-shrink-0">
                        {formatDistanceToNow(
                          new Date(conversation.lastMessageAt),
                          { addSuffix: true, locale: es }
                        )}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-neutral-400 truncate">
                        {conversation.contactPhone}
                      </p>
                      {conversation.lastMessage && (
                        <p
                          className={`text-xs truncate mt-0.5 ${
                            conversation.unreadCount > 0
                              ? 'text-neutral-700 font-medium'
                              : 'text-neutral-500'
                          }`}
                        >
                          {conversation.lastMessage}
                        </p>
                      )}
                    </div>
                    {conversation.unreadCount > 0 && (
                      <span className="flex-shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-semibold text-white bg-emerald-500 rounded-full">
                        {conversation.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
