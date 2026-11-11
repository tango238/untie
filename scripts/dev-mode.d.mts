/** 開発モード (開発用の画面を出す) を、vite の起動のしかたと UNTIE_DEV_MODE から決める。build は必ず false */
export function untieDevMode(env: { command: "serve" | "build"; mode: string }, appDir: string): boolean;
