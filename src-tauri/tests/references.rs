mod common;
use aipipe::core::{
    agents::claude_input,
    backlog,
    config::default_config,
    references,
    state::{read_state, update_state},
    tasks,
};
use serde_json::{json, Value};
use std::fs;

fn text(root: &std::path::Path, name: &str, value: &str) -> Value {
    fs::write(root.join(name), value).unwrap();
    references::import(root, &json!({"path":root.join(name)})).unwrap()
}
#[test]
fn 快照持久保存且不依賴原始檔案_內容變更會被偵測() {
    let root = common::project();
    let item = text(&root, "外部 設計.md", "驗收：必須支援登入");
    let id = item["id"].as_str().unwrap();
    fs::remove_file(root.join("外部 設計.md")).unwrap();
    let cfg = json!({"_reference_ids":[id]});
    let prepared =
        references::prepare(&root, &cfg, None, "chat", &|p| p.display().to_string()).unwrap();
    assert!(prepared.text.contains("驗收：必須支援登入"));
    assert_eq!(references::list(&root).len(), 1);
    let cache = root
        .join(".aipipe/references")
        .join(id)
        .join("files/外部 設計.md");
    fs::write(cache, "改過的快照").unwrap();
    assert!(
        references::prepare(&root, &cfg, None, "chat", &|p| p.display().to_string())
            .err()
            .unwrap()
            .message
            .contains("已變更")
    );
}
#[test]
fn 資料夾保留樹狀結構且排除套件金鑰與自身資料() {
    let root = common::project();
    for name in [
        "docs/規格.md",
        "node_modules/pkg/index.js",
        ".git/config",
        ".env",
        "secret.pem",
        "src/app.rs",
    ] {
        let p = root.join(name);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "reference").unwrap();
    }
    let item = references::import(&root, &json!({"path":root})).unwrap();
    assert_eq!(item["fileCount"], 2);
    assert!(item["excludedCount"].as_u64().unwrap() >= 4);
    let names: Vec<_> = item["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"docs/規格.md") && names.contains(&"src/app.rs"));
    assert_eq!(fs::read_to_string(root.join(".env")).unwrap(), "reference");
}
#[test]
fn 參考跟隨功能與父子任務且不洩漏到其他功能() {
    let root = common::project();
    let a = text(&root, "a.md", "feature");
    let b = text(&root, "b.md", "parent");
    let c = text(&root, "c.md", "child");
    let ai = a["id"].as_str().unwrap();
    let bi = b["id"].as_str().unwrap();
    let ci = c["id"].as_str().unwrap();
    update_state(&root, |s| s["prd"]["references"] = json!([ai])).unwrap();
    let cfg = default_config();
    for stage in ["prd", "prd_review", "tasks"] {
        assert_eq!(
            references::effective(&root, &cfg, Some(stage), stage).unwrap(),
            vec![ai]
        );
    }
    tasks::write_tasks(&root,&[json!({"id":1,"title":"parent","references":[bi],"subtasks":[{"id":1,"title":"child","references":[ci]}]})],Some("master"),json!({"references":[ai]})).unwrap();
    let effective = references::effective(&root, &cfg, Some("implement"), "task-1.1").unwrap();
    assert_eq!(effective.len(), 3);
    for id in [ai, bi, ci] {
        assert!(effective.contains(&id.to_string()));
    }
    tasks::assign_references(&root, "1", "old-tag", json!([])).unwrap_err();
    tasks::write_tasks(
        &root,
        &[json!({"id":1,"title":"next"})],
        Some("next"),
        json!({}),
    )
    .unwrap();
    assert!(
        references::effective(&root, &cfg, Some("implement"), "task-1")
            .unwrap()
            .is_empty()
    );
    assert!(references::effective(&root, &cfg, Some("chat"), "chat-id")
        .unwrap()
        .is_empty());
}
#[test]
fn 需求附件原子保存_錯誤附件不會留下半筆需求() {
    let root = common::project();
    aipipe::core::config::save_config(&root, &default_config()).unwrap();
    let a = text(&root, "spec.md", "spec");
    let item =
        backlog::add_item_with_references(&root, Some(&json!("需求")), None, &json!([a["id"]]))
            .unwrap();
    assert_eq!(
        backlog::get_item(&root, item["id"].as_str().unwrap()).unwrap()["references"],
        json!([a["id"]])
    );
    assert!(backlog::add_item_with_references(
        &root,
        Some(&json!("bad")),
        None,
        &json!(["../oops"])
    )
    .is_err());
    assert_eq!(backlog::read_backlog(&root).unwrap().len(), 1);
    assert!(read_state(&root)["prd"]["references"].is_null());
}
#[test]
fn 圖片是_multimodal_內容而非只有檔名_文字輸入維持相容() {
    let root = common::project();
    let image = root.join("設計.png");
    fs::write(&image, [137, 80, 78, 71]).unwrap();
    let line = claude_input("解釋這張圖", std::slice::from_ref(&image)).unwrap();
    let message: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        message["message"]["content"][1]["source"]["media_type"],
        "image/png"
    );
    assert_eq!(
        message["message"]["content"][1]["source"]["data"],
        "iVBORw=="
    );
    assert_eq!(claude_input("plain", &[]).unwrap(), "plain");
    let item = references::import(&root, &json!({"path":image})).unwrap();
    let cfg = json!({"_reference_ids":[item["id"]]});
    assert_eq!(
        references::prepare(&root, &cfg, None, "chat", &|p| p.display().to_string())
            .unwrap()
            .images
            .len(),
        1
    );
}
#[test]
fn 貼上與上傳驗證名稱與大小_無文字_pdf_保留警告() {
    let root = common::project();
    for name in ["../outside", "a/b", "..", "C:bad"] {
        assert!(references::import(&root, &json!({"name":name,"data":"aGk="})).is_err());
    }
    assert!(references::import(&root, &json!({"name":"hi.txt","data":"not base64"})).is_err());
    let pdf = references::import(&root, &json!({"name":"scan.pdf","data":"JVBERi0xLjc="})).unwrap();
    assert!(!pdf["warnings"].as_array().unwrap().is_empty());
    assert!(root
        .join(".aipipe/references")
        .join(pdf["id"].as_str().unwrap())
        .join("files/scan.pdf")
        .exists());
}
#[test]
fn 搜尋限定專案且不回傳依賴套件或秘密資料() {
    let root = common::project();
    fs::create_dir_all(root.join("node_modules")).unwrap();
    fs::write(root.join("reference.txt"), "yes").unwrap();
    fs::write(root.join("node_modules/reference.txt"), "no").unwrap();
    let result = references::suggest(&root, "reference").unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["name"], "reference.txt");
}

