import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import TalkApp from './TalkApp';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <TalkApp />
  </React.StrictMode>
);
