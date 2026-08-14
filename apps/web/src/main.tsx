import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { RoleProvider } from './auth/RoleContext';
import App from './App';
import './index.css';

const basename = typeof window !== 'undefined' && window.location.pathname.includes('/improvements')
  ? '/improvements'
  : undefined;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <RoleProvider>
        <BrowserRouter basename={basename}>
          <App />
        </BrowserRouter>
      </RoleProvider>
    </AuthProvider>
  </React.StrictMode>
);
