/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_CLOUDFLARE_API_URL?: string; }

interface Window {
  SpeechRecognition: typeof SpeechRecognition;
  webkitSpeechRecognition: typeof SpeechRecognition;
}
