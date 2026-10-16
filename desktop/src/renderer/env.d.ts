declare module '*.css';
declare module '@novnc/novnc' { const RFB: any; export default RFB; }
declare module 'novnc-keyboard' { const Keyboard: any; export default Keyboard; }
declare module 'novnc-logging' { export function initLogging(level: string): void; }
declare const __APP_VERSION__: string;
