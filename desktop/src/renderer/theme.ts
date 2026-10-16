import { useEffect, useState } from 'react';
import { rc } from './api';
import type { Prefs } from '../shared/types';

/** Applies light/dark, text size and density to the document. */
export function applyLook(p: Partial<Prefs> | null) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  root.dataset.theme = p?.theme === 'dark' || (p?.theme !== 'light' && mq.matches) ? 'dark' : 'light';
  root.dataset.density = p?.density || 'comfortable';
  root.style.setProperty('--fs', `${p?.fontSize || 14}px`);
}

export function useLook(p: Partial<Prefs> | null) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyLook(p);
    apply(); mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [p?.theme, p?.fontSize, p?.density]);
}

/** For secondary windows: read prefs once and keep the look in sync with the system. */
export function useTheme() {
  const [p, setP] = useState<Prefs | null>(null);
  useEffect(() => { rc.prefs.get().then(setP).catch(() => {}); }, []);
  useLook(p);
  return p;
}
