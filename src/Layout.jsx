import { Logo } from './Brand.jsx';
import { IconHome, IconOrders, IconClients, IconMore } from './Icons.jsx';

export function Layout({ children, activeTab, onTabChange, workspaceName, user, onLogout }) {
  const tabs = [
    { id: 'home', label: 'Accueil', icon: IconHome, href: '/' },
    { id: 'orders', label: 'Commandes', icon: IconOrders, href: '/commandes' },
    { id: 'clients', label: 'Clients', icon: IconClients, href: '/clients' },
    { id: 'more', label: 'Plus', icon: IconMore, href: '/plus' },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-neutral-50">
      {/* Sticky header */}
      <header className="fixed top-0 left-0 right-0 z-40 bg-white/95 backdrop-blur border-b border-neutral-200 no-print">
        <div className="max-w-3xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          {/* Logo */}
          <button onClick={() => window.location.hash = '/'} className="shrink-0 flex items-center h-8">
            <Logo size={32} />
          </button>

          {/* Workspace name */}
          <div className="text-sm font-medium text-neutral-600 truncate max-w-1/2">
            {workspaceName}
          </div>

          {/* Placeholder for future actions */}
        </div>
      </header>

      {/* Content area with bottom padding for tab bar */}
      <main className="flex-1 mt-16 mb-28 px-4 pt-4">
        <div className="max-w-3xl mx-auto">
          {children}
        </div>
      </main>

      {/* Fixed bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-neutral-200 no-print safe-area-pb">
        <div className="max-w-3xl mx-auto px-0">
          <div className="flex items-stretch divide-x divide-neutral-200">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    onTabChange(tab.id);
                    window.location.hash = tab.href;
                  }}
                  className={`flex-1 min-h-touch flex flex-col items-center justify-center gap-0.5 py-2 text-center transition ${
                    isActive
                      ? 'text-yf-primary'
                      : 'text-neutral-400'
                  }`}
                >
                  <Icon className="w-6 h-6" />
                  <span className="text-xs font-medium">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </nav>
    </div>
  );
}
