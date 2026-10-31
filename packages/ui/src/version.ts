// アプリのバージョン (ルートの package.json の version)。各 app の vite.config.ts が define で埋める
declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
