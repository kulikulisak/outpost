import { createRoot } from 'react-dom/client';
import { App } from './App';
import { WebApp } from './WebApp';
import './styles.css';

createRoot(document.getElementById('root')!).render(location.hash.startsWith('#web=') ? <WebApp /> : <App />);
