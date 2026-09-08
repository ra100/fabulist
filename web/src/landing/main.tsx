import { createRoot } from 'react-dom/client';
import { bootPalette } from '../palette.ts';
import '../styles.css';
import './landing.css';
import { Landing } from './Landing.tsx';

// Same call the app makes, for the same reason: a returning visitor who chose
// Nocturne should not see Chronicle flash first. The landing page reads the
// same stored key, so the marketing page and the app agree on their colour.
bootPalette();

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');
createRoot(el).render(<Landing />);
