/**
 * Side panel bootstrap.
 * Kept minimal: the panel opens and closes constantly while the user works
 * through an application, so its startup cost is paid over and over.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '@/assets/tailwind.css';

const container = document.getElementById('root');
if (container === null) throw new Error('Side panel is missing its #root element');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
