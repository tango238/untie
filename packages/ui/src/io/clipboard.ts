/** 文字列をクリップボードに写す */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
