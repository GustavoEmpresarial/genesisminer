import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { I18nProvider } from './shared/i18n';
import { applyBuildResetOnBoot } from './shared/runtime/build-reset';
import { TopIdleVerificationMark } from './shared/seo/TopIdleVerificationMark';
import './index.css';

applyBuildResetOnBoot();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <TopIdleVerificationMark />
      <App />
    </I18nProvider>
  </StrictMode>
);
