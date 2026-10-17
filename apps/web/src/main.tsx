import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { TooltipProvider } from '@/components/ui/tooltip';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('The root element is missing.');
}

createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