#[test]
fn 過大檔案會拒絕_不加入半份參考資料() {
    let root = common::project();
    let file = fs::File::create(root.join("large.bin")).unwrap();
    file.set_len(21 * 1024 * 1024).unwrap();
    assert!(references::import(&root, &json!({"path":root.join("large.bin")})).is_err());
    assert!(references::list(&root).is_empty());
}
#[test]
fn wsl_路徑保留專案發行版且不誤當_windows_根目錄() {
    if cfg!(windows) {
        let path = references::source_path(
            std::path::Path::new(r"\\wsl.localhost\Ubuntu\home\bear\project"),
            "/home/bear/外部 資料",
        )
        .unwrap();
        assert_eq!(
            path.to_string_lossy(),
            r"\\wsl.localhost\Ubuntu\home\bear\外部 資料"
        );
        assert!(
            references::source_path(std::path::Path::new(r"C:\project"), "/home/bear/spec.md")
                .is_err()
        );
    }
}

#[test]
fn pdf_擷取文字可交給兩種_cli_閱讀() {
    let root = common::project();
    let content = "BT /F1 12 Tf 50 700 Td (Reference PDF specification) Tj ET";
    let objects=["<< /Type /Catalog /Pages 2 0 R >>".into(),"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".into(),"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into(),format!("<< /Length {} >>\nstream\n{content}\nendstream",content.len())];
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = vec![];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
    }
    let xref = pdf.len();
    pdf.push_str("xref\n0 6\n0000000000 65535 f \n");
    for offset in offsets {
        pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    ));
    fs::write(root.join("spec.pdf"), pdf).unwrap();
    let item = references::import(&root, &json!({"path":root.join("spec.pdf")})).unwrap();
    assert_eq!(item["text"].as_array().unwrap().len(), 1, "{item}");
    let sidecar = root
        .join(".aipipe/references")
        .join(item["id"].as_str().unwrap())
        .join("text/spec.pdf.extracted.txt");
    assert!(fs::read_to_string(sidecar)
        .unwrap()
        .contains("Reference PDF specification"));
}
