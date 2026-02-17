import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/layout';
import { Dashboard, RealOrders, RealOrderDetail, RealReceipts, RealReceiptDetail, AdminUsers, Financieras } from './pages';
import ActivityLog from './pages/ActivityLog';
import BatchPrint from './pages/BatchPrint';
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
            <Route path="/receipts/:id" element={<RealReceiptDetail />} />
            <Route path="/admin/users" element={<AdminUsers />} />
            <Route path="/admin/activity" element={<ActivityLog />} />
            <Route path="/admin/financieras" element={<Financieras />} />
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
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
