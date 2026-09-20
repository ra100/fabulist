import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { bootPalette } from './palette.ts';
import { createQueryClient } from './queries.ts';
import './styles.css';

// Before render, so the stored preset never flashes the default first.
bootPalette();

const queryClient = createQueryClient();

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
