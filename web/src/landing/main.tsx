import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { bootPalette } from '../palette.ts';
import { createQueryClient } from '../queries.ts';
import '../styles.css';
import './landing.css';
import { Landing } from './Landing.tsx';

// Same call the app makes, for the same reason: a returning visitor who chose
// Nocturne should not see Chronicle flash first. The landing page reads the
// same stored key, so the marketing page and the app agree on their colour.
bootPalette();

// Independent from the main app's QueryClient: this is a separate HTML entry
// point (landing.html) that never mounts alongside App.tsx. Same policy
// (retry/refetch/mutation-error defaults) via the shared factory, even
// though this page has no mutations today.
const queryClient = createQueryClient();

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(
  <QueryClientProvider client={queryClient}>
    <Landing />
  </QueryClientProvider>,
);
