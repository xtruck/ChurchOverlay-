// Global type definitions for ChurchOverlay

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      // WebSocket Configuration
      PORT?: string;
      WS_HOST?: string;
      WS_AUTH_TOKEN?: string;

      // API Keys
      GROQ_API_KEY?: string;
      DEEPGRAM_API_KEY?: string;
      GEMINI_API_KEY?: string;

      // Security
      MAX_CONNECTIONS?: string;
      MAX_MESSAGES_PER_MINUTE?: string;
      VALIDATE_MESSAGES?: string;

      // Environment
      NODE_ENV?: 'development' | 'production' | 'test';
      DEBUG?: string;
    }
  }
}

export {};
