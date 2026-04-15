import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/layout';
import { Dashboard, RealOrders, RealOrderDetail, RealReceipts, RealReceiptDetail, AdminUsers, Financieras, ShippingForm, ShippingDocuments, ComprobantesForm, IntegrationSettings } from './pages';
import Customers from './pages/Customers';
import ActivityLog from './pages/ActivityLog';
import SyncQueue from './pages/SyncQueue';
import BatchPrint from './pages/BatchPrint';
import { WhatsAppActions } from './pages';
import ImageSyncStatus from './pages/ImageSyncStatus';
import SystemStatus from './pages/SystemStatus';
import { AiBotDashboard, AiBotConfig, AiBotHistory, AiBotPromptEditor, AdminBankPanel } from './pages';
import LocalReservas from './pages/local/LocalReservas';
import LocalReservaNew from './pages/local/LocalReservaNew';
import LocalReservaDetail from './pages/local/LocalReservaDetail';
import LocalCaja from './pages/local/LocalCaja';
import LocalCajaNew from './pages/local/LocalCajaNew';
import LocalCajaDetail from './pages/local/LocalCajaDetail';
import LocalAlertas from './pages/local/LocalAlertas';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { getDefaultRoute } from './utils/navigation';

// Componente para redirigir a la ruta por defecto
function DefaultRedirect() {
  const defaultRoute = getDefaultRoute();
  return <Navigate to={defaultRoute} replace />;
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <Routes>
      {/* Página de impresión masiva - sin Layout (para imprimir limpio) */}
      <Route path="/orders/print" element={<BatchPrint />} />

      {/* Resto de la app con Layout */}
      <Route path="*" element={
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/orders" element={<RealOrders />} />
            <Route path="/orders/:orderNumber" element={<RealOrderDetail />} />
            <Route path="/receipts" element={<RealReceipts />} />
            <Route path="/receipts/admin-bank" element={<AdminBankPanel />} />
            <Route path="/receipts/:id" element={<RealReceiptDetail />} />
            <Route path="/remitos" element={<ShippingDocuments />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/admin/users" element={<AdminUsers />} />
            <Route path="/admin/activity" element={<ActivityLog />} />
            <Route path="/admin/sync-queue" element={<SyncQueue />} />
            <Route path="/admin/financieras" element={<Financieras />} />
            <Route path="/admin/whatsapp-actions" element={<WhatsAppActions />} />
            <Route path="/admin/image-sync" element={<ImageSyncStatus />} />
            <Route path="/admin/integrations" element={<IntegrationSettings />} />
            <Route path="/admin/ai-bot" element={<AiBotDashboard />} />
            <Route path="/admin/ai-bot/config" element={<AiBotConfig />} />
            <Route path="/admin/ai-bot/history" element={<AiBotHistory />} />
            <Route path="/admin/ai-bot/prompt" element={<AiBotPromptEditor />} />
            <Route path="/system-status" element={<SystemStatus />} />
            {/* Módulo LOCAL */}
            <Route path="/local/reservas" element={<LocalReservas />} />
            <Route path="/local/reservas/nueva" element={<LocalReservaNew />} />
            <Route path="/local/reservas/:id" element={<LocalReservaDetail />} />
            <Route path="/local/caja" element={<LocalCaja />} />
            <Route path="/local/caja/nueva" element={<LocalCajaNew />} />
            <Route path="/local/caja/:id" element={<LocalCajaDetail />} />
            <Route path="/local/alertas" element={<LocalAlertas />} />
            {/* Ruta catch-all: redirige a la primera sección permitida */}
            <Route path="*" element={<DefaultRedirect />} />
          </Routes>
        </Layout>
      } />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Rutas públicas - sin autenticación */}
        <Route path="/envio" element={<ShippingForm />} />
        <Route path="/comprobantes" element={<ComprobantesForm />} />

        {/* Resto de la app - con autenticación */}
        <Route path="*" element={
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        } />
      </Routes>
    </BrowserRouter>
  );
}
