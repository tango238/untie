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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_model_file, write_model_file])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
