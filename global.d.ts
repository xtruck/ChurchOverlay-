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

  // ---------------------------------------------------------------------
  // window.churchOverlay — surface exposée par preload.js (contextBridge).
  // AJOUT (chantier 6b.2 — typer le pont IPC) : global.d.ts ne typait que
  // process.env jusqu'ici ; ce pont, appelé depuis chaque module de
  // dashboard/features/*.js, n'avait aucune vérification à la compilation —
  // un nom de méthode mal orthographié (ex. obsListScenes vs obsListScene)
  // échouait silencieusement à l'exécution (`undefined is not a function`)
  // plutôt qu'à `tsc --noEmit`. Formes de retour reconstruites en lisant les
  // handlers `ipcMain.handle(...)` correspondants dans main.js — la plupart
  // suivent la convention `{ ok: boolean, ...donnees }` ou
  // `{ ok: false, error: string }`, mais pas tous (ex. obs-switch-scene
  // délègue directement à obs-controller.js, qui a sa propre forme).
  // ---------------------------------------------------------------------
  interface ChurchOverlayStatus {
    status: string;
    logs: string[];
    overlayUrl: string;
    brandingOverlayUrl: string;
  }

  interface ChurchOverlaySettings {
    hasGroqKey: boolean;
    hasDeepgramKey: boolean;
    audioDevice: string | null;
    needsSetup: boolean;
    wsHost: string | null;
    suggestedLanIp: string | null;
  }

  interface ChurchOverlayPerfStats {
    cpuPercent: number;
    rssMB: number;
    heapUsedMB: number;
    [key: string]: unknown;
  }

  interface ChurchOverlayTheme {
    id: string;
    name: string;
    author?: string;
    [key: string]: unknown;
  }

  interface ChurchOverlayThemesResult {
    ok: boolean;
    themes: ChurchOverlayTheme[];
    error?: string;
  }

  interface ChurchOverlayActiveThemeResult {
    ok: boolean;
    theme: ChurchOverlayTheme | null;
    error?: string;
  }

  interface ChurchOverlayDisplay {
    id: number;
    label: string;
    bounds: { x: number; y: number; width: number; height: number };
  }

  interface ChurchOverlayObsConfigResult {
    ok: boolean;
    enabled?: boolean;
    obsWebsocketUrl?: string;
    hasPassword?: boolean;
    error?: string;
  }

  interface ChurchOverlayObsScenesResult {
    ok: boolean;
    scenes: string[];
    error?: string;
  }

  interface ChurchOverlayObsActionResult {
    ok: boolean;
    reason?: string;
    [key: string]: unknown;
  }

  interface ChurchOverlayProPresenterConfigResult {
    ok: boolean;
    enabled?: boolean;
    host?: string;
    port?: number;
    hasPassword?: boolean;
    autoSendVerses?: boolean;
    error?: string;
  }

  interface ChurchOverlayPlanningCenterConfigResult {
    ok: boolean;
    enabled?: boolean;
    appId?: string;
    hasSecret?: boolean;
    error?: string;
  }

  interface ChurchOverlayApiResult {
    ok: boolean;
    error?: string;
    [key: string]: unknown;
  }

  interface Window {
    churchOverlay: {
      // --- Écran de configuration initiale (setup.html) ---
      saveSetup: (
        audioDevice: string,
        groqApiKey: string,
        deepgramApiKey: string
      ) => Promise<boolean>;
      clearApiKey: (provider: 'groq' | 'deepgram') => Promise<boolean>;
      saveNetworkSettings: (wsHost: string) => Promise<boolean>;

      // --- Tableau de bord (dashboard.html) ---
      getStatus: () => Promise<ChurchOverlayStatus>;
      requestRestart: () => Promise<void>;
      openSetup: () => Promise<boolean>;
      getSettings: () => Promise<ChurchOverlaySettings>;
      getPerfStats: () => Promise<ChurchOverlayPerfStats>;

      // --- Capture micro native ---
      sendAudioChunk: (buffer: ArrayBuffer) => void;
      onAudioPipelineReady: (callback: () => void) => () => void;

      // --- Mises à jour poussées depuis main.js ---
      onStatusUpdate: (callback: (payload: unknown) => void) => () => void;
      onPerfUpdate: (callback: (payload: ChurchOverlayPerfStats) => void) => () => void;
      onPipelineAlert: (
        callback: (
          payload:
            | { code: string; severity: 'error' | 'warning'; message: string; timestamp: number }
            | { clear: true }
        ) => void
      ) => () => void;

      // --- Thèmes de l'overlay (theme-loader.js) ---
      listThemes: () => Promise<ChurchOverlayThemesResult>;
      getActiveTheme: () => Promise<ChurchOverlayActiveThemeResult>;
      setActiveTheme: (themeId: string) => Promise<ChurchOverlayActiveThemeResult>;

      // --- Contrôle OBS multi-scènes (obs-controller.js) ---
      getObsConfig: () => Promise<ChurchOverlayObsConfigResult>;
      setObsConfig: (cfg: {
        enabled?: boolean;
        obsWebsocketUrl?: string;
        password?: string;
      }) => Promise<ChurchOverlayApiResult>;
      obsConnect: () => Promise<{ ok: boolean; connected: boolean; error?: string }>;
      obsListScenes: () => Promise<ChurchOverlayObsScenesResult>;
      obsSwitchScene: (sceneName: string) => Promise<ChurchOverlayObsActionResult>;
      obsToggleRecording: () => Promise<ChurchOverlayObsActionResult>;

      // --- Pont ProPresenter ---
      getProPresenterConfig: () => Promise<ChurchOverlayProPresenterConfigResult>;
      setProPresenterConfig: (cfg: {
        enabled?: boolean;
        host?: string;
        port?: number;
        password?: string;
        autoSendVerses?: boolean;
      }) => Promise<ChurchOverlayApiResult>;
      proPresenterConnect: () => Promise<ChurchOverlayApiResult>;
      proPresenterSendMessage: (text: string) => Promise<ChurchOverlayApiResult>;

      // --- Planning Center Services (lecture seule) ---
      getPlanningCenterConfig: () => Promise<ChurchOverlayPlanningCenterConfigResult>;
      setPlanningCenterConfig: (cfg: {
        enabled?: boolean;
        appId?: string;
        secret?: string;
      }) => Promise<ChurchOverlayApiResult>;
      fetchPlanningCenterPlan: () => Promise<ChurchOverlayApiResult>;

      // --- Fenêtres d'affichage plein écran (overlay/stage/annonces) ---
      listDisplays: () => Promise<ChurchOverlayDisplay[]>;
      openDisplayWindow: (
        displayId: number,
        mode?: 'overlay' | 'stage-display' | 'announcement-loop'
      ) => Promise<unknown>;
      closeDisplayWindow: (mode?: string) => Promise<unknown>;

      // --- Médiathèque ---
      pickMediaFile: () => Promise<string | null>;
      getPathForFile: (file: File) => string;

      // --- Extraits vidéo (chantier 4.6) ---
      pickSourceVideoFile: () => Promise<string | null>;
      pickClipOutputDir: () => Promise<string | null>;
    };
  }
}

export {};
