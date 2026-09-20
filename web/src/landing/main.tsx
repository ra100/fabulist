import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { bootPalette } from '../palette.ts';
import '../styles.css';
import './landing.css';
import { Landing } from './Landing.tsx';

// Same call the app makes, for the same reason: a returning visitor who chose
// Nocturne should not see Chronicle flash first. The landing page reads the
// same stored key, so the marketing page and the app agree on their colour.
bootPalette();

// A separate entry point from the app, so it gets its own client — but with
// the same defaults: no retry (a 401 is an answer, not a failure) and no
// focus-refetch of a one-shot auth probe.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(
  <QueryClientProvider client={queryClient}>
    <Landing />
  </QueryClientProvider>,
);
