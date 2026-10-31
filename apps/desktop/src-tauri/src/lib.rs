use std::fs;

#[cfg(desktop)]
use tauri::Manager;

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

/// 秘密をしまう OS のキーチェーンのサービス名
const KEYRING_SERVICE: &str = "net.tech-square.untie";
/// 保存できる秘密の名前: AI のプロバイダー (画面の選択肢と合わせる) と、ログインのセッショントークン (`session`)
const SECRET_NAMES: [&str; 4] = ["claude", "codex", "gemini", "session"];

/// キーチェーンの項目名。API キーは `api-key-<名前>` (以前の版と同じ)、セッショントークンは `session-token`
fn account_name(name: &str) -> String {
    if name == "session" {
        "session-token".to_string()
    } else {
        format!("api-key-{name}")
    }
}

fn secret_entry(name: &str) -> Result<keyring::Entry, String> {
    if !SECRET_NAMES.contains(&name) {
        return Err(format!("不明な名前です: {name}"));
    }
    keyring::Entry::new(KEYRING_SERVICE, &account_name(name)).map_err(|e| e.to_string())
}

/// 秘密を読む。保存されていなければ None
#[tauri::command]
fn get_secret(name: String) -> Result<Option<String>, String> {
    match secret_entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("キーチェーンから読めませんでした: {e}")),
    }
}

/// 秘密を OS のキーチェーンに保存する。
/// 前の項目は消してから作り直す (別の署名のアプリが作った項目は、上書きでは読めるようにならないため)
#[tauri::command]
fn set_secret(name: String, value: String) -> Result<(), String> {
    let entry = secret_entry(&name)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            return Err(format!(
                "キーチェーンにある前の値を置き換えられませんでした: {e}。「キーチェーンアクセス」で {KEYRING_SERVICE} を削除してから保存し直してください"
            ))
        }
    }
    entry
        .set_password(value.trim())
        .map_err(|e| format!("キーチェーンに保存できませんでした: {e}"))
}

/// 秘密をキーチェーンから消す (無ければ何もしない)
#[tauri::command]
fn delete_secret(name: String) -> Result<(), String> {
    match secret_entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("キーチェーンから消せませんでした: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Windows / Linux は deep link で新しいプロセスが起動されるので、single-instance (deep-link 機能つき) が
    // その URL を動いている方のアプリに渡す。deep-link より前に登録する。動いている方のウィンドウを前に出す
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // untie:// を実行時に登録する: 開発ビルド (`pnpm tauri dev`) は未インストールなので Linux / Windows で、
            // Linux は AppImage で配るためリリースでも (AppImage はインストーラーが .desktop を置かない)。
            // macOS は .app の Info.plist、Windows のインストーラーはレジストリで決まるので、リリースでは呼ばない
            #[cfg(any(all(debug_assertions, windows), target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_model_file,
            write_model_file,
            get_secret,
            set_secret,
            delete_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
