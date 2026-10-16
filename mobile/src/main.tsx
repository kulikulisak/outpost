import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './Settings';
import './styles.css';

applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
createRoot(document.getElementById('root')!).render(<App />);
