import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { bootPalette } from './palette.ts';
import './styles.css';

// Before render, so the stored preset never flashes the default first.
bootPalette();

// retry: false — the app surfaces fetch errors to the user immediately and
// never retried before; refetchOnWindowFocus: false — the app has its own
// live-poll cadence and never refetched on focus.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
