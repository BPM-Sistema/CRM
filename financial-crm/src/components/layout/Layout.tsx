import { Sidebar } from './Sidebar';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-neutral-50">
      <Sidebar />
      {/* Desktop: sidebar padding. Mobile: bottom nav padding */}
      <main className="md:pl-64 min-h-screen pb-16 md:pb-0 transition-all duration-300">
        {children}
      </main>
    </div>
  );
}
