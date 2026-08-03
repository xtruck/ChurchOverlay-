// Core type definitions for ChurchOverlay

export interface VerseReference {
  book: string;
  chapter: number;
  verseStart?: number;
  verseEnd?: number;
}

export interface Verse {
  reference: string;
  text: string;
  text_fr?: string;
  text_en?: string;
  durationMs?: number;
  langMode?: 'fr' | 'en' | 'both';
  provider?: string;
  lang?: string;
  autoDetected?: boolean;
}

export interface WebSocketMessage {
  action: string;
  [key: string]: any;
}

export interface ShowVerseMessage extends WebSocketMessage {
  action: 'showVerse';
  reference: string;
  text: string;
  durationMs?: number;
  text_fr?: string;
  text_en?: string;
  langMode?: 'fr' | 'en' | 'both';
  provider?: string;
  lang?: string;
  autoDetected?: boolean;
}

export interface HideVerseMessage extends WebSocketMessage {
  action: 'hideVerse';
}

export interface UpdateVerseMessage extends WebSocketMessage {
  action: 'updateVerse';
  reference: string;
  text: string;
  durationMs?: number;
}

export interface LookupReferenceMessage extends WebSocketMessage {
  action: 'lookupReference';
  reference: string;
}

export interface TranscriptionResult {
  text: string;
  provider: 'groq' | 'deepgram';
  confidence?: number;
  duration?: number;
}

export interface DetectionResult {
  reference: string;
  book: string;
  chapter: number;
  verseStart?: number;
  verseEnd?: number;
  confidence: number;
  method: 'regex' | 'semantic' | 'quote' | 'voice';
}

export interface Theme {
  id: string;
  name: string;
  colors: {
    background: string;
    text: string;
    accent: string;
    [key: string]: string;
  };
  fonts?: {
    primary?: string;
    secondary?: string;
  };
  effects?: {
    showCross?: boolean;
    showParticles?: boolean;
    [key: string]: any;
  };
  readonly?: boolean;
}

export interface AudioSegment {
  filePath: string;
  duration: number;
  timestamp: number;
}

export interface RateLimitConfig {
  maxConnections?: number;
  maxMessagesPerMinute?: number;
  connectionWindowMs?: number;
  cleanupIntervalMs?: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string | null;
  sanitized?: any;
}

export interface BibleProvider {
  name: string;
  fetchChapter(bookCode: string, chapter: number): Promise<any>;
  parseVerse(data: any, verseNum: number): string;
}
