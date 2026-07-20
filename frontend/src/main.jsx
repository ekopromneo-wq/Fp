import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import App from './App.jsx';
import PwaUpdatePrompt from './components/PwaUpdatePrompt.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    {/* ADR-035: баннер обновления PWA + kill-switch. Живёт рядом с App, вне его
        дерева состояния — реагирует на глобальный флаг записи и события сети. */}
    <PwaUpdatePrompt />
  </React.StrictMode>
);
