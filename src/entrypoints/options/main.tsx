/**
 * Options page bootstrap.
 *
 * StrictMode is on deliberately. Its double-invocation of effects in
 * development surfaces exactly the class of bug this codebase cannot tolerate:
 * an effect that writes to storage twice, or a save that is not idempotent.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '@/assets/tailwind.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Options page is missing its #root element');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
