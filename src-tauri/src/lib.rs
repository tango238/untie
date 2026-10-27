use std::fs;

/// モデルの JSON ファイルを読む。パスはファイル選択ダイアログで選ばれたもの
#[tauri::command]
fn read_model_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path} を読めませんでした: {e}"))
}

/// モデルの JSON ファイルを書く。パスは保存ダイアログで選ばれたもの
#[tauri::command]
fn write_model_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("{path} に書けませんでした: {e}"))
}

/// API キーをしまう OS のキーチェーンのサービス名
const KEYRING_SERVICE: &str = "net.tech-square.untie";
/// キーを保存できる AI のプロバイダー (画面の選択肢と合わせる)
const PROVIDERS: [&str; 3] = ["claude", "codex", "gemini"];

fn key_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !PROVIDERS.contains(&provider) {
        return Err(format!("不明なプロバイダーです: {provider}"));
    }
    keyring::Entry::new(KEYRING_SERVICE, &format!("api-key-{provider}")).map_err(|e| e.to_string())
}

/// API キーを読む。保存されていなければ None
#[tauri::command]
fn get_api_key(provider: String) -> Result<Option<String>, String> {
    match key_entry(&provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("キーチェーンから読めませんでした: {e}")),
    }
}

/// API キーを OS のキーチェーンに保存する。
/// 前の項目は消してから作り直す (別の署名のアプリが作った項目は、上書きでは読めるようにならないため)
#[tauri::command]
fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let entry = key_entry(&provider)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            return Err(format!(
                "キーチェーンにある前の API キーを置き換えられませんでした: {e}。「キーチェーンアクセス」で {KEYRING_SERVICE} を削除してから保存し直してください"
            ))
        }
    }
    entry
        .set_password(key.trim())
        .map_err(|e| format!("キーチェーンに保存できませんでした: {e}"))
}

/// API キーをキーチェーンから消す (無ければ何もしない)
#[tauri::command]
fn delete_api_key(provider: String) -> Result<(), String> {
    match key_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("キーチェーンから消せませんでした: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_model_file,
            write_model_file,
            get_api_key,
            set_api_key,
            delete_api_key
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
