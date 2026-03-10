import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw, AlertCircle, MessageSquare } from 'lucide-react';
import { Header } from '../components/layout';
import { Card } from '../components/ui';
import { ConversationList } from '../components/inbox/ConversationList';
import { ChatWindow } from '../components/inbox/ChatWindow';
import { OrderPanel } from '../components/inbox/OrderPanel';
import {
  fetchChannelStatus,
  fetchConversations,
  WaspyConversation,
  WaspyChannelStatus,
} from '../services/waspy';
import { useAuth } from '../contexts/AuthContext';

export function InboxPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [channelStatus, setChannelStatus] = useState<WaspyChannelStatus | null>(null);
  const [conversations, setConversations] = useState<WaspyConversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<WaspyConversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Pre-fill search from URL query param
  const phoneParam = searchParams.get('phone');
  const phoneParamApplied = useRef(false);

  const loadChannelStatus = useCallback(async () => {
    try {
      const status = await fetchChannelStatus();
      setChannelStatus(status);
    } catch (err) {
      console.error('Error al cargar estado del canal:', err);
    }
  }, []);

  const selectedConversationRef = useRef(selectedConversation);
  selectedConversationRef.current = selectedConversation;

  const loadConversations = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setLoading(true);
    }
    setError(null);
    try {
      const data = await fetchConversations();
      const list = data.conversations || [];
      setConversations(list);

      // Update selected conversation if it still exists (refresh data)
      const currentSelected = selectedConversationRef.current;
      if (currentSelected) {
        const updated = list.find((c: WaspyConversation) => c.id === currentSelected.id);
        if (updated) {
          setSelectedConversation(updated);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar conversaciones');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadChannelStatus();
    loadConversations(true);
  }, []);

  // Handle phone query param - pre-select or search
  useEffect(() => {
    if (phoneParam && !phoneParamApplied.current && conversations.length > 0) {
      phoneParamApplied.current = true;

      // Try to find a matching conversation
      const match = conversations.find(
        (c) => c.contactPhone === phoneParam || c.contactPhone.endsWith(phoneParam)
      );

      if (match) {
        setSelectedConversation(match);
      } else {
        // Set as search query so user can see filtered results
        setSearchQuery(phoneParam);
      }
    }
  }, [phoneParam, conversations]);

  // Polling every 15 seconds (only when tab is visible)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadConversations();
        loadChannelStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadConversations();
      }
    }, 15000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(pollInterval);
    };
  }, [loadConversations]);

  // Filter conversations by search query
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;

    const query = searchQuery.toLowerCase().trim();
    return conversations.filter((c) => {
      const name = (c.contactName || '').toLowerCase();
      const phone = (c.contactPhone || '').toLowerCase();
      return name.includes(query) || phone.includes(query);
    });
  }, [conversations, searchQuery]);

  const handleRefresh = () => {
    loadConversations(true);
    loadChannelStatus();
  };

  // Permission check
  if (!hasPermission('inbox.view')) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="text-center py-8 px-12">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">
            Sin permisos
          </h3>
          <p className="text-neutral-500">No tienes permiso para ver el inbox.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        title="Inbox WhatsApp"
        subtitle={`${conversations.length} conversaciones`}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {/* Channel status banner */}
      {channelStatus && channelStatus.status !== 'connected' && (
        <div className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2">
          <AlertCircle size={16} className="text-amber-600 flex-shrink-0" />
          <span className="text-sm text-amber-700">
            {channelStatus.status === 'disconnected'
              ? 'WhatsApp desconectado. Conecta el canal desde Configuracion.'
              : 'WhatsApp con problemas. Algunos mensajes podrian no enviarse.'}
          </span>
          {hasPermission('whatsapp.connect') && (
            <button
              onClick={() => navigate('/admin/whatsapp')}
              className="ml-auto text-sm text-amber-700 underline whitespace-nowrap"
            >
              Configurar
            </button>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2">
          <AlertCircle size={16} className="text-red-600 flex-shrink-0" />
          <span className="text-sm text-red-700">{error}</span>
          <button
            onClick={handleRefresh}
            className="ml-auto text-sm text-red-700 underline whitespace-nowrap"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Main 3-column layout */}
      <div className="flex flex-1 h-[calc(100vh-8rem)] overflow-hidden">
        {/* Conversation List */}
        <div className="w-80 border-r border-neutral-200 flex flex-col bg-white">
          <ConversationList
            conversations={filteredConversations}
            selectedId={selectedConversation?.id}
            onSelect={setSelectedConversation}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            loading={loading}
          />
        </div>

        {/* Chat Window */}
        <div className="flex-1 flex flex-col min-w-0">
          {loading && conversations.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <RefreshCw size={32} className="animate-spin text-neutral-400" />
            </div>
          ) : selectedConversation ? (
            <ChatWindow
              conversation={selectedConversation}
              canSend={hasPermission('inbox.send')}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-neutral-400">
              <div className="text-center">
                <MessageSquare size={48} className="mx-auto mb-3 opacity-50" />
                <p className="text-sm">Selecciona una conversacion</p>
              </div>
            </div>
          )}
        </div>

        {/* Order Panel */}
        {selectedConversation && (
          <div className="w-80 border-l border-neutral-200 bg-white overflow-y-auto">
            <OrderPanel
              conversation={selectedConversation}
              canAssign={hasPermission('inbox.assign')}
            />
          </div>
        )}
      </div>
    </div>
  );
}
